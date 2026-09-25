// Web-as-context: HTML -> text, same-site crawl with robots.txt, page-only mode,
// JS-app fallback to a renderer, caps and error surfacing. Runs against a local server.
const http = require('http');
const web = require('../src/web');

let n = 0;
function check(name, ok, extra) { n++; if (!ok) { console.error('FAIL', name, extra ?? ''); process.exit(1); } console.log('ok', name); }

const pages = {
  '/': `<html><head><title>Home &amp; Start</title><script>bad()</script><style>.x{}</style></head><body><nav><a href="/nav-only">nav</a></nav><main><h1>Welcome</h1><p>Intro&nbsp;text &#8212; here.</p><p>${'Real content sentence number one. '.repeat(20)}</p><ul><li><a href="/a">A page</a></li><li><a href="/b.txt">B text</a></li><li><a href="/private/secret">secret</a></li><li><a href="https://other.example.com/x">external</a></li><li><a href="/pic.png">img</a></li><li><a href="/c#frag">C</a></li></ul></main><footer>footer junk</footer></body></html>`,
  '/a': '<html><head><title>A</title></head><body><article><h2>Alpha</h2><p>Alpha body with a <b>bold</b> word.</p><a href="/">home</a><a href="/a">self</a></article></body></html>',
  '/b.txt': 'plain text b',
  '/c': `<html><head><title>C</title></head><body><p>${'c'.repeat(50)}</p><a href="/spa">spa</a></body></html>`,
  '/spa': '<html><head><title>SPA</title></head><body><div id="root"></div><script>render()</script></body></html>',
  '/private/secret': '<html><body>SECRET</body></html>',
  '/nav-only': '<html><body>navpage</body></html>',
  '/robots.txt': 'User-agent: *\nDisallow: /private/\n',
};
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/robots.txt' || u === '/b.txt') { res.setHeader('content-type', 'text/plain'); return res.end(pages[u]); }
  if (!(u in pages)) { res.statusCode = 404; return res.end('nope'); }
  res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(pages[u]);
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // 1. html -> text
  const t = web.htmlToText(pages['/'], `${base}/`);
  check('title decoded', t.title === 'Home & Start', t.title);
  check('script/style/nav/footer dropped', !/bad\(\)|\.x\{|navpage|footer junk/.test(t.text), t.text);
  check('heading + list kept as lines', /# Welcome[\s\S]*- A page/.test(t.text), t.text);
  check('entities decoded', /Intro text — here\./.test(t.text), t.text);
  check('links resolved (nav link included, fragment stripped)', t.links.includes(`${base}/a`) && t.links.includes(`${base}/nav-only`) && t.links.includes(`${base}/c`) && !t.links.some((l) => l.includes('#')), t.links);

  // 2. single page
  const one = await web.fetchSite(`${base}/`, { wholeSite: false });
  check('page-only: exactly one page', one.pages === 1 && /Welcome/.test(one.text) && !/Alpha body/.test(one.text), one.pages);

  // 3. whole site
  let renders = 0;
  const render = async () => { renders++; return { title: 'SPA rendered', text: 'Rendered app text '.repeat(40), links: [`${base}/a`] }; };
  const site = await web.fetchSite(`${base}/`, { wholeSite: true, render, maxPages: 10 });
  const urls = site.text.match(/^URL: .*$/gm).map((l) => l.slice(5));
  check('crawled home, a, b.txt, c, spa, nav-only', ['/', '/a', '/b.txt', '/c', '/spa', '/nav-only'].every((p) => urls.includes(base + p)), urls);
  check('robots.txt respected for followed links', !urls.some((u) => u.includes('/private/')), urls);
  check('external links + images skipped', !urls.some((u) => /other\.example|\.png/.test(u)), urls);
  check('no duplicates (fragment / self links)', new Set(urls).size === urls.length, urls);
  check('JS-only page went through the renderer', renders === 1 && /Rendered app text/.test(site.text), renders);
  check('plain-text page included', /plain text b/.test(site.text));
  check('name shows host + page count', /127\.0\.0\.1 \(6 pages\)/.test(site.name), site.name);

  // 4. page cap
  const capped = await web.fetchSite(`${base}/`, { wholeSite: true, maxPages: 2 });
  check('page cap honoured and flagged', capped.pages === 2 && capped.truncated && /limit reached/.test(capped.text), [capped.pages, capped.truncated]);

  // 5. errors and classification
  let err = null; try { await web.fetchSite(`${base}/missing`); } catch (e) { err = e; }
  check('404 on the pasted page is an error', err && /HTTP 404/.test(err.message), err && err.message);
  check('classify: youtube / media / web', web.classifyUrl('youtu.be/abcdefghijk').kind === 'youtube' && web.classifyUrl('cdn.x.com/v.mp4').kind === 'media' && web.classifyUrl('x.com').url === 'https://x.com');
  check('looksLikeUrl', web.looksLikeUrl('docs.python.org/3/') && web.looksLikeUrl('https://a.io') && !web.looksLikeUrl('just some words'));

  server.close();
  console.log(`web: ${n} checks passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
