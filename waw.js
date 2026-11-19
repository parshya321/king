/*
 * Infinite Animes - watchanimeworld adapter (separate file, animesalt code is not touched)
 *
 * Only runs with the site owner's permission (their Cloudflare allow rule, sent as the
 * EXTRA_HEADERS header). It never tries to get around any block.
 *
 * What it reads (all structure verified on real pages of the site):
 *   series page   -> episode list  (article.episodes -> a.lnk-blk, span.num-epi "1x1")
 *   episode page  -> options-N iframes. "Server 1" is a direct host (play.zephyrix.org) that
 *                    refuses to play inside other sites, so it is skipped (WAW_SKIP_HOSTS).
 *                    "Server 2" is /dub-player/t/<id>/ , a language picker page.
 *   dub-player    -> CONFIG = { prefix, ready: { hin: "<abyss id>", eng: ... }, lang: {...} }
 *                    every ready language is one Abyss player: prefix + id
 *
 * Output (same shape the API already reads from episodes.servers):
 *   { server: 'Server 2', order: n, type: 'embed', lang: 'Hindi', host, id, url }
 */
'use strict';

const decode = (s) => String(s == null ? '' : s)
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/g, "'").replace(/&#8211;/g, '-').trim();
const attr = (tag, name) => { const m = tag && tag.match(new RegExp('\\b' + name + '="([^"]*)"', 'i')); return m ? decode(m[1]) : null; };

// "1x7" / "2x13" -> { season, ep }
function parseNum(s) {
  const m = String(s || '').match(/(\d+)x([\d.]+)/i);
  return m ? { season: +m[1], ep: +m[2] } : { season: null, ep: null };
}
const slugOfUrl = (u) => { const m = String(u).match(/\/(?:episode|series|movies)\/([^/?#]+)/); return m ? decodeURIComponent(m[1]).toLowerCase() : null; };

/* ---- series page: title, seasons (for the ajax season switch), episodes of the visible season ---- */
function parseSeries(html) {
  const title = decode((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '').replace(/<[^>]+>/g, '').trim();
  const seasons = [...html.matchAll(/<a\s+data-post="(\d+)"\s+data-season="(\d+)"/g)].map((m) => ({ post: +m[1], season: +m[2] }));
  const episodes = [];
  const re = /<article\b[^>]*class="[^"]*\bepisodes\b[^"]*"[^>]*>([\s\S]*?)<\/article>/g;
  let m;
  while ((m = re.exec(html))) {
    const b = m[1];
    const url = (b.match(/<a\s+href="([^"]+)"\s+class="lnk-blk"/) || [])[1];
    if (!url) continue;
    const n = parseNum((b.match(/class="num-epi">\s*([^<]+)</) || [])[1]);
    episodes.push({
      url, slug: slugOfUrl(url), season: n.season, ep: n.ep,
      title: decode((b.match(/<h2 class="entry-title">([\s\S]*?)<\/h2>/) || [])[1]),
      thumb: (b.match(/<img[^>]*src="([^"]+)"/) || [])[1] || null,
    });
  }
  return { title, seasons, episodes };
}

/* ---- episode page: list of option iframes ---- */
function parseEpisode(html) {
  const out = [];
  const re = /<div id="options-(\d+)"[^>]*>([\s\S]*?)(?=<div id="options-\d+"|<div class="mb-30">|$)/g;
  let m;
  while ((m = re.exec(html))) {
    const tag = (m[2].match(/<iframe\b[^>]*>/) || [])[0];
    if (!tag) continue;
    const src = attr(tag, 'data-src') || attr(tag, 'src');
    if (src) out.push({ idx: +m[1], src });
  }
  return out;
}

/* ---- dub-player page: the language -> player id map ---- */
function parseDub(html) {
  const m = html.match(/var CONFIG = (\{[\s\S]*?\});\s*\n/);
  if (!m) return null;
  let c;
  try { c = JSON.parse(m[1]); } catch (e) { return null; }
  if (!c || !c.prefix || !c.ready) return null;
  return { prefix: c.prefix, ready: c.ready, lang: c.lang || {} };
}

const SKIP = () => String(process.env.WAW_SKIP_HOSTS || 'play.zephyrix.org').split(/[\s,]+/).filter(Boolean).map((s) => s.toLowerCase());

/* ---- put it together: servers[] for one episode ----
 * options = parseEpisode(html); dubOf(path) must return the dub-player html (or null)  */
async function buildServers(base, options, dubOf) {
  const skip = SKIP();
  const servers = [];
  let order = 0;
  for (const o of options) {
    let u;
    try { u = new URL(o.src, base); } catch (e) { continue; }
    if (u.pathname.startsWith('/dub-player/')) {
      const html = await dubOf(u.href);
      const d = html && parseDub(html);
      if (!d) continue;
      for (const code of Object.keys(d.ready)) {
        const id = d.ready[code];
        if (!id) continue;
        const url = d.prefix.replace(/\/+$/, '/') + id;
        let host = '';
        try { host = new URL(url).hostname; } catch (e) { continue; }
        if (skip.includes(host.toLowerCase())) continue;
        servers.push({ server: 'Server ' + (o.idx + 1), order: order++, type: 'embed', lang: (d.lang[code] && d.lang[code].name) || code, host, id, url });
      }
      continue;
    }
    if (skip.includes(u.hostname.toLowerCase())) continue; // direct host that refuses to play inside other sites
    if (u.protocol !== 'https:') continue;
    servers.push({ server: 'Server ' + (o.idx + 1), order: order++, type: 'embed', lang: null, host: u.hostname, id: u.pathname.split('/').filter(Boolean).pop(), url: u.href });
  }
  return servers;
}

module.exports = { parseSeries, parseEpisode, parseDub, buildServers, parseNum, slugOfUrl };
