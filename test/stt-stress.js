// Can live listening keep up with non-stop talking? Continuous fast speech (no
// real pauses) on BOTH sources at once, fed at real-time pace (or faster, to
// emulate a slower / busier machine), through LocalTranscriber. Reports how far
// behind the transcript runs:
//   shown   – speech end -> a line for it appears (provisional or final)
//   refined – speech end -> the accuracy pass has finished that line
//   backlog – how long the recognizer worker needs to chew through what is queued
// and the word error rate, so speed is never bought with dropped speech.
//
//   node test/stt-stress.js [--minutes 3] [--speed 1] [--sources 2] [--json out.json]
const fs = require('fs');
const path = require('path');
const media = require('../src/media');
const dsp = require('../src/renderer/dsp');
const localStt = require('../src/providers/local-stt');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const MINUTES = +opt('minutes', 3), SPEED = +opt('speed', 1), SOURCES = +opt('sources', 2);
const CACHE = path.join(__dirname, '.cache');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function decode16k(file, tempo = 1) {
  const chunks = [];
  await media.run(['-nostdin', '-loglevel', 'error', '-i', file, '-ac', '1', '-ar', '16000', ...(tempo !== 1 ? ['-af', `atempo=${tempo}`] : []), '-f', 'f32le', '-'], { onStdout: (c) => { chunks.push(c); } });
  const b = Buffer.concat(chunks); const ab = new ArrayBuffer(b.length - (b.length % 4)); Buffer.from(ab).set(b.subarray(0, ab.byteLength));
  let a = new Float32Array(ab), s = 0, e = a.length;
  while (s < e && Math.abs(a[s]) < 0.003) s++; while (e > s && Math.abs(a[e - 1]) < 0.003) e--;
  a = a.subarray(s, e);
  let p = 0; for (const v of a) if (Math.abs(v) > p) p = Math.abs(v);
  return a.map((v) => (v * 0.3) / (p || 1));
}
const words = (s) => s.toLowerCase().replace(/for ever/g, 'forever').replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean);
function wer(ref, hyp) { // word error rate, ref/hyp arrays
  const n = ref.length, m = hyp.length; let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) { const cur = [i]; for (let j = 1; j <= m; j++) cur[j] = ref[i - 1] === hyp[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]); prev = cur; }
  return prev[m] / n;
}
const pct = (arr, p) => { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

(async () => {
  localStt.init(() => process.env.GHOST_MODELS || path.join(process.env.APPDATA || '', 'ghost', 'models'));
  if (!localStt.modelReady() || !localStt.modelInfo(localStt.REFINE_MODEL).ready) { console.log('skip: speech models not on disk'); return; }
  // material: every cached clip, sped up 1.25x (fast talkers), joined with only 0.12 s between them
  const refs = Object.fromEntries(fs.readFileSync(path.join(CACHE, 'libri-trans.txt'), 'utf8').trim().split(/\r?\n/).map((l) => { const i = l.indexOf(' '); return [l.slice(0, i), l.slice(i + 1)]; }));
  const clips = [];
  for (const f of fs.readdirSync(CACHE).filter((f) => /^(tts-\d+-|libri-(0|1)\.wav)/.test(f)).sort()) {
    const ref = f.startsWith('libri-') ? refs[f.replace('libri-', '')] : null;
    clips.push({ f, audio: await decode16k(path.join(CACHE, f), 1.25), ref });
  }
  if (clips.length < 4) { console.log('skip: run test/stt-bench.js once first (it creates the speech clips)'); return; }
  const gap = new Float32Array(Math.round(0.12 * 16000));
  const build = (order) => { const parts = []; let n = 0, k = 0; const used = []; while (n < MINUTES * 60 * 16000) { const c = clips[order[k++ % order.length]]; parts.push(c.audio, gap); n += c.audio.length + gap.length; used.push(c); } const out = new Float32Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return { samples: out, used }; };
  const idx = clips.map((_, i) => i);
  const tracks = [build(idx), build(idx.slice().reverse())].slice(0, SOURCES);
  console.log(`stress: ${MINUTES} min of non-stop speech on ${SOURCES} source(s) at ${SPEED}x real time (${clips.length} clips, 1.25x tempo, 0.12 s gaps)`);

  const agcs = tracks.map(() => dsp.createAgc({ rate: 16000 }));
  const ts = tracks.map((_, i) => new localStt.LocalTranscriber({ sampleRate: 16000, kind: i === 0 ? 'call' : 'mic' }));
  const feedWall = tracks.map(() => []); // wall time at which each second of audio was fed
  const shown = [], refined = [], onset = [], lines = tracks.map(() => []);
  ts.forEach((t, i) => {
    const byUid = new Map();
    const delay = (uid) => { const end = t._ends && t._ends.get(uid); const w = end != null ? feedWall[i][Math.min(feedWall[i].length - 1, Math.floor(end))] : null; return w ? (Date.now() - w) / 1000 : null; };
    const onsetDelay = (uid) => { const st = t._starts && t._starts.get(uid); const w = st != null ? feedWall[i][Math.min(feedWall[i].length - 1, Math.floor(st))] : null; return w ? (Date.now() - w) / 1000 : null; };
    t.on('final', (text, meta) => { const l = { uid: meta.uid, text }; lines[i].push(l); byUid.set(meta.uid, l); const d = delay(meta.uid); if (d != null) { shown.push(d); if (!meta.provisional) refined.push(d); } const o = onsetDelay(meta.uid); if (o != null) onset.push(o); });
    t.on('revise', (r) => { const l = byUid.get(r.uid); if (l && r.text) l.text = r.text; const d = delay(r.uid); if (d != null) refined.push(d); });
    t.on('error', (e) => console.error('stt error', e.message));
    if (process.env.GHOST_STT_DEBUG) { t.on('log', (x) => console.log('   ', x)); t.on('final', (text, meta) => console.log(`    FINAL ${meta.uid} prov=${!!meta.provisional} late=${!!meta.late}: ${text.slice(0, 70)}`)); t.on('revise', (r) => console.log(`    REVISE ${r.uid}${r.skipped ? ' (skipped)' : ''}: ${(r.text || r.error || '').slice(0, 70)}`)); }
  });
  for (const t of ts) await t.connect();
  await sleep(1500);

  const FRAME = 1365; const total = tracks[0].samples.length; const started = Date.now();
  let maxBacklog = 0, lastProbe = 0; const backlogs = [];
  for (let i = 0; i < total; i += FRAME) {
    for (let s = 0; s < SOURCES; s++) {
      const pcm = agcs[s].process(tracks[s].samples.slice(i, Math.min(total, i + FRAME)));
      const i16 = new Int16Array(pcm.length); for (let k = 0; k < pcm.length; k++) { const v = Math.max(-1, Math.min(1, pcm[k])); i16[k] = v < 0 ? v * 0x8000 : v * 0x7fff; }
      ts[s].sendAudio(Buffer.from(i16.buffer).toString('base64'));
      const sec = Math.floor(i / 16000); if (feedWall[s][sec] === undefined) feedWall[s][sec] = Date.now();
    }
    const due = started + ((i / 16000) * 1000) / SPEED; if (Date.now() < due) await sleep(due - Date.now());
    // every 15 s of audio: how long does the worker take to reach "now"? (queued audio = lag)
    if (i / 16000 - lastProbe >= 15) { lastProbe = i / 16000; const t0 = Date.now(); ts[0].drain().then(() => { const b = (Date.now() - t0) / 1000; backlogs.push(b); if (b > maxBacklog) maxBacklog = b; }); }
  }
  const fedIn = (Date.now() - started) / 1000;
  const t0 = Date.now(); await Promise.all(ts.map((t) => t.drain())); const finalBacklog = (Date.now() - t0) / 1000;
  const t1 = Date.now(); while (Date.now() - t1 < 240000 && localStt.refinePending() > 0) await sleep(200);
  const refineTail = (Date.now() - t1) / 1000;
  ts.forEach((t) => t.close()); await sleep(1200);

  let errs = 0, wordsTotal = 0;
  tracks.forEach((tr, i) => {
    const ref = words(tr.used.filter((c) => c.ref).map((c) => c.ref).join(' ')); // only clips with a reference transcript are scored exactly
    const hyp = words(lines[i].map((l) => l.text).join(' '));
    const refAll = tr.used.length, got = lines[i].length;
    // coverage: every reference word from the scored clips that appears somewhere in the hypothesis
    const hs = new Map(); for (const w of hyp) hs.set(w, (hs.get(w) || 0) + 1);
    let hit = 0; for (const w of ref) { const c = hs.get(w) || 0; if (c > 0) { hit++; hs.set(w, c - 1); } }
    errs += ref.length - hit; wordsTotal += ref.length;
    console.log(`  source ${i}: ${refAll} utterances fed, ${got} lines, ${hyp.length} words out; reference words recovered ${hit}/${ref.length} (${((100 * hit) / (ref.length || 1)).toFixed(1)} %)`);
  });
  const r = {
    minutes: MINUTES, speed: SPEED, sources: SOURCES, fedInSec: +fedIn.toFixed(1),
    spokenToScreen: { median: +pct(onset, 0.5).toFixed(1), p95: +pct(onset, 0.95).toFixed(1), max: +Math.max(0, ...onset).toFixed(1) },
    shown: { median: +pct(shown, 0.5).toFixed(1), p95: +pct(shown, 0.95).toFixed(1), max: +Math.max(0, ...shown).toFixed(1), n: shown.length },
    refined: { median: +pct(refined, 0.5).toFixed(1), p95: +pct(refined, 0.95).toFixed(1), max: +Math.max(0, ...refined).toFixed(1), n: refined.length },
    workerBacklog: { max: +maxBacklog.toFixed(1), atEnd: +finalBacklog.toFixed(1) }, refineTailSec: +refineTail.toFixed(1),
    recovered: +(1 - errs / (wordsTotal || 1)).toFixed(4),
    lines: lines.map((ls) => ls.map((l) => l.text)),
  };
  console.log(`  FIRST WORDS of a line: spoken -> on screen  median ${r.spokenToScreen.median} s · p95 ${r.spokenToScreen.p95} s · max ${r.spokenToScreen.max} s`);
  console.log(`  line shown after speech ends:   median ${r.shown.median} s · p95 ${r.shown.p95} s · max ${r.shown.max} s  (${r.shown.n} lines)`);
  console.log(`  accuracy pass finished after:   median ${r.refined.median} s · p95 ${r.refined.p95} s · max ${r.refined.max} s`);
  console.log(`  recognizer backlog:             max ${r.workerBacklog.max} s while running · ${r.workerBacklog.atEnd} s left at the end · accuracy queue ${r.refineTailSec} s`);
  const json = opt('json', null); if (json) fs.writeFileSync(json, JSON.stringify(r, null, 2));
  localStt.shutdown(); setTimeout(() => process.exit(0), 300);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
