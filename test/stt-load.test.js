// Getting the local speech engine onto disk and loaded, without the real models:
// a local HTTP server stands in for Hugging Face, and a stand-in worker thread
// for the recognizer where loading the real one would need the real model.
//   - two audio sources asking for the same model at once share ONE download
//     (it used to be two downloads into the same file: one source failed)
//   - a transfer cut short or stalled is an error, and leaves no file behind
//   - a damaged model (the speech runtime ABORTS the process that loads one) is
//     caught in a throwaway process, deleted and downloaded again — never loaded
//   - a marker left by a run that died while loading triggers that check at the next start
//   - a load that failed cleanly is retried on the next attempt, not remembered
process.env.GHOST_DL_STALL_MS = '1500';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const wt = require('worker_threads');

// stand-in recognizer thread: fails to load the first time, loads the second
let workersMade = 0;
class FakeWorker extends require('events').EventEmitter {
  constructor() { super(); this.n = ++workersMade; }
  postMessage(m) {
    if (m.type !== 'init') return;
    setTimeout(() => { if (this.n === 1) this.emit('message', { type: 'init-error', error: 'simulated load failure' }); else this.emit('message', { type: 'ready', ms: 1, vad: true }); }, 20);
  }
  terminate() { setTimeout(() => this.emit('exit', 1), 5); }
}
const RealWorker = wt.Worker;
wt.Worker = FakeWorker; // local-stt picks it up when it is required below
const stt = require('../src/providers/local-stt');
wt.Worker = RealWorker;

let failures = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'ok' : 'FAIL'} ${n}${x ? ` — ${x}` : ''}`); if (!c) failures++; };

// mode: 'ok' (full body), 'short' (closes early), 'stall' (headers, then nothing), 'garbage' (random bytes, full length)
let mode = 'ok', requests = 0;
const SIZE = 400000;
const server = http.createServer((req, res) => {
  requests++;
  res.writeHead(200, { 'content-length': SIZE });
  if (mode === 'stall') { res.write(Buffer.alloc(1000, 1)); return; } // never finishes
  const body = mode === 'garbage' ? require('crypto').randomBytes(SIZE) : Buffer.alloc(SIZE, 7);
  const end = mode === 'short' ? SIZE / 2 : SIZE;
  let sent = 0;
  const tick = () => {
    if (sent >= end) { if (mode === 'short') res.destroy(); else res.end(); return; }
    const n = Math.min(32768, end - sent); res.write(body.subarray(sent, sent + n)); sent += n; setTimeout(tick, 2);
  };
  tick();
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-stt-load-'));
  stt.init(() => dir);
  stt.setRefine(false);
  const fake = (id) => ({ id, label: id, base, files: { encoder: 'encoder.onnx', decoder: 'decoder.onnx', joiner: 'joiner.onnx', tokens: 'tokens.txt' }, minBytes: { encoder: 1e5, decoder: 1e5, joiner: 1e5, tokens: 1e5 }, modelType: '' });
  const files = (m) => Object.values(m.files).map((f) => path.join(dir, m.id, f));
  const allThere = (m) => files(m).every((f) => { try { return fs.statSync(f).size === SIZE; } catch { return false; } });
  const nonePart = (m) => fs.readdirSync(path.join(dir, m.id)).every((f) => !f.endsWith('.part'));

  // 1. two sources, one download. (The test server's bytes are not a real model, so the
  //    after-download test-load is answered 'unknown' here, as when it cannot run.)
  {
    const m = fake('race');
    stt._setProbe(async () => ({ verdict: 'unknown', why: 'stand-in' }));
    mode = 'ok'; requests = 0;
    const r = await Promise.allSettled([stt.ensureModel(() => {}, m), stt.ensureModel(() => {}, m), stt.ensureModel(() => {}, m)]);
    stt._setProbe(null);
    check('three callers for the same model at once all succeed', r.every((x) => x.status === 'fulfilled'), r.filter((x) => x.status === 'rejected').map((x) => x.reason.message).join('; '));
    check('…with one request per file, not one per caller', requests === 4, `${requests} requests`);
    check('…and every file complete', allThere(m) && nonePart(m));
  }

  // 2. a transfer that stops early is not a model file
  {
    const m = fake('short'); mode = 'short';
    let err = null; try { await stt.ensureModel(() => {}, m); } catch (e) { err = e; }
    check('download cut short is an error', !!err && /stopped early|terminated|fetch failed|other side closed|aborted|socket/i.test(err.message), err && err.message);
    check('…and leaves no file behind', !fs.existsSync(files(m)[0]) && nonePart(m));
  }

  // 3. a transfer that stalls is abandoned instead of hanging Listen forever
  {
    const m = fake('stall'); mode = 'stall';
    const t0 = Date.now(); let err = null;
    try { await stt.ensureModel(() => {}, m); } catch (e) { err = e; }
    check('stalled download gives up', !!err && /stalled/.test(err.message) && Date.now() - t0 < 10000, err && `${err.message} after ${Date.now() - t0} ms`);
    check('…and leaves no file behind', nonePart(m) && !fs.existsSync(files(m)[0]));
  }

  // 4. damaged model: the speech runtime would abort Ghost; it is caught in a separate process
  {
    const m = fake('damaged'); mode = 'garbage';
    const probe0 = Date.now();
    const v = await (async () => { fs.mkdirSync(path.join(dir, 'probe-only'), { recursive: true }); const pm = fake('probe-only'); for (const f of files(pm)) fs.writeFileSync(f, require('crypto').randomBytes(SIZE)); return stt.probeModel(pm); })();
    check('test-load of a damaged model: only the test process dies, verdict "bad"', v.verdict === 'bad', `${v.verdict} (${v.why}) in ${Date.now() - probe0} ms`);
    requests = 0;
    let err = null; try { await stt.ensureModel(() => {}, m); } catch (e) { err = e; }
    check('damaged download is deleted, fetched again once, then reported', !!err && /damaged/.test(err.message) && requests === 8, `${err && err.message} (${requests} requests)`);
    check('…and no damaged file is left to load', files(m).every((f) => !fs.existsSync(f)));
  }

  // 5. a run that died while loading leaves a marker; the next start checks the model first
  {
    const m = fake('marker'); mode = 'garbage';
    fs.mkdirSync(path.join(dir, m.id), { recursive: true });
    for (const f of files(m)) fs.writeFileSync(f, require('crypto').randomBytes(SIZE));
    fs.writeFileSync(path.join(dir, m.id, '.loading'), JSON.stringify({ pid: 999999, at: Date.now() - 3600e3 }));
    requests = 0;
    let err = null; try { await stt.prepareLoad(m); } catch (e) { err = e; }
    check('marker from a dead run -> model test-loaded, found damaged, re-downloaded', requests >= 4 && !!err && /damaged/.test(err.message), `${requests} requests, ${err && err.message}`);
    check('…the stale marker is gone', !fs.existsSync(path.join(dir, m.id, '.loading')));
    // our own marker (a load in progress in this process) is not evidence of anything
    const ok = fake('own'); fs.mkdirSync(path.join(dir, ok.id), { recursive: true });
    for (const f of files(ok)) fs.writeFileSync(f, Buffer.alloc(SIZE, 1));
    requests = 0;
    await stt.prepareLoad(ok);
    check('prepareLoad leaves a marker while loading', fs.existsSync(path.join(dir, ok.id, '.loading')));
    await stt.prepareLoad(ok);
    check('…and does not mistake its own marker for a crash', requests === 0 && allThere(ok));
  }

  // 6. a clean load failure is retried next time (it used to be remembered until restart)
  {
    const real = stt.MODEL;
    for (const k of Object.keys(real.files)) {
      const f = path.join(dir, real.id, real.files[k]);
      fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ''); fs.truncateSync(f, real.minBytes[k]); // right size, never loaded for real (stand-in worker)
    }
    const first = await stt.warmUp();
    check('first load fails cleanly', first === false && workersMade === 1);
    check('…its marker is cleared (a clean failure is not a crash)', !fs.existsSync(path.join(dir, real.id, '.loading')));
    const second = await stt.warmUp();
    check('next attempt really tries again and loads', second === true && workersMade === 2, `workers made: ${workersMade}`);
    check('…marker cleared after a good load', !fs.existsSync(path.join(dir, real.id, '.loading')));
    stt.shutdown();
  }

  server.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log(failures ? `stt-load: ${failures} FAILED` : 'stt-load: all checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
