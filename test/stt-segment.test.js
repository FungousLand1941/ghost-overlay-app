// Live-listening regression (fast): a loud sentence, a short gap, then a talker
// 24 dB quieter, with "Ask" pressed in the middle of the quiet sentence.
// Through the real path: capture DSP -> int16 frames -> LocalTranscriber
// (streaming model + VAD + levelled accuracy pass). Guards the failures the
// benchmark (test/stt-bench.js) exposed: quiet speech dropped or clipped at its
// start, a loud and a quiet sentence merged and one of them lost, and words cut
// when Ask is pressed mid-sentence. Skips without the speech models / SAPI.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const media = require('../src/media');
const dsp = require('../src/renderer/dsp');
const localStt = require('../src/providers/local-stt');

let n = 0;
function check(name, ok, extra) { n++; if (!ok) { console.error('FAIL', name, extra ?? ''); process.exit(1); } console.log('ok', name); }
const CACHE = path.join(__dirname, '.cache');
const RATE = 48000;
const A = 'Could you walk me through how you would design a rate limiter for a public API?';
const B = 'The time complexity of binary search is logarithmic in the number of elements.';

async function tts(name, voice, text) {
  const f = path.join(CACHE, `seg-${name}.wav`);
  if (!fs.existsSync(f)) execFileSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('Microsoft ${voice} Desktop'); $s.SetOutputToWaveFile('${f}'); $s.Speak('${text}'); $s.Dispose()`]);
  const chunks = [];
  await media.run(['-nostdin', '-loglevel', 'error', '-i', f, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { onStdout: (c) => { chunks.push(c); } });
  const b = Buffer.concat(chunks); const ab = new ArrayBuffer(b.length - (b.length % 4)); Buffer.from(ab).set(b.subarray(0, ab.byteLength));
  let a = new Float32Array(ab), s = 0, e = a.length;
  while (s < e && Math.abs(a[s]) < 0.003) s++; while (e > s && Math.abs(a[e - 1]) < 0.003) e--;
  a = a.subarray(s, e);
  let p = 0; for (const v of a) if (Math.abs(v) > p) p = Math.abs(v);
  return a.map((v) => (v * 0.3) / p);
}
const words = (s) => s.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  localStt.init(() => process.env.GHOST_MODELS || path.join(process.env.APPDATA || '', 'ghost', 'models'));
  if (process.platform !== 'win32' || !localStt.modelReady() || !localStt.modelInfo(localStt.REFINE_MODEL).ready) { console.log('skip: needs Windows + the speech models on disk'); return; }
  fs.mkdirSync(CACHE, { recursive: true });
  const a = await tts('a', 'David', A), bq = (await tts('b', 'Zira', B)).map((v) => v * 10 ** (-24 / 20));
  const sil = (sec) => new Float32Array(Math.round(sec * RATE));
  const parts = [sil(1), a, sil(0.7), bq, sil(3)];
  const all = new Float32Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  const askAt = RATE * 1 + a.length + RATE * 0.7 + Math.floor(bq.length * 0.5); // Ask pressed half-way through the quiet sentence

  const rs = dsp.createResampler(RATE, 16000), hp = dsp.createHighpass(16000), agc = dsp.createAgc({ rate: 16000 });
  const t = new localStt.LocalTranscriber({ sampleRate: 16000 });
  const lines = []; const byUid = new Map(); const finalsPerUid = new Map(); let snapshotSeen = false, lastEvent = Date.now();
  t.on('final', (text, meta) => { lastEvent = Date.now(); finalsPerUid.set(meta.uid, (finalsPerUid.get(meta.uid) || 0) + 1); const l = { uid: meta.uid, text }; lines.push(l); byUid.set(meta.uid, l); });
  t.on('revise', (r) => { lastEvent = Date.now(); const l = byUid.get(r.uid); if (l && r.text) l.text = r.text; });
  await t.connect();
  const started = Date.now();
  for (let i = 0; i < all.length; i += 4096) {
    const pcm = agc.process(hp.process(Float32Array.from(rs.process(all.slice(i, i + 4096)))));
    const i16 = new Int16Array(pcm.length); for (let k = 0; k < pcm.length; k++) { const s = Math.max(-1, Math.min(1, pcm[k])); i16[k] = s < 0 ? s * 0x8000 : s * 0x7fff; }
    t.sendAudio(Buffer.from(i16.buffer).toString('base64'));
    if (i <= askAt && askAt < i + 4096) {
      await t.drain(); await sleep(1500); // let the recognizer catch up to "now", as it is live
      const before = lines.length; t.nudge(); await t.drain(); await sleep(1500);
      snapshotSeen = lines.length > before && /complexity|binary/i.test(lines.map((l) => l.text).join(' '));
    }
    const due = started + ((i / RATE) * 1000) / 3; if (Date.now() < due) await sleep(due - Date.now());
  }
  await t.drain();
  const t0 = Date.now(); while (Date.now() - t0 < 60000 && (Date.now() - lastEvent < 2500 || localStt.refinePending() > 0)) await sleep(200);
  t.close(); await sleep(600);
  const hyp = lines.map((l) => l.text).join(' ');
  const hw = words(hyp);
  const missing = (ref) => words(ref).filter((w) => !hw.includes(w));
  check('loud sentence transcribed completely', missing(A).length <= 1, [missing(A), hyp]);
  check('quiet talker (24 dB down) transcribed completely', missing(B).length <= 1, [missing(B), hyp]);
  check('quiet sentence keeps its first words ("The time …")', /the time complexity/i.test(hyp), hyp);
  check('the two talkers come out as separate lines', lines.length >= 2 && lines.length <= 4, lines.map((l) => l.text));
  check('Ask mid-sentence put the words so far on screen', snapshotSeen, lines.map((l) => l.text));
  check('…and that line was completed in place, not duplicated', [...finalsPerUid.values()].every((c) => c === 1) && words(hyp).filter((w) => w === 'logarithmic').length === 1, [[...finalsPerUid], hyp]);
  localStt.shutdown();
  console.log(`stt-segment: ${n} checks passed`);
  setTimeout(() => process.exit(0), 300);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
