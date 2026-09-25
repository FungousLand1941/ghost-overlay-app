// Video/audio-as-context: bundled ffmpeg decode, pause segmentation, key-frame
// extraction, YouTube caption plumbing, and (when the speech model is on disk)
// a real end-to-end transcription of synthesized speech muxed into an .mp4.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const media = require('../src/media');

let n = 0;
function check(name, ok, extra) { n++; if (!ok) { console.error('FAIL', name, extra ?? ''); process.exit(1); } console.log('ok', name); }

(async () => {
  const ff = media.ffmpegPath();
  check('ffmpeg bundled', ff && fs.existsSync(ff), ff);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-media-'));

  // 1. decode: 3 s of tone at 44.1 kHz -> 48000 samples of 16 kHz mono
  const tone = path.join(tmp, 'tone.wav');
  execFileSync(ff, ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-ar', '44100', tone]);
  const info = await media.probe(tone);
  check('probe: duration + streams', Math.abs(info.seconds - 3) < 0.1 && info.hasAudio && !info.hasVideo, info);
  let got = 0;
  await media.run(['-nostdin', '-loglevel', 'error', '-i', tone, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { onStdout: (c) => { got += c.length / 4; } });
  check('decode to 16 kHz mono', Math.abs(got - 48000) < 400, got);

  // 2. segmenter: speech-like bursts with 1 s pauses at 13 s and 27 s
  const RATE = 16000; const sig = new Float32Array(RATE * 40);
  for (let t = 0; t < sig.length; t++) { const s = t / RATE; const talking = s < 13 || (s > 14 && s < 27) || s > 28; sig[t] = (Math.random() * 2 - 1) * (talking ? 0.3 : 0.001); }
  const segs = []; const seg = new media.Segmenter({ onSegment: (x) => segs.push(x.startSample / RATE) });
  for (let i = 0; i < sig.length; i += 16384) seg.push(sig.subarray(i, i + 16384)); seg.flush();
  check('segmenter cuts inside the pauses', segs.length === 3 && segs[1] > 13 && segs[1] < 14 && segs[2] > 27 && segs[2] < 28, segs);
  const loud = new Float32Array(RATE * 80).map(() => Math.random() * 0.6 - 0.3);
  const forced = []; const g = new media.Segmenter({ onSegment: (x) => forced.push(x.samples.length / RATE) }); g.push(loud); g.flush();
  check('no pauses -> forced 35 s cuts', forced[0] === 35 && forced[1] === 35 && Math.abs(forced[2] - 10) < 0.01, forced);
  const silent = []; const q = new media.Segmenter({ onSegment: (x) => silent.push(x.quiet) }); q.push(new Float32Array(RATE * 20)); q.flush();
  check('pure silence flagged quiet (skipped by the recogniser)', silent.length >= 1 && silent.every(Boolean), silent);

  // 3. YouTube caption plumbing (offline)
  const html = 'x"captionTracks":[{"baseUrl":"https://y/api?v=1\\u0026lang=en","languageCode":"en","kind":"asr"},{"baseUrl":"https://y/b","languageCode":"en","name":{"simpleText":"English"}}],"audioTracks"';
  const tracks = media.parseCaptionTracks(html);
  check('captionTracks parsed, \\u0026 decoded', tracks.length === 2 && tracks[0].baseUrl === 'https://y/api?v=1&lang=en', tracks);
  check('manual English preferred over auto-generated', media.pickTrack(tracks).baseUrl === 'https://y/b');
  check('json3 -> 20 s lines', JSON.stringify(media.json3ToLines({ events: [{ tStartMs: 0, segs: [{ utf8: 'hello ' }, { utf8: 'there' }] }, { tStartMs: 5000, segs: [{ utf8: '\n' }] }, { tStartMs: 9000, segs: [{ utf8: 'again' }] }, { tStartMs: 25000, segs: [{ utf8: 'new' }] }] })) === '[{"t":0,"text":"hello there again"},{"t":25,"text":"new"}]');
  check('timedtext xml -> lines (Android client format)', JSON.stringify(media.timedtextToLines('<?xml version="1.0"?><timedtext format="3"><body><p t="1200" d="2000">All right, so<s> here</s> &amp; there</p><p t="3000" d="10">\n</p><p t="30000" d="1000">later</p></body></timedtext>')) === '[{"t":1.2,"text":"All right, so here & there"},{"t":30,"text":"later"}]');
  check('youtube id forms', media.youtubeId('https://youtu.be/dQw4w9WgXcQ?t=3') === 'dQw4w9WgXcQ' && media.youtubeId('https://www.youtube.com/shorts/abcdefghijk') === 'abcdefghijk' && !media.youtubeId('https://vimeo.com/1'));

  // 4. key frames: 130 s video, red then blue at 65 s -> duplicates dropped, scene change kept, real timestamps
  const vid = path.join(tmp, 'v.mp4');
  execFileSync(ff, ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=65', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=65', '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]', '-r', '5', '-pix_fmt', 'yuv420p', vid]);
  const frames = await media.extractFrames(vid, { everySec: 30 });
  check('frames: duplicates dropped, scene change kept, timestamps real', frames.length >= 2 && frames.length <= 3 && frames[0].t === 0 && frames.some((f) => f.t >= 60 && f.t <= 90) && frames.every((f) => f.jpeg[0] === 0xff && f.jpeg[1] === 0xd8), frames.map((f) => [f.t, f.jpeg.length]));

  // 5. end to end: Windows speech synthesis -> mp4 -> offline transcript (needs the Parakeet model on disk)
  const localStt = require('../src/providers/local-stt');
  const modelsDir = process.env.GHOST_MODELS || path.join(process.env.APPDATA || '', 'ghost', 'models');
  localStt.init(() => modelsDir);
  if (process.platform === 'win32' && localStt.modelInfo(localStt.REFINE_MODEL).ready) {
    const wav = path.join(tmp, 'speech.wav'), mp4 = path.join(tmp, 'talk.mp4');
    const line = 'The quick brown fox jumps over the lazy dog. A binary tree has a left child and a right child.';
    execFileSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${wav}'); $s.Speak('${line}'); $s.Dispose()`]);
    execFileSync(ff, ['-nostdin', '-loglevel', 'error', '-i', wav, '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=5', '-shortest', '-c:a', 'aac', '-pix_fmt', 'yuv420p', mp4]);
    const progress = [];
    const r = await media.transcribeFile(mp4, { onProgress: (p) => progress.push(p.text) });
    localStt.shutdown();
    check('mp4 -> transcript mentions the fox and the tree', /quick brown fox/i.test(r.text) && /binary tree/i.test(r.text), r.text);
    check('timestamped lines + duration + progress reported', /^\[00:00\] /.test(r.text) && r.seconds > 4 && r.hasVideo && progress.some((p) => /transcribing/.test(p)), [r.seconds, progress.slice(-2)]);
  } else console.log('skip: end-to-end speech test (Parakeet model not on disk or not Windows)');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`media: ${n} checks passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
