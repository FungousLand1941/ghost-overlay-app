// Ghost started again while it is already running (Ghost.exe double-clicked
// twice because the portable build takes a few seconds to unpack, or started
// while it sits in the tray) must hand over to the running copy at once — and
// must not need any of the app's files to do it.
//
// Why: every launch of a portable Ghost.exe used to unpack into the same temp
// folder, wiping it first. A second launch deleted the running copy's files and
// started on a half-written folder: "A JavaScript error occurred in the main
// process — ENOENT … stt-level.js". The launcher now uses a folder per launch
// (package.json portable.unpackDirName), and main.js checks for a running copy
// before it loads anything.
//
// Starts Ghost (isolated config), then a second copy whose folder holds nothing
// but main.js and package.json, and checks that the second copy exits cleanly,
// quickly, and that the first one notices and keeps running.
//   node test/second-instance.js        (Linux without a display: uses xvfb-run)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'ok' : 'FAIL'} ${n}${x ? ` — ${x}` : ''}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-instance-ud-'));
const wiped = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-instance-app-'));
for (const f of ['main.js', 'package.json']) fs.copyFileSync(path.join(ROOT, f), path.join(wiped, f));

const electron = require('electron');
const headless = process.platform === 'linux' && !process.env.DISPLAY;
function launch(appDir) {
  const args = [appDir, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])];
  const cmd = headless ? 'xvfb-run' : electron;
  const child = spawn(cmd, headless ? ['-a', electron, ...args] : args, { env: { ...process.env, GHOST_USERDATA: userData }, detached: process.platform !== 'win32' });
  child.out = ''; child.stdout.on('data', (d) => { child.out += d; }); child.stderr.on('data', (d) => { child.out += d; });
  child.exited = new Promise((r) => child.on('exit', (code) => r(code)));
  return child;
}
function kill(child) { try { if (process.platform === 'win32') child.kill(); else process.kill(-child.pid, 'SIGTERM'); } catch {} }
const logText = () => { try { return fs.readFileSync(path.join(userData, 'ghost.log'), 'utf8'); } catch { return ''; } };

(async () => {
  const first = launch(ROOT);
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { await sleep(250); up = /\] v[\d.]+ started/.test(logText()); }
  check('first copy starts', up);
  if (!up) { kill(first); console.log(first.out.slice(-2000)); process.exit(1); }

  const t0 = Date.now();
  const second = launch(wiped);
  const code = await Promise.race([second.exited, sleep(15000).then(() => 'timeout')]);
  const ms = Date.now() - t0;
  if (code === 'timeout') kill(second);
  check('second copy (its app files gone) exits cleanly and quickly', code === 0 && ms < 10000, `exit ${code} after ${ms} ms`);
  check('…without any error', !/threw an error|Cannot find module|ENOENT|Uncaught/i.test(second.out), second.out.split('\n').find((l) => /threw an error|Cannot find module|ENOENT|Uncaught/i.test(l)) || '');
  await sleep(800);
  check('first copy is told, and shows itself', /started again while running/.test(logText()));
  check('first copy keeps running', first.exitCode === null);

  kill(first);
  await Promise.race([first.exited, sleep(5000)]);
  for (const d of [userData, wiped]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  console.log(failures ? `second-instance: ${failures} FAILED` : 'second-instance: all checks passed');
  process.exit(failures ? 1 : 0);
})();
