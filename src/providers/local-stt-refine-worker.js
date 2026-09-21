// Accuracy pass: an offline (utterance-level) recognizer — NVIDIA Parakeet TDT
// 0.6B — in its own worker thread. The streaming worker hands over the audio of
// each finished utterance; this one re-transcribes it (with punctuation and
// casing) and the transcript line is replaced. Never blocks streaming partials.
//   -> { type:'init', modelDir, files }            <- { type:'ready', ms } | { type:'init-error', error }
//   -> { type:'refine', uid, samples: Float32Array, sampleRate }  <- { type:'refined', uid, text, ms }
const { parentPort } = require('worker_threads');
const path = require('path');

let rec = null;
parentPort.on('message', (m) => {
  try {
    if (m.type === 'init') {
      const t0 = Date.now();
      const sherpa = require('sherpa-onnx-node');
      const d = m.modelDir, f = m.files;
      rec = new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
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
      const s = rec.createStream();
      s.acceptWaveform({ sampleRate: m.sampleRate || 16000, samples: m.samples });
      rec.decode(s);
      const text = (rec.getResult(s).text || '').trim();
      parentPort.postMessage({ type: 'refined', uid: m.uid, text, ms: Date.now() - t0, seconds: m.samples.length / (m.sampleRate || 16000) });
    }
  } catch (e) {
    parentPort.postMessage({ type: m.type === 'init' ? 'init-error' : 'refine-error', uid: m.uid, error: e.message || String(e) });
  }
});
