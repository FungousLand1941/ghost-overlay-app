// Live check of the whole Claude path, using the key Ghost already has stored
// on this machine. The key is decrypted inside this process by the same code
// the app uses; it is never printed and never leaves the process except in the
// requests to api.anthropic.com. Reads the config, never writes it.
// Cost: a dozen small requests, a few cents at most.
//
//   npx electron test/selftest-claude.js          (uses %APPDATA%/ghost)
//
// Covers every way Ghost calls Claude: key test, an Instant answer, a Think
// answer (thinking on), a screenshot (one image), video frames (several labelled
// images), transcript clean-up (JSON), rolling summary, document digest, prompt
// caching, and the request shape for the other models in the list.
const { app, nativeImage } = require('electron');
const path = require('path');

app.setPath('userData', process.env.GHOST_USERDATA || path.join(app.getPath('appData'), 'ghost'));
app.disableHardwareAcceleration();

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try { const detail = await fn(); results.push({ name, ok: true, ms: Date.now() - t0, detail }); console.log(`ok    ${name}  (${Date.now() - t0} ms)  ${detail || ''}`); }
  catch (e) { results.push({ name, ok: false, ms: Date.now() - t0, error: String(e && e.message || e) }); console.log(`FAIL  ${name}  (${Date.now() - t0} ms)  ${String(e && e.message || e).slice(0, 300)}`); }
}
function solid(r, g, b, size = 96) { // a plain coloured JPEG as base64
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) { buf[i * 4] = b; buf[i * 4 + 1] = g; buf[i * 4 + 2] = r; buf[i * 4 + 3] = 255; } // BGRA
  return nativeImage.createFromBitmap(buf, { width: size, height: size }).toJPEG(90).toString('base64');
}
async function ask(providers, cfg, messages, system) {
  const t0 = Date.now(); let first = 0, text = '';
  for await (const tok of providers.stream(cfg, { messages, system })) { if (!first) first = Date.now() - t0; text += tok; }
  return { text: text.trim(), first, total: Date.now() - t0 };
}

app.whenReady().then(async () => {
  const store = require('../src/store');
  const providers = require('../src/providers');
  const cfg = store.get();
  console.log(`config: provider=${cfg.provider}  model=${cfg.claude && cfg.claude.model}  instant=${cfg.instantModel && cfg.instantModel.claude}  key=${cfg.claude && cfg.claude.apiKey ? 'present' : 'MISSING'}  workspace=${cfg.claude && cfg.claude.workspaceId ? 'set' : 'none'}`);
  if (!cfg.claude || !cfg.claude.apiKey) { console.log('FAIL  no Claude key stored in this profile — open Ghost, ⚙, paste the key, Test.'); app.exit(2); return; }
  const c = { ...cfg, provider: 'claude', fallbackProvider: 'none' };
  const Q = 'LIVE TRANSCRIPT (oldest first, most recent last; still listening):\n[NEW 6s ago] THEM: okay so for the index we store everything in a tree\n[NEW 2s ago] THEM: wait, what is a binary tree, can you explain that?\nRespond to what is most useful right now (see priority rules).';

  await step('key test', async () => { const r = await providers.testKey(c, { provider: 'claude' }); if (!/ok/i.test(r.reply)) throw new Error(`unexpected reply "${r.reply}"`); return `${r.model} replied "${r.reply}"`; });
  await step('instant answer', async () => { const r = await ask(providers, providers.modeConfig(c, 'instant'), [{ role: 'user', text: Q }], providers.systemPrompt(c, 'general', 'instant')); if (!/tree/i.test(r.text)) throw new Error(`answer does not mention a tree: ${r.text.slice(0, 120)}`); return `first word ${r.first} ms, done ${r.total} ms, ${r.text.split(/\s+/).length} words: "${r.text.replace(/\s+/g, ' ').slice(0, 90)}…"`; });
  await step('instant answer again (prompt cache warm)', async () => { const r = await ask(providers, providers.modeConfig(c, 'instant'), [{ role: 'user', text: Q.replace('binary tree', 'hash table') }], providers.systemPrompt(c, 'general', 'instant')); if (!/hash/i.test(r.text)) throw new Error('answer does not mention a hash table'); return `first word ${r.first} ms, done ${r.total} ms`; });
  await step('think answer (thinking on)', async () => { const r = await ask(providers, providers.modeConfig(c, 'think'), [{ role: 'user', text: Q }], providers.systemPrompt(c, 'general', 'think')); if (!/tree/i.test(r.text)) throw new Error(`answer does not mention a tree: ${r.text.slice(0, 120)}`); if (/Cut off at max tokens/.test(r.text)) throw new Error('answer was cut off at max tokens'); return `first word ${r.first} ms, done ${r.total} ms, ${r.text.split(/\s+/).length} words`; });
  await step('screenshot (one image)', async () => { const r = await ask(providers, { ...providers.modeConfig(c, 'instant'), maxTokens: 60 }, [{ role: 'user', text: 'What single colour fills this image? Answer with one word.', image: { data: solid(0, 200, 0), mime: 'image/jpeg' } }], 'Answer briefly.'); if (!/green/i.test(r.text)) throw new Error(`expected green, got "${r.text}"`); return `saw "${r.text}"`; });
  await step('video frames (labelled images in one request)', async () => {
    const r = await ask(providers, { ...providers.modeConfig(c, 'instant'), maxTokens: 200 }, [{ role: 'user', text: 'For EACH frame write one line starting with its exact timestamp in square brackets, then the single colour that fills it.', images: [{ data: solid(0, 200, 0), mime: 'image/jpeg', label: 'Frame at [00:00]' }, { data: solid(255, 255, 255), mime: 'image/jpeg', label: 'Frame at [01:05]' }] }], 'You turn video frames into precise study notes.');
    if (!/\[00:00\][^\n]*green/i.test(r.text) || !/\[01:05\][^\n]*white/i.test(r.text)) throw new Error(`frames not read per timestamp: ${r.text.replace(/\n/g, ' / ')}`);
    return r.text.replace(/\n+/g, ' / ');
  });
  await step('transcript clean-up (JSON)', async () => {
    const out = await providers.cleanupTranscript(c, { lines: [{ n: 1, speaker: 'them', text: 'we store it in reedies and refill the token bucket' }, { n: 2, speaker: 'them', text: 'eventual consistency means replicas converge once rights stop' }], background: 'Topic of the call: a rate limiter built on Redis with a token bucket; eventual consistency; reads and writes.' });
    const s = JSON.stringify(out);
    if (!Object.keys(out).length) throw new Error('returned no corrections');
    if (!/Redis/.test(s) || !/writes/.test(s)) throw new Error(`did not fix the sound-alikes: ${s}`);
    return s.slice(0, 180);
  });
  await step('rolling summary', async () => { const s = await providers.summarize(c, { previous: '', newText: 'THEM: we are designing a rate limiter. THEM: token bucket per client stored in Redis, refilled on a schedule. YOU: what if Redis goes down? THEM: fail open briefly and use a local counter.' }); if (s.length < 40 || !/redis/i.test(s)) throw new Error(`weak summary: ${s.slice(0, 120)}`); return `${s.length} chars`; });
  await step('document digest', async () => { const doc = ('Section 1. B-trees keep keys sorted and allow searches, insertions and deletions in logarithmic time. A node of order m has at most m children. ' + 'Splitting a full node promotes its median key to the parent. ').repeat(40); const d = await providers.digest(c, doc); if (d.length < 60 || !/b-?tree/i.test(d)) throw new Error(`weak digest: ${d.slice(0, 120)}`); return `${d.length} chars`; });
  for (const model of providers.MODELS.claude.filter((m) => m !== (c.claude.model))) {
    await step(`request shape accepted by ${model}`, async () => { const r = await ask(providers, { ...c, speed: 'fast', maxTokens: 300, claude: { ...c.claude, model } }, [{ role: 'user', text: 'Reply with the single word: OK' }], 'You are a connectivity test. Reply with exactly: OK'); if (!/ok/i.test(r.text)) throw new Error(`unexpected reply "${r.text.slice(0, 80)}"`); return `first word ${r.first} ms`; });
  }
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed${bad.length ? ' — FAILED: ' + bad.map((b) => b.name).join('; ') : ''}`);
  app.exit(bad.length ? 1 : 0);
}).catch((e) => { console.log('FAIL', e && e.message); app.exit(1); });
