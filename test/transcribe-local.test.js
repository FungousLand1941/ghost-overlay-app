// Chunked transcription without a Gemini key (e.g. Claude-only): the WAV chunk
// is transcribed on this computer.
//   - the WAV is parsed by its chunks (format, rate, channels), not by searching
//     for the bytes "data" — which also match inside a metadata chunk
//   - other rates / stereo are converted to what the recognizer needs (16 kHz mono)
//   - with the model not on disk yet, the chunk is answered at once ("downloading…")
//     instead of every chunk waiting for a 670 MB download
const fs = require('fs');
const os = require('os');
const path = require('path');
const providers = require('../src/providers');
const stt = require('../src/providers/local-stt');

let failures = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'ok' : 'FAIL'} ${n}${x ? ` — ${x}` : ''}`); if (!c) failures++; };

function wav(samplesPerChannel, { rate = 16000, channels = 1, extra = null } = {}) {
  const n = samplesPerChannel[0].length, data = Buffer.alloc(n * channels * 2);
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samplesPerChannel[c][i])) * 32767), (i * channels + c) * 2);
  const fmt = Buffer.alloc(24); fmt.write('fmt ', 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(channels, 10); fmt.writeUInt32LE(rate, 12); fmt.writeUInt32LE(rate * channels * 2, 16); fmt.writeUInt16LE(channels * 2, 20); fmt.writeUInt16LE(16, 22);
  const parts = [fmt];
  if (extra) { const body = Buffer.from(extra); const h = Buffer.alloc(8); h.write('LIST', 0); h.writeUInt32LE(body.length, 4); parts.push(h, body, Buffer.alloc(body.length & 1)); }
  const dh = Buffer.alloc(8); dh.write('data', 0); dh.writeUInt32LE(data.length, 4); parts.push(dh, data);
  const body = Buffer.concat(parts), head = Buffer.alloc(12); head.write('RIFF', 0); head.writeUInt32LE(4 + body.length, 4); head.write('WAVE', 8);
  return Buffer.concat([head, body]).toString('base64');
}
const tone = (n, rate, hz, a = 0.5) => Float32Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * hz * i) / rate));
const rms = (x, from = 0, to = x.length) => { let s = 0; for (let i = from; i < to; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, to - from)); };

// 1. the chunk the renderer sends: 16 kHz mono
{
  const x = tone(16000, 16000, 440);
  const y = providers.wavToFloat32(wav([x]));
  let err = 0; for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(x[i] - y[i]));
  check('16 kHz mono WAV read back exactly', y.length === x.length && err < 1 / 16000, `max error ${err.toExponential(1)}`);
}
// 2. a metadata chunk containing the bytes "data" before the audio
{
  const x = tone(8000, 16000, 300);
  const y = providers.wavToFloat32(wav([x], { extra: 'INFOISFT\u0007\u0000\u0000\u0000metadata, recorded by some app' }));
  check('metadata chunk mentioning "data" does not shift the audio', y.length === x.length && Math.abs(y[100] - x[100]) < 1e-3 && Math.abs(y[4000] - x[4000]) < 1e-3);
}
// 3. 48 kHz stereo -> 16 kHz mono
{
  const l = tone(48000, 48000, 1000, 0.4), r = tone(48000, 48000, 1000, 0.4);
  const y = providers.wavToFloat32(wav([l, r], { rate: 48000, channels: 2 }));
  check('48 kHz stereo becomes 16 kHz mono, same length in time', Math.abs(y.length - 16000) <= 2, `${y.length} samples`);
  check('…and the same loudness', Math.abs(rms(y, 1000, 15000) - 0.4 / Math.SQRT2) < 0.02, rms(y, 1000, 15000).toFixed(3));
}
// 4. not a WAV / not PCM
{
  let e1 = null; try { providers.wavToFloat32(Buffer.from('hello world, not audio').toString('base64')); } catch (e) { e1 = e; }
  check('garbage is refused with a clear error', !!e1 && /not a WAV/.test(e1.message));
}
// 5. which engine
check('no Gemini key -> transcribed on this computer', providers.transcribesLocally({ gemini: { apiKey: '' }, claude: { apiKey: 'x' } }) === true);
check('Gemini key -> Gemini', providers.transcribesLocally({ gemini: { apiKey: 'AIza…' } }) === false);

// 6. model not on disk: answered at once, the download starts in the background
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-tl-'));
  stt.init(() => dir);
  const base = stt.REFINE_MODEL.base;
  stt.REFINE_MODEL.base = 'http://127.0.0.1:9'; // nothing listens there: the background download fails fast, offline
  const logs = []; stt.onRefineLog = (l) => logs.push(l);
  const t0 = Date.now(); let err = null;
  try { await providers.transcribe({ gemini: { apiKey: '' }, transcription: {} }, { wavBase64: wav([tone(16000, 16000, 200)]) }); } catch (e) { err = e; }
  check('model missing: the chunk is answered at once, not after a download', !!err && err.code === 'LOCAL_LOADING' && Date.now() - t0 < 1000, `${err && err.message} in ${Date.now() - t0} ms`);
  for (let i = 0; i < 50 && !logs.some((l) => /unavailable/.test(l)); i++) await new Promise((r) => setTimeout(r, 100));
  check('…and the download was started (and reported)', logs.some((l) => /accuracy model unavailable/.test(l)), logs.slice(-1)[0]);
  stt.REFINE_MODEL.base = base;
  stt.shutdown();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log(failures ? `transcribe-local: ${failures} FAILED` : 'transcribe-local: all checks passed');
  process.exit(failures ? 1 : 0);
})();
