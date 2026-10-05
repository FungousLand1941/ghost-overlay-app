// Test-loads a speech model in a throwaway process (see probeModel in local-stt.js).
// A damaged model file makes the speech runtime abort the process that loads it
// instead of throwing; here, only this process dies and Ghost reads that as "damaged".
//   argv[2]: JSON { kind: 'online' | 'offline', modelDir, files, modelType }
// Tells the parent { type: 'started' } once the engine itself loads, then
// { type: 'ok', ms } or { type: 'error', error }.
const path = require('path');

function send(msg) {
  return new Promise((resolve) => { try { process.send(msg, () => resolve()); } catch { resolve(); } });
}

(async () => {
  let a, sherpa;
  try {
    a = JSON.parse(process.argv[2]);
    sherpa = require('sherpa-onnx-node');
  } catch (e) {
    await send({ type: 'error', error: `speech engine unavailable: ${e.message}` }); // not the model's fault
    process.exit(0);
  }
  await send({ type: 'started' });
  try {
    const t0 = Date.now();
    const d = a.modelDir, f = a.files;
    const modelConfig = {
      transducer: { encoder: path.join(d, f.encoder), decoder: path.join(d, f.decoder), joiner: path.join(d, f.joiner) },
      tokens: path.join(d, f.tokens), numThreads: 1, provider: 'cpu', debug: 0,
      ...(a.modelType ? { modelType: a.modelType } : {}),
    };
    const featConfig = { sampleRate: 16000, featureDim: 80 };
    if (a.kind === 'offline') new sherpa.OfflineRecognizer({ featConfig, modelConfig, decodingMethod: 'greedy_search' });
    else new sherpa.OnlineRecognizer({ featConfig, modelConfig, decodingMethod: 'greedy_search' });
    await send({ type: 'ok', ms: Date.now() - t0 });
  } catch (e) {
    await send({ type: 'error', error: e.message || String(e) });
  }
  process.exit(0);
})();
