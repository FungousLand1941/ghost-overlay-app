// Can sherpa-onnx-node load and decode inside a worker_thread? (needed so the
// 6 s model load and per-frame decoding never block the Electron main process)
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const path = require('path');
const fs = require('fs');

if (isMainThread) {
  const modelDir = process.argv[2]; const wav = process.argv[3];
  const t0 = Date.now();
  let ticks = 0; const tick = setInterval(() => ticks++, 10); // main-thread liveness while the worker loads
  const w = new Worker(__filename, { workerData: { modelDir, wav } });
  w.on('message', (m) => {
    if (m.type === 'ready') console.log(`worker: model loaded in ${m.ms} ms; main thread ticked ${ticks}x meanwhile (blocked if ~0)`);
    if (m.type === 'result') { console.log(`worker: "${m.text}" (${m.decodeMs} ms decode for ${m.seconds.toFixed(1)} s audio)`); clearInterval(tick); console.log(`total ${Date.now() - t0} ms`); w.terminate(); }
    if (m.type === 'error') { console.error('worker error:', m.error); clearInterval(tick); process.exitCode = 1; w.terminate(); }
  });
  w.on('error', (e) => { console.error('worker crashed:', e.message); clearInterval(tick); process.exitCode = 1; });
} else {
  try {
    const sherpa = require('sherpa-onnx-node');
    const d = workerData.modelDir;
    const t0 = Date.now();
    const rec = new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: { transducer: { encoder: path.join(d, 'encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx'), decoder: path.join(d, 'decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx'), joiner: path.join(d, 'joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx') }, tokens: path.join(d, 'tokens.txt'), numThreads: 2, provider: 'cpu', debug: 0 },
      decodingMethod: 'greedy_search', enableEndpoint: true,
    });
    parentPort.postMessage({ type: 'ready', ms: Date.now() - t0 });
    const b = fs.readFileSync(workerData.wav);
    let off = 12, data = null; while (off < b.length) { const id = b.toString('ascii', off, off + 4); const len = b.readUInt32LE(off + 4); if (id === 'data') { data = b.subarray(off + 8, off + 8 + len); break; } off += 8 + len; }
    const n = data.length / 2; const f32 = new Float32Array(n); for (let i = 0; i < n; i++) f32[i] = data.readInt16LE(i * 2) / 32768;
    const s = rec.createStream(); const t1 = Date.now();
    for (let i = 0; i < n; i += 4096) { s.acceptWaveform({ sampleRate: 16000, samples: f32.subarray(i, i + 4096) }); while (rec.isReady(s)) rec.decode(s); }
    s.inputFinished(); while (rec.isReady(s)) rec.decode(s);
    parentPort.postMessage({ type: 'result', text: rec.getResult(s).text, decodeMs: Date.now() - t1, seconds: n / 16000 });
  } catch (e) { parentPort.postMessage({ type: 'error', error: e.stack || e.message }); }
}
