// Big context: a whole website / hours of video don't fit the prompt. Checks that
// docs over the cap fall back to digests in the system prompt, that per-question
// retrieval picks the right pages / timestamp blocks, and that a huge site's
// digest is built from a map of every page rather than just its beginning.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-retr-'));
const docs = require('../src/docs');
docs.init(() => tmp);

let n = 0;
function check(name, ok, extra) { n++; if (!ok) { console.error('FAIL', name, extra ?? ''); process.exit(1); } console.log('ok', name); }

// a crawled "site": 3 pages on different topics
const page = (title, url, body) => `## ${title}\nURL: ${url}\n\n${body}`;
const site = [
  '# Website: docs.example\nSource: https://docs.example\nFetched: 2026-09-25 — 3 pages',
  page('Installing', 'https://docs.example/install', 'Run the installer. Set the PATH variable. Restart your terminal after installation. '.repeat(30)),
  page('Optimizers', 'https://docs.example/optim', 'Gradient descent updates weights using the learning rate. Adam adapts the learning rate per parameter. Momentum smooths the gradient. '.repeat(30)),
  page('Deployment', 'https://docs.example/deploy', 'Build a container image and push it to the registry. Configure the load balancer and health checks. '.repeat(30)),
].join('\n\n');
const web = docs.addEntry({ name: 'docs.example (3 pages)', kind: 'web', text: site, source: 'https://docs.example', pages: 3 });
docs.update(web.id, { digest: 'DIGEST: install, optimizers, deployment', digestStatus: 'ready' });

// a transcribed "lecture"
const lines = [];
for (let s = 0; s < 3600; s += 20) {
  const mm = String(Math.floor(s / 60)).padStart(2, '0'), ss = String(s % 60).padStart(2, '0');
  const topic = s < 1200 ? 'Today we cover binary search trees and their invariants.' : s < 2400 ? 'Now hash tables: buckets, load factor and collision resolution with chaining.' : 'Finally graphs: breadth first search, depth first search and Dijkstra shortest paths.';
  lines.push(`[${mm}:${ss}] ${topic}`);
  if (s === 1500) lines.push(`[${mm}:${ss}] ON SCREEN: Slide "Load factor α = n / m" with a chart of probe counts`);
}
const vid = docs.addEntry({ name: 'lecture.mp4', kind: 'video', text: `# lecture.mp4\nDuration: 1:00:00\n\n${lines.join('\n')}`, seconds: 3600 });
docs.update(vid.id, { digest: 'DIGEST: BSTs, hash tables, graphs', digestStatus: 'ready' });

// a short note that always fits
docs.addEntry({ name: 'note', kind: 'text', text: 'My name is Keshav and I am interviewing for a backend role.' });

// 1. tokenizer
check('tokenizer drops stopwords, keeps terms', JSON.stringify(docs.tokenize('What is the learning rate in Adam?')) === '["learning","rate","adam"]', docs.tokenize('What is the learning rate in Adam?'));

// 2. everything fits -> think mode sends full text, nothing is partial
const full = docs.contextFor('think', { capChars: 10000000 });
check('think mode under the cap: full text of all docs', /\(full text\)/.test(full) && /Gradient descent/.test(full) && /Dijkstra/.test(full) && /Keshav/.test(full));
check('nothing partial when it all fits', docs.partialDocs('think', { capChars: 10000000 }).length === 0);

// 3. over the cap -> big docs become digests, the small note stays in full, and they are reported as partial
const capped = docs.contextFor('think', { capChars: 4000 });
check('over the cap: digests stand in for the big docs', /DIGEST: install/.test(capped) && /DIGEST: BSTs/.test(capped) && !/Gradient descent/.test(capped), capped.slice(0, 300));
check('short note still sent in full', /Keshav/.test(capped));
const partial = docs.partialDocs('think', { capChars: 4000 });
check('both big docs reported partial, the note is not', partial.length === 2 && partial.includes(web.id) && partial.includes(vid.id));

// 4. retrieval picks the right page and the right part of the video
const r1 = docs.retrieve('what learning rate does Adam use?', { maxChars: 3000, onlyDocs: partial });
check('question about optimizers -> Optimizers page, not Installing', /Optimizers/.test(r1) && /learning rate/.test(r1) && !/Installing/.test(r1) && !/container image/.test(r1), r1.slice(0, 200));
const r2 = docs.retrieve('how does the load factor affect collisions in a hash table', { maxChars: 3000, onlyDocs: partial });
check('question about hash tables -> the 20–40 min block of the lecture, incl. the on-screen slide', /\[2[0-9]:\d\d\]|\[3[0-9]:\d\d\]/.test(r2) && /load factor/.test(r2) && /ON SCREEN/.test(r2) && !/\[0[0-9]:\d\d\] Today we cover/.test(r2), r2.slice(0, 200));
check('chunks carry doc name and section title', /### lecture\.mp4 — from \d+:\d\d/.test(r2) && /### docs\.example \(3 pages\) — Optimizers/.test(r1));
check('retrieval respects the char budget', r1.length <= 3000 * 1.1 && r2.length <= 3000 * 1.1, [r1.length, r2.length]);
check('no matching terms -> nothing attached', docs.retrieve('zzzz qqqq', { onlyDocs: partial }) === '' && docs.retrieve('', { onlyDocs: partial }) === '');

// 5. instant mode: digests in the prompt, big docs partial -> excerpts get attached per question
check('instant: digests in prompt, both big docs partial', /DIGEST: install/.test(docs.contextFor('instant')) && docs.partialDocs('instant').length === 2);

// 6. digest source for a huge site = a map of every page
const bigPages = [];
for (let i = 0; i < 300; i++) bigPages.push(page(`Page ${i}`, `https://big.example/p${i}`, `Unique topic ${i} keyword${i}. ${'filler text '.repeat(400)}`));
const big = docs.addEntry({ name: 'big.example (300 pages)', kind: 'web', text: `# Website: big.example\n\n${bigPages.join('\n\n')}`, source: 'https://big.example', pages: 300 });
const src = docs.digestSource(big.id);
check('huge site digest source covers first AND last pages within 400k', src.length <= 400000 && /## Page 0\b/.test(src) && /## Page 299\b/.test(src) && /keyword299/.test(src), [src.length]);
check('a normal doc digest source is just its text', docs.digestSource(vid.id).startsWith('# lecture.mp4'));
check('2 MB doc cap', docs.MAX_DOC_CHARS === 2000000 && big.chars === Math.min(2000000, big.chars));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`retrieval: ${n} checks passed`);
