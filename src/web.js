// Web pages as context: turn a public URL (one page or a whole site) into text.
// Plain fetch + a small HTML-to-text pass; JavaScript-only pages fall back to an
// offscreen renderer the main process supplies (render(url) -> {title,text,links}).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const MAX_PAGE_CHARS = 150000;
const DEFAULT_MAX_PAGES = 40;
const DEFAULT_MAX_CHARS = 400000; // matches docs.MAX_DOC_CHARS
const MAX_BODY_BYTES = 40 * 1024 * 1024;
const SKIP_EXT = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|mp4|m4v|mkv|webm|mov|avi|mp3|m4a|wav|ogg|flac|zip|gz|tgz|bz2|7z|rar|dmg|exe|msi|apk|css|js|mjs|map|woff2?|ttf|otf|eot|rss|atom)(?:[?#].*)?$/i;

const YT = /^(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i;
const MEDIA_URL = /\.(?:mp4|m4v|mkv|webm|mov|avi|mp3|m4a|aac|wav|ogg|oga|flac|opus|wma|ts)(?:[?#].*)?$/i;

// What kind of thing is this link? youtube | media (direct video/audio file) | web
function classifyUrl(raw) {
  const s = String(raw || '').trim();
  const yt = s.match(YT);
  if (yt) return { kind: 'youtube', id: yt[1], url: `https://www.youtube.com/watch?v=${yt[1]}` };
  const url = /^[a-z]+:\/\//i.test(s) ? s : `https://${s}`;
  if (MEDIA_URL.test(url)) return { kind: 'media', url };
  return { kind: 'web', url };
}
function looksLikeUrl(s) { return /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?$/i.test(String(s || '').trim()); }

function normalizeUrl(u, base) {
  let x; try { x = new URL(u, base); } catch { return null; }
  if (!/^https?:$/.test(x.protocol)) return null;
  x.hash = '';
  x.hostname = x.hostname.toLowerCase();
  let s = x.toString();
  if (!x.search && x.pathname !== '/' && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}
const bareHost = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
function sameSite(a, b) { return bareHost(a) === bareHost(b); }

async function fetchUrl(url, { timeoutMs = 20000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.8' },
      redirect: 'follow', signal: ac.signal,
    });
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (+res.headers.get('content-length') > MAX_BODY_BYTES) throw new Error('page is too large (over 40 MB)');
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: res.ok, status: res.status, type, buf, url: res.url || url };
  } finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------- HTML -> text
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·', bull: '•', deg: '°', times: '×', euro: '€', pound: '£', yen: '¥', cent: '¢', shy: '' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    if (e[0] === '#') { const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
    const k = e.toLowerCase(); return k in ENT ? ENT[k] : m;
  });
}

// Readable text + same-page links. Keeps headings / lists / table rows as
// lines so structure survives; drops scripts, styles, nav chrome, forms.
function htmlToText(html, baseUrl) {
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
  const links = [];
  for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const n = normalizeUrl(decodeEntities(m[1] ?? m[2] ?? m[3] ?? ''), baseUrl);
    if (n) links.push(n);
  }
  let s = html.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer|aside|form|button|select|canvas|video|audio|object|embed)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  // content region: <main>, else a lone <article>, else <body>
  const main = s.match(/<main\b[\s\S]*?<\/main\s*>/i);
  const articles = s.match(/<article\b[\s\S]*?<\/article\s*>/gi) || [];
  const body = s.match(/<body\b[\s\S]*?<\/body\s*>/i);
  s = main ? main[0] : articles.length === 1 ? articles[0] : body ? body[0] : s;
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<(\/?)h([1-6])\b[^>]*>/gi, (m, close, lvl) => (close ? '\n' : `\n\n${'#'.repeat(+lvl)} `));
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<\/(?:td|th)\s*>/gi, ' | ').replace(/<\/tr\s*>/gi, '\n');
  s = s.replace(/<\/?(?:p|div|section|article|main|header|blockquote|pre|ul|ol|dl|dt|dd|table|thead|tbody|tfoot|tr|figure|figcaption|details|summary|hr|address|fieldset|legend)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t \r]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, text: s, links: [...new Set(links)] };
}

// ---------------------------------------------------------------- robots.txt (for followed links only)
function ruleToRegex(rule) { return new RegExp('^' + rule.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')); }
async function robotsDisallow(origin) {
  try {
    const r = await fetchUrl(`${origin}/robots.txt`, { timeoutMs: 8000 });
    if (!r.ok || !/text/.test(r.type)) return [];
    const out = []; let applies = false;
    for (const raw of r.buf.toString('utf8').split(/\r?\n/)) {
      const line = raw.replace(/#.*/, '').trim(); if (!line) continue;
      const i = line.indexOf(':'); if (i < 0) continue;
      const key = line.slice(0, i).trim().toLowerCase(); const v = line.slice(i + 1).trim();
      if (key === 'user-agent') applies = v === '*';
      else if (applies && key === 'disallow' && v) out.push(ruleToRegex(v));
    }
    return out;
  } catch { return []; }
}

// ---------------------------------------------------------------- one page
async function loadPage(url, { render = null } = {}) {
  let r;
  try { r = await fetchUrl(url); }
  catch (e) { if (render) return renderPage(url, render); throw new Error(`could not reach ${url}: ${e.message}`); }
  if ([401, 403, 429, 503].includes(r.status)) { if (render) return renderPage(url, render); throw new Error(`the site refused the request (HTTP ${r.status})`); }
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  if (/application\/pdf/.test(r.type) || r.buf.subarray(0, 5).toString() === '%PDF-') {
    const pdf = require('pdf-parse');
    const p = await pdf(r.buf);
    return { title: (p.info && p.info.Title) || decodeURIComponent(url.split('/').pop() || 'document'), text: (p.text || '').trim(), links: [], kind: 'pdf', pages: p.numpages };
  }
  const body = r.buf.toString('utf8');
  if (/text\/html|application\/xhtml/.test(r.type) || /^\s*<(?:!doctype|html)/i.test(body)) {
    const page = htmlToText(body, r.url);
    // Nearly empty after stripping but full of scripts = a JavaScript app; let a real browser render it.
    if (page.text.length < 400 && render && /<script\b/i.test(body)) {
      try { const rp = await renderPage(url, render); if (rp.text.length > page.text.length) return rp; } catch {}
    }
    return { ...page, kind: 'html' };
  }
  if (/^text\/|json|xml/.test(r.type)) return { title: decodeURIComponent(url.split('/').pop() || url), text: body.trim(), links: [], kind: 'text' };
  throw new Error(`unsupported content type ${r.type || '(unknown)'} at ${url}`);
}
async function renderPage(url, render) {
  const rp = await render(url);
  if (!rp || !rp.text) throw new Error(`no readable text at ${url}`);
  return { title: (rp.title || '').trim(), text: rp.text.replace(/[ \t \r]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim(), links: [...new Set((rp.links || []).map((l) => normalizeUrl(l, url)).filter(Boolean))], kind: 'html', rendered: true };
}

// ---------------------------------------------------------------- site
// wholeSite: breadth-first over same-site links (robots.txt respected for the
// links we follow, never for the page the user pasted), capped by pages/chars.
async function fetchSite(startUrl, { wholeSite = false, maxPages = DEFAULT_MAX_PAGES, maxChars = DEFAULT_MAX_CHARS, render = null, onProgress = () => {}, concurrency = 3 } = {}) {
  const start = normalizeUrl(classifyUrl(startUrl).url);
  if (!start) throw new Error('That does not look like a web address.');
  const disallow = wholeSite ? await robotsDisallow(new URL(start).origin) : [];
  const allowed = (u) => { const p = new URL(u).pathname; return !disallow.some((re) => re.test(p)); };
  const queue = [start]; const seen = new Set([start]); const pages = [];
  let total = 0, truncated = false, active = 0;

  const fetchOne = async (url) => {
    onProgress({ text: `fetching page ${pages.length + 1}${wholeSite ? ` (of up to ${maxPages})` : ''}: ${url}`, done: pages.length, total: maxPages });
    let page;
    try { page = await loadPage(url, { render }); }
    catch (e) { if (url === start) throw e; return; } // a dead link on the site is not fatal
    if (!page.text) { if (url === start) throw new Error('No readable text found on that page.'); return; }
    const text = page.text.slice(0, MAX_PAGE_CHARS);
    pages.push({ url, title: page.title, text, kind: page.kind, pages: page.pages || null });
    total += text.length;
    if (wholeSite) for (const l of page.links) if (!seen.has(l) && sameSite(l, start) && !SKIP_EXT.test(l) && allowed(l)) { seen.add(l); queue.push(l); }
  };
  await new Promise((resolve, reject) => {
    let failed = false;
    const next = () => {
      if (failed) return;
      if (pages.length >= maxPages || total >= maxChars) { truncated = truncated || queue.length > 0; if (!active) resolve(); return; }
      while (active < concurrency && queue.length && pages.length + active < maxPages) {
        const u = queue.shift(); active++;
        fetchOne(u).then(() => { active--; next(); }, (e) => { failed = true; reject(e); });
      }
      if (!active && !queue.length) resolve();
    };
    next();
  });

  const host = bareHost(start);
  const multi = pages.length > 1;
  const title = pages[0].title || host;
  const header = [
    `# ${multi ? `Website: ${host}` : title}`,
    `Source: ${start}`,
    `Fetched: ${new Date().toISOString().slice(0, 10)}${multi ? ` — ${pages.length} pages` : ''}${truncated ? ' (site has more pages; limit reached)' : ''}`,
  ].join('\n');
  const bodyText = pages.map((p) => `## ${p.title || p.url}\nURL: ${p.url}\n\n${p.text}`).join('\n\n---\n\n');
  return { name: multi ? `${host} (${pages.length} pages)` : (title || host), url: start, pages: pages.length, truncated, text: `${header}\n\n${bodyText}` };
}

module.exports = { UA, classifyUrl, looksLikeUrl, normalizeUrl, sameSite, htmlToText, decodeEntities, fetchUrl, loadPage, fetchSite, robotsDisallow };
