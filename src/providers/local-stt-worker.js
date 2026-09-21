// Worker thread hosting the sherpa-onnx streaming recognizer, so the model load
// and per-frame decoding never block the Electron main process. Protocol (postMessage):
//   -> { type:'init', modelDir, files, modelType }  <- { type:'ready', ms } | { type:'init-error', error }
//   -> { type:'open', id }                          (creates a stream for an audio source)
//   -> { type:'audio', id, samples: Float32Array }  <- { type:'interim', id, text } / { type:'final', id, uid, text, audio: Float32Array }
//   -> { type:'nudge', id }                         (commit the current partial)
//   -> { type:'close', id }
// Each finalized utterance carries its own audio so the accuracy pass (a second
// worker) can re-transcribe it.
const { parentPort } = require('worker_threads');
const path = require('path');

let rec = null;
const streams = new Map(); // id -> { s, last, chunks, samples }
const MAX_UTTERANCE_SAMPLES = 16000 * 40; // 40 s cap on audio kept per utterance
let uidCounter = 0;

function tidy(text) {
  const t = text.trim().toLowerCase();
  if (!t) return '';
  return t.replace(/\bi\b/g, 'I').replace(/^./, (c) => c.toUpperCase());
}
function takeAudio(st) {
  const total = Math.min(st.samples, MAX_UTTERANCE_SAMPLES);
  const out = new Float32Array(total);
  let off = 0;
  for (const c of st.chunks) { const n = Math.min(c.length, total - off); if (n <= 0) break; out.set(c.subarray(0, n), off); off += n; }
  st.chunks = []; st.samples = 0;
  return out;
}
function finalize(id) {
  const st = streams.get(id); if (!st) return;
  const text = st.last;
  const audio = takeAudio(st);
  rec.reset(st.s); st.last = '';
  if (text) {
    const uid = `${id}-${++uidCounter}`;
    parentPort.postMessage({ type: 'final', id, uid, text, audio }, [audio.buffer]);
  }
  parentPort.postMessage({ type: 'interim', id, text: '' });
}

parentPort.on('message', (m) => {
  try {
    if (m.type === 'init') {
      const t0 = Date.now();
      const sherpa = require('sherpa-onnx-node');
      const d = m.modelDir, f = m.files;
      rec = new sherpa.OnlineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: path.join(d, f.encoder), decoder: path.join(d, f.decoder), joiner: path.join(d, f.joiner) },
          tokens: path.join(d, f.tokens), numThreads: 2, provider: 'cpu', debug: 0,
          ...(m.modelType ? { modelType: m.modelType } : {}),
        },
        decodingMethod: 'greedy_search',
        enableEndpoint: true,
        rule1MinTrailingSilence: 2.0, rule2MinTrailingSilence: 0.9, rule3MinUtteranceLength: 25,
      });
      parentPort.postMessage({ type: 'ready', ms: Date.now() - t0 });
    } else if (m.type === 'open') {
      if (!rec) throw new Error('recognizer not initialised');
      streams.set(m.id, { s: rec.createStream(), last: '', chunks: [], samples: 0 });
    } else if (m.type === 'audio') {
      const st = streams.get(m.id); if (!st) return;
      st.s.acceptWaveform({ sampleRate: m.sampleRate || 16000, samples: m.samples });
      if (st.samples < MAX_UTTERANCE_SAMPLES) { st.chunks.push(m.samples); st.samples += m.samples.length; }
      while (rec.isReady(st.s)) rec.decode(st.s);
      const text = tidy(rec.getResult(st.s).text);
      if (text !== st.last) { st.last = text; parentPort.postMessage({ type: 'interim', id: m.id, text }); }
      if (rec.isEndpoint(st.s)) finalize(m.id);
      else if (!text && st.samples > 16000 * 8) { st.chunks = []; st.samples = 0; } // long silence: don't hoard audio
    } else if (m.type === 'nudge') {
      const st = streams.get(m.id); if (st && st.last) finalize(m.id);
    } else if (m.type === 'close') {
      const st = streams.get(m.id); if (!st) return;
      if (st.last) finalize(m.id);
      try { st.s.inputFinished?.(); } catch {}
      streams.delete(m.id);
    }
  } catch (e) {
    parentPort.postMessage({ type: m.type === 'init' ? 'init-error' : 'error', id: m.id, error: e.message || String(e) });
  }
});
