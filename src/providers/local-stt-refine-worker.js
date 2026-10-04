// Accuracy pass: an offline (utterance-level) recognizer — NVIDIA Parakeet TDT
// 0.6B — in its own worker thread. The streaming worker hands over the audio of
// each speech segment; this one transcribes it (with punctuation and casing)
// and the transcript line is replaced. Never blocks streaming partials.
//   -> { type:'init', modelDir, files }            <- { type:'ready', ms } | { type:'init-error', error }
//   -> { type:'refine', uid, samples: Float32Array, sampleRate, hint }
//   <- { type:'refined', uid, text, ms, seconds, how }
//
// NEVER LOSE WORDS. On some audio the model returns nothing, or only one of two
// voices — typically when one voice follows another with almost no gap, i.e.
// exactly what fast back-and-forth talk looks like. Each part transcribes fine
// on its own. `hint` is what the streaming model heard in the same audio: less
// accurate wording, but complete. So the result must cover the hint's words;
// if it does not, the audio is split at its quietest point and the halves are
// transcribed separately (recursively) and the better-covering result wins;
// if even that falls short, the hint itself is returned. Without a hint the
// check is words per second of actual speech. Extra work only when the first
// try fell short.
const { parentPort } = require('worker_threads');
const path = require('path');

const RATE = 16000;
const CHUNK_SEC = 15; // only genuinely long audio is cut up front (at its quietest point); shorter single-voice stretches decode best whole
let rec = null;

// The model swallows words when the audio starts or stops abruptly on speech (a piece
// cut at a short pause has almost no lead-in), so every decode gets a little silence
// on both sides.
const PAD = Math.round(0.3 * RATE);
function decode(x) {
  const samples = new Float32Array(x.length + 2 * PAD); samples.set(x, PAD);
  const s = rec.createStream();
  s.acceptWaveform({ sampleRate: RATE, samples });
  rec.decode(s);
  return (rec.getResult(s).text || '').trim();
}
const norm = (t) => (t || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
const wordCount = (t) => norm(t).length;
// share of the hint's words (with multiplicity) that appear in the text
function coverage(text, hintWords) {
  if (!hintWords.length) return 1;
  const have = new Map(); for (const w of norm(text)) have.set(w, (have.get(w) || 0) + 1);
  let hit = 0; for (const w of hintWords) { const c = have.get(w) || 0; if (c > 0) { hit++; have.set(w, c - 1); } }
  return hit / hintWords.length;
}
// seconds of the audio that actually carry speech-level signal: 20 ms frames
// within ~20 dB of the segment's own loud frames (so it works at any volume)
function speechSeconds(x) {
  const W = 320; const r = [];
  for (let i = 0; i + W <= x.length; i += W) { let s = 0; for (let j = i; j < i + W; j++) s += x[j] * x[j]; r.push(Math.sqrt(s / W)); }
  if (!r.length) return 0;
  const loud = r.slice().sort((a, b) => a - b)[Math.floor(r.length * 0.9)];
  if (loud < 1e-4) return 0;
  let n = 0; for (const v of r) if (v > loud * 0.1) n++;
  return (n * W) / RATE;
}
// centre of the quietest 60 ms in the middle 60 % of the audio
function quietSplit(x) {
  const a = Math.floor(x.length * 0.2), b = Math.floor(x.length * 0.8), W = 960;
  let best = Infinity, at = x.length >> 1;
  for (let i = a; i + W <= b; i += 160) { let s = 0; for (let j = i; j < i + W; j++) s += x[j] * x[j]; if (s < best) { best = s; at = i + W / 2; } }
  return at;
}
// split-and-join transcription, to the given depth
function pieces(samples, depth) {
  const sec = samples.length / RATE;
  if (depth <= 0 || sec < 2.5) return decode(samples);
  const cut = quietSplit(samples);
  return [pieces(samples.slice(0, cut), depth - 1), pieces(samples.slice(cut), depth - 1)].filter(Boolean).join(' ');
}
function transcribe(samples, hint) {
  const sec = samples.length / RATE;
  const hintWords = norm(hint);
  // a hint with more words than this audio could hold (fast speech is ~4 words a second) is not this
  // audio's text: it would make a correct transcription look incomplete. Do not judge by it.
  const plausible = hintWords.length <= Math.max(4, (samples.length / 16000) * 5.5);
  const useHint = hintWords.length >= 4 && plausible;
  if (!useHint) {
    // No reference (the streaming model was shed, or heard nothing).
    // One pass (two halves if the audio is long). Only when that is clearly too
    // short for the speech present — nothing, or under a word a second — is a finer
    // split tried; the longer result wins. Segments normally arrive already cut at
    // real pauses, so this is a safety net, not the common path: cost stays ~1x.
    const depth = sec > CHUNK_SEC ? 1 : 0;
    const first = pieces(samples, depth);
    if (sec < 3 || wordCount(first) >= speechSeconds(samples) * 1.0) return { text: first, how: depth ? 'split x2' : 'whole' };
    const finer = pieces(samples, depth + 1);
    return wordCount(finer) > wordCount(first) ? { text: finer, how: `split x${2 ** (depth + 1)}` } : { text: first, how: depth ? 'split x2' : 'whole' };
  }
  // good enough = covers what the streaming model heard, or (no hint) a plausible number of words for the speech present
  const score = (t) => (useHint ? coverage(t, hintWords) : Math.min(1, wordCount(t) / Math.max(1, speechSeconds(samples) * 1.8)));
  const OK = useHint ? 0.8 : 1;
  let best = { text: '', score: -1, how: '' };
  const consider = (text, how) => { const sc = score(text); if (sc > best.score || (sc === best.score && wordCount(text) > wordCount(best.text))) best = { text, score: sc, how }; return sc >= OK; };
  // long audio goes in halves from the start; otherwise whole first, then finer splits only if it fell short
  const plans = sec > CHUNK_SEC ? [1, 2, 3] : [0, 1, 2];
  for (const depth of plans) {
    if (depth > 0 && sec < 3) break;
    if (consider(pieces(samples, depth), depth ? `split x${2 ** depth}` : 'whole')) return best;
  }
  // still short of what the streaming model heard: keep its words rather than lose them
  if (useHint && best.score < 0.6) return { text: hint, score: 1, how: 'kept streaming text' };
  return best;
}

parentPort.on('message', (m) => {
  try {
    if (m.type === 'init') {
      const t0 = Date.now();
      const sherpa = require('sherpa-onnx-node');
      const d = m.modelDir, f = m.files;
      rec = new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: RATE, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: path.join(d, f.encoder), decoder: path.join(d, f.decoder), joiner: path.join(d, f.joiner) },
          tokens: path.join(d, f.tokens), numThreads: Math.max(2, Math.min(4, require('os').cpus().length - 1)), provider: 'cpu', debug: 0,
          modelType: m.modelType || 'nemo_transducer',
        },
        decodingMethod: 'greedy_search',
      });
      parentPort.postMessage({ type: 'ready', ms: Date.now() - t0 });
    } else if (m.type === 'refine') {
      if (!rec) throw new Error('refiner not initialised');
      const t0 = Date.now();
      const r = transcribe(m.samples, m.hint || '');
      parentPort.postMessage({ type: 'refined', uid: m.uid, text: r.text, ms: Date.now() - t0, seconds: m.samples.length / (m.sampleRate || RATE), how: r.how });
    }
  } catch (e) {
    parentPort.postMessage({ type: m.type === 'init' ? 'init-error' : 'refine-error', uid: m.uid, error: e.message || String(e) });
  }
});
