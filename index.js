'use strict';
/**
 * animesalt.cx -> MongoDB scraper
 *
 * MODE (env variable):
 *   count  : sitemap padhke bata deta hai kitni series / movies hain (DB nahi chahiye)
 *   test   : TEST_URLS wale kuch titles scrape karke poora data log mein dikhata hai
 *   run    : poora scrape + verify, phir watcher (har WATCH_MINUTES minute mein naya/badla dhoondhta hai)
 *   verify : sirf verification chalata hai
 *   reconcile : site ki apni list se exact total nikaalke sitemap se compare karta hai, chhoote titles queue mein daalta hai
 *   retry  : fail hue episodes dobara queue mein daalta hai
 *
 * Mismatch rokne ke rules:
 *   - Har cheez ka ID URL slug hai (naam nahi). Episode ID = "naruto-shippuden-2x37".
 *   - Season aur episode number URL se aate hain, list ki position se nahi.
 *   - Episode page ka "back to series" link series slug se match hona chahiye.
 *   - Verify step jab tak pass na ho, title "live: true" nahi hota. Mini App sirf live:true wale dikhaye.
 */
try { require('dotenv').config(); } catch (e) { /* dotenv optional on Railway */ }

const crypto = require('crypto');

const BASE = (process.env.BASE_URL || 'https://animesalt.cx').replace(/\/+$/, '');
const MODE = (process.env.MODE || 'run').toLowerCase();
const DB_NAME = process.env.DB_NAME || 'animedb';
const C_TITLES = +process.env.CONCURRENCY_TITLES || 3;
const C_EPS = +process.env.CONCURRENCY_EPISODES || 6;
const DELAY_MS = +process.env.DELAY_MS || 300;
const WATCH_MIN = +process.env.WATCH_MINUTES || 10;
const MAX_ATTEMPTS = 3;
const UA = process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uniq = (a) => [...new Set(a)];

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */
let _http;
function http() {
  if (!_http) {
    const axios = require('axios');
    _http = axios.create({
      timeout: 30000,
      maxRedirects: 5,
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      responseType: 'text',
      transformResponse: [(d) => d],
      validateStatus: (s) => s >= 200 && s < 300,
    });
  }
  return _http;
}

async function get(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await http().get(url);
      const body = typeof r.data === 'string' ? r.data : String(r.data);
      if (/<title>\s*Just a moment/i.test(body)) throw Object.assign(new Error('cloudflare_challenge'), { blocked: true });
      await sleep(DELAY_MS + Math.random() * 150);
      return body;
    } catch (e) {
      const st = e.response && e.response.status;
      if (st === 404) throw Object.assign(new Error('404 ' + url), { notFound: true });
      if (i === tries - 1) throw e;
      const blocked = e.blocked || st === 429 || st === 403 || st === 503;
      const wait = blocked ? 15000 * (i + 1) : 1500 * 2 ** i;
      log(`retry ${i + 1}/${tries - 1} (${st || e.message}) ${url} wait ${wait}ms`);
      await sleep(wait);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Telegram bot: alerts + commands (/status /errors /review /new ...)  */
/* ------------------------------------------------------------------ */
const TG_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT = String(process.env.TG_CHAT_ID || '').trim();
const REPORT_MIN = +process.env.REPORT_MINUTES || 30;
const stats = { startedAt: Date.now(), phase: 'start', lastSync: null, lastDeep: null, pendingErr: [], errorsTotal: 0, harvested: 0, firstRunDone: false, forceDeep: false };

let wakeFn = null;
const nap = (ms) => new Promise((res) => {
  const t = setTimeout(() => { wakeFn = null; res(); }, ms);
  wakeFn = () => { clearTimeout(t); wakeFn = null; res(); };
});
const wake = () => { if (wakeFn) wakeFn(); };

async function tgApi(method, payload) {
  const r = await http().post(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, payload || {}, { timeout: 40000 });
  return JSON.parse(r.data);
}
async function tgSend(text, chat) {
  const to = chat || TG_CHAT;
  if (!TG_TOKEN || !to) return;
  const s = String(text);
  for (let i = 0; i < s.length; i += 3800) {
    try { await tgApi('sendMessage', { chat_id: to, text: s.slice(i, i + 3800), disable_web_page_preview: true }); }
    catch (e) { log('telegram send failed:', e.message); }
  }
}
const notify = (text) => tgSend(text);

async function logError(db, kind, id, message) {
  const msg = String(message || '').slice(0, 300);
  stats.errorsTotal++;
  stats.pendingErr.push({ kind, id, msg });
  if (stats.pendingErr.length > 500) stats.pendingErr.shift();
  try { await db.collection('errors').insertOne({ ts: new Date(), kind, id, message: msg }); } catch (e) { /* ignore */ }
}
async function flushErrors() {
  if (!stats.pendingErr.length) return;
  const list = stats.pendingErr.splice(0);
  const byKind = {};
  for (const e of list) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  const head = Object.entries(byKind).map(([k, n]) => `${k}: ${n}`).join(', ');
  const ex = list.slice(0, 5).map((e) => `- ${e.kind} ${e.id}: ${e.msg.slice(0, 90)}`).join('\n');
  await tgSend(`⚠️ ${list.length} naye error (${head})\n${ex}${list.length > 5 ? `\n...aur ${list.length - 5}. Poori list: /errors` : ''}`);
}

const fmtDur = (min) => {
  if (!isFinite(min) || min < 0) return '?';
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h}h ${Math.round(min % 60)}m` : `${Math.round(h / 24)} din`;
};
const fmtN = (n) => Number(n).toLocaleString('en-US');

async function statusText(db) {
  const T = db.collection('titles'), E = db.collection('episodes');
  const since10 = new Date(Date.now() - 10 * 60000), since1h = new Date(Date.now() - 3600000);
  const [ts, tm, done, pend, terr, live, review, hidden, etot, edone, epend, efail, nosrv, last10, err1h, noEpTitles] = await Promise.all([
    T.countDocuments({ type: 'series', hidden: { $ne: true } }), T.countDocuments({ type: 'movie', hidden: { $ne: true } }),
    T.countDocuments({ status: 'done' }), T.countDocuments({ status: { $in: ['pending', 'listed'] }, hidden: { $ne: true } }),
    T.countDocuments({ status: 'error' }), T.countDocuments({ live: true }), T.countDocuments({ status: 'done', live: false }),
    T.countDocuments({ hidden: true }),
    E.estimatedDocumentCount(), E.countDocuments({ scraped: true }),
    E.countDocuments({ scraped: false, attempts: { $lt: MAX_ATTEMPTS } }), E.countDocuments({ scraped: false, attempts: { $gte: MAX_ATTEMPTS } }),
    E.countDocuments({ flags: 'no_servers' }), E.countDocuments({ scraped_at: { $gte: since10 } }),
    db.collection('errors').countDocuments({ ts: { $gte: since1h } }),
    T.countDocuments({ type: 'series', status: 'error', error: 'no_episode_link' }),
  ]);
  const perMin = last10 / 10;
  const eta = perMin > 0 ? fmtDur(epend / perMin) : (epend ? 'speed 0, ruka hua?' : '-');
  const d = stats.lastDeep ? stats.lastDeep.lines.join('\n  ') : 'abhi nahi hua';
  return [
    `📊 STATUS (phase: ${stats.phase})`,
    `⏱ Chal raha: ${fmtDur((Date.now() - stats.startedAt) / 60000)}`,
    ``,
    `🎬 Site ke titles mile: Series ${fmtN(ts)} | Movies ${fmtN(tm)} | hidden ${hidden}`,
    `✅ Titles complete: ${fmtN(done)} | baaki: ${fmtN(pend)} | error: ${terr}${noEpTitles ? ` (bina episode link: ${noEpTitles})` : ''}`,
    `🟢 Live (Mini App ke liye ready): ${fmtN(live)} | 🔴 review chahiye: ${fmtN(review)}`,
    ``,
    `📺 Episodes: mile ${fmtN(etot)} | scrape hue ${fmtN(edone)} | baaki ${fmtN(epend)} | fail ${fmtN(efail)} | bina server ${fmtN(nosrv)}`,
    `⚡ Speed: ${perMin.toFixed(1)} episode/min (pichhle 10 min) | ETA: ${eta}`,
    ``,
    `⚠️ Errors: pichhle 1 ghante ${err1h} | start se ${stats.errorsTotal}`,
    `🔗 Nayi titles related links se mili: ${stats.harvested}`,
    `🔎 Last deep discovery:\n  ${d}`,
    `🔄 Last sync: ${stats.lastSync ? fmtDur((Date.now() - stats.lastSync) / 60000) + ' pehle' : 'abhi nahi'}`,
  ].join('\n');
}

const HELP = [
  'Commands:',
  '/status  : kitna data aaya, speed, ETA, errors',
  '/errors  : aakhri errors aur kitne kis type ke',
  '/review  : jo titles verify mein fail hue (wajah ke saath)',
  '/new     : site pe naye mile titles / badle links',
  '/discover: site ko dobara poora khangalo (nayi titles dhundo)',
  '/retry   : fail hue episodes/titles dobara try karo',
  '/id      : apni chat ID',
].join('\n');

async function handleCommand(db, text, chatId) {
  const cmd = text.trim().split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
  const T = db.collection('titles'), E = db.collection('episodes');
  if (cmd === '/start' || cmd === '/help') return tgSend(HELP, chatId);
  if (cmd === '/id') return tgSend(`Chat ID: ${chatId}`, chatId);
  if (cmd === '/status') return tgSend(await statusText(db), chatId);
  if (cmd === '/errors') {
    const last = await db.collection('errors').find({}).sort({ ts: -1 }).limit(15).toArray();
    const by = await db.collection('errors').aggregate([{ $match: { ts: { $gte: new Date(Date.now() - 86400000) } } }, { $group: { _id: '$kind', n: { $sum: 1 } } }]).toArray();
    const head = by.length ? by.map((x) => `${x._id}: ${x.n}`).join(', ') : 'koi nahi';
    const body = last.map((e) => `${e.ts.toISOString().slice(11, 16)} ${e.kind} ${e.id}\n   ${e.message.slice(0, 110)}`).join('\n');
    return tgSend(`⚠️ Errors (24 ghante): ${head}\n\n${body || 'Abhi koi error nahi 🎉'}`, chatId);
  }
  if (cmd === '/review') {
    const n = await T.countDocuments({ status: 'done', live: false });
    const list = await T.find({ status: 'done', live: false }).sort({ verified_at: -1 }).limit(15).toArray();
    const body = list.map((t) => `${t.type}:${t.slug}\n   ${(t.errors || []).join(', ').slice(0, 120)}`).join('\n');
    return tgSend(`🔴 Review chahiye: ${n}\n\n${body || 'Sab theek hai ✅'}`, chatId);
  }
  if (cmd === '/new') {
    const list = await T.find({}).sort({ first_seen: -1 }).limit(10).toArray();
    const ch = await E.find({ link_changed_at: { $exists: true } }).sort({ link_changed_at: -1 }).limit(5).toArray();
    return tgSend(`🆕 Latest titles:\n${list.map((t) => `- ${t.type}:${t.slug} (${t.status})`).join('\n')}\n\n🔁 Links badle:\n${ch.map((e) => `- ${e._id}`).join('\n') || 'koi nahi'}`, chatId);
  }
  if (cmd === '/discover') {
    stats.forceDeep = true; wake();
    return tgSend('🔎 Deep discovery queue mein hai. Agar abhi scrape chal raha hai to wo khatam hote hi shuru hogi.', chatId);
  }
  if (cmd === '/retry') {
    const a = await E.updateMany({ scraped: false, attempts: { $gte: MAX_ATTEMPTS } }, { $set: { attempts: 0 } });
    const b = await T.updateMany({ status: 'error' }, { $set: { attempts: 0 } });
    wake();
    return tgSend(`🔁 Dobara try: ${a.modifiedCount} episodes, ${b.modifiedCount} titles.`, chatId);
  }
  return tgSend('Samjha nahi. /help dekho.', chatId);
}

async function tgLoop(db) {
  let offset = 0;
  log('telegram bot sun raha hai');
  for (;;) {
    try {
      const r = await tgApi('getUpdates', { timeout: 25, offset, allowed_updates: ['message'] });
      for (const u of r.result || []) {
        offset = u.update_id + 1;
        const m = u.message;
        if (!m || !m.text) continue;
        const chatId = String(m.chat.id);
        if (!TG_CHAT) { // TG_CHAT_ID abhi set nahi: sirf chat ID bata do
          if (/^\/(id|start)/i.test(m.text)) await tgSend(`Tumhari chat ID: ${chatId}\nIse Railway Variables mein TG_CHAT_ID naam se daalo aur redeploy karo.`, chatId);
          continue;
        }
        if (chatId !== TG_CHAT) continue; // koi aur bot use na kar sake
        try { await handleCommand(db, m.text, chatId); } catch (e) { await tgSend('Command error: ' + e.message, chatId); }
      }
    } catch (e) {
      const st = e.response && e.response.status;
      log('telegram poll error:', st || e.message);
      await sleep(st === 409 ? 15000 : 5000);
    }
  }
}

async function reporterLoop(db) {
  let lastReport = 0;
  for (;;) {
    await sleep(5 * 60 * 1000);
    try {
      await flushErrors();
      if (stats.phase !== 'idle' && Date.now() - lastReport >= REPORT_MIN * 60000) {
        await tgSend(await statusText(db));
        lastReport = Date.now();
      }
    } catch (e) { log('reporter error:', e.message); }
  }
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
function decode(s) {
  return String(s == null ? '' : s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => (ENT[n.toLowerCase()] !== undefined ? ENT[n.toLowerCase()] : m))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const dec = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };
const attr = (tag, name) => {
  const m = String(tag).match(new RegExp('(?:^|\\s)' + name + '="([^"]*)"', 'i'));
  return m ? m[1] : null;
};
const normImg = (u) => (u ? (u.startsWith('//') ? 'https:' + u : u) : null);

function slugOf(url) {
  const m = String(url).match(/\/(series|movies|episode)\/([^/?#]+)/);
  return m ? { kind: m[1], slug: dec(m[2]).toLowerCase() } : null;
}
function epSlugParts(slug) {
  const m = String(slug).match(/^(.*)-(\d+)x(\d+(?:\.\d+)?)$/);
  return m ? { base: m[1], season: +m[2], ep: +m[3] } : null;
}
async function bulk(col, ops) {
  for (let i = 0; i < ops.length; i += 1000) await col.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
}

/* ------------------------------------------------------------------ */
/* Sitemap                                                             */
/* ------------------------------------------------------------------ */
async function readSitemapIndex() {
  const xml = await get(BASE + '/sitemap_index.xml');
  return [...xml.matchAll(/<sitemap>\s*<loc>([^<]+)<\/loc>(?:\s*<lastmod>([^<]+)<\/lastmod>)?/g)]
    .map((m) => ({ loc: m[1].trim(), lastmod: m[2] || null }));
}
async function readUrlset(loc) {
  const xml = await get(loc);
  return [...xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>(?:\s*<lastmod>([^<]+)<\/lastmod>)?/g)]
    .map((m) => ({ url: m[1].trim(), lastmod: m[2] || null }));
}
async function discover(verbose) {
  const kids = (await readSitemapIndex()).filter((k) => /(series|movies)-sitemap/.test(k.loc));
  const out = new Map();
  for (const k of kids) {
    const items = await readUrlset(k.loc);
    let n = 0;
    for (const it of items) {
      const m = it.url.match(/^https?:\/\/[^/]+\/(series|movies)\/([^/?#]+)\/?$/);
      if (!m) continue; // archive pages like /movies/ ko chhod do
      const type = m[1] === 'series' ? 'series' : 'movie';
      const slug = dec(m[2]).toLowerCase();
      out.set(type + ':' + slug, { type, slug, url: it.url, lastmod: it.lastmod });
      n++;
    }
    if (verbose) log(`${k.loc} -> ${n} titles`);
  }
  return [...out.values()];
}

/* ------------------------------------------------------------------ */
/* Parsers (pure functions, regex based)                               */
/* ------------------------------------------------------------------ */
function classify(src, name, idx) {
  src = decode(src);
  let u;
  try { u = new URL(src, BASE); } catch (e) { return [{ server: name, order: idx, type: 'unknown', url: src }]; }
  const vm = u.pathname.match(/\/video\/([0-9a-f]{32})/i);
  if (vm) return [{ server: name, order: idx, type: 'embed', host: u.hostname, id: vm[1], url: u.href }];
  const raw = (src.match(/[?&]data=([^&#]+)/) || [])[1];
  if (raw) {
    try {
      const arr = JSON.parse(Buffer.from(decodeURIComponent(raw), 'base64').toString('utf8'));
      return arr.filter((x) => x && x.link).map((x) => {
        const lu = new URL(x.link);
        return {
          server: name, order: idx, type: 'embed', lang: x.language || null,
          host: lu.hostname, id: lu.pathname.split('/').filter(Boolean).pop(), url: lu.href,
        };
      });
    } catch (e) {
      return [{ server: name, order: idx, type: 'wrapped', url: u.href, error: 'decode_failed' }];
    }
  }
  return [{ server: name, order: idx, type: 'unknown', host: u.hostname, url: u.href }];
}

function parseServers(html) {
  const names = [...html.matchAll(/<div class="server-info">([\s\S]*?)<\/div>/g)].map((m) => decode(m[1]));
  const out = [];
  const re = /<div id="options-(\d+)"[^>]*>([\s\S]*?)(?=<div id="options-\d+"|<div class="mb-30">|$)/g;
  let m;
  while ((m = re.exec(html))) {
    const idx = +m[1];
    const tag = (m[2].match(/<iframe\b[^>]*>/) || [])[0];
    if (!tag) continue;
    const src = attr(tag, 'data-src') || attr(tag, 'src');
    if (!src) continue;
    out.push(...classify(src, names[idx] || 'Server ' + (idx + 1), idx));
  }
  return out;
}
function fallbackServers(html) {
  const urls = uniq(html.match(/https?:\/\/[^"'\s<>]+\/video\/[0-9a-f]{32}/g) || []);
  return urls.flatMap((u, i) => classify(u, 'Server ' + (i + 1), i));
}

function parseDownloads(html) {
  const i = html.indexOf('id="mdl-download"');
  if (i < 0) return [];
  const part = html.slice(i).replace(/&#038;|&amp;/g, '&');
  const out = [];
  for (const row of part.match(/<tr>[\s\S]*?<\/tr>/g) || []) {
    const tds = [...row.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (tds.length < 4) continue;
    const link = row.match(/trdownload=(\d+)&t=([a-z]+)&trid=(\d+)/);
    out.push({
      server: decode(tds[0].replace(/<span[^>]*>[\s\S]*?<\/span>/, '')),
      lang: decode(tds[1]),
      quality: (tds[2].match(/(\d{3,4}p)/) || [])[1] || decode(tds[2]),
      trdownload: link ? +link[1] : null,
      trid: link ? +link[3] : null,
      url: link ? `${BASE}/?trdownload=${link[1]}&t=${link[2]}&trid=${link[3]}` : null,
    });
  }
  return out;
}

function parseSeasons(html) {
  const out = [];
  const re = /<a\b[^>]*class="[^"]*season-btn[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0].slice(0, m[0].indexOf('>') + 1);
    const text = decode(m[1]);
    const r = text.match(/(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?\s*\((\d+)\)/);
    out.push({
      post: attr(tag, 'data-post'),
      season: +attr(tag, 'data-season'),
      from: r ? +r[1] : null,
      to: r ? +(r[2] || r[1]) : null,
      count: r ? +r[3] : null,
      sub: /\[sub\]/i.test(text) || /non-regional/.test(tag),
      label: text,
    });
  }
  return out;
}

function parseEpisodeList(html) {
  const out = [];
  const re = /<article\b[^>]*class="[^"]*\bepisodes\b[^"]*"[^>]*>([\s\S]*?)<\/article>/g;
  let m;
  while ((m = re.exec(html))) {
    const b = m[1];
    const href = (b.match(/<a\s+href="([^"]+)"\s+class="lnk-blk"/) || [])[1];
    if (!href) continue;
    const num = (b.match(/class="num-epi">\s*([\d.]+)/) || [])[1];
    out.push({
      url: href,
      num: num != null ? +num : null,
      title: decode((b.match(/<h2 class="entry-title">([\s\S]*?)<\/h2>/) || [])[1]),
      thumb: (b.match(/<img[^>]*data-src="([^"]+)"/) || [])[1] || null,
    });
  }
  return out;
}

function parseEpisodePage(html) {
  const servers = parseServers(html);
  const downloads = parseDownloads(html);
  const se = html.match(/Season\s+(\d+)\s+Episode\s+([\d.]+)\s*-\s*([^<\n]*)/i);
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1];
  const dl = downloads.find((d) => d.trid);
  const postId = (dl && dl.trid) || (html.match(/\bterm-(\d+)\b/) || [])[1] || null;
  const seriesPost = (html.match(/let postID = "(\d+)"/) || [])[1] || (html.match(/data-post="(\d+)"/) || [])[1] || null;
  const sm = html.match(/href="https?:\/\/[^"\/]+\/series\/([^\/"]+)\/?"/);
  return {
    servers, downloads,
    seriesTitle: decode(h1 || ''),
    season: se ? +se[1] : null,
    ep: se ? +se[2] : null,
    title: se ? decode(se[3]) : null,
    postId: postId ? +postId : null,
    seriesPost,
    seriesSlug: sm ? dec(sm[1]).toLowerCase() : null,
    poster: normImg((html.match(/let image = "([^"]+)"/) || [])[1]),
    backdrop: normImg((html.match(/(?:https?:)?\/\/image\.tmdb\.org\/t\/p\/w1280\/[^"'\s)]+/) || [])[0]),
  };
}

// body ke flat text se overview / runtime / year / season-episode claims nikaalta hai (pure function)
function metaFromText(flat, title) {
  const i = title ? flat.indexOf(title) : -1;
  const start = i >= 0 ? i + title.length : 0;
  const oi = flat.indexOf('Overview', start);
  let overview = '';
  if (oi >= 0) {
    const rest = flat.slice(oi + 8);
    const end = rest.search(/\s(?:Read More|Genres|Languages)\b/);
    overview = (end >= 0 ? rest.slice(0, end) : rest.slice(0, 1500)).trim();
  }
  const near = flat.slice(start, oi >= 0 ? Math.min(oi, start + 300) : start + 300);
  return {
    overview,
    runtime: (near.match(/\b(\d+h\s*\d+m|\d+h|\d+\s*min)\b/) || [])[1] || null,
    year: (near.match(/\b((?:19|20)\d{2})\b(?!\s*Episodes?)/) || [])[1] || null,
    claims: {
      seasons: +((near.match(/(\d+)\s*Seasons?/i) || [])[1] || 0) || null,
      episodes: +((near.match(/(\d+)\s*Episodes?/i) || [])[1] || 0) || null,
    },
  };
}

// series / movie page ka metadata (cheerio)
function parseMeta(html) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const title = decode($('h1').first().text());
  const flat = decode($('body').text());
  const t = metaFromText(flat, title);
  let overview = t.overview;
  if (!overview) overview = decode($('.overviewCss').first().text());
  if (!overview) overview = decode($('meta[property="og:description"]').attr('content') || '');
  overview = overview.replace(/\s*Read More\s*$/i, '');
  const texts = (sel) => uniq($(sel).map((_, e) => decode($(e).text())).get().filter(Boolean));
  const head = html.split(/Recommended (?:Movies|Series)/)[0];
  return {
    title,
    overview,
    genres: texts('a[href*="/category/genre/"]'),
    languages: texts('a[href*="/category/language/"]'),
    runtime: t.runtime,
    year: t.year,
    claims: t.claims,
    poster: normImg((head.match(/(?:https?:)?\/\/image\.tmdb\.org\/t\/p\/w500\/[^"'\s)]+/) || [])[0]),
    // background image page ke aakhir mein hoti hai (Recommended ke baad), isliye poore html mein dhoondho
    backdrop: normImg((html.match(/(?:https?:)?\/\/image\.tmdb\.org\/t\/p\/w1280\/[^"'\s)]+/) || [])[0]),
  };
}

/* ------------------------------------------------------------------ */
/* Processing                                                          */
/* ------------------------------------------------------------------ */
// har page pe jo bhi /series/ ya /movies/ ke links mile (Recommended wagairah), unhe bhi queue mein daalo
async function harvest(db, html) {
  try {
    const found = new Map();
    for (const m of html.matchAll(/href="https?:\/\/[^"\/]+\/(series|movies)\/([^\/"?#]+)\/?"/g)) {
      const type = m[1] === 'series' ? 'series' : 'movie';
      const slug = dec(m[2]).toLowerCase();
      found.set(`${type}:${slug}`, { type, slug, url: `${BASE}/${m[1]}/${m[2]}/` });
    }
    if (!found.size) return;
    const ops = [...found.entries()].map(([id, f]) => ({
      updateOne: {
        filter: { _id: id }, upsert: true,
        update: {
          $set: { seen_at: new Date(), missing_runs: 0 },
          $setOnInsert: { type: f.type, slug: f.slug, url: f.url, status: 'pending', attempts: 0, first_seen: new Date(), source: 'harvest' },
        },
      },
    }));
    const r = await db.collection('titles').bulkWrite(ops, { ordered: false });
    stats.harvested += r.upsertedCount || 0;
  } catch (e) { /* harvest kabhi main kaam nahi rokega */ }
}

async function processSeries(db, t) {
  const html = await get(t.url);
  await harvest(db, html);
  const meta = parseMeta(html);
  const first = (html.match(/href="(https?:\/\/[^"]*\/episode\/[^"]+)"/) || [])[1];
  if (!first) throw new Error('no_episode_link');

  const epHtml = await get(first);
  const cur = parseEpisodePage(epHtml);
  let seasons = parseSeasons(epHtml);
  const lists = [];
  if (!seasons.length) {
    seasons = [{ post: cur.seriesPost, season: cur.season || 1, from: null, to: null, count: null, sub: false, label: '' }];
    lists.push({ s: seasons[0], items: parseEpisodeList(epHtml) });
  } else {
    for (const s of seasons) {
      const items = s.season === cur.season
        ? parseEpisodeList(epHtml)
        : parseEpisodeList(await get(`${BASE}/wp-admin/admin-ajax.php?action=action_select_season&season=${s.season}&post=${s.post}`));
      lists.push({ s, items });
    }
  }

  const ops = [];
  let total = 0;
  for (const { s, items } of lists) {
    for (const it of items) {
      const sl = slugOf(it.url);
      if (!sl || sl.kind !== 'episode') continue;
      const parts = epSlugParts(sl.slug);
      const season = parts ? parts.season : s.season;
      const epNum = parts ? parts.ep : it.num;
      const titleMissing = !it.title || /^(untitled|title|unknown)$/i.test(it.title);
      ops.push({
        updateOne: {
          filter: { _id: sl.slug },
          update: {
            $set: {
              type: 'episode', series_slug: t.slug, series_title: meta.title || cur.seriesTitle,
              season, ep_num: epNum, list_num: it.num, title: it.title, title_missing: titleMissing,
              thumb: it.thumb, url: it.url, sub: s.sub, updated_at: new Date(),
            },
            $setOnInsert: { scraped: false, attempts: 0, created_at: new Date() },
          },
          upsert: true,
        },
      });
      total++;
    }
  }
  if (ops.length) await bulk(db.collection('episodes'), ops);

  if (t.needs_refresh) { // badla hua series: aakhri 2 seasons ke episodes dobara fetch honge
    const last = uniq(lists.map((l) => l.s.season)).sort((a, b) => b - a).slice(0, 2);
    await db.collection('episodes').updateMany({ series_slug: t.slug, season: { $in: last } }, { $set: { scraped: false, attempts: 0 } });
  }

  await db.collection('titles').updateOne({ _id: t._id }, {
    $set: {
      title: meta.title || cur.seriesTitle, overview: meta.overview, genres: meta.genres, languages: meta.languages,
      runtime: meta.runtime, year: meta.year, claims: meta.claims,
      poster: cur.poster || meta.poster, backdrop: cur.backdrop || meta.backdrop,
      post_id: cur.seriesPost ? +cur.seriesPost : null,
      seasons, episodes_listed: total,
      status: t.status === 'done' ? 'done' : 'listed',
      needs_refresh: false, error: null, attempts: 0, scraped_at: new Date(),
    },
  });
  log(`series ok: ${t.slug} (${seasons.length} seasons, ${total} episodes)`);
}

async function processMovie(db, t) {
  const html = await get(t.url);
  await harvest(db, html);
  const meta = parseMeta(html);
  let servers = parseServers(html);
  if (!servers.length) servers = fallbackServers(html);
  const downloads = parseDownloads(html);
  const dl = downloads.find((d) => d.trid);
  const postId = (dl && dl.trid) || (html.match(/\bpostid-(\d+)\b/) || [])[1] || (html.match(/\bterm-(\d+)\b/) || [])[1] ||
    (html.match(/let postID = "(\d+)"/) || [])[1] || (html.match(/[?&]p=(\d+)['"]/) || [])[1] || null;
  const flags = servers.length ? [] : ['no_servers'];
  await db.collection('titles').updateOne({ _id: t._id }, {
    $set: {
      title: meta.title, overview: meta.overview, genres: meta.genres, languages: meta.languages,
      runtime: meta.runtime, year: meta.year, poster: meta.poster, backdrop: meta.backdrop,
      servers, downloads, post_id: postId ? +postId : null, flags,
      status: 'done', needs_refresh: false, error: null, attempts: 0, scraped_at: new Date(),
    },
  });
  log(`movie ok: ${t.slug} (${servers.length} server links)`);
}

async function processTitles(db) {
  const pLimit = require('p-limit');
  const limit = pLimit(C_TITLES);
  const col = db.collection('titles');
  const todo = await col.find({
    hidden: { $ne: true }, attempts: { $lt: MAX_ATTEMPTS },
    $or: [{ status: 'pending' }, { status: 'error' }, { needs_refresh: true }],
  }).toArray();
  log(`titles to process: ${todo.length}`);
  let done = 0;
  await Promise.all(todo.map((t) => limit(async () => {
    try {
      if (t.type === 'series') await processSeries(db, t); else await processMovie(db, t);
    } catch (e) {
      await col.updateOne({ _id: t._id }, {
        $set: { error: String(e.message || e).slice(0, 300), ...(t.status === 'done' ? {} : { status: 'error' }) },
        $inc: { attempts: 1 },
      });
      log('ERR title', t.slug, e.message);
      await logError(db, 'title', t.slug, e.message);
    }
    if (++done % 50 === 0) log(`titles ${done}/${todo.length}`);
  })));
  return todo.length;
}

async function processEpisode(db, ep) {
  const col = db.collection('episodes');
  try {
    const html = await get(ep.url);
    const p = parseEpisodePage(html);
    const flags = [];
    if (p.seriesSlug && p.seriesSlug !== ep.series_slug) flags.push('series_mismatch');
    if (p.season != null && p.season !== ep.season) flags.push('season_mismatch');
    if (p.ep != null && p.ep !== ep.ep_num) flags.push('ep_mismatch');
    if (!p.servers.length) flags.push('no_servers');
    const fp = crypto.createHash('sha1').update(JSON.stringify([p.servers, p.downloads])).digest('hex');
    const changed = ep.fingerprint && ep.fingerprint !== fp;
    await col.updateOne({ _id: ep._id }, {
      $set: {
        servers: p.servers, downloads: p.downloads, post_id: p.postId, page_title: p.title,
        flags, fingerprint: fp, scraped: true, attempts: 0, scraped_at: new Date(),
        ...(changed ? { link_changed_at: new Date() } : {}),
      },
    });
  } catch (e) {
    await col.updateOne({ _id: ep._id }, { $inc: { attempts: 1 }, $set: { last_error: String(e.message || e).slice(0, 200) } });
    log('ERR episode', ep._id, e.message);
    await logError(db, 'episode', ep._id, e.message);
  }
}

async function processEpisodes(db) {
  const pLimit = require('p-limit');
  const limit = pLimit(C_EPS);
  const col = db.collection('episodes');
  let total = 0;
  for (;;) {
    const batch = await col.find({ scraped: false, attempts: { $lt: MAX_ATTEMPTS } }).limit(300).toArray();
    if (!batch.length) break;
    await Promise.all(batch.map((ep) => limit(() => processEpisode(db, ep))));
    total += batch.length;
    log(`episodes processed: ${total}`);
  }
  return total;
}

async function finalize(db) {
  const pend = await db.collection('episodes').aggregate([
    { $match: { scraped: false, attempts: { $lt: MAX_ATTEMPTS } } },
    { $group: { _id: '$series_slug' } },
  ]).toArray();
  await db.collection('titles').updateMany(
    { type: 'series', status: 'listed', slug: { $nin: pend.map((x) => x._id) } },
    { $set: { status: 'done' } },
  );
}

/* ------------------------------------------------------------------ */
/* Sync + verify                                                       */
/* ------------------------------------------------------------------ */
async function syncTitles(db, found) {
  const col = db.collection('titles');
  const existing = new Map((await col.find({}, { projection: { lastmod_site: 1, status: 1, seen_at: 1 } }).toArray()).map((d) => [d._id, d]));
  const ops = [];
  const seen = new Set();
  const newTitles = [];
  let added = 0, changed = 0;
  for (const f of found) {
    const id = `${f.type}:${f.slug}`;
    seen.add(id);
    const ex = existing.get(id);
    if (!ex) {
      ops.push({ updateOne: { filter: { _id: id }, upsert: true, update: {
        $set: { type: f.type, slug: f.slug, url: f.url, lastmod_site: f.lastmod, missing_runs: 0, seen_at: new Date() },
        $setOnInsert: { status: 'pending', attempts: 0, first_seen: new Date() },
      } } });
      added++; newTitles.push(f.slug);
    } else {
      const set = { url: f.url, seen_at: new Date(), missing_runs: 0, hidden: false };
      if (ex.lastmod_site !== f.lastmod) {
        set.lastmod_site = f.lastmod; set.needs_refresh = true; set.attempts = 0; changed++;
      }
      ops.push({ updateOne: { filter: { _id: id }, update: { $set: set } } });
    }
  }
  // sitemap theek se padha gaya ho tabhi "gayab" titles gino (warna galti se sab hide ho jaayenge)
  if (existing.size && found.length >= existing.size * 0.8) {
    for (const [id, ex] of existing) {
      const stale = !ex.seen_at || Date.now() - new Date(ex.seen_at).getTime() > 48 * 3600 * 1000; // 48 ghante kahin nahi dikha
      if (!seen.has(id) && stale) ops.push({ updateOne: { filter: { _id: id }, update: { $inc: { missing_runs: 1 } } } });
    }
  }
  await bulk(col, ops);
  await col.updateMany({ missing_runs: { $gte: 3 } }, { $set: { hidden: true, live: false } });
  return { added, changed, newTitles };
}

async function verify(db) {
  const titles = db.collection('titles');
  const eps = db.collection('episodes');
  let live = 0, blocked = 0;
  const cur = titles.find({ status: 'done', hidden: { $ne: true } });
  for await (const t of cur) {
    const errors = [], warnings = [];
    if (t.type === 'series') {
      const list = await eps.find({ series_slug: t.slug }, { projection: { season: 1, ep_num: 1, flags: 1, scraped: 1, title_missing: 1 } }).toArray();
      if (!list.length) errors.push('zero_episodes');
      const bySeason = new Map();
      for (const e of list) { if (!bySeason.has(e.season)) bySeason.set(e.season, []); bySeason.get(e.season).push(e); }
      for (const s of t.seasons || []) {
        const have = bySeason.get(s.season) || [];
        const nums = have.map((e) => e.ep_num);
        if (new Set(nums).size !== nums.length) errors.push(`duplicate_s${s.season}`);
        if (s.count != null && have.length !== s.count) errors.push(`season_count_s${s.season}:${have.length}/${s.count}`);
        if (Number.isInteger(s.from) && Number.isInteger(s.to)) {
          const set = new Set(nums); const miss = [];
          for (let n = s.from; n <= s.to; n++) if (!set.has(n)) miss.push(n);
          if (miss.length) warnings.push(`missing_s${s.season}:${miss.slice(0, 10).join(',')}`);
        }
      }
      const mism = list.filter((e) => (e.flags || []).some((f) => /mismatch/.test(f))).length;
      if (mism) errors.push(`mismatch_episodes:${mism}`);
      const uns = list.filter((e) => !e.scraped).length;
      if (uns) errors.push(`unscraped_episodes:${uns}`);
      const nos = list.filter((e) => (e.flags || []).includes('no_servers')).length;
      if (nos) warnings.push(`no_servers_episodes:${nos}`);
      const tm = list.filter((e) => e.title_missing).length;
      if (tm) warnings.push(`title_missing:${tm}`);
      if (t.claims && t.claims.episodes && t.claims.episodes !== list.length) warnings.push(`site_claims_${t.claims.episodes}_episodes_we_have_${list.length}`);
    } else if (!(t.servers || []).length) {
      errors.push('no_servers');
    }
    const ok = errors.length === 0;
    await titles.updateOne({ _id: t._id }, { $set: { live: ok, errors, warnings, verified_at: new Date() } });
    ok ? live++ : blocked++;
  }
  log(`VERIFY: live=${live} blocked(needs_review)=${blocked}`);
  return { live, blocked };
}

async function ensureIndexes(db) {
  const t = db.collection('titles'), e = db.collection('episodes');
  await Promise.all([
    t.createIndex({ status: 1 }), t.createIndex({ type: 1, live: 1 }), t.createIndex({ slug: 1 }),
    e.createIndex({ series_slug: 1, season: 1, ep_num: 1 }), e.createIndex({ scraped: 1, attempts: 1 }), e.createIndex({ scraped_at: 1 }),
    t.createIndex({ first_seen: -1 }), db.collection('errors').createIndex({ ts: 1 }, { expireAfterSeconds: 14 * 86400 }),
  ]);
}

/* ------------------------------------------------------------------ */
/* Reconcile: site ki apni list se exact count nikaalna                */
/* (sitemap mein jo titles nahi hain, unhe bhi pakadta hai)            */
/* ------------------------------------------------------------------ */
// WordPress REST API: header "x-wp-total" site ka exact count deta hai
async function restList(kind) {
  const out = [];
  let total = null, pages = 1;
  for (let p = 1; p <= pages; p++) {
    const r = await http().get(`${BASE}/wp-json/wp/v2/${kind}?per_page=100&page=${p}&_fields=slug,link,modified`);
    let arr;
    try { arr = JSON.parse(r.data); } catch (e) { throw new Error('rest_not_json'); }
    if (!Array.isArray(arr)) throw new Error('rest_bad_response');
    if (p === 1) { total = +r.headers['x-wp-total'] || null; pages = +r.headers['x-wp-totalpages'] || 1; }
    for (const x of arr) out.push({ slug: dec(x.slug).toLowerCase(), url: x.link, lastmod: x.modified || null });
    await sleep(DELAY_MS);
  }
  return { items: out, total };
}

function parseArchive(html, kind) {
  const out = [];
  const re = /<article\b[^>]*>([\s\S]*?)<\/article>/g;
  let m;
  while ((m = re.exec(html))) {
    const l = m[1].match(new RegExp('href="(https?://[^"]*/' + kind + '/([^/"?#]+)/?)"'));
    if (l) out.push({ slug: dec(l[2]).toLowerCase(), url: l[1] });
  }
  return out;
}

// REST na chale to /series/page/2/ jaise listing pages crawl karo
async function archiveList(kind) {
  const seen = new Map();
  for (let p = 1; p <= 400; p++) {
    const url = p === 1 ? `${BASE}/${kind}/` : `${BASE}/${kind}/page/${p}/`;
    let html;
    try { html = await get(url); } catch (e) { if (e.notFound) break; throw e; }
    let added = 0;
    for (const it of parseArchive(html, kind)) if (!seen.has(it.slug)) { seen.set(it.slug, it); added++; }
    if (!added) break;
  }
  return { items: [...seen.values()], total: seen.size };
}

function parseListing(html) {
  const out = [];
  const re = /<article\b[^>]*>([\s\S]*?)<\/article>/g;
  let m;
  while ((m = re.exec(html))) {
    const l = m[1].match(/href="(https?:\/\/[^"\/]+\/(series|movies)\/([^\/"?#]+)\/?)"/);
    if (l) out.push({ type: l[2] === 'series' ? 'series' : 'movie', slug: dec(l[3]).toLowerCase(), url: l[1] });
  }
  return out;
}

// category / letters / genre jaise saare listing pages khangalo (har ek ke /page/N/ tak)
async function listingsCrawl() {
  const MAX_LISTINGS = +process.env.MAX_LISTINGS || 300;
  const MAX_PAGES = +process.env.MAX_LISTING_PAGES || 80;
  const kids = (await readSitemapIndex()).filter((k) => !/(series|movies|episode|episodes|page|post)-sitemap/.test(k.loc));
  const listings = new Set([`${BASE}/category/anime/`, `${BASE}/category/cartoon/`]);
  for (const k of kids) {
    try { for (const it of await readUrlset(k.loc)) if (listings.size < MAX_LISTINGS) listings.add(it.url); } catch (e) { log('listing sitemap fail', k.loc, e.message); }
  }
  const items = new Map();
  let pages = 0;
  for (const base of listings) {
    const b = base.replace(/\/+$/, '');
    for (let p = 1; p <= MAX_PAGES; p++) {
      let html;
      try { html = await get(p === 1 ? b + '/' : `${b}/page/${p}/`); } catch (e) { break; }
      pages++;
      let added = 0;
      for (const it of parseListing(html)) { const key = `${it.type}:${it.slug}`; if (!items.has(key)) { items.set(key, it); added++; } }
      if (!added) break;
    }
  }
  return { listings: listings.size, pages, items };
}

async function reconcile(found) {
  const sitemapSet = new Set(found.map((f) => `${f.type}:${f.slug}`));
  const site = new Map();
  const lines = [];
  for (const kind of ['series', 'movies']) {
    let r, source = 'rest';
    try { r = await restList(kind); } catch (e) {
      log(`REST ${kind}: nahi chala (${e.message}); listing pages crawl kar raha hoon`);
      source = 'archive';
      r = await archiveList(kind);
    }
    const type = kind === 'series' ? 'series' : 'movie';
    for (const i of r.items) site.set(`${type}:${i.slug}`, { type, slug: i.slug, url: i.url, lastmod: i.lastmod || null });
    const inSm = [...sitemapSet].filter((k) => k.startsWith(type + ':')).length;
    const lost = r.items.filter((i) => !sitemapSet.has(`${type}:${i.slug}`)).length;
    lines.push(`${kind.toUpperCase()}: site ka exact total ${r.total != null ? r.total : r.items.length} (via ${source}) | sitemap ${inSm} | sitemap mein nahi ${lost}`);
  }
  if (process.env.DEEP_LISTINGS !== '0') {
    try {
      const l = await listingsCrawl();
      for (const [k, v] of l.items) if (!site.has(k)) site.set(k, { ...v, lastmod: null });
      lines.push(`LISTINGS: ${l.listings} listing pages, ${l.pages} pages dekhe, ${l.items.size} titles mile`);
    } catch (e) { log('listings crawl error:', e.message); lines.push('LISTINGS: error ' + e.message); }
  }
  const extras = [...site.entries()].filter(([k]) => !sitemapSet.has(k)).map(([, v]) => v);
  const union = new Set([...sitemapSet, ...site.keys()]);
  lines.push(`TOTAL (sab sources milake): ${union.size} titles | sitemap se alag mile: ${extras.length}`);
  lines.forEach((l) => log('DISCOVERY ' + l));
  stats.lastDeep = { at: new Date(), lines };
  await tgSend('🔎 Deep discovery\n' + lines.join('\n') + (extras.length ? `\nChhoote hue (pehle 10): ${extras.slice(0, 10).map((e) => e.slug).join(', ')}` : ''));
  return extras;
}

/* ------------------------------------------------------------------ */
/* Modes                                                               */
/* ------------------------------------------------------------------ */
async function countMode() {
  const found = await discover(true);
  const s = found.filter((f) => f.type === 'series').length;
  const m = found.filter((f) => f.type === 'movie').length;
  log(`TOTAL: series=${s} movies=${m} (sum ${s + m})`);
}

let lastReconcile = 0;
async function runOnce(db, watch) {
  stats.phase = 'discovery';
  const found = await discover(!watch);
  if (!watch || stats.forceDeep || Date.now() - lastReconcile > 24 * 3600 * 1000) {
    stats.forceDeep = false;
    try { found.push(...(await reconcile(found))); lastReconcile = Date.now(); } catch (e) { log('reconcile error:', e.message); await logError(db, 'discovery', 'reconcile', e.message); }
  }
  const r = await syncTitles(db, found);
  stats.lastSync = Date.now();
  log(`sitemap: ${found.length} titles | new ${r.added} | changed ${r.changed}`);
  stats.phase = 'titles';
  const a = await processTitles(db);
  stats.phase = 'episodes';
  const b = await processEpisodes(db);
  await finalize(db);
  stats.phase = 'verify';
  let v = null;
  if (!watch || a || b || r.added || r.changed) v = await verify(db);
  stats.phase = 'idle';
  if (!stats.firstRunDone) {
    stats.firstRunDone = true;
    await tgSend('✅ Pehla poora scrape khatam!' + (v ? `\nVerify: live ${v.live} | review ${v.blocked}` : '') + '\n\n' + (await statusText(db)));
  } else if (watch && (r.added || r.changed)) {
    await tgSend(`🆕 Anime Salt sync: ${r.added} naye, ${r.changed} badle.\n${r.newTitles.slice(0, 15).join(', ')}`);
  }
}

async function testMode(db) {
  const urls = (process.env.TEST_URLS || `${BASE}/series/naruto-shippuden/ ${BASE}/movies/forgotten-island/`).split(/[\s,]+/).filter(Boolean);
  const nEps = +process.env.TEST_EPISODES || 3;
  for (const url of urls) {
    const m = url.match(/\/(series|movies)\/([^/?#]+)/);
    if (!m) { log('bad url', url); continue; }
    const type = m[1] === 'series' ? 'series' : 'movie';
    const slug = dec(m[2]).toLowerCase();
    const _id = `${type}:${slug}`;
    await db.collection('titles').updateOne({ _id }, {
      $set: { type, slug, url: url.replace(/\/?$/, '/'), test: true },
      $setOnInsert: { status: 'pending', attempts: 0 },
    }, { upsert: true });
    const t = await db.collection('titles').findOne({ _id });
    if (type === 'series') await processSeries(db, t); else await processMovie(db, t);
    const doc = await db.collection('titles').findOne({ _id });
    if (doc.seasons) doc.seasons = doc.seasons.map((s) => `S${s.season}: ${s.from}-${s.to} (${s.count})${s.sub ? ' [Sub]' : ''}`);
    log('TITLE ' + JSON.stringify(doc, null, 1));
    if (type === 'series') {
      const list = await db.collection('episodes').find({ series_slug: slug }).sort({ season: 1, ep_num: 1 }).limit(nEps).toArray();
      for (const e of list) await processEpisode(db, e);
      const after = await db.collection('episodes').find({ _id: { $in: list.map((e) => e._id) } }).sort({ season: 1, ep_num: 1 }).toArray();
      log('EPISODES (pehle ' + nEps + ') ' + JSON.stringify(after, null, 1));
      const per = await db.collection('episodes').aggregate([{ $match: { series_slug: slug } }, { $group: { _id: '$season', n: { $sum: 1 } } }, { $sort: { _id: 1 } }]).toArray();
      log('EPISODE COUNT PER SEASON ' + per.map((x) => `S${x._id}=${x.n}`).join(' '));
    }
  }
}

async function main() {
  if (MODE === 'count') { await countMode(); return; }
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI variable set nahi hai');
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  log(`MongoDB connected (db: ${DB_NAME}, mode: ${MODE})`);
  await ensureIndexes(db);

  if (MODE === 'test') { await testMode(db); await client.close(); return; }
  if (MODE === 'verify') { await verify(db); await client.close(); return; }
  if (MODE === 'reconcile') {
    const found = await discover(true);
    const extras = await reconcile(found);
    const r = await syncTitles(db, found.concat(extras));
    log(`queue: new ${r.added} | changed ${r.changed}. Ab MODE=run karo.`);
    await client.close(); return;
  }
  if (MODE === 'retry') {
    const r = await db.collection('episodes').updateMany(
      { $or: [{ flags: 'no_servers' }, { attempts: { $gte: MAX_ATTEMPTS } }] }, { $set: { scraped: false, attempts: 0 } });
    log(`retry queued: ${r.modifiedCount}`);
    await processEpisodes(db); await finalize(db); await verify(db); await client.close(); return;
  }

  // MODE=run
  if (TG_TOKEN) {
    tgLoop(db).catch((e) => log('tgLoop band:', e.message));
    reporterLoop(db).catch((e) => log('reporterLoop band:', e.message));
    await tgSend(`🚀 Scraper chalu hua (db: ${DB_NAME}). Commands ke liye /help bhejo.`);
  } else {
    log('TG_BOT_TOKEN set nahi: Telegram alerts band');
  }
  try { await runOnce(db, false); } catch (e) { log('FIRST RUN ERROR', e.message); await logError(db, 'run', 'first', e.message); await notify('❌ Scraper error: ' + e.message); }
  stats.phase = 'idle';
  log(`watcher chalu: har ${WATCH_MIN} minute mein check`);
  for (;;) {
    await nap(WATCH_MIN * 60 * 1000);
    try { await runOnce(db, true); } catch (e) { log('WATCH ERROR', e.message); await logError(db, 'run', 'watch', e.message); await notify('❌ Scraper error: ' + e.message); }
    stats.phase = 'idle';
  }
}

module.exports = { handleCommand, statusText, stats, flushErrors, logError, parseListing, parseArchive, metaFromText, parseServers, parseDownloads, parseSeasons, parseEpisodeList, parseEpisodePage, classify, epSlugParts, slugOf, decode, fallbackServers };

if (require.main === module) {
  process.on('unhandledRejection', (e) => log('unhandledRejection', e && e.message));
  main().then(() => { if (MODE !== 'run') process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
}
