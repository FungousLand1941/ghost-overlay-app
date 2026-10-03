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

// Voice-activity model (Silero, 0.6 MB, shipped with the app): finds every stretch of speech.
function vadPath() { return path.join(__dirname, '..', '..', 'assets', 'silero_vad.onnx').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'); }
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
      if (m.type === 'ready') { workerState = 'ready'; resolve({ ms: m.ms, vad: m.vad }); return; }
      if (m.type === 'init-error') { workerState = 'failed'; reject(new Error(m.error)); return; }
      const t = byId.get(m.id); if (!t) return;
      if (m.type === 'interim') { t.lastPartial = m.text; t.emit('interim', m.text); }
      else if (m.type === 'final') {
        // One speech segment (found by the VAD). If the streaming model has words
        // for it, show them now and let the accuracy pass revise the line (same
        // uid). If it heard nothing — quiet or unclear speech — the accuracy pass
        // alone decides, and its text arrives as a late final.
        const canRefine = refineEnabled && refineState !== 'failed' && m.audio && m.audio.length >= 16000 * 0.25;
        const shown = t._shown || (t._shown = new Set());
        (t._ends || (t._ends = new Map())).set(m.uid, m.end); // audio time each line ends at / starts at (lag measurement)
        if (!(t._starts || (t._starts = new Map())).has(m.uid)) t._starts.set(m.uid, m.start);
        if (shown.has(m.uid)) {
          // this line is already on screen (an Ask snapshot, now completed or re-snapshotted): update it in place
          if (canRefine) refine(t, m.uid, m.audio, false, m.text);
          else if (m.text) t.emit('revise', { uid: m.uid, text: m.text });
        } else {
          if (m.text) { shown.add(m.uid); t.emit('final', m.text, { uid: m.uid, provisional: canRefine }); }
          if (canRefine) refine(t, m.uid, m.audio, !m.text, m.text);
        }
      }
      else if (m.type === 'synced') { const r = t._syncs && t._syncs.shift(); if (r) r(); }
      else if (m.type === 'log') t.emit('log', m.text);
      else if (m.type === 'error') t.emit('error', Object.assign(new Error(`local STT failed: ${m.error}`), { code: 'LOCAL' }));
    });
    worker.on('error', (e) => { workerState = 'failed'; reject(e); for (const t of byId.values()) t.emit('error', Object.assign(new Error(`local STT worker crashed: ${e.message}`), { code: 'LOCAL' })); });
    worker.on('exit', () => { if (workerState !== 'ready') reject(new Error('local STT worker exited during load')); worker = null; workerState = 'idle'; readyPromise = null; });
    worker.postMessage({ type: 'init', modelDir: modelDir(), files: MODEL.files, modelType: MODEL.modelType || '', vadModel: vadPath() });
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
      if (m.uid === refineBusy) { refineBusy = null; setImmediate(pumpRefine); }
      if (m.type === 'refined' && m.seconds > 1) rtf = rtf ? rtf * 0.8 + (m.ms / 1000 / m.seconds) * 0.2 : m.ms / 1000 / m.seconds;
      const p = pendingRefine.get(m.uid); // m.uid is the job key here
      if (!p) { // not a live utterance: a file segment (video/audio context)
        const f = pendingFile.get(m.uid);
        if (f) { pendingFile.delete(m.uid); if (m.type === 'refined') f.resolve((m.text || '').trim()); else f.reject(new Error(m.error || 'recognition failed')); }
        return;
      }
      pendingRefine.delete(m.uid);
      const shown = p.t._shown || (p.t._shown = new Set());
      if (p.silent && !shown.has(p.uid)) {
        // nothing was shown for this segment yet; a lone word from a sub-second blip is more likely noise than speech
        const words = (m.text || '').trim().split(/\s+/).filter(Boolean).length;
        if (m.type === 'refined' && words && !(words === 1 && p.seconds < 1.5) && !(words === 2 && p.seconds < 1.0)) { shown.add(p.uid); p.t.emit('final', m.text, { uid: p.uid, provisional: false, late: true, ms: m.ms }); }
      }
      else if (m.type === 'refined') p.t.emit('revise', { uid: p.uid, text: m.text, ms: m.ms, seconds: m.seconds });
      else p.t.emit('revise', { uid: p.uid, text: '', error: m.error });
    });
    refiner.on('error', (e) => { refineState = 'failed'; onRefineLog(`accuracy worker crashed: ${e.message}`); for (const p of pendingRefine.values()) p.t.emit('revise', { uid: p.uid, text: '', error: e.message }); pendingRefine.clear(); failFiles(e); reject(e); });
    refiner.on('exit', () => { refiner = null; refineBusy = null; if (refineState !== 'failed') refineState = 'idle'; refinePromise = null; failFiles(new Error('speech recogniser exited')); });
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
// The accuracy pass runs one job at a time from a queue we control, so it can
// never fall unboundedly behind:
//   * a newer job for the same line (a later snapshot, or the finished sentence)
//     replaces a queued older one — only the latest audio is worth transcribing;
//   * if more than OVERLOAD_SEC of audio is waiting, the oldest lines that already
//     show the streaming model's text keep that text instead of being re-done.
let refineSeq = 0;
let refineBusy = null;       // key of the job the worker is on
const refineQueue = [];      // { key, uid, audio }
const OVERLOAD_SEC = 40;
const MAX_WAIT_MS = 20000;   // a segment that has waited this long is given up on (see refine())
let rtf = 0;                 // measured: seconds of CPU per second of audio in the accuracy pass (moving average)
function shedStale() {
  // Still older than MAX_WAIT_MS at the head with nothing left to shortcut: this computer
  // cannot transcribe as fast as people are talking. For a live assistant, staying current
  // beats completeness — being minutes behind is useless — so the oldest speech is skipped
  // (your own side first) and marked in the transcript rather than silently lost.
  const now = Date.now();
  while (refineQueue.length > 1 && now - refineQueue[0].at > MAX_WAIT_MS) {
    let i = refineQueue.findIndex((j) => j.kind === 'mic' && now - j.at > MAX_WAIT_MS); if (i < 0) i = 0;
    const j = refineQueue.splice(i, 1)[0]; const p = pendingRefine.get(j.key); pendingRefine.delete(j.key);
    const secs = Math.round(j.audio.length / 16000);
    if (p) {
      const shown = p.t._shown || (p.t._shown = new Set());
      if (shown.has(j.uid)) p.t.emit('revise', { uid: j.uid, text: '', skipped: true });
      else { shown.add(j.uid); p.t.emit('final', `[${secs} s of speech skipped — this computer could not keep up]`, { uid: j.uid, provisional: false, skipped: true }); }
    }
    onRefineLog(`overloaded: skipped ${secs} s of ${j.kind === 'mic' ? 'your' : 'call'} speech that had waited ${Math.round((now - j.at) / 1000)} s${rtf ? ` (accuracy pass runs at ${rtf.toFixed(2)}x real time here)` : ''}`);
  }
}
function pumpRefine() {
  if (refineBusy || !refineQueue.length || !refiner || refineState !== 'ready') return;
  shedStale();
  const job = refineQueue.shift();
  refineBusy = job.key;
  refiner.postMessage({ type: 'refine', uid: job.key, samples: job.audio, sampleRate: 16000, hint: job.hint }, [job.audio.buffer]);
}
// `hint`: what the streaming model heard in this audio — the accuracy pass must cover those words.
function refine(t, uid, audio, silent = false, hint = '') {
  if (refineState === 'failed') return;
  const key = `${uid}#${++refineSeq}`; // per job: the same line can be refined again (snapshot, then the finished sentence)
  for (let i = refineQueue.length - 1; i >= 0; i--) if (refineQueue[i].uid === uid) { pendingRefine.delete(refineQueue[i].key); refineQueue.splice(i, 1); } // superseded
  pendingRefine.set(key, { t, uid, at: Date.now(), seconds: audio.length / 16000, silent });
  refineQueue.push({ key, uid, audio, hint, at: Date.now(), kind: t.kind });
  let waiting = 0; for (const j of refineQueue) waiting += j.audio.length / 16000;
  for (let i = 0; waiting > OVERLOAD_SEC && i < refineQueue.length - 1;) {
    const j = refineQueue[i], p = pendingRefine.get(j.key);
    if (p && !p.silent) { // this line already shows text: keep it as it is
      waiting -= j.audio.length / 16000; refineQueue.splice(i, 1); pendingRefine.delete(j.key);
      p.t.emit('revise', { uid: j.uid, text: '', skipped: true });
      onRefineLog(`accuracy pass overloaded: kept the live text for ${j.uid}`);
    } else i++;
  }
  shedStale();
  if (refineState === 'ready') pumpRefine();
  else startRefiner().then(pumpRefine, () => { for (const j of refineQueue.splice(0)) { const p = pendingRefine.get(j.key); pendingRefine.delete(j.key); if (p) p.t.emit('revise', { uid: j.uid, text: '', error: 'refiner unavailable' }); } });
}
function refinePending() { return pendingRefine.size; }
function shutdownRefiner() { try { refiner?.terminate(); } catch {} refiner = null; refineState = 'idle'; refinePromise = null; pendingRefine.clear(); refineQueue.length = 0; refineBusy = null; failFiles(new Error('speech recogniser shut down')); }

// Load the models in the background at app start so a mid-call fallback is instant.
async function warmUp() { if (!modelReady()) return false; try { await startWorker(); return true; } catch { return false; } }
function shutdown() { try { worker?.terminate(); } catch {} worker = null; workerState = 'idle'; readyPromise = null; shutdownRefiner(); }

class LocalTranscriber extends EventEmitter {
  constructor({ sampleRate = 16000, kind = 'call' } = {}) {
    super();
    this.sampleRate = sampleRate;
    this.kind = kind; // 'mic' | 'call' (the mic's echo gate silences frames; the worker treats those differently)
    this.ready = false;
    this.closed = false;
    this.lastPartial = '';
    this.framesSent = 0;
    this.id = nextId++;
  }

  async connect() {
    const info = await ensureModel((p) => this.emit('status', `downloading speech model ${p.file} ${p.pct}%`));
    const t0 = Date.now();
    const { ms, vad } = await startWorker();
    if (this.closed) throw new Error('cancelled');
    byId.set(this.id, this);
    worker.postMessage({ type: 'open', id: this.id, kind: this.kind });
    this.ready = true;
    if (this._early) { const early = this._early; this._early = null; for (const b of early) this.sendAudio(b); }
    this.emit('log', `local STT ready (${MODEL.id}, ${(info.bytes / 1e6).toFixed(0)} MB, model load ${ms} ms, waited ${Date.now() - t0} ms, off main thread, voice detector ${vad ? 'on' : 'OFF — using recognizer pauses'})`);
    this.emit('status', 'local offline transcription ready');
    return 'local:' + MODEL.id;
  }

  sendAudio(base64Pcm16) {
    if (this.closed) return;
    if (!this.ready || !worker) {
      // The models are still loading (a cold start takes a few seconds). Keep what is being said
      // meanwhile — up to ~20 s — and feed it in the moment the recognizer is up, instead of losing it.
      (this._early || (this._early = [])).push(base64Pcm16);
      if (this._early.length > 240) this._early.shift();
      return;
    }
    const buf = Buffer.from(base64Pcm16, 'base64');
    const n = buf.length >> 1;
    const f32 = new Float32Array(n);
    for (let i = 0; i < n; i++) f32[i] = buf.readInt16LE(i * 2) / 32768;
    this.framesSent++;
    worker.postMessage({ type: 'audio', id: this.id, sampleRate: this.sampleRate, samples: f32, t: Date.now() }, [f32.buffer]);
  }

  // "Ask" was pressed: commit whatever is being said right now.
  nudge() { if (this.ready && worker) worker.postMessage({ type: 'nudge', id: this.id }); }

  // Resolves once the worker has decoded everything sent so far (tests / benchmark).
  drain() {
    if (!this.ready || !worker) return Promise.resolve();
    return new Promise((resolve) => { (this._syncs = this._syncs || []).push(resolve); worker.postMessage({ type: 'sync', id: this.id }); });
  }

  close() {
    if (this.closed) return;
    this.closed = true; this.ready = false;
    if (worker) { try { worker.postMessage({ type: 'close', id: this.id }); } catch {} }
    // keep routing for a moment so the final emitted by 'close' still reaches listeners
    setTimeout(() => byId.delete(this.id), 500);
  }
}

module.exports = { LocalTranscriber, init, ensureModel, modelReady, modelInfo, warmUp, shutdown, setModel, setRefine, refinePending, transcribeSamples, startRefiner, MODELS, REFINE_MODEL, DEFAULT_MODEL, get MODEL() { return MODEL; }, get refineState() { return refineState; }, set onRefineLog(f) { onRefineLog = f; } };
