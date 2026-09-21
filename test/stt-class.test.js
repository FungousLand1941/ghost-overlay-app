// LocalTranscriber (the class the app uses) fed exactly like the app feeds it:
// base64 PCM16 frames of ~256 ms. Uses an already-downloaded model directory
// (pass it as argv[2] or set GHOST_STT_MODEL_DIR) so the test is offline.
//   node test/stt-class.test.js <modelsRootContaining zipformer-en-2023-06-26-int8> <wav16k> [expected words...]
const fs = require('fs');
const path = require('path');
const stt = require('../src/providers/local-stt');

const [root, wavPath, ...expected] = process.argv.slice(2);
if (!root || !wavPath) { console.log('SKIP  (usage: node test/stt-class.test.js <modelsRoot> <wav>)'); process.exit(0); }
stt.init(() => root);
stt.setModel('zipformer-en-2023-06-26-int8');
if (!stt.modelReady()) { console.log(`SKIP  model not present under ${root}`); process.exit(0); }

function readWavPcm16(p) {
  const b = fs.readFileSync(p);
  let off = 12; while (off < b.length) { const id = b.toString('ascii', off, off + 4); const len = b.readUInt32LE(off + 4); if (id === 'data') return b.subarray(off + 8, off + 8 + len); off += 8 + len; }
  throw new Error('no data chunk');
}

(async () => {
  let failures = 0;
  const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n} ${x}`); if (!c) failures++; };
  const t = new stt.LocalTranscriber({ sampleRate: 16000 });
  const ev = { interim: [], final: [], status: [], error: [] };
  for (const k of Object.keys(ev)) t.on(k, (v) => ev[k].push(v instanceof Error ? v.message : v));
  const model = await t.connect();
  check('connect returns local model id', /^local:zipformer/.test(model), model);

  const pcm = readWavPcm16(wavPath);
  const FRAME = 16000 * 0.256 * 2; // bytes
  const t0 = Date.now();
  for (let i = 0; i < pcm.length; i += FRAME) t.sendAudio(pcm.subarray(i, i + FRAME).toString('base64'));
  t.nudge(); // like pressing Ask: commit what's being said
  // decoding happens in the worker thread: wait for the final to come back
  const deadline = Date.now() + 8000;
  while (!ev.final.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  const elapsed = Date.now() - t0;
  check('interim partials streamed', ev.interim.filter(Boolean).length >= 5, `${ev.interim.length} partials`);
  check('final text produced', ev.final.length >= 1, JSON.stringify(ev.final));
  check('no errors', ev.error.length === 0, ev.error.join('; '));
  check('faster than real time', elapsed < (pcm.length / 32000) * 1000 * 0.5, `${elapsed} ms for ${(pcm.length / 32000).toFixed(1)} s audio`);
  check('tidy: sentence case, not SHOUTING', ev.final.every((f) => f !== f.toUpperCase()), JSON.stringify(ev.final));
  if (expected.length) {
    const got = ev.final.join(' ').toUpperCase().replace(/[^A-Z ]/g, '').split(/\s+/);
    const hit = expected.filter((w) => got.includes(w.toUpperCase())).length;
    check(`accuracy: ${hit}/${expected.length} expected words`, hit / expected.length >= 0.7);
  }
  t.close();
  await new Promise((r) => setTimeout(r, 300)); // let the worker flush the closing final
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exitCode = failures ? 1 : 0;
  stt.shutdown();
})();
