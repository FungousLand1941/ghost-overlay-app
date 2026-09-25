// Local, free, offline streaming speech-to-text (sherpa-onnx streaming
// Zipformer, int8). Same event interface as gemini-live.js so the app can
// swap engines: 'interim' (partial text), 'final' (utterance done), 'status',
// 'error', 'log'. The recognizer lives in a worker thread
// (local-stt-worker.js) so the ~6 s model load and per-frame decoding never
// block the main process; each audio source is one stream inside it.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Worker } = require('worker_threads');

// Local models (streaming transducers, from Hugging Face as individual files).
//   nemo: NVIDIA FastConformer — trained on thousands of hours of varied real speech,
//         far more robust on laptop mics / accents (18/18 on the reference clip), ~480 MB, ~0.37 RTF.
//   zipformer: light LibriSpeech model, ~72 MB, ~0.11 RTF; weaker on real-world audio.
const MODELS = {
  'nemo-fastconformer-en-80ms': {
    id: 'nemo-fastconformer-en-80ms', label: 'NVIDIA FastConformer (accurate, 480 MB)',
    base: 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-80ms/resolve/main',
    files: { encoder: 'encoder.onnx', decoder: 'decoder.onnx', joiner: 'joiner.onnx', tokens: 'tokens.txt' },
    minBytes: { encoder: 400e6, decoder: 10e6, joiner: 4e6, tokens: 5000 },
    modelType: 'nemo_transducer',
  },
  'zipformer-en-2023-06-26-int8': {
    id: 'zipformer-en-2023-06-26-int8', label: 'Zipformer int8 (light, 72 MB)',
    base: 'https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26/resolve/main',
    files: {
      encoder: 'encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
      decoder: 'decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
      joiner: 'joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
      tokens: 'tokens.txt',
    },
    minBytes: { encoder: 60e6, decoder: 1e6, joiner: 2e5, tokens: 1000 },
    modelType: '',
  },
};
// Accuracy pass (offline, utterance-level): NVIDIA Parakeet TDT 0.6B v3 — top of the
// open ASR leaderboard, punctuation + casing, 25 languages, ~670 MB, ~0.2 RTF on CPU.
const REFINE_MODEL = {
  id: 'parakeet-tdt-0.6b-v3-int8', label: 'NVIDIA Parakeet TDT 0.6B v3 (accuracy pass)',
  base: 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main',
  files: { encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx', joiner: 'joiner.int8.onnx', tokens: 'tokens.txt' },
  minBytes: { encoder: 600e6, decoder: 10e6, joiner: 5e6, tokens: 50000 },
  modelType: 'nemo_transducer',
};
const DEFAULT_MODEL = 'nemo-fastconformer-en-80ms';
let MODEL = MODELS[DEFAULT_MODEL];
// Switch the active model (e.g. from settings); the worker reloads on next use.
function setModel(id) {
  const m = MODELS[id] || MODELS[DEFAULT_MODEL];
  if (m !== MODEL) { MODEL = m; shutdown(); }
  return MODEL.id;
}

let modelsDirFn = null;
function init(getModelsDir) { modelsDirFn = getModelsDir; }
function modelDir(m = MODEL) { return path.join(modelsDirFn(), m.id); }
function modelReady(m = MODEL) {
  try { return Object.entries(m.files).every(([k, f]) => fs.statSync(path.join(modelDir(m), f)).size >= m.minBytes[k]); } catch { return false; }
}
function modelInfo(m = MODEL) {
  let bytes = 0; try { for (const f of Object.values(m.files)) bytes += fs.statSync(path.join(modelDir(m), f)).size; } catch {}
  return { id: m.id, ready: modelReady(m), bytes, dir: modelDir(m), loaded: m === MODEL ? workerState === 'ready' : refineState === 'ready' };
}

// Download missing files with progress; resolves when all present.
async function ensureModel(onProgress = () => {}, m = MODEL) {
  if (modelReady(m)) return modelInfo(m);
  fs.mkdirSync(modelDir(m), { recursive: true });
  for (const [k, f] of Object.entries(m.files)) {
    const dest = path.join(modelDir(m), f);
    try { if (fs.statSync(dest).size >= m.minBytes[k]) continue; } catch {}
    const url = `${m.base}/${f}`;
    onProgress({ file: f, pct: 0 });
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`download failed ${res.status} for ${f}`);
    const total = +res.headers.get('content-length') || 0;
    const tmp = dest + '.part';
    const out = fs.createWriteStream(tmp);
    let got = 0, lastPct = -1;
    for await (const chunk of res.body) {
      out.write(chunk); got += chunk.length;
      const pct = total ? Math.floor((got / total) * 100) : 0;
      if (pct !== lastPct) { lastPct = pct; onProgress({ file: f, pct, got, total }); }
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
    if (fs.statSync(tmp).size < m.minBytes[k]) { fs.unlinkSync(tmp); throw new Error(`downloaded ${f} is too small — network problem?`); }
    fs.renameSync(tmp, dest);
  }
  return modelInfo(m);
}

// ---------------------------------------------------------------- shared worker
let worker = null;
let workerState = 'idle'; // idle | loading | ready | failed
let readyPromise = null;
const byId = new Map();   // stream id -> LocalTranscriber
let nextId = 1;

function workerPath() {
  // packaged: the worker (and the native module it requires) live in app.asar.unpacked
  return path.join(__dirname, 'local-stt-worker.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

function startWorker() {
  if (readyPromise) return readyPromise;
  workerState = 'loading';
  readyPromise = new Promise((resolve, reject) => {
    const t0 = Date.now();
    worker = new Worker(workerPath());
    worker.on('message', (m) => {
      if (m.type === 'ready') { workerState = 'ready'; resolve({ ms: m.ms }); return; }
      if (m.type === 'init-error') { workerState = 'failed'; reject(new Error(m.error)); return; }
      const t = byId.get(m.id); if (!t) return;
      if (m.type === 'interim') { t.lastPartial = m.text; t.emit('interim', m.text); }
      else if (m.type === 'final') {
        // provisional line now; the accuracy pass revises it (same uid) when done
        t.emit('final', m.text, { uid: m.uid, provisional: refineEnabled && refineState !== 'failed' });
        if (refineEnabled && m.audio && m.audio.length >= 16000 * 0.4) refine(t, m.uid, m.audio);
      }
      else if (m.type === 'error') t.emit('error', Object.assign(new Error(`local STT failed: ${m.error}`), { code: 'LOCAL' }));
    });
    worker.on('error', (e) => { workerState = 'failed'; reject(e); for (const t of byId.values()) t.emit('error', Object.assign(new Error(`local STT worker crashed: ${e.message}`), { code: 'LOCAL' })); });
    worker.on('exit', () => { if (workerState !== 'ready') reject(new Error('local STT worker exited during load')); worker = null; workerState = 'idle'; readyPromise = null; });
    worker.postMessage({ type: 'init', modelDir: modelDir(), files: MODEL.files, modelType: MODEL.modelType || '' });
    if (refineEnabled) startRefiner().catch(() => {});
    setTimeout(() => { if (workerState === 'loading') reject(new Error(`local STT model load timed out after ${Date.now() - t0} ms`)); }, 90000);
  });
  return readyPromise;
}

// ---------------------------------------------------------------- accuracy pass (second worker)
let refineEnabled = true;
let refiner = null;
let refineState = 'idle'; // idle | loading | ready | failed
let refinePromise = null;
const pendingRefine = new Map(); // uid -> { t, at, seconds }
let onRefineLog = () => {};
function setRefine(enabled) { refineEnabled = !!enabled; if (!enabled) shutdownRefiner(); }
function refinerPath() { return path.join(__dirname, 'local-stt-refine-worker.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'); }
function startRefiner() {
  if (refinePromise) return refinePromise;
  refineState = 'loading';
  refinePromise = new Promise(async (resolve, reject) => {
    try { await ensureModel((p) => onRefineLog(`downloading accuracy model ${p.file} ${p.pct}%`), REFINE_MODEL); }
    catch (e) { refineState = 'failed'; refinePromise = null; onRefineLog(`accuracy model unavailable: ${e.message}`); return reject(e); }
    const t0 = Date.now();
    refiner = new Worker(refinerPath());
    refiner.on('message', (m) => {
      if (m.type === 'ready') { refineState = 'ready'; onRefineLog(`accuracy pass ready (${REFINE_MODEL.id}, load ${m.ms} ms)`); resolve(); return; }
      if (m.type === 'init-error') { refineState = 'failed'; onRefineLog(`accuracy pass failed to load: ${m.error}`); reject(new Error(m.error)); return; }
      const p = pendingRefine.get(m.uid);
      if (!p) { // not a live utterance: a file segment (video/audio context)
        const f = pendingFile.get(m.uid);
        if (f) { pendingFile.delete(m.uid); if (m.type === 'refined') f.resolve((m.text || '').trim()); else f.reject(new Error(m.error || 'recognition failed')); }
        return;
      }
      pendingRefine.delete(m.uid);
      if (m.type === 'refined') p.t.emit('revise', { uid: m.uid, text: m.text, ms: m.ms, seconds: m.seconds });
      else p.t.emit('revise', { uid: m.uid, text: '', error: m.error });
    });
    refiner.on('error', (e) => { refineState = 'failed'; onRefineLog(`accuracy worker crashed: ${e.message}`); for (const [uid, p] of pendingRefine) p.t.emit('revise', { uid, text: '', error: e.message }); pendingRefine.clear(); failFiles(e); reject(e); });
    refiner.on('exit', () => { refiner = null; if (refineState !== 'failed') refineState = 'idle'; refinePromise = null; failFiles(new Error('speech recogniser exited')); });
    refiner.postMessage({ type: 'init', modelDir: modelDir(REFINE_MODEL), files: REFINE_MODEL.files, modelType: REFINE_MODEL.modelType });
    setTimeout(() => { if (refineState === 'loading') { refineState = 'failed'; reject(new Error(`accuracy model load timed out after ${Date.now() - t0} ms`)); } }, 120000);
  });
  return refinePromise;
}
// Whole-file recognition (video / audio context): same accuracy model, one segment at a time.
const pendingFile = new Map(); // uid -> { resolve, reject }
let fileUid = 0;
function failFiles(err) { for (const f of pendingFile.values()) f.reject(err); pendingFile.clear(); }
async function transcribeSamples(samples) {
  await startRefiner();
  return new Promise((resolve, reject) => {
    const uid = `file${++fileUid}`;
    pendingFile.set(uid, { resolve, reject });
    refiner.postMessage({ type: 'refine', uid, samples, sampleRate: 16000 }, [samples.buffer]);
  });
}
function refine(t, uid, audio) {
  if (refineState === 'failed') return;
  pendingRefine.set(uid, { t, at: Date.now(), seconds: audio.length / 16000 });
  const send = () => { if (refiner && refineState === 'ready') refiner.postMessage({ type: 'refine', uid, samples: audio, sampleRate: 16000 }, [audio.buffer]); else { pendingRefine.delete(uid); t.emit('revise', { uid, text: '', error: 'refiner not ready' }); } };
  if (refineState === 'ready') send(); else startRefiner().then(send, () => { pendingRefine.delete(uid); t.emit('revise', { uid, text: '', error: 'refiner unavailable' }); });
}
function refinePending() { return pendingRefine.size; }
function shutdownRefiner() { try { refiner?.terminate(); } catch {} refiner = null; refineState = 'idle'; refinePromise = null; pendingRefine.clear(); failFiles(new Error('speech recogniser shut down')); }

// Load the models in the background at app start so a mid-call fallback is instant.
async function warmUp() { if (!modelReady()) return false; try { await startWorker(); return true; } catch { return false; } }
function shutdown() { try { worker?.terminate(); } catch {} worker = null; workerState = 'idle'; readyPromise = null; shutdownRefiner(); }

class LocalTranscriber extends EventEmitter {
  constructor({ sampleRate = 16000 } = {}) {
    super();
    this.sampleRate = sampleRate;
    this.ready = false;
    this.closed = false;
    this.lastPartial = '';
    this.framesSent = 0;
    this.id = nextId++;
  }

  async connect() {
    const info = await ensureModel((p) => this.emit('status', `downloading speech model ${p.file} ${p.pct}%`));
    const t0 = Date.now();
    const { ms } = await startWorker();
    if (this.closed) throw new Error('cancelled');
    byId.set(this.id, this);
    worker.postMessage({ type: 'open', id: this.id });
    this.ready = true;
    this.emit('log', `local STT ready (${MODEL.id}, ${(info.bytes / 1e6).toFixed(0)} MB, model load ${ms} ms, waited ${Date.now() - t0} ms, off main thread)`);
    this.emit('status', 'local offline transcription ready');
    return 'local:' + MODEL.id;
  }

  sendAudio(base64Pcm16) {
    if (!this.ready || this.closed || !worker) return;
    const buf = Buffer.from(base64Pcm16, 'base64');
    const n = buf.length >> 1;
    const f32 = new Float32Array(n);
    for (let i = 0; i < n; i++) f32[i] = buf.readInt16LE(i * 2) / 32768;
    this.framesSent++;
    worker.postMessage({ type: 'audio', id: this.id, sampleRate: this.sampleRate, samples: f32 }, [f32.buffer]);
  }

  // "Ask" was pressed: commit whatever is being said right now.
  nudge() { if (this.ready && worker) worker.postMessage({ type: 'nudge', id: this.id }); }

  close() {
    if (this.closed) return;
    this.closed = true; this.ready = false;
    if (worker) { try { worker.postMessage({ type: 'close', id: this.id }); } catch {} }
    // keep routing for a moment so the final emitted by 'close' still reaches listeners
    setTimeout(() => byId.delete(this.id), 500);
  }
}

module.exports = { LocalTranscriber, init, ensureModel, modelReady, modelInfo, warmUp, shutdown, setModel, setRefine, refinePending, transcribeSamples, startRefiner, MODELS, REFINE_MODEL, DEFAULT_MODEL, get MODEL() { return MODEL; }, get refineState() { return refineState; }, set onRefineLog(f) { onRefineLog = f; } };
