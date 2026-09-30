// Worker thread hosting the streaming recognizer and the voice-activity
// detector, so model load and per-frame decoding never block the main process.
//
// Two jobs per audio source:
//   * streaming recognizer -> live partial text (what is being said right now)
//   * Silero VAD           -> where each stretch of speech starts and ends
// Every speech segment the VAD finds is handed over WITH its audio (padded a
// little on both sides) so the accuracy pass (a second worker) transcribes it —
// whether or not the streaming model managed to hear words in it. Previously a
// segment only got that far if the streaming model had text for it, so quiet or
// unclear speech was lost outright, and segments were cut at the streaming
// model's own pause detector with no padding (clipped first/last words).
//
// Protocol (postMessage):
//   -> { type:'init', modelDir, files, modelType, vadModel }  <- { type:'ready', ms, vad } | { type:'init-error', error }
//   -> { type:'open', id }                          (creates a stream for an audio source)
//   -> { type:'audio', id, samples: Float32Array }  <- { type:'interim', id, text } / { type:'final', id, uid, text, audio, seconds }
//   -> { type:'nudge', id }                         (commit whatever is being said right now)
//   -> { type:'sync', id }                          <- { type:'synced', id } once everything before it is decoded
//   -> { type:'close', id }
// 'final'.text is the streaming model's hypothesis for the segment and may be ''.
const { parentPort } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const { makeFastGain, levelSegment } = require('./stt-level');

const RATE = 16000;
const PRE_PAD = Math.round(0.40 * RATE);  // kept before the detected start: soft onsets, first consonants
const POST_PAD = Math.round(0.25 * RATE); // kept after the detected end: trailing syllables
const CONTIG_PAD = RATE * 3;              // reach-back for the segment that follows a forced split
const KEEP = RATE * 45;                   // recent audio kept per stream
const MAX_SEG = RATE * 30;                // longest segment handed to the accuracy pass
const MIN_SEG = Math.round(0.2 * RATE);
const DEBUG = !!process.env.GHOST_STT_DEBUG; // log every segment's boundaries

let sherpa = null;
let rec = null;
let vadCfg = null;
const streams = new Map(); // id -> stream state
let uidCounter = 0;

function tidy(text) {
  const t = text.trim().toLowerCase();
  if (!t) return '';
  return t.replace(/\bi\b/g, 'I').replace(/^./, (c) => c.toUpperCase());
}
function makeVad() {
  if (!vadCfg) return null;
  try { return new sherpa.Vad(vadCfg, 60); }
  catch (e) { parentPort.postMessage({ type: 'log', text: `voice-activity detector unavailable (${e.message}); using the recognizer's own pause detection` }); vadCfg = null; return null; }
}

// ---- per-stream ring of recent audio, addressed by absolute sample index
function ringPush(st, samples) {
  st.chunks.push({ start: st.total, data: samples });
  st.total += samples.length;
  while (st.chunks.length > 1 && st.chunks[0].start + st.chunks[0].data.length < st.total - KEEP) st.chunks.shift();
}
function ringSlice(st, a, b) {
  a = Math.max(a, st.chunks.length ? st.chunks[0].start : 0); b = Math.min(b, st.total);
  const out = new Float32Array(Math.max(0, b - a));
  for (const c of st.chunks) {
    const cs = c.start, ce = cs + c.data.length;
    if (ce <= a) continue; if (cs >= b) break;
    const from = Math.max(a, cs), to = Math.min(b, ce);
    out.set(c.data.subarray(from - cs, to - cs), from - a);
  }
  return out;
}

// Hand one speech segment [startAbs, endAbs) over, padded, never overlapping the previous one.
function emitSegment(id, st, startAbs, endAbs, why = 'vad', postPad = POST_PAD) {
  // After a forced split (Ask pressed, or noise holding the detector open) the VAD
  // restarts cold and finds the next sentence late: reach back to where the
  // previous segment ended so no audio between the two is skipped.
  const from = Math.max(startAbs - (st.contig ? CONTIG_PAD : PRE_PAD), st.lastSegEnd);
  st.contig = false;
  const to = Math.min(endAbs + postPad, st.total, from + MAX_SEG);
  if (to - Math.max(startAbs, st.lastSegEnd) < MIN_SEG) return; // already covered by the previous segment
  // level the segment with look-ahead: a quiet talker and a loud one end up equally loud
  const audio = levelSegment(ringSlice(st, from, to));
  st.lastSegEnd = Math.min(endAbs, to);
  const text = st.last;
  rec.reset(st.s); st.last = ''; st.textStart = -1;
  if (!audio.length) return;
  // an Ask snapshot already put a line on screen for this speech: finish that line rather than add one
  const uid = st.openUid || `${id}-${++uidCounter}`;
  st.openUid = null;
  if (DEBUG) parentPort.postMessage({ type: 'log', id, text: `segment ${uid} ${why}: speech ${(startAbs / RATE).toFixed(2)}–${(endAbs / RATE).toFixed(2)} s, audio ${(from / RATE).toFixed(2)}–${(to / RATE).toFixed(2)} s, rms ${Math.sqrt(audio.reduce((s, v) => s + v * v, 0) / audio.length).toFixed(4)}, streaming text: "${text.slice(0, 60)}"` });
  parentPort.postMessage({ type: 'final', id, uid, text, audio, seconds: audio.length / RATE }, [audio.buffer]);
  parentPort.postMessage({ type: 'interim', id, text: '' });
}
function drainVad(id, st) {
  while (!st.vad.isEmpty()) {
    const seg = st.vad.front(false);
    st.vad.pop();
    const startAbs = st.vadBase + seg.start;
    emitSegment(id, st, startAbs, startAbs + seg.samples.length);
  }
}
// Centre of the quietest 60 ms in [a, b): where a pause actually is.
function quietestPoint(st, a, b) {
  a = Math.max(a, st.chunks.length ? st.chunks[0].start : 0, st.lastSegEnd);
  const x = ringSlice(st, a, b);
  const W = 960; let best = Infinity, at = x.length;
  for (let i = 0; i + W <= x.length; i += 160) { let s = 0; for (let j = i; j < i + W; j++) s += x[j] * x[j]; if (s < best) { best = s; at = i + W / 2; } }
  return a + at;
}
// Steady noise can hold the VAD "open" across real pauses. The recognizer heard a
// pause after words — but it notices ~1 s late, when the next sentence may have
// begun. So cut at the pause itself (the quietest recent point), hand the tail
// back to a fresh VAD, and let the next segment reach back to the cut.
function splitAtPause(id, st) {
  const cut = quietestPoint(st, st.total - RATE * 1.5, st.total - 800);
  st.vad.flush();
  while (!st.vad.isEmpty()) {
    const seg = st.vad.front(false); st.vad.pop();
    const s0 = st.vadBase + seg.start;
    if (s0 < cut) emitSegment(id, st, s0, Math.min(s0 + seg.samples.length, cut), 'pause-split', 0);
  }
  if (st.last) emitSegment(id, st, st.textStart >= 0 ? st.textStart : st.lastSegEnd, cut, 'pause-split', 0);
  st.vad.reset(); st.vadBase = cut;
  const tail = ringSlice(st, cut, st.total);
  if (tail.length) st.vad.acceptWaveform(st.fast(tail));
  st.lastSegEnd = Math.max(st.lastSegEnd, cut);
  st.contig = true;
}
// "Ask" was pressed: the answer needs what is being said right now, but cutting
// the audio here could split a word. Send a snapshot of the speech so far under
// a uid; when the sentence finishes naturally the same uid carries the complete
// segment and the line is replaced. Nothing is reset, nothing is lost.
function snapshot(id, st) {
  if (!st.last && !(st.vad && st.vad.isDetected())) return;
  const from = st.textStart >= 0 ? Math.max(st.lastSegEnd, st.textStart - RATE * 1.5) : Math.max(st.lastSegEnd, st.total - RATE * 8);
  const audio = levelSegment(ringSlice(st, from, st.total));
  if (audio.length < MIN_SEG) return;
  if (!st.openUid) st.openUid = `${id}-${++uidCounter}`;
  if (DEBUG) parentPort.postMessage({ type: 'log', id, text: `segment ${st.openUid} snapshot: audio ${(from / RATE).toFixed(2)}–${(st.total / RATE).toFixed(2)} s, streaming text: "${st.last.slice(0, 60)}"` });
  parentPort.postMessage({ type: 'final', id, uid: st.openUid, text: st.last, audio, seconds: audio.length / RATE, snapshot: true }, [audio.buffer]);
}
// Commit everything in progress (the stream is closing).
function flush(id, st) {
  if (st.vad) {
    st.vad.flush(); drainVad(id, st);
    st.vad.reset(); st.vadBase = st.total;
  }
  // words the streaming model has that no VAD segment covered
  if (st.last) emitSegment(id, st, st.textStart >= 0 ? st.textStart : Math.max(st.lastSegEnd, st.total - RATE * 10), st.total, 'flush');
  st.contig = true;
}

parentPort.on('message', (m) => {
  try {
    if (m.type === 'init') {
      const t0 = Date.now();
      sherpa = require('sherpa-onnx-node');
      const d = m.modelDir, f = m.files;
      rec = new sherpa.OnlineRecognizer({
        featConfig: { sampleRate: RATE, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: path.join(d, f.encoder), decoder: path.join(d, f.decoder), joiner: path.join(d, f.joiner) },
          tokens: path.join(d, f.tokens), numThreads: 2, provider: 'cpu', debug: 0,
          ...(m.modelType ? { modelType: m.modelType } : {}),
        },
        decodingMethod: 'greedy_search',
        enableEndpoint: true,
        rule1MinTrailingSilence: 2.0, rule2MinTrailingSilence: 0.9, rule3MinUtteranceLength: 25,
      });
      vadCfg = m.vadModel && fs.existsSync(m.vadModel)
        ? { sileroVad: { model: m.vadModel, threshold: 0.4, minSilenceDuration: 0.55, minSpeechDuration: 0.2, windowSize: 512, maxSpeechDuration: 22 }, sampleRate: RATE, numThreads: 1, provider: 'cpu', debug: 0 }
        : null;
      if (vadCfg && !makeVad()) vadCfg = null; // make sure it actually loads
      parentPort.postMessage({ type: 'ready', ms: Date.now() - t0, vad: !!vadCfg });
    } else if (m.type === 'open') {
      if (!rec) throw new Error('recognizer not initialised');
      streams.set(m.id, { s: rec.createStream(), last: '', textStart: -1, vad: makeVad(), fast: makeFastGain(), vadBase: 0, total: 0, chunks: [], lastSegEnd: 0, openUid: null, contig: false });
    } else if (m.type === 'audio') {
      const st = streams.get(m.id); if (!st) return;
      const samples = m.samples;
      ringPush(st, samples);
      st.s.acceptWaveform({ sampleRate: m.sampleRate || RATE, samples });
      while (rec.isReady(st.s)) rec.decode(st.s);
      const text = tidy(rec.getResult(st.s).text);
      if (text !== st.last) {
        if (!st.last && text) st.textStart = Math.max(st.lastSegEnd, st.total - samples.length - RATE); // the streaming model lags ~1 s
        st.last = text;
        parentPort.postMessage({ type: 'interim', id: m.id, text });
      }
      if (st.vad) {
        st.vad.acceptWaveform(st.fast(samples)); // the detector gets a fast-levelled copy so quiet speech is caught from its first syllable
        drainVad(m.id, st);
        // The recognizer heard words and then a pause, but the VAD never fired
        // (very soft speech): don't lose them — commit on the recognizer's pause.
        if (st.last && rec.isEndpoint(st.s) && st.vad.isEmpty()) {
          if (!st.vad.isDetected()) emitSegment(m.id, st, st.textStart >= 0 ? st.textStart : st.lastSegEnd, st.total, 'recognizer-pause');
          else splitAtPause(m.id, st);
        }
      } else if (rec.isEndpoint(st.s)) {
        if (st.last) emitSegment(m.id, st, st.textStart >= 0 ? st.textStart : st.lastSegEnd, st.total);
        else rec.reset(st.s);
      }
    } else if (m.type === 'nudge') {
      const st = streams.get(m.id); if (st) snapshot(m.id, st);
    } else if (m.type === 'sync') {
      parentPort.postMessage({ type: 'synced', id: m.id });
    } else if (m.type === 'close') {
      const st = streams.get(m.id); if (!st) return;
      flush(m.id, st);
      try { st.s.inputFinished?.(); } catch {}
      streams.delete(m.id);
    }
  } catch (e) {
    parentPort.postMessage({ type: m.type === 'init' ? 'init-error' : 'error', id: m.id, error: e.message || String(e) });
  }
});
