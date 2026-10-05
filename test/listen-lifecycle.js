// Listening start / stop in the REAL app (renderer, audio worklet, DSP, IPC,
// main process, Live session), with no sound devices and no network: the
// renderer plays synthetic call / mic tracks into its capture graph
// (GHOST_FAKE_AUDIO) and transcription goes to the mock Live server.
// Runs main.js's GHOST_SMOKE=listen step and checks:
//   1. Listen pressed twice quickly -> nothing left capturing (it used to leave a
//      capture running that no button could stop, feeding every frame twice)
//   2. one press -> one capture per source, at the real-time rate
//   3. Stop mid-sentence -> capture stops, and that sentence is still kept
//   4. Stop during a start that is failing over to chunked mode -> stays stopped
//
//   node test/listen-lifecycle.js      (Linux without a display: uses xvfb-run)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
process.env.MOCK_LIVE_HOLD_TURN = '1'; // the mock speaker never finishes the sentence on their own
const { startMock } = require('./mock-live');

const ROOT = path.join(__dirname, '..');
const RATE = 16000;
let failures = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'ok' : 'FAIL'} ${n}${x ? ` — ${x}` : ''}`); if (!c) failures++; };

// 30 s of speech-like signal per side (looped by the renderer)
function track(seed, level) {
  const n = RATE * 30, x = new Float32Array(n); let s = seed, lp = 0;
  for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; lp += 0.3 * ((s / 2147483648 - 1) - lp); x[i] = level * (0.55 + 0.45 * Math.sin((2 * Math.PI * 4 * i) / RATE)) * lp * 3; }
  return Buffer.from(x.buffer);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-listen-'));
const call = path.join(dir, 'call.f32'), mic = path.join(dir, 'mic.f32');
fs.writeFileSync(call, track(7, 0.12)); fs.writeFileSync(mic, track(11, 0.06));

const wss = startMock(0);
wss.on('listening', () => {
  const env = { ...process.env, GHOST_SMOKE: 'listen', GHOST_FAKE_AUDIO: `${call};${mic}`, GEMINI_LIVE_URL: `ws://127.0.0.1:${wss.address().port}`, GHOST_SMOKE_OUT: dir };
  const electron = require('electron'); // the binary's path, from Node
  let cmd = electron, args = ['.'];
  if (process.platform === 'linux') {
    args.push('--no-sandbox');
    if (!process.env.DISPLAY) { args = ['-a', electron, ...args]; cmd = 'xvfb-run'; }
  }
  const child = spawn(cmd, args, { cwd: ROOT, env });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { const t = String(d); if (/SMOKE_FAIL|\[renderer\]/.test(t)) process.stderr.write(t); });
  const kill = setTimeout(() => { console.log('FAIL timed out'); child.kill(); }, 90000);
  child.on('exit', () => {
    clearTimeout(kill); wss.close();
    const i = out.indexOf('SMOKE_OK');
    let res = null; try { res = JSON.parse(out.slice(out.indexOf('{', i))).listen; } catch {}
    if (!res) { console.log(out.slice(-3000)); console.log('FAIL no result from the app'); process.exit(1); }
    const near = (v, want) => Math.abs(v - want) < want * 0.25;
    const { doublePress: d, single: s, afterStop: a, stopDuringStart: x } = res;
    check('double press: nothing is left capturing', d.mode === null && !d.active && d.rate.system === 0 && d.rate.mic === 0, JSON.stringify({ mode: d.mode, rate: d.rate }));
    check('one press: listening', s.mode === 'live' && s.active, s.status);
    check('…one capture per source at the real-time rate (not doubled)', near(s.rate.system, RATE) && near(s.rate.mic, RATE), `${s.rate.system} / ${s.rate.mic} samples/s`);
    check('stop: capture stops', a.mode === null && !a.active && a.rate.system === 0 && a.rate.mic === 0, JSON.stringify(a.rate));
    check('stop mid-sentence: the sentence being spoken is kept, both sides', a.lines.includes('them:wait what is a binary tree') && a.lines.includes('you:wait what is a binary tree'), JSON.stringify(a.lines));
    check('stop during a start that fails over to chunked mode: stays stopped', x.mode === null && !x.active && x.rate.system === 0 && x.rate.mic === 0, JSON.stringify({ mode: x.mode, active: x.active, status: x.status }));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    console.log(failures ? `listen-lifecycle: ${failures} FAILED` : 'listen-lifecycle: all checks passed');
    process.exit(failures ? 1 : 0);
  });
});
