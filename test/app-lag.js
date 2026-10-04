// How far behind does the REAL APP run during non-stop talk, and does it still
// get the words right? Starts Ghost (isolated config, local engine), injects
// minutes of continuous fast speech on BOTH sources straight into its capture
// graph (GHOST_FAKE_AUDIO — silent, the speakers and microphone are not touched),
// toggles listening with the global hotkey, then reads
//   - the lag stamped on every transcript line in the log ("+N.N s" = time from
//     the words arriving to the line appearing), and
//   - the transcript the app saved, scored word by word against what was played.
// Covers what test/stt-stress.js cannot: the renderer's audio worklet and DSP,
// the echo gate, IPC, the main process, and the transcript UI.
//
//   node test/app-lag.js [--scenario headphones] [--minutes 5] [--burn 0] [--exe path\to\Ghost.exe]
//     --scenario headphones  both sides talk non-stop at the same time; the mic hears only you (default)
//                speakers    the call talks non-stop; the mic hears the call from the speakers
//                            (delayed, quieter, muffled, with room decay) and you talking over it in turns
//                noise       as headphones, with steady background noise on both sides
//     --burn N   run N busy CPU processes alongside (a machine that is also in a call, sharing, etc.)
//     --exe      test a packaged build instead of the source tree
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const media = require('../src/media');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const MINUTES = +opt('minutes', 5), BURN = +opt('burn', 0), EXE = opt('exe', null), SCENARIO = opt('scenario', 'headphones');
const ROOT = path.join(__dirname, '..');
const CACHE = path.join(__dirname, '.cache');
const RATE = 16000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keys = (k) => execFileSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${k}')`]);
const pct = (a, p) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const words = (s) => s.toLowerCase().replace(/for ever/g, 'forever').replace(/dishonoured/g, 'dishonored').replace(/in-memory/g, 'in memory').replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean);

// what each clip says (the clips themselves are made by test/stt-bench.js)
const TTS = {
  0: 'Could you walk me through how you would design a rate limiter for a public API?',
  1: 'Sure. I would start with a token bucket per client, stored in Redis, and refill it on a fixed schedule.',
  2: 'What happens when the cache goes down in the middle of a traffic spike?',
  3: 'Then we fail open for a short window,', '3b': 'and fall back to a local in memory counter on each server.',
  4: 'The time complexity of binary search', '4b': 'is logarithmic in the number of elements.',
  5: 'Eventual consistency means replicas may briefly disagree, but they converge once writes stop.',
  6: 'How would you detect a cycle in a linked list without using extra memory?',
  7: 'Use two pointers. One moves a single step, the other moves two steps, and if they ever meet there is a cycle.',
};

async function decode16k(file, tempo) {
  const chunks = [];
  await media.run(['-nostdin', '-loglevel', 'error', '-i', file, '-ac', '1', '-ar', String(RATE), '-af', `atempo=${tempo}`, '-f', 'f32le', '-'], { onStdout: (c) => { chunks.push(c); } });
  const b = Buffer.concat(chunks); const ab = new ArrayBuffer(b.length - (b.length % 4)); Buffer.from(ab).set(b.subarray(0, ab.byteLength));
  let a = new Float32Array(ab), s = 0, e = a.length;
  while (s < e && Math.abs(a[s]) < 0.003) s++; while (e > s && Math.abs(a[e - 1]) < 0.003) e--;
  a = a.subarray(s, e);
  let p = 0; for (const v of a) if (Math.abs(v) > p) p = Math.abs(v);
  return a.map((v) => (v * 0.3) / (p || 1));
}

// deterministic noise (so two runs hear the same thing)
function noise(n, level, seed) {
  const out = new Float32Array(n); let x = seed >>> 0, lp = 0;
  for (let i = 0; i < n; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; const w = x / 2147483648 - 1; lp += 0.12 * (w - lp); out[i] = lp; } // low-passed: room / fan / road noise
  let s = 0; for (const v of out) s += v * v; const g = level / Math.sqrt(s / n || 1);
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

async function makeTracks() {
  const libri = Object.fromEntries(fs.readFileSync(path.join(CACHE, 'libri-trans.txt'), 'utf8').trim().split(/\r?\n/).map((l) => { const i = l.indexOf(' '); return [l.slice(0, i), l.slice(i + 1)]; }));
  const files = fs.readdirSync(CACHE).filter((f) => /^(tts-\d+b?-|libri-(0|1)\.wav)/.test(f)).sort();
  if (files.length < 8) throw new Error('run test/stt-bench.js once first (it creates the speech clips)');
  const call = [], mic = [];
  for (const f of files) {
    const m = f.match(/^tts-(\d+b?)-(\w+)-/);
    const clip = { a: await decode16k(path.join(CACHE, f), 1.25), text: m ? TTS[m[1]] : libri[f.replace('libri-', '')] };
    if (m ? m[2] === 'David' : f === 'libri-0.wav') call.push(clip); else mic.push(clip); // one voice set per side, so each side has its own words
  }
  const total = (MINUTES * 60 + 20) * RATE;
  // clips back to back with `gapSec` between them, looping; events = where each sentence sits
  const lay = (clips, gapSec) => {
    const out = new Float32Array(total), events = []; let o = Math.round(0.5 * RATE), k = 0;
    while (o < total) { const c = clips[k++ % clips.length]; if (o + c.a.length > total) break; out.set(c.a, o); events.push({ end: (o + c.a.length) / RATE, text: c.text }); o += c.a.length + Math.round(gapSec * RATE); }
    return { out, events };
  };
  const c = lay(call, 0.12);
  const m = SCENARIO === 'speakers' ? lay(mic, 3.5) : lay(mic, 0.12); // speakers: you answer in turns, over the call
  const user = m.out.slice(); // your voice alone (ground truth for test/echo-sim.js)
  if (SCENARIO === 'speakers') {
    // what a laptop microphone hears of its own speakers: 110 ms late, a quarter as loud, muffled, ringing on in the room
    const d = Math.round(0.11 * RATE), comb = Math.round(0.047 * RATE); let lp = 0;
    const bleed = new Float32Array(total);
    for (let i = d; i < total; i++) { lp += 0.35 * (c.out[i - d] - lp); bleed[i] = 0.25 * lp + (i >= comb ? 0.35 * bleed[i - comb] : 0); }
    const n = noise(total, 0.002, 7);
    for (let i = 0; i < total; i++) m.out[i] += bleed[i] + n[i];
  }
  if (SCENARIO === 'noise') {
    const a = noise(total, 0.012, 11), b = noise(total, 0.012, 23); // ~12 dB below the speech
    for (let i = 0; i < total; i++) { c.out[i] += a[i]; m.out[i] += b[i]; }
  }
  const save = (x, name) => { const f = path.join(CACHE, name); fs.writeFileSync(f, Buffer.from(x.buffer)); return f; };
  return { call: save(c.out, 'track-call.f32'), mic: save(m.out, 'track-mic.f32'), refs: { them: c.events, you: m.events }, pcm: { call: c.out, mic: m.out, user } };
}

// word errors of `hyp` against `ref` (substitutions + deletions + insertions); extra words after the end of ref are free
function wordErrors(ref, hyp) {
  let prev = new Uint32Array(hyp.length + 1), cur = new Uint32Array(hyp.length + 1);
  for (let j = 0; j <= hyp.length; j++) prev[j] = j;
  for (let i = 1; i <= ref.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= hyp.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  let best = Infinity; for (let j = 0; j <= hyp.length; j++) if (prev[j] < best) best = prev[j];
  return best;
}

module.exports = { makeTracks, RATE };
if (require.main === module) (async () => {
  const tracks = await makeTracks();
  let ud = path.join(os.tmpdir(), 'ghost-app-lag');
  try { execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Process Ghost,electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue']); } catch {}
  await sleep(1500);
  // the previous run's Ghost may still hold files in its profile for a moment: wait, and if it still will not go, use a fresh folder
  try { fs.rmSync(ud, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }); } catch { ud = `${ud}-${Date.now()}`; console.log(`  (previous profile still locked; using ${ud})`); }
  fs.mkdirSync(ud, { recursive: true });
  const env = { ...process.env, GHOST_USERDATA: ud, GHOST_MODELS: process.env.GHOST_MODELS || path.join(process.env.APPDATA, 'ghost', 'models'), GHOST_FAKE_AUDIO: `${tracks.call};${tracks.mic}`, GHOST_AUDIO_SOURCE: 'both' };
  const burners = [];
  for (let i = 0; i < BURN; i++) burners.push(spawn(process.execPath, ['-e', 'for(;;){Math.sqrt(Math.random())}'], { stdio: 'ignore', windowsHide: true }));
  const app = EXE ? spawn(EXE, [], { env, stdio: 'ignore', windowsHide: true }) : spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT], { env, cwd: ROOT, stdio: 'ignore', windowsHide: true });
  console.log(`app-lag [${SCENARIO}]: ${MINUTES} min of non-stop speech, ${EXE ? 'packaged build' : 'source tree'}${BURN ? `, ${BURN} busy CPU processes alongside (${os.cpus().length} threads)` : ''}`);
  const logFile = path.join(ud, 'ghost.log');
  for (let i = 0; i < 60 && !(fs.existsSync(logFile) && /accuracy pass ready|warm-up ready/.test(fs.readFileSync(logFile, 'utf8'))); i++) await sleep(1000);
  await sleep(2500);
  keys('^+l');
  await sleep(MINUTES * 60 * 1000);
  keys('^+l');
  await sleep(9000); // last lines refined, session saved
  for (const b of burners) { try { b.kill(); } catch {} }
  try { execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Process Ghost,electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue']); } catch {}
  try { app.kill(); } catch {}

  const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/);
  const ver = (lines.find((l) => /\[ghost\] v/.test(l)) || '').replace(/^\S+ /, '');
  const shown = [], refined = [], per = { them: 0, you: 0 }; let lastAt = 0, firstAt = 0;
  const seen = new Set();
  for (const l of lines) {
    const f = l.match(/^(\S+) \[live:(them|you):local\] final(?: \(provisional\))? \+([\d.]+)s/);
    const r = l.match(/^(\S+) \[live:(them|you):local\] revised (\S+) \+([\d.]+)s/);
    if (f) { shown.push(+f[3]); per[f[2]]++; if (!/provisional/.test(l)) refined.push(+f[3]); const t = Date.parse(f[1]); if (!firstAt) firstAt = t; lastAt = t; }
    else if (r) { if (!seen.has(r[3])) { seen.add(r[3]); refined.push(+r[4]); } lastAt = Date.parse(r[1]); }
  }
  const sheds = lines.filter((l) => /pausing live partial words/.test(l)).length;
  const skipped = lines.filter((l) => /overloaded: skipped/.test(l)).length;
  const kept = lines.filter((l) => /kept the live text/.test(l)).length;
  const errors = lines.filter((l) => /error|failed|crash/i.test(l) && !/revise .* failed: undefined/.test(l)).slice(0, 5);
  const heard = lines.filter((l) => /worst delays/.test(l)).map((l) => +(l.match(/\((\d+) %\)/) || [])[1]).filter((x) => x > 0);
  // drift: is the lag at the end worse than at the start?
  const third = Math.max(1, Math.floor(refined.length / 3));
  const head = refined.slice(0, third), tail = refined.slice(-third);
  console.log(`  ${ver}`);
  console.log(`  lines: ${shown.length} (${per.them} call side, ${per.you} your side) over ${((lastAt - firstAt) / 60000).toFixed(1)} min`);
  console.log(`  a line appears after the words:     median ${pct(shown, 0.5).toFixed(1)} s · p95 ${pct(shown, 0.95).toFixed(1)} s · max ${Math.max(0, ...shown).toFixed(1)} s`);
  console.log(`  ...and is fully refined after:      median ${pct(refined, 0.5).toFixed(1)} s · p95 ${pct(refined, 0.95).toFixed(1)} s · max ${Math.max(0, ...refined).toFixed(1)} s`);
  console.log(`  drift: first third median ${pct(head, 0.5).toFixed(1)} s  ->  last third median ${pct(tail, 0.5).toFixed(1)} s`);
  console.log(`  audio that reached Ghost: ${heard.length ? `${Math.min(...heard)}–${Math.max(...heard)} % of real time per 20 s` : 'n/a'}`);
  console.log(`  live partial words paused ${sheds}x · lines kept as live text ${kept} · speech skipped ${skipped}x${errors.length ? ` · errors: ${errors.map((e) => e.slice(25, 120)).join(' | ')}` : ' · no errors'}`);

  // accuracy: the transcript the app saved, against the sentences that were fully played while it listened
  let session = { transcript: [] };
  try { session = JSON.parse(fs.readFileSync(path.join(ud, 'session.json'), 'utf8')); } catch {}
  const acc = {}; let leak = 0;
  for (const side of ['them', 'you']) {
    const ref = words(tracks.refs[side].filter((e) => e.end <= MINUTES * 60 - 8).map((e) => e.text).join(' '));
    const hyp = words(session.transcript.filter((t) => t.speaker === side).map((t) => t.text).join(' '));
    const errs = wordErrors(ref, hyp);
    acc[side] = ref.length ? errs / ref.length : 0;
    console.log(`  ${side === 'them' ? 'call side' : 'your side'}: ${ref.length} words played, ${hyp.length} transcribed, ${errs} word errors (${(100 * acc[side]).toFixed(1)} %)`);
  }
  if (SCENARIO === 'speakers') {
    // words only the call said, showing up as yours = speaker bleed that got through
    const callOnly = new Set(words(tracks.refs.them.map((e) => e.text).join(' ')).filter((w) => w.length > 5));
    for (const w of words(tracks.refs.you.map((e) => e.text).join(' '))) callOnly.delete(w);
    const you = words(session.transcript.filter((t) => t.speaker === 'you').map((t) => t.text).join(' '));
    leak = you.filter((w) => callOnly.has(w)).length;
    console.log(`  call words that leaked into your side through the speakers: ${leak}`);
  }
  if (process.env.APP_LAG_SHOW) console.log(session.transcript.map((t) => `    ${t.speaker}: ${t.text}`).join('\n'));
  const ok = shown.length > MINUTES * 8 && Math.max(0, ...refined) < 30 && pct(tail, 0.5) < pct(head, 0.5) + 3 && acc.them < 0.06 && acc.you < 0.1 && leak <= 3;
  console.log(ok ? '  PASS: stays current, no drift, words right' : '  FAIL: see numbers above');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
