// Loudness handling for the local recognizer. People on a call are not equally
// loud (a quiet talker right after a loud one can be 20+ dB down), and a slow,
// clean real-time gain cannot follow that. Two tools, used in the worker:
//
//   makeFastGain()  – causal, fast-reacting gain for the voice-activity detector
//                     ONLY. It may pump, which a detector does not care about; it
//                     makes quiet speech detectable from its first syllable.
//   levelSegment()  – non-causal levelling of a finished speech segment before
//                     the accuracy pass: with look-ahead, every talker in the
//                     segment is brought to the same loudness without pumping.
const RATE = 16000;

function makeFastGain({ target = 0.2, maxGain = 40, floor = 0.0008, block = 160, release = 0.035 } = {}) {
  let env = 0;
  return (x) => {
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i += block) {
      const e = Math.min(x.length, i + block);
      let p = 0; for (let j = i; j < e; j++) { const a = x[j] < 0 ? -x[j] : x[j]; if (a > p) p = a; }
      if (p > floor) env = p > env ? p : env + (p - env) * release; // instant attack, ~0.3 s release (10 ms blocks)
      const g = env > floor ? Math.min(maxGain, Math.max(1, target / env)) : 1;
      for (let j = i; j < e; j++) { const v = x[j] * g; out[j] = v > 1 ? 1 : v < -1 ? -1 : v; }
    }
    return out;
  };
}

function levelSegment(x, { target = 0.08, maxGain = 60, minGain = 0.25, floor = 0.0004, windowSec = 0.05, lookSec = 0.4, smoothSec = 0.2 } = {}) {
  const W = Math.round(windowSec * RATE);
  const n = Math.ceil(x.length / W);
  if (n < 2) return x;
  // short-term level per 50 ms window
  const env = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const a = k * W, b = Math.min(x.length, a + W);
    let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i];
    env[k] = Math.sqrt(s / (b - a));
  }
  // the talker's level around each window = loudest window within ±lookSec
  // (follows who is speaking, not the gaps between their words)
  const R = Math.max(1, Math.round(lookSec / windowSec));
  const gain = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let m = 0; for (let j = Math.max(0, k - R); j <= Math.min(n - 1, k + R); j++) if (env[j] > m) m = env[j];
    gain[k] = m > floor ? Math.min(maxGain, Math.max(minGain, target / m)) : 0; // 0 = silence, decided below
  }
  // silence takes the gain of the nearest speech (forward, then backward fill)
  let last = 0;
  for (let k = 0; k < n; k++) { if (gain[k]) last = gain[k]; else gain[k] = last; }
  last = 0;
  for (let k = n - 1; k >= 0; k--) { if (gain[k]) last = gain[k]; else gain[k] = last || 1; }
  // smooth the gain curve so it never steps
  const S = Math.max(1, Math.round(smoothSec / windowSec));
  const sm = new Float32Array(n);
  for (let k = 0; k < n; k++) { let s = 0, c = 0; for (let j = Math.max(0, k - S); j <= Math.min(n - 1, k + S); j++) { s += gain[j]; c++; } sm[k] = s / c; }
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const p = i / W - 0.5;
    const k0 = Math.max(0, Math.min(n - 1, Math.floor(p))), k1 = Math.min(n - 1, k0 + 1);
    const f = Math.max(0, Math.min(1, p - k0));
    const v = x[i] * (sm[k0] * (1 - f) + sm[k1] * f);
    out[i] = v > 0.99 ? 0.99 : v < -0.99 ? -0.99 : v;
  }
  return out;
}

module.exports = { makeFastGain, levelSegment };
