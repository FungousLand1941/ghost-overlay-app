// How far behind does the REAL APP run during non-stop talk? Starts Ghost
// (isolated config, local engine), injects minutes of continuous fast speech on
// BOTH sources straight into its capture graph (GHOST_FAKE_AUDIO — silent, the
// speakers and microphone are not touched), toggles listening with the global
// hotkey, and reads the lag stamped on every transcript line in the log:
// "+N.N s" = time from the words being spoken to the line arriving.
// Covers what test/stt-stress.js cannot: the renderer's audio worklet and DSP,
// the echo gate, IPC, the main process, and the transcript UI.
//
//   node test/app-lag.js [--minutes 5] [--burn 0] [--exe path\to\Ghost.exe]
//     --burn N   run N busy CPU processes alongside (a machine that is also in a call, sharing, etc.)
//     --exe      test a packaged build instead of the source tree
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const media = require('../src/media');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const MINUTES = +opt('minutes', 5), BURN = +opt('burn', 0), EXE = opt('exe', null);
const ROOT = path.join(__dirname, '..');
const CACHE = path.join(__dirname, '.cache');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keys = (k) => execFileSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${k}')`]);
const pct = (a, p) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

async function decode16k(file, tempo) {
  const chunks = [];
  await media.run(['-nostdin', '-loglevel', 'error', '-i', file, '-ac', '1', '-ar', '16000', '-af', `atempo=${tempo}`, '-f', 'f32le', '-'], { onStdout: (c) => { chunks.push(c); } });
  const b = Buffer.concat(chunks); const ab = new ArrayBuffer(b.length - (b.length % 4)); Buffer.from(ab).set(b.subarray(0, ab.byteLength));
  let a = new Float32Array(ab), s = 0, e = a.length;
  while (s < e && Math.abs(a[s]) < 0.003) s++; while (e > s && Math.abs(a[e - 1]) < 0.003) e--;
  a = a.subarray(s, e);
  let p = 0; for (const v of a) if (Math.abs(v) > p) p = Math.abs(v);
  return a.map((v) => (v * 0.3) / (p || 1));
}
async function makeTracks() {
  const files = fs.readdirSync(CACHE).filter((f) => /^(tts-\d+-|libri-(0|1)\.wav)/.test(f)).sort();
  if (files.length < 4) throw new Error('run test/stt-bench.js once first (it creates the speech clips)');
  const clips = []; for (const f of files) clips.push(await decode16k(path.join(CACHE, f), 1.25));
  const gap = new Float32Array(Math.round(0.12 * 16000));
  const build = (order, name) => {
    const parts = []; let n = 0, k = 0;
    while (n < (MINUTES * 60 + 20) * 16000) { const c = clips[order[k++ % order.length]]; parts.push(c, gap); n += c.length + gap.length; }
    const out = new Float32Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    const f = path.join(CACHE, name); fs.writeFileSync(f, Buffer.from(out.buffer)); return f;
  };
  const idx = clips.map((_, i) => i);
  return [build(idx, 'track-call.f32'), build(idx.slice().reverse(), 'track-mic.f32')];
}

(async () => {
  const [call, mic] = await makeTracks();
  const ud = path.join(os.tmpdir(), 'ghost-app-lag');
  fs.rmSync(ud, { recursive: true, force: true }); fs.mkdirSync(ud, { recursive: true });
  try { execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Process Ghost,electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue']); } catch {}
  await sleep(1500);
  const env = { ...process.env, GHOST_USERDATA: ud, GHOST_MODELS: process.env.GHOST_MODELS || path.join(process.env.APPDATA, 'ghost', 'models'), GHOST_FAKE_AUDIO: `${call};${mic}`, GHOST_AUDIO_SOURCE: 'both' };
  const burners = [];
  for (let i = 0; i < BURN; i++) burners.push(spawn(process.execPath, ['-e', 'for(;;){Math.sqrt(Math.random())}'], { stdio: 'ignore', windowsHide: true }));
  const app = EXE ? spawn(EXE, [], { env, stdio: 'ignore', windowsHide: true }) : spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT], { env, cwd: ROOT, stdio: 'ignore', windowsHide: true });
  console.log(`app-lag: ${MINUTES} min of non-stop speech on both sources, ${EXE ? 'packaged build' : 'source tree'}${BURN ? `, ${BURN} busy CPU processes alongside (${os.cpus().length} threads)` : ''}`);
  const logFile = path.join(ud, 'ghost.log');
  for (let i = 0; i < 60 && !(fs.existsSync(logFile) && /accuracy pass ready|warm-up ready/.test(fs.readFileSync(logFile, 'utf8'))); i++) await sleep(1000);
  await sleep(2500);
  keys('^+l');
  await sleep(MINUTES * 60 * 1000);
  keys('^+l');
  await sleep(4000);
  for (const b of burners) { try { b.kill(); } catch {} }
  try { execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Process Ghost,electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue']); } catch {}
  try { app.kill(); } catch {}

  const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/);
  const ver = (lines.find((l) => /\[ghost\] v/.test(l)) || '').replace(/^\S+ /, '');
  const shown = [], refined = [], per = { them: 0, you: 0 }; let late = 0, lastAt = 0, firstAt = 0;
  const seen = new Set();
  for (const l of lines) {
    const m = l.match(/^(\S+) \[live:(them|you):local\] (final|revised)( \(provisional\))?(?: (\S+))? ?\+([\d.]+)s/);
    const f = l.match(/^(\S+) \[live:(them|you):local\] final(?: \(provisional\))? \+([\d.]+)s/);
    const r = l.match(/^(\S+) \[live:(them|you):local\] revised (\S+) \+([\d.]+)s/);
    if (f) { shown.push(+f[3]); per[f[2]]++; if (!/provisional/.test(l)) { refined.push(+f[3]); late++; } const t = Date.parse(f[1]); if (!firstAt) firstAt = t; lastAt = t; }
    else if (r) { if (!seen.has(r[3])) { seen.add(r[3]); refined.push(+r[4]); } lastAt = Date.parse(r[1]); }
    void m;
  }
  const sheds = lines.filter((l) => /pausing live partial words/.test(l)).length;
  const skipped = lines.filter((l) => /overloaded: skipped/.test(l)).length;
  const kept = lines.filter((l) => /kept the live text/.test(l)).length;
  const errors = lines.filter((l) => /error|failed|crash/i.test(l) && !/revise .* failed: undefined/.test(l)).slice(0, 5);
  // drift: is the lag at the end worse than at the start?
  const third = Math.max(1, Math.floor(refined.length / 3));
  const head = refined.slice(0, third), tail = refined.slice(-third);
  console.log(`  ${ver}`);
  console.log(`  lines: ${shown.length} (${per.them} call side, ${per.you} your side) over ${((lastAt - firstAt) / 60000).toFixed(1)} min`);
  console.log(`  a line appears after the words:     median ${pct(shown, 0.5).toFixed(1)} s · p95 ${pct(shown, 0.95).toFixed(1)} s · max ${Math.max(0, ...shown).toFixed(1)} s`);
  console.log(`  ...and is fully refined after:      median ${pct(refined, 0.5).toFixed(1)} s · p95 ${pct(refined, 0.95).toFixed(1)} s · max ${Math.max(0, ...refined).toFixed(1)} s`);
  console.log(`  drift: first third median ${pct(head, 0.5).toFixed(1)} s  ->  last third median ${pct(tail, 0.5).toFixed(1)} s`);
  console.log(`  live partial words paused ${sheds}x · lines kept as live text ${kept} · speech skipped ${skipped}x${errors.length ? ` · errors: ${errors.map((e) => e.slice(25, 120)).join(' | ')}` : ' · no errors'}`);
  const ok = shown.length > MINUTES * 8 && Math.max(0, ...refined) < 30 && pct(tail, 0.5) < pct(head, 0.5) + 5;
  console.log(ok ? '  PASS: stays current, no drift' : '  FAIL: see numbers above');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
