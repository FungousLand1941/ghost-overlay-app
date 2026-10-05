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
    modelType: 'nemo_transducer', approxMB: 480,
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
    modelType: '', approxMB: 72,
  },
};
// Accuracy pass (offline, utterance-level): NVIDIA Parakeet TDT 0.6B v3 — top of the
// open ASR leaderboard, punctuation + casing, 25 languages, ~670 MB, ~0.2 RTF on CPU.
const REFINE_MODEL = {
  id: 'parakeet-tdt-0.6b-v3-int8', label: 'NVIDIA Parakeet TDT 0.6B v3 (accuracy pass)',
  base: 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main',
  files: { encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx', joiner: 'joiner.int8.onnx', tokens: 'tokens.txt' },
  minBytes: { encoder: 600e6, decoder: 10e6, joiner: 5e6, tokens: 50000 },
  modelType: 'nemo_transducer', kind: 'offline', approxMB: 670,
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
  return { id: m.id, label: m.label, approxMB: m.approxMB, ready: modelReady(m), bytes, dir: modelDir(m), loaded: m === MODEL ? workerState === 'ready' : refineState === 'ready' };
}
// MB still to download before local transcription can run (the streaming model, plus the accuracy model if it is on)
function downloadNeededMB() { return (modelReady(MODEL) ? 0 : MODEL.approxMB) + (refineEnabled && !modelReady(REFINE_MODEL) ? REFINE_MODEL.approxMB : 0); }

// Download missing files with progress; resolves when all present.
// One download per model at a time: on a first run both audio sources (and the
// settings panel) ask for the same model at once, and two downloads writing the
// same file made one of them fail (and could leave a damaged file behind).
// A file only counts once every byte the server announced has arrived, and a
// transfer that stops sending for STALL_MS is abandoned rather than leaving
// Listen waiting forever. A fresh download is then test-loaded in a separate
// process (see probeModel) before Ghost loads it itself.
const STALL_MS = +process.env.GHOST_DL_STALL_MS || 60000; // env: tests only
const downloads = new Map(); // model id -> { promise, listeners }
function ensureModel(onProgress = () => {}, m = MODEL) {
  if (modelReady(m)) return Promise.resolve(modelInfo(m));
  let d = downloads.get(m.id);
  if (!d) {
    const listeners = new Set();
    const emit = (p) => { for (const f of listeners) { try { f(p); } catch {} } };
    const promise = (async () => {
      for (let attempt = 1; ; attempt++) {
        if (!(await downloadModel(m, emit))) return; // nothing was missing
        emit({ phase: 'verify', file: '', pct: 100 });
        const r = await probe(m);
        if (r.verdict !== 'bad') { if (r.verdict === 'unknown') onLog(`could not test-load ${m.id} in a separate process (${r.why}); loading it directly`); return; }
        removeModelFiles(m);
        onLog(`downloaded ${m.id} does not load (${r.why}): deleted${attempt < 2 ? ', downloading it again' : ''}`);
        if (attempt >= 2) throw new Error(`the downloaded ${m.label} is damaged (${r.why}) — it was deleted; try again, or check the disk / antivirus`);
      }
    })().finally(() => downloads.delete(m.id));
    d = { promise, listeners };
    downloads.set(m.id, d);
  }
  d.listeners.add(onProgress);
  return d.promise.finally(() => d.listeners.delete(onProgress)).then(() => modelInfo(m));
}
// Fetches the files of `m` that are missing; resolves with how many it fetched.
async function downloadModel(m, onProgress) {
  fs.mkdirSync(modelDir(m), { recursive: true });
  let fetched = 0;
  for (const [k, f] of Object.entries(m.files)) {
    const dest = path.join(modelDir(m), f);
    try { if (fs.statSync(dest).size >= m.minBytes[k]) continue; } catch {}
    await downloadFile(`${m.base}/${f}`, dest, m.minBytes[k], (p) => onProgress({ file: f, ...p }));
    fetched++;
  }
  return fetched;
}
async function downloadFile(url, dest, minBytes, onProgress) {
  const name = path.basename(dest), tmp = dest + '.part';
  const ac = new AbortController();
  let stalled = false, timer = null, out = null;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; ac.abort(); }, STALL_MS); };
  try {
    onProgress({ pct: 0 });
    arm();
    const res = await fetch(url, { redirect: 'follow', signal: ac.signal });
    if (!res.ok) throw new Error(`download failed ${res.status} for ${name}`);
    const total = +res.headers.get('content-length') || 0;
    out = fs.createWriteStream(tmp);
    let werr = null; out.on('error', (e) => { werr = e; });
    const drained = () => new Promise((r) => { const done = () => { out.off('drain', done); out.off('error', done); r(); }; out.on('drain', done); out.on('error', done); });
    let got = 0, lastPct = -1;
    for await (const chunk of res.body) {
      arm();
      if (!out.write(chunk)) await drained(); // the disk is slower than the network: do not buffer the whole file in memory
      if (werr) throw werr;
      got += chunk.length;
      const pct = total ? Math.floor((got / total) * 100) : 0;
      if (pct !== lastPct) { lastPct = pct; onProgress({ pct, got, total }); }
    }
    clearTimeout(timer);
    await new Promise((r, j) => { out.once('close', r); out.once('error', j); out.end(); });
    out = null;
    if (werr) throw werr;
    if (total && got !== total) throw new Error(`download of ${name} stopped early (${got} of ${total} bytes) — network problem?`);
    if (fs.statSync(tmp).size < minBytes) throw new Error(`downloaded ${name} is too small — network problem?`);
    fs.renameSync(tmp, dest);
  } catch (e) {
    if (out) await new Promise((r) => { if (out.closed) r(); else { out.once('close', r); out.destroy(); } });
    try { fs.unlinkSync(tmp); } catch {}
    if (stalled) throw new Error(`download of ${name} stalled (no data for ${STALL_MS / 1000} s) — network problem?`);
    throw e;
  } finally { clearTimeout(timer); }
}
function removeModelFiles(m) {
  for (const f of Object.values(m.files)) for (const p of [f, f + '.part']) { try { fs.unlinkSync(path.join(modelDir(m), p)); } catch {} }
}

// ---------------------------------------------------------------- damaged models
// A damaged model file does not make the speech runtime throw an error: it ABORTS
// the whole process (measured: "terminate called after throwing Ort::Exception",
// exit 134). The recognizer runs in a thread of Ghost's main process and is warmed
// up at every launch, so one bad file would crash Ghost at every start. Two guards:
//   * a model is test-loaded in a throwaway process after it is downloaded, and
//     whenever an earlier run of Ghost died while loading it — only that process
//     can die; a model that does not load there is deleted and downloaded again;
//   * a marker file sits next to a model while it loads into Ghost itself, so a
//     load that took Ghost down is noticed at the next start (and checked as above).
const PROCESS_START = Date.now() - Math.round(process.uptime() * 1000);
let onLog = () => {};
function markerPath(m) { return path.join(modelDir(m), '.loading'); }
function markLoading(m) { try { fs.writeFileSync(markerPath(m), JSON.stringify({ pid: process.pid, at: Date.now() })); } catch {} }
function ownMarker(mk) { return !!mk && mk.pid === process.pid && mk.at >= PROCESS_START - 1000; }
function readMarker(m) {
  let raw; try { raw = fs.readFileSync(markerPath(m), 'utf8'); } catch { return null; }
  try { return JSON.parse(raw) || {}; } catch { return {}; } // half-written: the process died right there
}
// remove the marker if this process wrote it (a stale one is evidence for the next check, never wiped by accident)
function clearLoading(m) { if (ownMarker(readMarker(m))) { try { fs.unlinkSync(markerPath(m)); } catch {} } }
function diedLoading(m) { const mk = readMarker(m); return mk !== null && !ownMarker(mk); }
function probePath() { return path.join(__dirname, 'local-stt-probe.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'); }
// Load `m` in a separate process. Resolves { verdict: 'ok' | 'bad' | 'unknown', why }.
// 'unknown' (the test process could not start, or took too long) is never treated as damage.
function probeModel(m, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    let child = null, started = false, done = false, stderr = '', timer = null;
    const finish = (verdict, why = '') => { if (done) return; done = true; clearTimeout(timer); try { child && child.kill(); } catch {} resolve({ verdict, why }); };
    const args = JSON.stringify({ kind: m.kind || 'online', modelDir: modelDir(m), files: m.files, modelType: m.modelType || '' });
    try {
      // run as plain Node (inside Electron, the same binary with ELECTRON_RUN_AS_NODE)
      child = require('child_process').fork(probePath(), [args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    } catch (e) { return finish('unknown', e.message); }
    timer = setTimeout(() => finish('unknown', `no answer in ${timeoutMs / 1000} s`), timeoutMs);
    if (child.stderr) child.stderr.on('data', (b) => { stderr = (stderr + b).slice(-600); });
    child.on('message', (msg) => {
      if (!msg) return;
      if (msg.type === 'started') started = true;
      else if (msg.type === 'ok') finish('ok');
      else if (msg.type === 'error') finish(started ? 'bad' : 'unknown', msg.error);
    });
    child.on('error', (e) => finish('unknown', e.message));
    child.on('exit', (code, signal) => {
      const last = stderr.trim().split(/\r?\n/).filter(Boolean).pop() || '';
      finish(started ? 'bad' : 'unknown', `${signal || `exit code ${code}`}${last ? `: ${last.slice(0, 200)}` : ''}`);
    });
  });
}
let probe = probeModel; // tests swap in a stand-in
// Right before `m` is loaded into this process.
async function prepareLoad(m, onProgress = () => {}) {
  if (diedLoading(m)) {
    const r = await probe(m);
    try { fs.unlinkSync(markerPath(m)); } catch {}
    onLog(`the last run of Ghost stopped while loading ${m.id}; test-loaded it separately: ${r.verdict}${r.why ? ` (${r.why})` : ''}`);
    if (r.verdict === 'bad') {
      removeModelFiles(m);
      onLog(`${m.id} is damaged: deleted, downloading it again`);
      await ensureModel(onProgress, m);
    }
  }
  markLoading(m);
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

// A load that fails without taking the process down (a clean error, a timeout, the
// thread dying) is forgotten, so the next Listen tries again instead of repeating
// the same stored failure until Ghost is restarted.
const LOAD_TIMEOUT_MS = 150000;
let loadGen = 0, refineGen = 0; // bumped by shutdown: a load still being prepared then is abandoned
function startWorker(onProgress = () => {}) {
  if (readyPromise) return readyPromise;
  workerState = 'loading';
  const model = MODEL, gen = loadGen;
  const p = (async () => {
    try { await prepareLoad(model, onProgress); } catch (e) { if (gen === loadGen) workerState = 'failed'; throw e; }
    if (gen !== loadGen) { clearLoading(model); throw new Error('cancelled'); }
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const w = new Worker(workerPath());
      worker = w;
      let loading = true;
      const giveUp = (err) => {
        if (!loading) return;
        loading = false; clearTimeout(timer); clearLoading(model);
        if (worker === w) { worker = null; workerState = 'failed'; }
        try { w.terminate(); } catch {}
        reject(err);
      };
      const timer = setTimeout(() => giveUp(new Error(`local STT model load timed out after ${Date.now() - t0} ms`)), LOAD_TIMEOUT_MS);
      w.on('message', (m) => {
        if (m.type === 'ready') { if (!loading) return; loading = false; clearTimeout(timer); clearLoading(model); workerState = 'ready'; resolve({ ms: m.ms, vad: m.vad }); return; }
        if (m.type === 'init-error') { giveUp(new Error(m.error)); return; }
        if (worker !== w) return;
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
        else if (m.type === 'stat') { t.workerLag = m.lag; t.workerShed = m.shed; }
        else if (m.type === 'error') t.emit('error', Object.assign(new Error(`local STT failed: ${m.error}`), { code: 'LOCAL' }));
      });
      w.on('error', (e) => {
        if (loading) { giveUp(e); return; }
        if (worker !== w) return;
        workerState = 'failed';
        for (const t of byId.values()) t.emit('error', Object.assign(new Error(`local STT worker crashed: ${e.message}`), { code: 'LOCAL' }));
      });
      w.on('exit', () => {
        if (loading) giveUp(new Error('local STT worker exited during load'));
        if (worker === w) { worker = null; workerState = 'idle'; readyPromise = null; }
      });
      w.postMessage({ type: 'init', modelDir: modelDir(model), files: model.files, modelType: model.modelType || '', vadModel: vadPath() });
      if (refineEnabled) startRefiner().catch(() => {});
    });
  })();
  readyPromise = p;
  p.catch(() => { if (readyPromise === p) readyPromise = null; });
  return p;
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
  const gen = refineGen;
  const p = (async () => {
    try {
      const say = (x) => onRefineLog(x.phase === 'verify' ? 'checking the downloaded accuracy model…' : `downloading accuracy model ${x.file} ${x.pct}%`);
      await ensureModel(say, REFINE_MODEL);
      await prepareLoad(REFINE_MODEL, say);
    } catch (e) { if (gen === refineGen) refineState = 'failed'; onRefineLog(`accuracy model unavailable: ${e.message}`); throw e; }
    if (gen !== refineGen) { clearLoading(REFINE_MODEL); throw new Error('cancelled'); }
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const r = new Worker(refinerPath());
      refiner = r;
      let loading = true;
      const giveUp = (err) => {
        if (!loading) return;
        loading = false; clearTimeout(timer); clearLoading(REFINE_MODEL);
        if (refiner === r) { refiner = null; refineState = 'failed'; }
        try { r.terminate(); } catch {}
        reject(err);
      };
      const timer = setTimeout(() => { onRefineLog(`accuracy model load timed out after ${Date.now() - t0} ms`); giveUp(new Error(`accuracy model load timed out after ${Date.now() - t0} ms`)); }, LOAD_TIMEOUT_MS);
      r.on('message', (m) => {
        if (m.type === 'ready') { if (!loading) return; loading = false; clearTimeout(timer); clearLoading(REFINE_MODEL); refineState = 'ready'; onRefineLog(`accuracy pass ready (${REFINE_MODEL.id}, load ${m.ms} ms)`); resolve(); return; }
        if (m.type === 'init-error') { onRefineLog(`accuracy pass failed to load: ${m.error}`); giveUp(new Error(m.error)); return; }
        if (refiner !== r) return;
        if (m.uid === refineBusy) { refineBusy = null; setImmediate(pumpRefine); }
        if (m.type === 'refined' && m.seconds > 1) rtf = rtf ? rtf * 0.8 + (m.ms / 1000 / m.seconds) * 0.2 : m.ms / 1000 / m.seconds;
        const p = pendingRefine.get(m.uid); // m.uid is the job key here
        if (!p) { // not a live utterance: a file segment (video/audio context, chunked listening)
          const f = pendingFile.get(m.uid);
          if (f) { pendingFile.delete(m.uid); if (m.type === 'refined') f.resolve((m.text || '').trim()); else f.reject(new Error(m.error || 'recognition failed')); }
          return;
        }
        pendingRefine.delete(m.uid);
        const shown = p.t._shown || (p.t._shown = new Set());
        if (p.silent && !shown.has(p.uid)) {
          // nothing was shown for this segment yet; a lone word from a sub-second blip is more likely noise than speech
          const words = (m.text || '').trim().split(/\s+/).filter(Boolean).length;
          if (m.type === 'refined' && words && !(words === 1 && p.seconds < 1.5) && !(words === 2 && p.seconds < 1.0)) { shown.add(p.uid); p.t.emit('final', m.text, { uid: p.uid, provisional: false, late: true, ms: m.ms, how: m.how, waited: Date.now() - p.at - m.ms, seconds: m.seconds }); }
        }
        else if (m.type === 'refined') p.t.emit('revise', { uid: p.uid, text: m.text, ms: m.ms, seconds: m.seconds, how: m.how, waited: Date.now() - p.at - m.ms });
        else p.t.emit('revise', { uid: p.uid, text: '', error: m.error });
      });
      r.on('error', (e) => {
        if (loading) { giveUp(e); return; }
        if (refiner !== r) return;
        refineState = 'failed'; onRefineLog(`accuracy worker crashed: ${e.message}`);
        for (const p of pendingRefine.values()) p.t.emit('revise', { uid: p.uid, text: '', error: e.message });
        pendingRefine.clear(); failFiles(e);
      });
      r.on('exit', () => {
        if (loading) giveUp(new Error('accuracy worker exited during load'));
        if (refiner !== r) return;
        refiner = null; refineBusy = null; if (refineState !== 'failed') refineState = 'idle'; refinePromise = null; failFiles(new Error('speech recogniser exited'));
      });
      r.postMessage({ type: 'init', modelDir: modelDir(REFINE_MODEL), files: REFINE_MODEL.files, modelType: REFINE_MODEL.modelType });
    });
  })();
  refinePromise = p;
  p.catch(() => { if (refinePromise === p) refinePromise = null; });
  return refinePromise;
}
// Whole-file recognition (video / audio context): same accuracy model, one segment at a time.
const pendingFile = new Map(); // uid -> { resolve, reject }
let fileUid = 0;
function failFiles(err) { for (const f of pendingFile.values()) f.reject(err); pendingFile.clear(); }
async function transcribeSamples(samples) {
  await startRefiner();
  return new Promise((resolve, reject) => {
    if (!refiner) { reject(new Error('speech recogniser is not running')); return; }
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
// Finished lines matter more than live partial words. When the accuracy pass starts to queue up
// (a slow or throttled computer, both sides talking), tell the streaming recognizer to stand down so
// the accuracy pass gets the CPU; it resumes as soon as the queue is empty again.
let pressure = false;
function updatePressure() {
  const wait = refineQueue.length ? Date.now() - refineQueue[0].at : 0;
  // on only when the accuracy pass is really behind (its oldest job has waited 3 s); off once it has caught up
  const on = pressure ? refineQueue.length > 0 : wait > 3000;
  if (on === pressure) return;
  pressure = on;
  try { if (worker) worker.postMessage({ type: 'pressure', on }); } catch {}
}
function pumpRefine() {
  updatePressure();
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
  updatePressure();
  if (refineState === 'ready') pumpRefine();
  else startRefiner().then(pumpRefine, () => { for (const j of refineQueue.splice(0)) { const p = pendingRefine.get(j.key); pendingRefine.delete(j.key); if (p) p.t.emit('revise', { uid: j.uid, text: '', error: 'refiner unavailable' }); } });
}
function refinePending() { return pendingRefine.size; }
function shutdownRefiner() { refineGen++; try { refiner?.terminate(); } catch {} refiner = null; refineState = 'idle'; refinePromise = null; pendingRefine.clear(); refineQueue.length = 0; refineBusy = null; failFiles(new Error('speech recogniser shut down')); if (modelsDirFn) clearLoading(REFINE_MODEL); }

// Load the models in the background at app start so a mid-call fallback is instant.
async function warmUp() { if (!modelReady()) return false; try { await startWorker(); return true; } catch { return false; } }
function shutdown() { loadGen++; try { worker?.terminate(); } catch {} worker = null; workerState = 'idle'; readyPromise = null; shutdownRefiner(); clearOwnMarkers(); }
// stopped on purpose (quit, model switch): a load cut short here is not a crash
function clearOwnMarkers() { if (!modelsDirFn) return; for (const m of [...Object.values(MODELS), REFINE_MODEL]) clearLoading(m); }
function downloadStatus(m, p) { return p.phase === 'verify' ? `checking the downloaded speech model (${m.label})…` : `downloading the speech model (${m.label}, once): ${p.file} ${p.pct}%`; }

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
    const model = MODEL;
    const progress = (p) => this.emit('status', downloadStatus(model, p));
    const info = await ensureModel(progress, model);
    const t0 = Date.now();
    const { ms, vad } = await startWorker(progress);
    if (this.closed) throw new Error('cancelled');
    byId.set(this.id, this);
    worker.postMessage({ type: 'open', id: this.id, kind: this.kind });
    this.ready = true;
    if (this._early) { const early = this._early; this._early = null; for (const b of early) this.sendAudio(b); }
    this.emit('log', `local STT ready (${MODEL.id}, ${(info.bytes / 1e6).toFixed(0)} MB, model load ${ms} ms, waited ${Date.now() - t0} ms, off main thread, voice detector ${vad ? 'on' : 'OFF — using recognizer pauses'})`);
    this.emit('status', 'local offline transcription ready');
    return 'local:' + MODEL.id;
  }

  // wall-clock time at which audio position `sec` reached Ghost
  heardAt(sec) {
    const marks = this._marks || [];
    for (let i = marks.length - 1; i >= 0; i--) if (marks[i][0] <= sec) return marks[i][1] + (sec - marks[i][0]) * 1000;
    return (this._t0 || Date.now()) + sec * 1000;
  }

  sendAudio(base64Pcm16) {
    if (this.closed) return;
    if (!this._t0) this._t0 = Date.now(); // wall-clock time of audio position 0 (for lag measurement)
    // when did each second of audio actually arrive? (a mark per second, last 10 min). Counting samples alone
    // would report audio the computer dropped before Ghost got it as Ghost being behind.
    const marks = this._marks || (this._marks = []); this._pos = this._pos || 0;
    if (!marks.length || this._pos - marks[marks.length - 1][0] >= 1) { marks.push([this._pos, Date.now()]); if (marks.length > 600) marks.shift(); }
    this._pos += (base64Pcm16.length * 3 / 8) / this.sampleRate;
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
    // keep routing for a while so the last line, finished by 'close', still reaches listeners
    // (the worker may be a second behind on a busy computer; that line must not be dropped)
    setTimeout(() => byId.delete(this.id), 8000);
  }
}

module.exports = {
  LocalTranscriber, init, ensureModel, modelReady, modelInfo, downloadNeededMB, warmUp, shutdown, setModel, setRefine, refinePending, transcribeSamples, startRefiner,
  probeModel, prepareLoad, MODELS, REFINE_MODEL, DEFAULT_MODEL,
  get MODEL() { return MODEL; }, get refineState() { return refineState; },
  set onRefineLog(f) { onRefineLog = f; }, set onLog(f) { onLog = f; },
  _setProbe(f) { probe = f || probeModel; }, // tests
};
