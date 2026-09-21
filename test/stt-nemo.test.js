// Evaluate the NVIDIA streaming FastConformer transducer (NeMo) via sherpa-onnx
// as a more robust local engine. usage: node test/stt-nemo.test.js <modelDir> <wav16k> [expected words...]
const fs = require('fs');
const path = require('path');
const sherpa = require('sherpa-onnx-node');
const [modelDir, wavPath, ...expected] = process.argv.slice(2);

function readWav(p) {
  const b = fs.readFileSync(p);
  const channels = b.readUInt16LE(22), rate = b.readUInt32LE(24);
  let off = 12; let data = null;
  while (off < b.length) { const id = b.toString('ascii', off, off + 4); const len = b.readUInt32LE(off + 4); if (id === 'data') { data = b.subarray(off + 8, off + 8 + len); break; } off += 8 + len; }
  const n = data.length / 2 / channels; const f32 = new Float32Array(n);
  for (let i = 0; i < n; i++) f32[i] = data.readInt16LE(i * 2 * channels) / 32768;
  return { rate, samples: f32 };
}
const { rate, samples } = readWav(wavPath);
const t0 = Date.now();
const rec = new sherpa.OnlineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: { encoder: path.join(modelDir, 'encoder.onnx'), decoder: path.join(modelDir, 'decoder.onnx'), joiner: path.join(modelDir, 'joiner.onnx') },
    tokens: path.join(modelDir, 'tokens.txt'), numThreads: 2, provider: 'cpu', debug: 0, modelType: 'nemo_transducer',
  },
  decodingMethod: 'greedy_search', enableEndpoint: true,
  rule1MinTrailingSilence: 2.0, rule2MinTrailingSilence: 0.9, rule3MinUtteranceLength: 25,
});
const s = rec.createStream();
console.log(`nemo model loaded in ${Date.now() - t0} ms`);
const FRAME = Math.round(rate * 0.256); const finals = []; let last = ''; let compute = 0;
for (let i = 0; i < samples.length; i += FRAME) {
  const t = Date.now();
  s.acceptWaveform({ sampleRate: rate, samples: samples.subarray(i, i + FRAME) });
  while (rec.isReady(s)) rec.decode(s);
  const text = rec.getResult(s).text.trim(); if (text !== last) last = text;
  if (rec.isEndpoint(s)) { if (text) finals.push(text); rec.reset(s); last = ''; }
  compute += Date.now() - t;
}
s.inputFinished(); while (rec.isReady(s)) rec.decode(s); const tail = rec.getResult(s).text.trim(); if (tail) finals.push(tail);
console.log('finals:', JSON.stringify(finals));
console.log(`real-time factor: ${(compute / 1000 / (samples.length / rate)).toFixed(3)}`);
if (expected.length) { const got = finals.join(' ').toUpperCase().replace(/[^A-Z ]/g, '').split(/\s+/); const hit = expected.filter((w) => got.includes(w.toUpperCase())).length; console.log(`word hits: ${hit}/${expected.length}`); }
