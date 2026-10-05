// The renderer's capture chain (src/renderer/audio.js) in chunked mode, driven
// block by block the way the audio worklet drives it (48 kHz, 4096-sample
// blocks, both sources on the same audio clock), with synthetic speech-like
// signals so the result is known:
//   - speakers: the mic hears the call ~110 ms late; that bleed must be removed
//     before the two sources are mixed (it used to go into every chunk raw,
//     putting the call in the mix twice — an echo the recognizer chokes on)
//   - your own voice on the mic still reaches the chunk
//   - a timed chunk ends in a pause, not in the middle of a word, and no audio
//     is lost or repeated across chunks
//   - live mode still streams per-source frames exactly as before
global.window = {};
global.GhostDSP = require('../src/renderer/dsp.js');
require('../src/renderer/audio.js');
const AudioChunker = window.AudioChunker;
const dsp = global.GhostDSP;

let failures = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'ok' : 'FAIL'} ${n}${x ? ` — ${x}` : ''}`); if (!c) failures++; };

const IN = 48000, BLOCK = 4096, OUT = 16000;
let seed = 12345;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2147483648 - 1; };
// speech-like: band-limited noise, syllable-rate amplitude modulation, in bursts ("words") with gaps
function voice(n, { level = 0.1, on = (i) => true, rate = IN } = {}) {
  const x = new Float32Array(n); let lp = 0, lp2 = 0;
  for (let i = 0; i < n; i++) {
    lp += 0.3 * (rnd() - lp); lp2 += 0.3 * (lp - lp2);
    const syl = 0.55 + 0.45 * Math.sin((2 * Math.PI * 4 * i) / rate);
    x[i] = on(i) ? level * syl * (lp - lp2) * 6 : 0;
  }
  return x;
}
// what a laptop mic hears of its speakers: 110 ms late, quieter, muffled
function bleedOf(call, { delay = 0.11, gain = 0.3 } = {}) {
  const d = Math.round(delay * IN), out = new Float32Array(call.length); let lp = 0;
  for (let i = d; i < call.length; i++) { lp += 0.5 * (call[i - d] - lp); out[i] = gain * lp; }
  return out;
}
function makeChunker(opts) {
  const c = new AudioChunker({ source: 'both', chunkSeconds: 10, onStatus: () => {}, onError: () => {}, ...opts });
  c.rate = IN; c.running = true;
  for (const name of opts.names || ['system', 'mic']) {
    c.chain[name] = { rs: dsp.createResampler(IN, OUT), hp: dsp.createHighpass(OUT), agc: dsp.createAgc({ rate: OUT }) };
    c.analysers[name] = {};
  }
  return c;
}
// feed both sources block by block on a shared clock, the way the worklets deliver them
// (ranges are whole blocks: `from`/`to` are rounded down to a block boundary, as the worklet's blocks are)
function feed(c, tracks, from = 0, to = Infinity) {
  from = Math.floor(from / BLOCK) * BLOCK;
  const n = Math.min(Math.floor(to / BLOCK) * BLOCK, ...Object.values(tracks).map((x) => x.length));
  for (let o = from; o + BLOCK <= n; o += BLOCK) {
    const t = (o + BLOCK) / IN;
    for (const [name, x] of Object.entries(tracks)) c._onSamples(name, x.slice(o, o + BLOCK), 0, t);
  }
}
const energy = (frames, key) => frames.reduce((e, f) => { const x = f[key]; let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return e + s; }, 0);
const db = (a, b) => 10 * Math.log10(a / b);

// 1. speakers, you silent: the mic carries only bleed. It must not reach the chunk mix.
{
  const n = IN * 24;
  const call = voice(n, { level: 0.15, on: (i) => (i % (IN * 2)) < IN * 1.5 }); // talks 1.5 s of every 2 s
  const mic = bleedOf(call);
  for (let i = 0; i < n; i++) mic[i] += 0.0005 * rnd(); // a little room noise
  const c = makeChunker({ onChunk: () => {} });
  feed(c, { system: call, mic }, 0, IN * 12); // let the canceller learn the path
  c.buffers = { system: [], mic: [] };
  feed(c, { system: call, mic }, IN * 12, n);
  const micIn = (() => { let s = 0; const r = dsp.createResampler(IN, OUT).process(mic.slice(IN * 12)); for (const v of r) s += v * v; return s; })();
  const micOut = energy(c.buffers.mic, 'raw');
  check('speakers: call bleed on the mic is removed before the chunk mix', db(micIn, micOut) > 15, `${db(micIn, micOut).toFixed(1)} dB removed`);
  const sysOut = energy(c.buffers.system, 'raw');
  check('…the call itself is in the mix once, at full strength', sysOut > 0 && db(sysOut, micOut) > 20, `call ${db(sysOut, micOut).toFixed(1)} dB above what is left of the bleed`);
}

// 2. you talking (the call silent): your voice is kept
{
  const n = IN * 10;
  const call = new Float32Array(n);
  const mic = voice(n, { level: 0.05, on: (i) => (i % IN) < IN * 0.7 });
  const c = makeChunker({ onChunk: () => {} });
  feed(c, { system: call, mic });
  const micIn = (() => { let s = 0; const r = dsp.createResampler(IN, OUT).process(mic); for (const v of r) s += v * v; return s; })();
  const kept = energy(c.buffers.mic, 'raw');
  check('your voice reaches the chunk (nothing to cancel)', db(micIn, kept) < 1.5, `${db(micIn, kept).toFixed(2)} dB lost`);
  check('…levelled up for the recognizer', energy(c.buffers.mic, 'pcm') > kept);
}

// 3. a timed chunk ends in a pause; nothing is lost or doubled across chunks
{
  // the call talks in words of 0.8 s with 0.3 s gaps; one longer pause near the 10 s mark
  const n = IN * 31;
  const gapAt = (i) => (i >= IN * 9.0 && i < IN * 9.5);
  const call = voice(n, { level: 0.12, on: (i) => !gapAt(i) && (i % Math.round(IN * 1.1)) < IN * 0.8 });
  const chunks = [];
  const c = makeChunker({ names: ['system'], source: 'system', onChunk: (b64, info) => chunks.push({ b64, info }) });
  feed(c, { system: call }, 0, IN * 10);
  c.flush({ atPause: true });
  const first = chunks[0];
  const pcm = (b) => { const buf = Buffer.from(b, 'base64'); const n16 = (buf.length - 44) >> 1; const x = new Float32Array(n16); for (let i = 0; i < n16; i++) x[i] = buf.readInt16LE(44 + 2 * i) / 32768; return x; };
  const end = first ? first.info.seconds : 0;
  check('timed chunk is cut inside a pause, not at the 10 s mark', end > 8.6 && end < 9.6, `cut at ${end.toFixed(2)} s`);
  if (first) {
    const x = pcm(first.b64); let tail = 0; for (let i = x.length - 800; i < x.length; i++) tail = Math.max(tail, Math.abs(x[i]));
    check('…the last 50 ms of the chunk are quiet (no word cut in two)', tail < 0.02, `peak ${tail.toFixed(4)}`);
  }
  feed(c, { system: call }, IN * 10, IN * 20);
  c.flush({ atPause: true });
  feed(c, { system: call }, IN * 20, n);
  c.flush(); // Ask: everything, now
  const sent = chunks.reduce((s, ch) => s + pcm(ch.b64).length, 0);
  const produced = Math.floor(IN * 31 / BLOCK) * BLOCK / 3; // 16 kHz samples that went through the chain
  check('every sample is in exactly one chunk', Math.abs(sent - produced) < 400, `${sent} sent of ~${Math.round(produced)} (resampler holds back ~100)`);
  check('Ask flush leaves nothing behind', c.buffers.system.length === 0);
}

// 4. silent chunks are still skipped (they cost a request with Gemini)
{
  const c = makeChunker({ onChunk: () => { throw new Error('should not send'); } });
  const n = IN * 6; const quiet = new Float32Array(n); for (let i = 0; i < n; i++) quiet[i] = 0.0003 * rnd();
  feed(c, { system: new Float32Array(n), mic: quiet });
  let threw = false; try { c.flush({ atPause: true }); } catch { threw = true; }
  check('a chunk of room noise is not sent', !threw && c.stats.chunksSkippedSilent === 1);
}

// 5. live mode: frames per source, int16 base64, as before
{
  const frames = [];
  const c = makeChunker({ onFrame: (name, b64, info) => frames.push({ name, n: Buffer.from(b64, 'base64').length / 2, info }) });
  const n = IN * 3;
  feed(c, { system: voice(n, { level: 0.1 }), mic: voice(n, { level: 0.05 }) });
  const sys = frames.filter((f) => f.name === 'system'), mic = frames.filter((f) => f.name === 'mic');
  check('live: system frames streamed (~1365 samples each; the first is shorter by the resampler look-ahead)', sys.length >= 30 && sys.slice(1).every((f) => Math.abs(f.n - 1365) <= 2), sys.slice(0, 4).map((f) => f.n).join(','));
  check('live: mic frames streamed after the canceller', mic.length > 0 && mic.reduce((s, f) => s + f.n, 0) > OUT * 2);
  check('live: nothing buffered for chunks', c.buffers.system.length === 0 && c.buffers.mic.length === 0);
}

console.log(failures ? `audio-chunk: ${failures} FAILED` : 'audio-chunk: all checks passed');
process.exit(failures ? 1 : 0);
