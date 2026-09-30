// Speech-to-text accuracy benchmark through the real pipeline: capture DSP
// (src/renderer/dsp.js, or the previous DSP with --dsp legacy) -> int16 frames
// -> LocalTranscriber (streaming worker + accuracy pass), scored as word error
// rate against known text. Material: real LibriSpeech clips + two synthetic
// voices holding a technical conversation, with realistic pauses, under
// several capture conditions (normal, very quiet loopback, noisy, a quiet
// talker among loud ones, 44.1 kHz device).
//
//   node test/stt-bench.js [--dsp new|legacy] [--cond normal,quiet,noisy,mixed,44k] [--label name] [--json out.json]
//
// Needs the speech models in %APPDATA%/ghost/models (or GHOST_MODELS) and Windows (SAPI voices).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const media = require('../src/media');
const dsp = require('../src/renderer/dsp');
const localStt = require('../src/providers/local-stt');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const DSP = opt('dsp', 'new');
const CONDS = opt('cond', 'normal,quiet,faint,noisy,loudnoise,mixed,44k').split(',');
const LABEL = opt('label', DSP);
const SPEED = +opt('speed', 2); // feed rate relative to real time
const NUDGE = +opt('nudge', 0); // seconds of audio between simulated Ask presses (0 = none)
const CACHE = path.join(__dirname, '.cache');
fs.mkdirSync(CACHE, { recursive: true });
const RATE = 48000;

// ---------------------------------------------------------------- material
const TTS = [ // [voice, text] or [voice, firstHalf, secondHalf] (spoken with a 1.1 s thinking pause in the middle)
  ['David', 'Could you walk me through how you would design a rate limiter for a public API?'],
  ['Zira', 'Sure. I would start with a token bucket per client, stored in Redis, and refill it on a fixed schedule.'],
  ['David', 'What happens when the cache goes down in the middle of a traffic spike?'],
  ['Zira', 'Then we fail open for a short window,', 'and fall back to a local in memory counter on each server.'],
  ['David', 'The time complexity of binary search', 'is logarithmic in the number of elements.'],
  ['Zira', 'Eventual consistency means replicas may briefly disagree, but they converge once writes stop.'],
  ['David', 'How would you detect a cycle in a linked list without using extra memory?'],
  ['Zira', 'Use two pointers. One moves a single step, the other moves two steps, and if they ever meet there is a cycle.'],
];
const LIBRI = [['libri-0.wav', '0.wav'], ['libri-1.wav', '1.wav'], ['libri-8k.wav', '8k.wav']];
const GAPS = [1.4, 0.7, 2.0, 1.0, 0.6, 1.6, 0.9, 1.2, 2.4, 0.8, 1.1];

function ttsWav(i, voice, text) {
  const f = path.join(CACHE, `tts-${i}-${voice}-${text.length}.wav`);
  if (!fs.existsSync(f)) execFileSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('Microsoft ${voice} Desktop'); $s.SetOutputToWaveFile('${f}'); $s.Speak('${text.replace(/'/g, "''")}'); $s.Dispose()`]);
  return f;
}
async function decode(file) {
  const chunks = [];
  await media.run(['-nostdin', '-loglevel', 'error', '-i', file, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { onStdout: (c) => { chunks.push(c); } });
  const b = Buffer.concat(chunks); const ab = new ArrayBuffer(b.length - (b.length % 4)); Buffer.from(ab).set(b.subarray(0, ab.byteLength));
  return new Float32Array(ab);
}
const silence = (sec) => new Float32Array(Math.round(sec * RATE));
function concat(list) { const out = new Float32Array(list.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of list) { out.set(a, o); o += a.length; } return out; }
function peakOf(a) { let p = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > p) p = v; } return p; }
function scaled(a, g) { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] * g; return o; }
function trimSilence(a) { let s = 0, e = a.length; while (s < e && Math.abs(a[s]) < 0.003) s++; while (e > s && Math.abs(a[e - 1]) < 0.003) e--; return a.subarray(Math.max(0, s - 480), Math.min(a.length, e + 480)); }

async function material() {
  const items = [];
  const libriRef = Object.fromEntries(fs.readFileSync(path.join(CACHE, 'libri-trans.txt'), 'utf8').trim().split(/\r?\n/).map((l) => { const i = l.indexOf(' '); return [l.slice(0, i), l.slice(i + 1)]; }));
  const tts = [];
  for (let i = 0; i < TTS.length; i++) {
    const [voice, a, b] = TTS[i];
    const wa = trimSilence(await decode(ttsWav(i, voice, a)));
    const audio = b ? concat([wa, silence(1.1), trimSilence(await decode(ttsWav(`${i}b`, voice, b)))]) : wa;
    tts.push({ ref: b ? `${a} ${b}` : a, audio, kind: 'tts' });
  }
  const libri = [];
  for (const [file, key] of LIBRI) libri.push({ ref: libriRef[key], audio: trimSilence(await decode(path.join(CACHE, file))), kind: 'real' });
  // interleave: real speech clips spread among the conversation
  tts.forEach((t, i) => { items.push(t); if (i === 1) items.push(libri[0]); if (i === 4) items.push(libri[1]); if (i === 6) items.push(libri[2]); });
  for (const it of items) it.audio = scaled(it.audio, 0.3 / (peakOf(it.audio) || 1));
  return items;
}

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function pinkNoise(n, seed = 7) {
  const r = mulberry32(seed); const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) { const w = r() * 2 - 1; b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2; }
  return out;
}
function track(items, cond) {
  const parts = [silence(1.0)];
  items.forEach((it, i) => {
    let a = it.audio;
    if (cond === 'mixed' && i % 2 === 1) a = scaled(a, 10 ** (-24 / 20)); // every other talker is 24 dB quieter
    parts.push(a, silence(GAPS[i % GAPS.length]));
  });
  let t = concat(parts);
  if (cond === 'quiet') t = scaled(t, 0.02 / 0.3); // loopback at a few % system volume
  if (cond === 'faint') t = scaled(t, 0.004 / 0.3); // barely audible: volume slider almost at zero
  if (cond === 'noisy' || cond === 'loudnoise') {
    const snr = cond === 'noisy' ? 10 : 3;
    const speech = Math.sqrt(items.reduce((s, it) => s + it.audio.reduce((q, v) => q + v * v, 0), 0) / items.reduce((n, it) => n + it.audio.length, 0));
    const noise = pinkNoise(t.length); const nr = dsp.rmsOf(noise); const g = (speech / 10 ** (snr / 20)) / nr;
    for (let i = 0; i < t.length; i++) t[i] += noise[i] * g;
  }
  let rate = RATE;
  if (cond === '44k') { t = Float32Array.from(dsp.createResampler(RATE, 44100).process(t)); rate = 44100; }
  return { samples: t, rate };
}

// ---------------------------------------------------------------- DSP under test
// The capture DSP exactly as shipped before this benchmark existed (audio.js _downsample + _emitFrame).
function legacyChain(rate) {
  const st = { phase: 0, z1: 0, z2: 0 }; let agc;
  return (f32) => {
    let pcm = f32;
    if (rate !== 16000) {
      const ratio = rate / 16000; const a = Math.exp(-2 * Math.PI * (16000 / 2.2) / rate), b = 1 - a;
      const lp = new Float32Array(f32.length); let z1 = st.z1, z2 = st.z2;
      for (let i = 0; i < f32.length; i++) { z1 = b * f32[i] + a * z1; z2 = b * z1 + a * z2; lp[i] = z2; }
      st.z1 = z1; st.z2 = z2;
      const out = new Float32Array(Math.max(0, Math.floor((f32.length - st.phase) / ratio) + 1)); let o = 0, p = st.phase;
      while (p < f32.length) { const i0 = Math.floor(p), frac = p - i0, i1 = i0 + 1 < f32.length ? i0 + 1 : i0; out[o++] = lp[i0] * (1 - frac) + lp[i1] * frac; p += ratio; }
      st.phase = p - f32.length; pcm = out.subarray(0, o);
    }
    let peak = 0; for (let i = 0; i < pcm.length; i++) { const v = Math.abs(pcm[i]); if (v > peak) peak = v; }
    if (peak > 0) {
      const env = agc || peak;
      agc = peak > env ? env * 0.6 + peak * 0.4 : env * 0.985 + peak * 0.015;
      if (agc > 0.004) { const g = Math.min(8, Math.max(1, 0.28 / agc)); if (g > 1.03) for (let i = 0; i < pcm.length; i++) { let v = pcm[i] * g; if (v > 0.85 || v < -0.85) v = Math.tanh(v); pcm[i] = v; } }
    }
    return pcm;
  };
}
function newChain(rate) {
  const rs = dsp.createResampler(rate, 16000), hp = dsp.createHighpass(16000), agc = dsp.createAgc({ rate: 16000 });
  return (f32) => agc.process(hp.process(Float32Array.from(rs.process(f32))));
}
function toB64Int16(pcm) {
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) { const s = Math.max(-1, Math.min(1, pcm[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
  return Buffer.from(out.buffer).toString('base64');
}

// ---------------------------------------------------------------- scoring
const SPELL = { dishonoured: 'dishonored', 'in-memory': 'in memory', api: 'a p i' };
function norm(s) {
  return s.toLowerCase().replace(/for ever/g, 'forever').replace(/[^a-z0-9' -]/g, ' ').split(/[\s-]+/).filter(Boolean).map((w) => SPELL[w] || w).join(' ').replace(/\ba p i\b/g, 'api').split(' ');
}
function wer(refWords, hypWords) {
  const n = refWords.length, m = hypWords.length;
  let prev = new Array(m + 1); for (let j = 0; j <= m; j++) prev[j] = { c: j, s: 0, d: 0, i: j };
  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1); cur[0] = { c: i, s: 0, d: i, i: 0 };
    for (let j = 1; j <= m; j++) {
      if (refWords[i - 1] === hypWords[j - 1]) { cur[j] = prev[j - 1]; continue; }
      const sub = prev[j - 1], del = prev[j], ins = cur[j - 1];
      if (sub.c <= del.c && sub.c <= ins.c) cur[j] = { c: sub.c + 1, s: sub.s + 1, d: sub.d, i: sub.i };
      else if (del.c <= ins.c) cur[j] = { c: del.c + 1, s: del.s, d: del.d + 1, i: del.i };
      else cur[j] = { c: ins.c + 1, s: ins.s, d: ins.d, i: ins.i + 1 };
    }
    prev = cur;
  }
  const r = prev[m];
  return { wer: r.c / n, errors: r.c, sub: r.s, del: r.d, ins: r.i, words: n };
}

// ---------------------------------------------------------------- run
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function runCondition(items, cond) {
  const { samples, rate } = track(items, cond);
  const chain = DSP === 'legacy' ? legacyChain(rate) : newChain(rate);
  const t = new localStt.LocalTranscriber({ sampleRate: 16000 });
  const lines = []; const byUid = new Map(); let lastEvent = Date.now();
  t.on('final', (text, meta) => { lastEvent = Date.now(); const l = { uid: meta && meta.uid, text }; lines.push(l); if (l.uid) byUid.set(l.uid, l); });
  t.on('revise', (r) => { lastEvent = Date.now(); const l = byUid.get(r.uid); if (l && r.text) l.text = r.text; });
  t.on('error', (e) => console.error('  stt error:', e.message));
  await t.connect();
  const FRAME = 4096;
  const all = concat([samples, new Float32Array(rate * 3)]); // trailing silence flushes the last utterance
  const started = Date.now();
  for (let i = 0; i < all.length; i += FRAME) {
    const pcm = chain(all.slice(i, Math.min(all.length, i + FRAME)));
    if (pcm.length) t.sendAudio(toB64Int16(pcm));
    // --nudge N: press "Ask" every N seconds of audio, mid-speech included (must not lose words)
    if (NUDGE && Math.floor(i / rate / NUDGE) !== Math.floor((i + FRAME) / rate / NUDGE)) t.nudge();
    // pace the feed (default 2x real time) so the recogniser keeps up, as it does live
    const due = started + ((i / rate) * 1000) / SPEED;
    if (Date.now() < due) await sleep(due - Date.now());
  }
  // everything queued must be decoded before the stream is closed (close drops late results)
  if (t.drain) await t.drain(); else { lastEvent = Date.now(); while (Date.now() - lastEvent < 8000) await sleep(200); }
  const t0 = Date.now();
  while (Date.now() - t0 < 180000 && (Date.now() - lastEvent < 2500 || localStt.refinePending() > 0)) await sleep(200);
  t.close();
  await sleep(700);
  const hyp = lines.map((l) => l.text).join(' ');
  const ref = items.map((it) => it.ref).join(' ');
  const score = wer(norm(ref), norm(hyp));
  return { cond, seconds: +(samples.length / rate).toFixed(1), lines: lines.length, ...score, hyp };
}

(async () => {
  localStt.init(() => process.env.GHOST_MODELS || path.join(process.env.APPDATA || '', 'ghost', 'models'));
  if (!localStt.modelReady() || !localStt.modelInfo(localStt.REFINE_MODEL).ready) { console.log('skip: speech models not on disk'); return; }
  const items = await material();
  console.log(`material: ${items.length} utterances (${items.filter((i) => i.kind === 'real').length} real speech), ${norm(items.map((i) => i.ref).join(' ')).length} words · dsp=${DSP} · label=${LABEL}`);
  const results = [];
  for (const cond of CONDS) {
    const r = await runCondition(items, cond);
    results.push(r);
    console.log(`${cond.padEnd(7)} WER ${(r.wer * 100).toFixed(1).padStart(5)}%  (${r.errors} errors: ${r.sub} wrong, ${r.del} missed, ${r.ins} extra of ${r.words})  ${r.lines} lines  ${r.seconds}s audio`);
  }
  const tot = results.reduce((a, r) => ({ e: a.e + r.errors, w: a.w + r.words, d: a.d + r.del }), { e: 0, w: 0, d: 0 });
  console.log(`OVERALL WER ${((tot.e / tot.w) * 100).toFixed(1)}%  (${tot.e} errors / ${tot.w} words, ${tot.d} missed words)  [${LABEL}]`);
  const json = opt('json', null);
  if (json) fs.writeFileSync(json, JSON.stringify({ label: LABEL, dsp: DSP, overall: tot.e / tot.w, results }, null, 2));
  localStt.shutdown();
  setTimeout(() => process.exit(0), 300);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
