// Feasibility / regression test for local streaming STT (sherpa-onnx Zipformer).
//   node test/stt-local.test.js <modelDir> <wav16kMono> [expected words...]
// Streams the wav in 256 ms frames exactly like the app does, prints partials,
// endpoint-separated finals, and the real-time factor.
const fs = require('fs');
const sherpa = require('sherpa-onnx-node');

const [modelDir, wavPath, ...expected] = process.argv.slice(2);
if (!modelDir || !wavPath) { console.error('usage: node test/stt-local.test.js <modelDir> <wav>'); process.exit(2); }

function readWav(p) {
  const b = fs.readFileSync(p);
  const channels = b.readUInt16LE(22), rate = b.readUInt32LE(24), bits = b.readUInt16LE(34);
  let off = 12; let data = null;
  while (off < b.length) { const id = b.toString('ascii', off, off + 4); const len = b.readUInt32LE(off + 4); if (id === 'data') { data = b.subarray(off + 8, off + 8 + len); break; } off += 8 + len; }
  const n = data.length / 2 / channels;
  const f32 = new Float32Array(n);
  for (let i = 0; i < n; i++) f32[i] = data.readInt16LE(i * 2 * channels) / 32768;
  return { rate, bits, channels, samples: f32 };
}

const { rate, samples } = readWav(wavPath);
const cfg = {
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: {
      encoder: `${modelDir}/encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx`,
      decoder: `${modelDir}/decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx`,
      joiner: `${modelDir}/joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx`,
    },
    tokens: `${modelDir}/tokens.txt`,
    numThreads: 2, provider: 'cpu', debug: 0,
  },
  decodingMethod: 'greedy_search',
  enableEndpoint: true,
  rule1MinTrailingSilence: 2.4, rule2MinTrailingSilence: 1.0, rule3MinUtteranceLength: 20,
};
const t0 = Date.now();
const rec = new sherpa.OnlineRecognizer(cfg);
const stream = rec.createStream();
console.log(`model loaded in ${Date.now() - t0} ms; wav ${rate} Hz, ${(samples.length / rate).toFixed(1)} s`);

const FRAME = Math.round(rate * 0.256);
const finals = []; let lastPartial = ''; let compute = 0;
for (let i = 0; i < samples.length; i += FRAME) {
  const t = Date.now();
  stream.acceptWaveform({ sampleRate: rate, samples: samples.subarray(i, i + FRAME) });
  while (rec.isReady(stream)) rec.decode(stream);
  const text = rec.getResult(stream).text.trim();
  if (text && text !== lastPartial) { lastPartial = text; process.stdout.write(`\r  partial: ${text.slice(-70)}`); }
  if (rec.isEndpoint(stream)) { if (text) finals.push(text); rec.reset(stream); lastPartial = ''; process.stdout.write('\n'); }
  compute += Date.now() - t;
}
stream.inputFinished();
while (rec.isReady(stream)) rec.decode(stream);
const tail = rec.getResult(stream).text.trim(); if (tail) finals.push(tail);
console.log(`\nfinals: ${JSON.stringify(finals)}`);
console.log(`real-time factor: ${(compute / 1000 / (samples.length / rate)).toFixed(3)} (compute ${compute} ms for ${(samples.length / rate).toFixed(1)} s audio)`);
if (expected.length) {
  const got = finals.join(' ').toUpperCase().replace(/[^A-Z ]/g, '').split(/\s+/);
  const hit = expected.filter((w) => got.includes(w.toUpperCase())).length;
  console.log(`word hits: ${hit}/${expected.length}`);
  process.exitCode = hit / expected.length >= 0.7 ? 0 : 1;
}
