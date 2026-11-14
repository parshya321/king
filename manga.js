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
const CONC_WALK = +env('CONCURRENCY_WALK', 3);
const DELAY_MS = +env('DELAY_MS', 300);
const WATCH_MINUTES = +env('WATCH_MINUTES', 60);
const REPORT_MINUTES = +env('REPORT_MINUTES', 60);
const MAX_WALK = +env('MAX_WALK', 3000);
const TG_TOKEN = env('TG_BOT_TOKEN', '');
const TG_CHAT = env('TG_CHAT_ID', '');
const ADULT = new Set(String(env('ADULT_GENRES', 'Mature,Sexual Violence,Smut,Hentai,Adult')).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';

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
const stats = { req: 0, errors: 0, errLog: [], newManga: 0, newChapters: 0, started: Date.now(), lastSync: 0 };

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
    try {
      await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
        { chat_id: TG_CHAT, text: s.slice(i, i + 3800), disable_web_page_preview: true }, { timeout: 20000 });
    } catch (e) { log('telegram failed', e.message); }
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
  const inChrome = (a) => $(a).closest('header,nav,footer,aside,[class*="menu"],[class*="nav"],[class*="dropdown"]').length > 0;
  const genres = [...new Set($('a[href*="/genre/"]').filter((i, a) => !inChrome(a)).map((i, a) => clean($(a).text())).get().filter(Boolean))];
  const authors = [...new Set($('a[href*="/author/"]').filter((i, a) => !inChrome(a)).map((i, a) => clean($(a).text())).get().filter(Boolean))];
  const type = field(body, 'Type', '(Manga|Manhwa|Manhua|Webtoon|Comic|Doujinshi|One[- ]?shot|Novel)');
  const status = field(body, 'Status', '(Ongoing|Completed|Hiatus|Cancelled|Discontinued|On Hold)');
  const year = field(body, '(?:Published|Released|Year)', '(\\d{4})');
  const enCount = (new RegExp(LANG_NAME + '\\s*\\((\\d[\\d,]*)\\s*Chapters?\\)', 'i').exec(body) || [])[1];
  let cover = meta('og:image');
  if (!cover) { const im = $('img[src*="/cover/"]').first().attr('src'); if (im) cover = im; }
  const chapters = chapterLinks($, slug);
  return {
    title: title || slug,
    cover: cover ? new URL(cover, BASE).href : null,
    description: clean(meta('og:description') || meta('description')).slice(0, 2000),
    genres: genres.length > 40 ? [] : genres, // 40+ matlab menu pakda gaya, galat
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
    live: after > 0, siteLastmod: lastmod || null, scrapedAt: now,
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
    if (isNew && r.total > 0) stats.newManga++;
    else if (!isNew) stats.newChapters += r.added;
    if (r.needWalk) await walk(slug);
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
  const m = await M.findOne({ _id: slug }, { projection: { enCount: 1 } });
  let steps = 0;
  for (;;) {
    const oldest = await C.find({ slug, num: { $ne: null } }).sort({ num: 1 }).limit(1).next()
      || await C.find({ slug }).sort({ firstSeen: 1 }).limit(1).next();
    if (!oldest || steps++ > MAX_WALK) break;
    let nav;
    try { nav = parseChapterNav(await get(`${BASE}/read/${enc(slug)}/${LANG}/${enc(oldest.key)}`), slug, oldest.key); }
    catch (e) { noteError('walk', `${slug}/${oldest.key}`, e); break; }
    if (!nav.prev) break;
    const id = `${slug}|${nav.prev.key}`;
    if (await C.findOne({ _id: id }, { projection: { _id: 1 } })) break; // pehle se hai: aage gap nahi
    await C.insertOne({ _id: id, slug, key: nav.prev.key, num: chapNum(nav.prev.key, nav.prev.text), title: 'Chapter ' + (chapNum(nav.prev.key) ?? ''), firstSeen: new Date() });
  }
  const total = await C.countDocuments({ slug });
  const done = !m || m.enCount == null || total >= m.enCount;
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
    const known = new Map((await M.find({}, { projection: { siteLastmod: 1, state: 1 } }).toArray()).map((d) => [d._id, d]));
    const jobs = [];
    for (const { slug, lastmod } of list) {
      const k = known.get(slug);
      if (!k) jobs.push({ slug, lastmod, isNew: !first });
      else if (k.state !== 'done' && k.state !== 'gone') jobs.push({ slug, lastmod, isNew: false });
      else if (lastmod && k.siteLastmod !== lastmod) jobs.push({ slug, lastmod, isNew: false });
    }
    log(`kaam: ${jobs.length} manga`);
    if (first) await tg(`📚 Manga worker: sitemap mein ${fmtN(list.length)} manga mile. Abhi ${fmtN(jobs.length)} scrape honge.`);
    const lim = pLimit(CONC_TITLES);
    await Promise.all(jobs.map((j) => lim(() => doManga(j.slug, j.lastmod, j.isNew))));
    // 'partial' wale dobara walk
    const partial = await M.find({ state: { $in: ['walk', 'partial'] } }, { projection: { _id: 1 } }).toArray();
    const wl = pLimit(CONC_WALK);
    await Promise.all(partial.map((p) => wl(() => walk(p._id).catch((e) => noteError('walk', p._id, e)))));
    stats.lastSync = Date.now();
  } catch (e) { noteError('sync', '-', e); }
  finally { syncing = false; }
}

async function statusText() {
  const [total, live, done, todo, part, err, gone, noLang, adult, dj, chaps] = await Promise.all([
    M.countDocuments({}), M.countDocuments({ live: true }), M.countDocuments({ state: 'done' }),
    M.countDocuments({ state: { $in: ['walk', null] } }), M.countDocuments({ state: 'partial' }),
    M.countDocuments({ state: 'error' }), M.countDocuments({ state: 'gone' }),
    M.countDocuments({ state: 'done', live: false }), M.countDocuments({ adult: true, live: true }),
    M.countDocuments({ doujinshi: true, live: true }), C.estimatedDocumentCount(),
  ]);
  const hr = Date.now() - 3600e3;
  const errs = stats.errLog.filter((e) => e.at > hr);
  return [
    '📚 MANGA STATUS',
    `Manga DB mein: ${fmtN(total)} | Live (${LANG_NAME} chapters wale): ${fmtN(live)}`,
    `Done: ${fmtN(done)} | Adhoori list: ${fmtN(part)} | Error: ${fmtN(err)} | Site se hata: ${fmtN(gone)}`,
    `${LANG_NAME} chapter nahi: ${fmtN(noLang)} | 18+: ${fmtN(adult)} | Doujinshi: ${fmtN(dj)}`,
    `Chapters: ${fmtN(chaps)}`,
    `Naye (is run mein): manga ${fmtN(stats.newManga)} | chapters ${fmtN(stats.newChapters)}`,
    `Requests: ${fmtN(stats.req)} | Errors pichhle 1 ghante: ${errs.length}`,
    ...(errs.slice(-5).map((e) => '  • ' + e.msg)),
    `Last sync: ${stats.lastSync ? Math.round((Date.now() - stats.lastSync) / 60000) + ' min pehle' : 'chal raha hai'}`,
    `Baaki kaam: ${fmtN(todo)}`,
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
        `🧪 TEST: ${slug}`,
        `Naam: ${info.title}`,
        `Type: ${info.type} | Status: ${info.status} | Saal: ${info.year}`,
        `Author: ${info.authors.join(', ') || '-'}`,
        `Genres (${info.genres.length})${info.genresSuspicious ? ' ⚠️ menu pakda gaya' : ''}: ${info.genres.join(', ') || '-'}`,
        `18+: ${info.genres.some((g) => ADULT.has(g.toLowerCase())) ? 'haan' : 'nahi'}`,
        `Cover: ${info.cover || '-'}`,
        `Description: ${(info.description || '-').slice(0, 150)}`,
        `${LANG_NAME} chapters (site ke hisaab se): ${info.enCount ?? '?'} | page pe mile: ${info.chapters.length}`,
        `Pehla/aakhri mila: ${sorted[0] ? sorted[0].key : '-'} ... ${sorted.length ? sorted[sorted.length - 1].key : '-'}`,
        `Sabse purane chapter ka "Prev": ${nav && nav.prev ? nav.prev.key : 'nahi mila'} | uske pages: ${nav ? nav.pages : '-'}`,
        info.enCount && info.chapters.length < info.enCount ? '➡️ List adhoori hai, run mode mein Prev se peeche jayega.' : '✅ List poori hai.',
      ].join('\n');
    } catch (e) { out = `🧪 TEST: ${slug}\n❌ ${e.message}`; }
    log('\n' + out);
    await tg(out);
  }
}

async function main() {
  if (MODE === 'count') {
    const { maps, list } = await sitemapManga();
    const msg = `📚 MangaPark sitemap: ${maps} files, ${fmtN(list.length)} manga`;
    log(msg); await tg(msg); return;
  }
  if (MODE === 'test') { await testMode(); return; }
  if (!MONGO_URI) throw new Error('MONGO_URI nahi diya');
  await initDb();
  await tg('📚 Manga worker chalu hua.');
  setInterval(async () => { try { await tg(await statusText()); } catch (e) { log('report', e.message); } }, REPORT_MINUTES * 60e3);
  await sync(true);
  await tg('✅ Pehla manga sync poora.\n\n' + await statusText());
  stats.newManga = 0; stats.newChapters = 0;
  for (;;) {
    await sleep(WATCH_MINUTES * 60e3);
    const a = stats.newManga, b = stats.newChapters;
    await sync(false);
    if (stats.newManga > a || stats.newChapters > b) {
      await tg(`🆕 Naya manga content: ${stats.newManga - a} manga, ${stats.newChapters - b} chapters`);
    }
  }
}

if (require.main === module) {
  main().then(() => { if (MODE !== 'run') process.exit(0); }).catch(async (e) => {
    log('FATAL', e); await tg('❌ Manga worker band: ' + e.message); process.exit(1);
  });
}
// index.js ke andar se chalane ke liye: error aaye to bhi animesalt scraper band nahi hota
function start() {
  main().catch(async (e) => { log('MANGA FATAL', e && e.message); await tg('❌ Manga worker ruk gaya: ' + (e && e.message)); });
}
module.exports = { start, parseManga, parseChapterNav, locs, slugOf, chapNum };
