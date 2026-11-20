/*
 * Infinite Animes - Manga worker (mangapark.cc -> MongoDB)
 * Isi repo ke index.js se apne aap chalta hai (alag service ki zaroorat nahi).
 * Band karna ho to Railway variable MANGA = off.
 *
 * Kya karta hai:
 *   - sitemap se saare manga ki list leta hai
 *   - har manga ka naam, cover, genres, author, type, status, description aur
 *     ENGLISH chapters ki list MongoDB mein daalta hai
 *   - jahan chapter list adhoori ho ("Load more"), wahan chapter page ke
 *     "Prev Chapter" link pakad ke peeche tak chalta hai
 *   - har WATCH_MINUTES pe sitemap dobara dekhta hai: naya manga / naya chapter aaya to le leta hai
 *   - Telegram bot pe report bhejta hai
 *
 * Chapter ki photos (pages) yahan SAVE NAHI hoti. Jab user chapter kholta hai,
 * API tabhi photos ke link laati hai. Isse MongoDB chhota rehta hai.
 *
 * MANGA_MODE (animesalt wale MODE se alag):
 *   test : sirf TEST_SLUGS wale manga scrape karke bot pe poori detail bhejta hai (check ke liye)
 *   count: sitemap se sirf ginti bata deta hai (DB ko nahi chhoota)
 *   run  : poora kaam + watcher (default)
 */
'use strict';
require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const { MongoClient } = require('mongodb');
const pLimit = require('p-limit');

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const MONGO_URI = env('MONGO_URI', '');
const DB_NAME = env('DB_NAME', 'animedb');
const BASE = env('MANGA_BASE', 'https://mangapark.cc').replace(/\/+$/, '');
const LANG = env('MANGA_LANG', 'en');
const LANG_NAME = env('MANGA_LANG_NAME', 'English');
const MODE = env('MANGA_MODE', 'run').toLowerCase();
const TEST_SLUGS = String(env('TEST_SLUGS', 'naruto-official-colored,rise-of-the-limitless-necromancer')).split(/[\s,]+/).filter(Boolean);
const CONC_TITLES = +env('CONCURRENCY_TITLES', 3);
const CONC_WALK = +env('CONCURRENCY_WALK', 4);
const DELAY_MS = +env('DELAY_MS', 300);
const WATCH_MINUTES = +env('WATCH_MINUTES', 60);
const REPORT_MINUTES = +env('REPORT_MINUTES', 60);
const MAX_WALK = +env('MAX_WALK', 3000);
const TG_TOKENS = String(env('TG_BOT_TOKEN', '')).split(/[\s,]+/).filter(Boolean);
const TG_TOKEN = TG_TOKENS[0] || '';
const TG_CHAT = env('TG_CHAT_ID', '');
const ADULT = new Set(String(env('ADULT_GENRES', 'Mature,Sexual Violence,Smut,Hentai,Adult')).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';

const PV = 2; // parser version: badla to purane manga dobara padhe jayenge
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fmtN = (n) => Number(n || 0).toLocaleString('en-IN');

/* ---------------- http ---------------- */
const http = axios.create({
  timeout: 25000,
  maxRedirects: 5,
  headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  responseType: 'text',
  transformResponse: (d) => d,
  validateStatus: (s) => s >= 200 && s < 300,
});
const stats = {
  req: 0, errors: 0, errLog: [], newManga: 0, newChapters: 0, started: Date.now(), lastSync: 0,
  phase: 'starting', siteCount: 0, jobsTotal: 0, jobsDone: 0, jobsStarted: 0, walkTotal: 0, walkDone: 0,
  newList: [], // naye manga / chapters ke naam, notification ke liye
};
const fmtDur = (ms) => {
  const min = ms / 60000;
  if (!isFinite(min) || min < 0) return '-';
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h}h ${Math.round(min % 60)}m` : `${Math.round(h / 24)} days`;
};

async function get(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      stats.req++;
      const r = await http.get(url);
      const body = String(r.data || '');
      if (/<title>\s*(Just a moment|Attention Required)/i.test(body)) throw Object.assign(new Error('blocked'), { blocked: true });
      await sleep(DELAY_MS + Math.random() * 150);
      return body;
    } catch (e) {
      const st = e.response && e.response.status;
      if (st === 404 || st === 410) throw Object.assign(new Error('404'), { notFound: true });
      if (i === tries - 1) throw e;
      const slow = e.blocked || st === 429 || st === 403 || st === 503;
      const wait = slow ? 20000 * (i + 1) : 1500 * 2 ** i;
      log(`retry ${i + 1} (${st || e.message}) ${url} wait ${wait}ms`);
      await sleep(wait);
    }
  }
}

/* ---------------- telegram ---------------- */
async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  const s = String(text);
  for (let i = 0; i < s.length; i += 3800) {
    for (const tk of TG_TOKENS) {
      try {
        await axios.post(`https://api.telegram.org/bot${tk}/sendMessage`,
          { chat_id: TG_CHAT, text: s.slice(i, i + 3800), disable_web_page_preview: true }, { timeout: 20000 });
      } catch (e) { log('telegram failed', e.message); }
    }
  }
}
function noteError(kind, id, e) {
  stats.errors++;
  const msg = `${kind} ${id}: ${(e && e.message) || e}`.slice(0, 200);
  stats.errLog.push({ at: Date.now(), msg });
  if (stats.errLog.length > 50) stats.errLog.shift();
  log('ERR', msg);
}

/* ---------------- sitemap ---------------- */
function locs(xml) {
  const out = [];
  const re = /<url>([\s\S]*?)<\/url>/g; let m;
  while ((m = re.exec(xml))) {
    const loc = (/<loc>\s*([^<\s]+)\s*<\/loc>/.exec(m[1]) || [])[1];
    const lastmod = (/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/.exec(m[1]) || [])[1] || null;
    if (loc) out.push({ loc: loc.replace(/&amp;/g, '&'), lastmod });
  }
  return out;
}
function slugOf(url) {
  const m = /\/manga\/([^/?#]+)\/?$/.exec(url);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
}
async function sitemapManga() {
  const idx = await get(`${BASE}/sitemap.xml`);
  const maps = [...idx.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]).filter((u) => /\/sitemap\/manga-\d+\.xml/.test(u));
  const all = new Map();
  for (const u of maps) {
    const xml = await get(u);
    for (const { loc, lastmod } of locs(xml)) {
      const slug = slugOf(loc);
      if (slug && !all.has(slug)) all.set(slug, lastmod);
    }
  }
  return { maps: maps.length, list: [...all].map(([slug, lastmod]) => ({ slug, lastmod })) };
}

/* ---------------- parsing ---------------- */
const enc = (s) => encodeURIComponent(s);
const readRe = (slug) => new RegExp('^/read/' + enc(slug).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/' + LANG + '/([^/?#]+)/?$', 'i');
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
function chapNum(key, text) {
  const m = /chapter-([\d]+(?:\.\d+)?)/i.exec(key) || /(?:ch(?:apter)?\.?\s*)([\d]+(?:\.\d+)?)/i.exec(text || '');
  return m ? parseFloat(m[1]) : null;
}
function pathOf(href) {
  try { return new URL(href, BASE).pathname; } catch (e) { return ''; }
}
function chapterLinks($, slug) {
  const re = readRe(slug), seen = new Map();
  $('a[href]').each((i, a) => {
    const href = $(a).attr('href'); const p = pathOf(href);
    let m = re.exec(p); if (!m) { try { m = re.exec(decodeURI(p)); } catch (e) { m = null; } }
    if (!m) return;
    const key = m[1]; const text = clean($(a).text());
    if (!seen.has(key)) seen.set(key, { key, text, pos: i });
    else if (text.length > seen.get(key).text.length) seen.get(key).text = text;
  });
  return [...seen.values()];
}
function field(text, label, re) {
  const m = new RegExp(label + '\\s*:?\\s*' + re, 'i').exec(text);
  return m ? m[1] : null;
}
function parseManga(html, slug) {
  const $ = cheerio.load(html);
  const meta = (n) => $(`meta[property="${n}"]`).attr('content') || $(`meta[name="${n}"]`).attr('content') || '';
  let title = clean($('h1').first().text()) || clean(meta('og:title'));
  title = title.replace(/\s*[-|–]\s*(read|manga\s*park).*$/i, '').replace(/^read\s+/i, '').trim();
  const body = clean($('body').text());
  const inChrome = (a) => $(a).closest('header,nav,footer').length > 0;
  const genres = [...new Set($('a[href*="/genre/"]').filter((i, a) => !inChrome(a)).map((i, a) => clean($(a).text())).get().filter(Boolean))];
  const authors = [...new Set($('a[href*="/author/"]').filter((i, a) => !inChrome(a)).map((i, a) => clean($(a).text())).get().filter(Boolean))];
  const type = field(body, 'Type', '(Manga|Manhwa|Manhua|Webtoon|Comic|Doujinshi|One[- ]?shot|Novel)');
  const desc = clean(meta('og:description') || meta('description'));
  const dm = /\bis an?\s+(completed|ongoing|hiatus|cancelled|discontinued)\b/i.exec(desc);
  const status = field(body, '(?:Status|Original Publication|Publication)', '(Ongoing|Completed|Hiatus|Cancelled|Discontinued|On Hold)')
    || (dm ? dm[1].charAt(0).toUpperCase() + dm[1].slice(1).toLowerCase() : null);
  if (!authors.length) { const am = /\bby\s+([^,.]+?)(?:,|\.|\s+tagged)/i.exec(desc); if (am) authors.push(clean(am[1])); }
  let gl = genres.length > 40 ? [] : genres;
  if (!gl.length) { const tm = /\btagged\s+([^.]+)\./i.exec(desc); if (tm) gl = tm[1].split(/,|\band\b/).map(clean).filter(Boolean); }
  const year = field(body, '(?:Published|Released|Year)', '(\\d{4})');
  const enCount = (new RegExp(LANG_NAME + '\\s*\\((\\d[\\d,]*)\\s*Chapters?\\)', 'i').exec(body) || [])[1];
  let cover = meta('og:image');
  if (!cover) { const im = $('img[src*="/cover/"]').first().attr('src'); if (im) cover = im; }
  const chapters = chapterLinks($, slug);
  return {
    title: title || slug,
    cover: cover ? new URL(cover, BASE).href : null,
    description: desc.slice(0, 2000),
    genres: gl, // 40+ matlab menu pakda gaya, galat
    genresSuspicious: genres.length > 40,
    authors,
    type: type ? type.replace(/one[- ]?shot/i, 'Oneshot') : null,
    status: status || null,
    year: year ? +year : null,
    enCount: enCount ? +String(enCount).replace(/,/g, '') : null,
    chapters,
  };
}
function parseChapterNav(html, slug, curKey) {
  const $ = cheerio.load(html), re = readRe(slug);
  let prev = null;
  $('a[href]').each((i, a) => {
    if (prev) return;
    const t = clean($(a).text());
    if (!/prev/i.test(t)) return;
    const m = re.exec(pathOf($(a).attr('href')));
    if (m && m[1] !== curKey) prev = { key: m[1], text: t };
  });
  const pages = (/(\d+)\s*pages?\b/i.exec(clean($('body').text())) || [])[1];
  return { prev, pages: pages ? +pages : null };
}

/* ---------------- db ---------------- */
let db, M, C;
async function initDb() {
  const cli = new MongoClient(MONGO_URI, { maxPoolSize: 10 });
  await cli.connect();
  db = cli.db(DB_NAME);
  M = db.collection('manga'); C = db.collection('manga_chapters');
  await Promise.all([
    M.createIndex({ state: 1 }), M.createIndex({ live: 1, updatedAt: -1 }), M.createIndex({ title: 1 }),
    C.createIndex({ slug: 1, num: 1 }), C.createIndex({ firstSeen: -1 }),
  ]);
}

async function saveManga(slug, info, lastmod) {
  const before = await C.countDocuments({ slug });
  const now = new Date();
  if (info.chapters.length) {
    await C.bulkWrite(info.chapters.map((c) => ({
      updateOne: {
        filter: { _id: `${slug}|${c.key}` },
        update: { $setOnInsert: { slug, key: c.key, num: chapNum(c.key, c.text), title: c.text.slice(0, 200), firstSeen: now } },
        upsert: true,
      },
    })), { ordered: false });
  }
  const after = await C.countDocuments({ slug });
  const added = after - before;
  const genresLc = info.genres.map((g) => g.toLowerCase());
  const needWalk = info.enCount != null && after < info.enCount;
  const set = {
    title: info.title, cover: info.cover, description: info.description, genres: info.genres, authors: info.authors,
    type: info.type, status: info.status, year: info.year, enCount: info.enCount,
    adult: genresLc.some((g) => ADULT.has(g)), doujinshi: genresLc.includes('doujinshi') || /doujin/i.test(info.type || ''),
    chapterCount: after, hasLang: after > 0 || (info.enCount || 0) > 0,
    live: after > 0, siteLastmod: lastmod || null, scrapedAt: now, pv: PV,
    listedLast: info.chapters.length ? info.chapters[info.chapters.length - 1].key : null,
    state: needWalk ? 'walk' : 'done',
  };
  if (added > 0) set.updatedAt = now;
  if (info.genresSuspicious) set.genresSuspicious = true;
  await M.updateOne({ _id: slug }, { $set: set, $setOnInsert: { firstSeen: now } }, { upsert: true });
  return { added, total: after, needWalk };
}

async function doManga(slug, lastmod, isNew) {
  try {
    const html = await get(`${BASE}/manga/${enc(slug)}`);
    const info = parseManga(html, slug);
    const r = await saveManga(slug, info, lastmod);
    if (isNew && r.total > 0) { stats.newManga++; stats.newList.push(`📖 ${info.title} (new, ${r.total} chapters)`); }
    else if (!isNew && r.added > 0) { stats.newChapters += r.added; stats.newList.push(`➕ ${info.title}: ${r.added} new chapter${r.added === 1 ? '' : 's'}`); }
    if (stats.newList.length > 200) stats.newList.shift();
    // lambi chapter list (walk) yahan nahi: pehle saare manga, phir sync ke doosre hisse mein walk
    return { info, ...r };
  } catch (e) {
    if (e.notFound) { await M.updateOne({ _id: slug }, { $set: { state: 'gone', live: false } }); return null; }
    await M.updateOne({ _id: slug }, { $set: { state: 'error', lastError: String(e.message).slice(0, 200) }, $inc: { tries: 1 } });
    noteError('manga', slug, e);
    return null;
  }
}

/* adhoori list: sabse purane chapter se "Prev Chapter" pakad ke peeche jao */
async function walk(slug) {
  const m = await M.findOne({ _id: slug }, { projection: { enCount: 1, walkFrom: 1, listedLast: 1 } });
  let cur = (m && (m.walkFrom || m.listedLast)) || null;
  let steps = 0;
  while (cur && steps++ < MAX_WALK) {
    let nav;
    try { nav = parseChapterNav(await get(`${BASE}/read/${enc(slug)}/${LANG}/${enc(cur)}`), slug, cur); }
    catch (e) { noteError('walk', `${slug}/${cur}`, e); break; }
    if (!nav.prev) { cur = null; break; }
    const id = `${slug}|${nav.prev.key}`;
    if (await C.findOne({ _id: id }, { projection: { _id: 1 } })) { cur = null; break; } // yahan se aage sab pehle se hai
    await C.insertOne({ _id: id, slug, key: nav.prev.key, num: chapNum(nav.prev.key, nav.prev.text), title: 'Chapter ' + (chapNum(nav.prev.key) ?? ''), firstSeen: new Date() });
    cur = nav.prev.key;
    if (steps % 20 === 0) await M.updateOne({ _id: slug }, { $set: { walkFrom: cur } }); // restart pe yahin se
  }
  await M.updateOne({ _id: slug }, cur ? { $set: { walkFrom: cur } } : { $unset: { walkFrom: '' } });
  const total = await C.countDocuments({ slug });
  const done = !cur || !m || m.enCount == null || total >= m.enCount; // peeche tak pahunch gaye = poora
  await M.updateOne({ _id: slug }, { $set: { chapterCount: total, live: total > 0, state: done ? 'done' : 'partial' } });
  return total;
}

/* ---------------- sync ---------------- */
let syncing = false;
async function sync(first) {
  if (syncing) return; syncing = true;
  try {
    const { maps, list } = await sitemapManga();
    log(`sitemap: ${maps} files, ${list.length} manga`);
    const known = new Map((await M.find({}, { projection: { siteLastmod: 1, state: 1, pv: 1 } }).toArray()).map((d) => [d._id, d]));
    const jobs = [];
    for (const { slug, lastmod } of list) {
      const k = known.get(slug);
      if (!k) jobs.push({ slug, lastmod, isNew: !first });
      else if (k.state !== 'done' && k.state !== 'gone') jobs.push({ slug, lastmod, isNew: false });
      else if (k.state === 'done' && k.pv !== PV) jobs.push({ slug, lastmod, isNew: false });
      else if (lastmod && k.siteLastmod !== lastmod) jobs.push({ slug, lastmod, isNew: false });
    }
    log(`kaam: ${jobs.length} manga`);
    stats.siteCount = list.length;
    if (first) {
      await tg([
        '📚 MANGA | SYNC STARTED',
        `Source: MangaPark (${LANG_NAME} chapters only)`,
        `Titles on site: ${fmtN(list.length)} (from ${maps} sitemap files)`,
        `Already up to date: ${fmtN(list.length - jobs.length)}`,
        `To process now: ${fmtN(jobs.length)}`,
        '',
        `Progress reports every ${REPORT_MINUTES} min. Send /manga anytime for a live report.`,
      ].join('\n'));
    }
    stats.phase = 'titles'; stats.jobsTotal = jobs.length; stats.jobsDone = 0; stats.jobsStarted = Date.now();
    const lim = pLimit(CONC_TITLES);
    await Promise.all(jobs.map((j) => lim(() => doManga(j.slug, j.lastmod, j.isNew).finally(() => { stats.jobsDone++; }))));
    stats.phase = 'chapters';
    // 'partial' wale dobara walk
    const partial = await M.find({ state: { $in: ['walk', 'partial'] } }, { projection: { _id: 1 } }).toArray();
    stats.walkTotal = partial.length; stats.walkDone = 0;
    const wl = pLimit(CONC_WALK);
    await Promise.all(partial.map((p) => wl(() => walk(p._id).catch((e) => noteError('walk', p._id, e)).finally(() => { stats.walkDone++; }))));
    stats.phase = 'idle';
    stats.lastSync = Date.now();
  } catch (e) { noteError('sync', '-', e); }
  finally { syncing = false; }
}

async function statusText() {
  if (!M) throw new Error('not started yet');
  const [total, live, done, todo, part, err, gone, noLang, adult, dj, chaps, types] = await Promise.all([
    M.countDocuments({}), M.countDocuments({ live: true }), M.countDocuments({ state: 'done' }),
    M.countDocuments({ state: { $in: ['walk', null] } }), M.countDocuments({ state: 'partial' }),
    M.countDocuments({ state: 'error' }), M.countDocuments({ state: 'gone' }),
    M.countDocuments({ state: 'done', live: false }), M.countDocuments({ adult: true, live: true }),
    M.countDocuments({ doujinshi: true, live: true }), C.estimatedDocumentCount(),
    M.aggregate([{ $match: { live: true } }, { $group: { _id: '$type', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray(),
  ]);
  const hr = Date.now() - 3600e3;
  const errs = stats.errLog.filter((e) => e.at > hr);
  const PH = { starting: 'Starting', titles: 'Scraping titles', chapters: 'Completing chapter lists', idle: 'Idle (watching for new chapters)' };
  let progress = '';
  if (stats.phase === 'titles' && stats.jobsTotal) {
    const pct = (stats.jobsDone / stats.jobsTotal) * 100;
    const el = Date.now() - stats.jobsStarted;
    const eta = stats.jobsDone ? fmtDur((el / stats.jobsDone) * (stats.jobsTotal - stats.jobsDone)) : '-';
    progress = `• Progress: ${fmtN(stats.jobsDone)} of ${fmtN(stats.jobsTotal)} (${pct.toFixed(1)}%) | ETA: ${eta}`;
  } else if (stats.phase === 'chapters' && stats.walkTotal) {
    progress = `• Long chapter lists: ${fmtN(stats.walkDone)} of ${fmtN(stats.walkTotal)} done`;
  }
  const typeLine = types.filter((t) => t._id).map((t) => `${t._id} ${fmtN(t.n)}`).join(' | ');
  return [
    '📚 MANGA CATALOG | STATUS REPORT',
    `Source: MangaPark (${LANG_NAME})`,
    `Phase: ${PH[stats.phase] || stats.phase}`,
    `Uptime: ${fmtDur(Date.now() - stats.started)}`,
    ...(progress ? [progress] : []),
    '',
    '📖 TITLES',
    `• On site: ${fmtN(stats.siteCount || total)} | In database: ${fmtN(total)}`,
    `• Live in Mini App: ${fmtN(live)}`,
    `• Complete: ${fmtN(done)} | Queued: ${fmtN(todo)} | Chapter list in progress: ${fmtN(part)}`,
    `• Errors: ${fmtN(err)} | Removed from site: ${fmtN(gone)} | No ${LANG_NAME} chapters: ${fmtN(noLang)}`,
    `• 18+: ${fmtN(adult)} | Doujinshi: ${fmtN(dj)}`,
    ...(typeLine ? [`• By type: ${typeLine}`] : []),
    '',
    '📄 CHAPTERS',
    `• Total in database: ${fmtN(chaps)}`,
    `• New since start: ${fmtN(stats.newManga)} titles | ${fmtN(stats.newChapters)} chapters`,
    '',
    '🩺 HEALTH',
    `• Requests sent: ${fmtN(stats.req)} | Errors in the last hour: ${errs.length}`,
    ...(errs.slice(-5).map((e) => '   - ' + e.msg)),
    `• Last full sync: ${stats.lastSync ? fmtDur(Date.now() - stats.lastSync) + ' ago' : 'in progress'}`,
  ].join('\n');
}

/* ---------------- modes ---------------- */
async function testMode() {
  for (const slug of TEST_SLUGS) {
    let out;
    try {
      const html = await get(`${BASE}/manga/${enc(slug)}`);
      const info = parseManga(html, slug);
      const sorted = [...info.chapters].sort((a, b) => (a.num ?? 0) - (b.num ?? 0));
      let nav = null;
      const last = info.chapters[info.chapters.length - 1];
      if (last) nav = parseChapterNav(await get(`${BASE}/read/${enc(slug)}/${LANG}/${enc(last.key)}`), slug, last.key);
      out = [
        `🧪 MANGA | TEST REPORT`,
        `Slug: ${slug}`,
        '',
        `Title: ${info.title}`,
        `Type: ${info.type || '-'} | Status: ${info.status || '-'} | Year: ${info.year || '-'}`,
        `Author: ${info.authors.join(', ') || '-'}`,
        `Genres (${info.genres.length})${info.genresSuspicious ? ' ⚠️ site menu detected, ignored' : ''}: ${info.genres.join(', ') || '-'}`,
        `18+: ${info.genres.some((g) => ADULT.has(g.toLowerCase())) ? 'Yes' : 'No'}`,
        `Cover: ${info.cover || '-'}`,
        `Description: ${(info.description || '-').slice(0, 200)}`,
        '',
        `${LANG_NAME} chapters on site: ${info.enCount ?? 'unknown'}`,
        `Chapters listed on the page: ${info.chapters.length}`,
        `Range found: ${sorted[0] ? sorted[0].key : '-'} to ${sorted.length ? sorted[sorted.length - 1].key : '-'}`,
        `Previous chapter link from the oldest listed chapter: ${nav && nav.prev ? nav.prev.key : 'not found'} (${nav && nav.pages ? nav.pages + ' pages' : 'page count unknown'})`,
        info.enCount && info.chapters.length < info.enCount
          ? `➡️ The page lists only part of the chapters. In run mode the worker follows "Previous chapter" links to collect the remaining ${info.enCount - info.chapters.length}.`
          : '✅ Full chapter list found on the page.',
      ].join('\n');
    } catch (e) { out = `🧪 MANGA | TEST REPORT\nSlug: ${slug}\n❌ Failed: ${e.message}`; }
    log('\n' + out);
    await tg(out);
  }
}

async function main() {
  if (MODE === 'count') {
    const { maps, list } = await sitemapManga();
    const msg = `📚 MANGA | SITE COUNT\nMangaPark sitemap: ${fmtN(list.length)} titles in ${maps} files`;
    log(msg); await tg(msg); return;
  }
  if (MODE === 'test') { await testMode(); return; }
  if (!MONGO_URI) throw new Error('MONGO_URI is not set');
  await initDb();
  await tg(`🚀 Manga worker started (database: ${DB_NAME}, source: MangaPark, language: ${LANG_NAME}).`);
  // idle mein report nahi (sirf naya content aane pe message); /manga se kabhi bhi
  setInterval(async () => { if (stats.phase === 'idle') return; try { await tg(await statusText()); } catch (e) { log('report', e.message); } }, REPORT_MINUTES * 60e3);
  await sync(true);
  await tg('✅ MANGA | FULL SYNC COMPLETE\n\n' + await statusText());
  stats.newManga = 0; stats.newChapters = 0; stats.newList = [];
  for (;;) {
    await sleep(WATCH_MINUTES * 60e3);
    const a = stats.newManga, b = stats.newChapters, k = stats.newList.length;
    await sync(false);
    if (stats.newManga > a || stats.newChapters > b) {
      const items = stats.newList.slice(k);
      await tg([
        '🆕 MANGA | NEW CONTENT',
        `New titles: ${stats.newManga - a} | New chapters: ${stats.newChapters - b}`,
        '',
        ...items.slice(0, 25),
        ...(items.length > 25 ? [`...and ${items.length - 25} more`] : []),
      ].join('\n'));
    }
  }
}

if (require.main === module) {
  main().then(() => { if (MODE !== 'run') process.exit(0); }).catch(async (e) => {
    log('FATAL', e); await tg('❌ Manga worker stopped: ' + e.message); process.exit(1);
  });
}
// index.js ke andar se chalane ke liye: error aaye to bhi animesalt scraper band nahi hota
function start() {
  main().catch(async (e) => { log('MANGA FATAL', e && e.message); await tg('❌ Manga worker stopped: ' + (e && e.message) + '\nThe anime scraper keeps running.'); });
}
module.exports = { start, statusText, parseManga, parseChapterNav, locs, slugOf, chapNum };
