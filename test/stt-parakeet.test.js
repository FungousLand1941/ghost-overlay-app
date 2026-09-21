// Offline (utterance-level) recognition with NVIDIA Parakeet TDT 0.6B via sherpa-onnx.
//   node test/stt-parakeet.test.js <modelDir> <wav16k> [<wav16k> ...]
const fs = require('fs');
const path = require('path');
const sherpa = require('sherpa-onnx-node');
const [modelDir, ...wavs] = process.argv.slice(2);

function readWav(p) {
  const b = fs.readFileSync(p);
  const channels = b.readUInt16LE(22), rate = b.readUInt32LE(24);
  let off = 12; let data = null;
  while (off < b.length) { const id = b.toString('ascii', off, off + 4); const len = b.readUInt32LE(off + 4); if (id === 'data') { data = b.subarray(off + 8, off + 8 + len); break; } off += 8 + len; }
  const n = data.length / 2 / channels; const f32 = new Float32Array(n);
  for (let i = 0; i < n; i++) f32[i] = data.readInt16LE(i * 2 * channels) / 32768;
  return { rate, samples: f32 };
}
const t0 = Date.now();
const rec = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: { encoder: path.join(modelDir, 'encoder.int8.onnx'), decoder: path.join(modelDir, 'decoder.int8.onnx'), joiner: path.join(modelDir, 'joiner.int8.onnx') },
    tokens: path.join(modelDir, 'tokens.txt'), numThreads: 4, provider: 'cpu', debug: 0, modelType: 'nemo_transducer',
  },
  decodingMethod: 'greedy_search',
});
console.log(`parakeet loaded in ${Date.now() - t0} ms`);
for (const w of wavs) {
  const { rate, samples } = readWav(w);
  const s = rec.createStream();
  const t1 = Date.now();
  s.acceptWaveform({ sampleRate: rate, samples });
  rec.decode(s);
  const r = rec.getResult(s);
  const ms = Date.now() - t1;
  console.log(`${path.basename(w)} (${(samples.length / rate).toFixed(1)} s): "${r.text.trim()}"  [${ms} ms, RTF ${(ms / 1000 / (samples.length / rate)).toFixed(2)}]`);
}
