// Ghost — screen-share-invisible AI overlay (main process)
//
// How invisibility works:
//   win.setContentProtection(true)
//     Windows  -> SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)
//     macOS    -> NSWindow.sharingType = .none
//   Every screen-capture path the OS exposes (Zoom, Meet, Teams, Discord, OBS,
//   Windows Game Bar, macOS screen recording) honours this flag, so the window
//   is simply absent from the captured frames while still visible to you.
//   Bonus: our own desktopCapturer screenshots don't contain the overlay either.
//
// Two Windows gotchas, verified empirically with test/exp-probe.ps1 (Electron 33):
//   1. setContentProtection(true) called BEFORE the first show() is silently lost.
//   2. Every hide() -> show() cycle resets the affinity back to 0 (capturable!).
//   So we (re)apply it on every 'show' and run a cheap watchdog. Don't remove.

const {
  app, BrowserWindow, globalShortcut, ipcMain, desktopCapturer,
  screen, session, shell, systemPreferences,
} = require('electron');
const path = require('path');
const store = require('./src/store');
const providers = require('./src/providers');

const SMOKE = !!process.env.GHOST_SMOKE;
// Smoke runs must never touch the real config (they write dummy keys).
if (SMOKE) app.setPath('userData', path.join(require('os').tmpdir(), 'ghost-smoke-userdata'));
const DEFAULT_W = 680;
const DEFAULT_H = 660;
const MIN_W = 640; // header holds two big buttons + mode toggle + 7 icons + Quit
const MOVE_STEP = 40;

let win = null;
let clickThrough = false;

// Plain-text diagnostics log at <userData>/ghost.log (no keys, no transcripts).
function log(...args) {
  const line = `${new Date().toISOString()} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  console.log(line);
  try { require('fs').appendFileSync(path.join(app.getPath('userData'), 'ghost.log'), line + '\n'); } catch {}
}
let inflight = null; // AbortController for the active chat stream

app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');
// Needed for getDisplayMedia() loopback capture on some GPUs.
app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  const cfg = store.get();
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const b = cfg.bounds || {};

  win = new BrowserWindow({
    width: Math.max(MIN_W, b.width || DEFAULT_W),
    height: b.height || DEFAULT_H,
    minWidth: MIN_W,
    minHeight: 360,
    x: b.x ?? disp.workArea.x + disp.workArea.width - DEFAULT_W - 24,
    y: b.y ?? disp.workArea.y + 24,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: 'Ghost',
    // Windows: 'toolbar' -> WS_EX_TOOLWINDOW, hides the window from Alt+Tab
    //          (the Alt+Tab switcher itself IS captured in a screen share).
    // macOS:   'panel' floats above fullscreen apps and doesn't steal focus.
    ...(process.platform === 'win32' ? { type: 'toolbar' } : {}),
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  applyProtection();
  win.on('show', applyProtection);
  win.on('restore', applyProtection);
  win.on('focus', applyProtection);
  setInterval(applyProtection, 2000).unref();

  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setMenuBarVisibility(false);
  if (process.platform === 'darwin') {
    win.setHiddenInMissionControl(true);
    win.setWindowButtonVisibility(false);
  }
  win.setOpacity(cfg.opacity ?? 1);

  win.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
    applyProtection(); // must happen after the first show (see header comment)
    if (SMOKE) runSmoke();
    // test hook: exercise the hide/show path the toggle hotkey uses
    if (process.env.GHOST_TEST_TOGGLE) setTimeout(() => { toggleVisible(); setTimeout(toggleVisible, 700); }, 1500);
  });

  const saveBounds = () => { if (win && !win.isDestroyed()) store.patch({ bounds: win.getBounds() }); };
  win.on('moved', saveBounds);
  win.on('resized', saveBounds);
  win.on('closed', () => { win = null; });

  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// Idempotent and cheap; see the gotchas in the header comment.
function applyProtection() {
  if (win && !win.isDestroyed()) win.setContentProtection(true);
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------------------------------------------------------------------------
// Screenshot (main-process; overlay is excluded by content protection)
// ---------------------------------------------------------------------------
async function captureScreen() {
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const sf = disp.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(disp.size.width * sf), height: Math.round(disp.size.height * sf) },
  });
  if (!sources.length) throw new Error('No screen sources available (check Screen Recording permission on macOS).');
  const src = sources.find((s) => String(s.display_id) === String(disp.id)) || sources[0];
  let img = src.thumbnail;
  if (img.isEmpty()) throw new Error('Screen capture returned an empty image.');

  // Downscale: vision models cap around ~1.5k px on the long edge anyway,
  // and smaller images = fewer tokens = faster answers.
  const { width, height } = img.getSize();
  const maxEdge = store.get().screenshotMaxEdge || 1568;
  const longest = Math.max(width, height);
  if (longest > maxEdge) {
    const r = maxEdge / longest;
    img = img.resize({ width: Math.round(width * r), height: Math.round(height * r), quality: 'good' });
  }
  return { mime: 'image/jpeg', data: img.toJPEG(82).toString('base64') };
}

// ---------------------------------------------------------------------------
// Global shortcuts
// ---------------------------------------------------------------------------
function toggleVisible() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else { ensureOnScreen(); win.show(); win.focus(); }
}

// If the saved position is off every display (monitor unplugged, resolution
// change), bring the window back onto the display under the cursor.
function ensureOnScreen() {
  const b = win.getBounds();
  const onSome = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x + b.width > a.x + 40 && b.x < a.x + a.width - 40 && b.y + 20 > a.y && b.y < a.y + a.height - 40;
  });
  if (onSome) return;
  const a = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  win.setPosition(a.x + a.width - b.width - 24, a.y + 24);
}

function nudge(dx, dy) {
  if (!win) return;
  const [x, y] = win.getPosition();
  win.setPosition(x + dx, y + dy);
}

function setClickThrough(on) {
  clickThrough = on;
  if (!win) return;
  // forward:true keeps mousemove events flowing so hover states still work
  win.setIgnoreMouseEvents(on, { forward: true });
  send('state', { clickThrough });
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  const s = store.get().shortcuts;
  const map = {
    [s.toggle]:        toggleVisible,
    [s.ask]:           () => { if (win) { win.show(); win.focus(); } send('hotkey', { action: 'ask' }); },
    [s.answerAudio]:   () => { if (win) win.show(); send('hotkey', { action: 'answer-audio' }); },
    [s.listen]:        () => send('hotkey', { action: 'toggle-listen' }),
    [s.clickThrough]:  () => setClickThrough(!clickThrough),
    [s.reset]:         () => send('hotkey', { action: 'reset' }),
    [s.stop]:          () => { if (inflight) inflight.abort(); },
    [s.moveLeft]:      () => nudge(-MOVE_STEP, 0),
    [s.moveRight]:     () => nudge(MOVE_STEP, 0),
    [s.moveUp]:        () => nudge(0, -MOVE_STEP),
    [s.moveDown]:      () => nudge(0, MOVE_STEP),
    [s.opacityDown]:   () => stepOpacity(-0.1),
    [s.opacityUp]:     () => stepOpacity(+0.1),
    [s.quit]:          () => requestQuit(),
  };
  const failed = [];
  for (const [accel, fn] of Object.entries(map)) {
    if (!accel) continue;
    try { if (!globalShortcut.register(accel, fn)) failed.push(accel); }
    catch { failed.push(accel); }
  }
  if (failed.length) console.warn('[ghost] could not register shortcuts:', failed.join(', '));
  return failed;
}

function stepOpacity(d) {
  if (!win) return;
  const o = Math.min(1, Math.max(0.2, +(win.getOpacity() + d).toFixed(2)));
  win.setOpacity(o);
  store.patch({ opacity: o });
  send('state', { opacity: o });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('config:get', () => {
  const c = store.getPublic();
  if (process.env.GHOST_AUDIO_SOURCE) c.transcription.sourceOverride = process.env.GHOST_AUDIO_SOURCE; // test override only
  return c;
});
ipcMain.handle('config:set', (_e, patch) => {
  // The renderer only ever sees masked keys ("sk-ant…abcd"); never let a masked
  // value overwrite the real one.
  for (const p of ['claude', 'gemini', 'openai']) {
    if (!patch?.[p] || !('apiKey' in patch[p])) continue;
    if (patch[p].apiKey === null) { patch[p].apiKey = ''; continue; }            // explicit "remove this key"
    if (!patch[p].apiKey || patch[p].apiKey.includes('…')) delete patch[p].apiKey; // empty/masked: keep the saved key
  }
  store.patch(patch);
  if (patch.shortcuts) registerShortcuts();
  if (patch.governor) { governor.configure(patch.governor); broadcastStats(); }
  if (patch.transcription && patch.transcription.localModel) localStt.setModel(patch.transcription.localModel);
  if (patch.transcription && 'refine' in patch.transcription) localStt.setRefine(patch.transcription.refine !== false);
  if (typeof patch.opacity === 'number' && win) win.setOpacity(patch.opacity);
  return store.getPublic();
});

ipcMain.handle('screen:capture', () => captureScreen());

// Streams a chat completion back to the renderer as {id, type, data} events.
ipcMain.handle('chat:start', async (_e, { id, messages, profile, mode }) => {
  if (inflight) inflight.abort();
  // User-initiated answers are never throttled, but they are counted and they
  // respect Pause.
  const gateErr = gate('ask');
  if (gateErr) { send('chat:event', { id, type: 'error', data: gateErr }); return; }
  const ac = new AbortController();
  inflight = ac;
  // 'instant' = small fast model, no thinking, short answer; 'think' = full model + thinking.
  const cfg = providers.modeConfig(store.get(), mode || 'instant');
  const answering = providers.effectiveProvider(cfg);
  const modelName = answering === 'gemini' ? cfg.gemini.model : answering === 'openai' ? cfg.openai.model : cfg.claude.model;
  const t0 = Date.now(); let tFirst = 0; let chars = 0;
  try {
    for await (const token of providers.stream(cfg, { messages, system: providers.systemPrompt(cfg, profile, mode), signal: ac.signal })) {
      if (ac.signal.aborted) break;
      if (!tFirst) tFirst = Date.now();
      chars += token.length;
      send('chat:event', { id, type: 'token', data: token });
    }
    log('[chat]', `mode=${mode || 'instant'} model=${modelName} firstToken=${tFirst ? tFirst - t0 : -1}ms total=${Date.now() - t0}ms chars=${chars} promptMsgs=${messages.length}`);
    send('chat:event', { id, type: 'done', model: modelName });
  } catch (err) {
    noteProviderError(err);
    if (ac.signal.aborted) send('chat:event', { id, type: 'done', aborted: true });
    else send('chat:event', { id, type: 'error', data: err.message || String(err) });
  } finally {
    if (inflight === ac) inflight = null;
  }
});
ipcMain.handle('chat:stop', () => { if (inflight) inflight.abort(); });

ipcMain.handle('provider:test', async (_e, { provider, apiKey }) => {
  const typed = apiKey && !apiKey.includes('…') ? apiKey : '';
  const shape = (typed || (store.get()[provider] || {}).apiKey || '');
  log(`[test] ${provider} key ${typed ? 'typed' : 'saved'} prefix=${shape.slice(0, 6)} len=${shape.length}`);
  if (provider === 'gemini') {
    // which models can this key actually see? (new AQ. keys may only get Gemini 3.x)
    try { const names = await require('./src/providers/gemini').listModels(shape); log(`[test] gemini models visible to this key: ${names ? names.slice(0, 25).join(', ') : '(list unavailable)'}`); } catch (e) { log('[test] gemini model list failed', e.message); }
  }
  try { const r = await providers.testKey(store.get(), { provider, apiKey: typed }); log(`[test] ${provider} OK model=${r.model} ${r.ms}ms`); return r; }
  catch (err) { log(`[test] ${provider} FAILED: ${err.message}`); return { ok: false, error: err.message || String(err) }; }
});

// ---- streaming transcription (Gemini Live) ----
// One session per audio source so lines come back labelled: system -> "them", mic -> "you".
const SPEAKER = { system: 'them', mic: 'you' };
let live = {}; // source -> LiveTranscriber
function stopLive() { liveGen++; for (const t of Object.values(live)) { try { t.close(); } catch {} } live = {}; }
// Start (or restart) transcription for one audio source with a given engine.
// Gemini Live is the accurate one; if it can't connect, is rejected, or runs
// out of quota — now or later mid-call — the source silently moves to the
// local offline engine so transcription never just stops.
let liveGen = 0;
async function startSource(source, engine, cfg) {
  const speaker = SPEAKER[source];
  const gen = liveGen;
  const { LiveTranscriber } = require('./src/providers/gemini-live');
  const t = engine === 'gemini'
    ? new LiveTranscriber({ apiKey: cfg.gemini.apiKey, model: cfg.transcription?.liveModel, sampleRate: 16000 })
    : new localStt.LocalTranscriber({ sampleRate: 16000 });
  t.engine = engine;
  t.on('interim', (text) => send('live:event', { type: 'interim', text, speaker, source }));
  t.on('final', (text, meta) => { log(`[live:${speaker}:${engine}] final${meta && meta.provisional ? ' (provisional)' : ''} (${text.split(/\s+/).length} words): ${text.slice(0, 90)}`); send('live:event', { type: 'final', text, speaker, source, uid: meta && meta.uid, provisional: !!(meta && meta.provisional) }); });
  t.on('revise', (r) => { if (r.text) log(`[live:${speaker}:${engine}] revised ${r.uid} in ${r.ms} ms (${(r.seconds || 0).toFixed(1)} s audio): ${r.text.slice(0, 90)}`); else log(`[live:${speaker}:${engine}] revise ${r.uid} failed: ${r.error}`); send('live:event', { type: 'revise', uid: r.uid, text: r.text, speaker, source }); });
  t.on('status', (text) => send('live:event', { type: 'status', text: `${speaker}: ${text}`, speaker, source }));
  t.on('log', (line) => log(`[live:${speaker}:${engine}]`, line));
  t.on('error', async (err) => {
    log(`[live:${speaker}:${engine}] error`, err.message);
    if (gen !== liveGen || live[source] !== t) return; // stale session
    if (engine === 'gemini' && cfg.transcription?.localFallback !== false) {
      if (err.code === 'QUOTA') { governor.noteError(err); }
      send('live:event', { type: 'status', text: `${speaker}: Gemini Live ${err.code === 'QUOTA' ? 'quota exhausted' : 'failed'} → switched to local offline transcription`, speaker, source });
      try { t.close(); } catch {}
      try { await startSource(source, 'local', cfg); } catch (e2) { send('live:event', { type: 'error', text: `${err.message}; local fallback failed too: ${e2.message}`, speaker, source }); }
      return;
    }
    send('live:event', { type: 'error', text: err.message, speaker, source });
  });
  const model = await t.connect();
  if (gen !== liveGen) { t.close(); throw new Error('cancelled'); }
  live[source] = t;
  return model;
}

ipcMain.handle('live:start', async (_e, { sources } = {}) => {
  const cfg = store.get();
  let engine = cfg.transcription?.engine || 'gemini';
  const key = cfg.gemini?.apiKey;
  const paused = governor.allow('ask');
  if (!paused.ok) return { ok: false, error: paused.reason, code: 'GOVERNOR' };
  if (engine === 'gemini' && (!key || !governor.allow('live').ok)) {
    const why = !key ? 'no Gemini API key' : governor.allow('live').reason;
    if (cfg.transcription?.localFallback === false) return { ok: false, error: `Gemini Live transcription unavailable: ${why}` };
    send('live:event', { type: 'status', text: `Gemini Live unavailable (${why}) → using local offline transcription` });
    engine = 'local';
  }
  stopLive(); liveGen++;
  const wanted = (sources && sources.length ? sources : ['system']).filter((s) => SPEAKER[s]);
  log('[live] starting sources', wanted, 'engine', engine, engine === 'gemini' ? `model ${cfg.transcription?.liveModel}` : `local model ready=${localStt.modelReady()}`, 'electron', process.versions.electron);
  if (engine !== 'gemini' && !localStt.modelReady()) send('live:event', { type: 'status', text: 'first run: downloading the free speech model (~72 MB, once)…' });
  const results = await Promise.all(wanted.map(async (source) => {
    const speaker = SPEAKER[source];
    try {
      return { source, ok: true, model: await startSource(source, engine, cfg) };
    } catch (err) {
      log(`[live:${speaker}:${engine}] connect failed:`, err.attempts || err.message);
      if (engine === 'gemini' && cfg.transcription?.localFallback !== false) {
        send('live:event', { type: 'status', text: `${speaker}: Gemini Live could not connect (${String(err.message).slice(0, 80)}) → local offline transcription`, speaker, source });
        try { return { source, ok: true, model: await startSource(source, 'local', cfg), fellBack: true }; }
        catch (e2) { return { source, ok: false, error: `${err.message}; local: ${e2.message}` }; }
      }
      return { source, ok: false, error: err.message };
    }
  }));
  const ok = results.filter((r) => r.ok);
  if (!ok.length) return { ok: false, error: results.map((r) => `${SPEAKER[r.source]}: ${r.error}`).join(' | ') };
  return { ok: true, model: ok[0].model, sources: ok.map((r) => r.source), failed: results.filter((r) => !r.ok).map((r) => `${SPEAKER[r.source]}: ${r.error}`) };
});
// Diagnostic: GHOST_DUMP_AUDIO=1 appends every received PCM16 frame per source to
// <userData>/dump-<source>.pcm (raw 16 kHz mono LE), so we can transcribe exactly
// what Ghost captured and prove whether the fault is capture or recognition.
const audioDump = process.env.GHOST_DUMP_AUDIO ? {} : null;
ipcMain.on('live:audio', (_e, { source, data }) => {
  if (audioDump) { try { require('fs').appendFileSync(path.join(app.getPath('userData'), `dump-${source}.pcm`), Buffer.from(data, 'base64')); } catch {} }
  const t = live[source]; if (t) t.sendAudio(data);
});
ipcMain.handle('live:nudge', () => { for (const t of Object.values(live)) t.nudge(); });
ipcMain.handle('live:pendingRevisions', () => localStt.refinePending());
ipcMain.handle('live:stop', () => stopLive());

// ---- quitting & tray -------------------------------------------------------
// Quit asks the renderer to flush its session to disk first (it replies by
// calling win:quit); if that doesn't happen within 600 ms we quit anyway.
let quitting = false;
function requestQuit() {
  if (quitting) return app.quit();
  quitting = true;
  send('app:save-now', {});
  setTimeout(() => app.quit(), 600);
}

// A 16x16 tray icon drawn in code (no asset files): a soft white ghost blob.
function trayIcon() {
  const { nativeImage } = require('electron');
  const zlib = require('zlib');
  const W = 16, H = 16;
  const px = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const cx = 7.5, cy = 6.5, r = 6.2;
    const d = Math.hypot(x - cx, y - cy);
    const inHead = d <= r && y <= cy;                       // dome
    const inBody = y > cy && y <= 13 && Math.abs(x - cx) <= r * 0.98 && !((y === 13) && ((x + 1) % 4 < 2)); // skirt with notches
    const eye = (x === 5 || x === 10) && (y === 6 || y === 7);
    const on = (inHead || inBody) && !eye;
    const i = (y * W + x) * 4;
    px[i] = 235; px[i + 1] = 235; px[i + 2] = 245; px[i + 3] = on ? 255 : 0;
  }
  // encode PNG
  const crcTable = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0; px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4); }
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return nativeImage.createFromBuffer(png);
}

let tray = null;
function createTray() {
  const { Tray, Menu } = require('electron');
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip('Ghost — invisible AI overlay');
    const rebuild = () => {
      const paused = governor.stats().paused;
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: win && win.isVisible() ? 'Hide overlay' : 'Show overlay', click: () => toggleVisible() },
        { label: paused ? '▶ Resume AI' : '⏸ Pause AI', click: () => { governor.setPaused(!paused); if (!paused) { if (inflight) inflight.abort(); stopLive(); } broadcastStats(); rebuild(); } },
        { type: 'separator' },
        { label: 'Quit Ghost', click: () => requestQuit() },
      ]));
    };
    rebuild();
    tray.on('click', () => toggleVisible());
    if (win) { win.on('show', rebuild); win.on('hide', rebuild); }
  } catch (e) { log('[tray] unavailable', e.message); }
}

// ---- Claude: persist an auto-detected workspace id (multi-workspace keys) ----
require('./src/providers/claude').onWorkspaceDiscovered = (id) => {
  store.patch({ claude: { workspaceId: id } });
  log('[claude] workspace auto-detected and saved:', id);
  send('toast', { text: `Claude workspace detected (${id}) — saved` });
};

// ---- Gemini: persist a model that had to be swapped because the key can't see the configured one ----
require('./src/providers/gemini').onModelResolved = ({ wanted, chosen, purpose }) => {
  const cfg = store.get();
  if (purpose === 'chat' && cfg.gemini?.model === wanted) store.patch({ gemini: { model: chosen } });
  if (purpose === 'transcribe' && cfg.transcription?.model === wanted) store.patch({ transcription: { model: chosen } });
  if (cfg.instantModel?.gemini === wanted) store.patch({ instantModel: { ...cfg.instantModel, gemini: chosen } });
  log(`[gemini] ${wanted} not available to this key -> switched ${purpose} model to ${chosen} (saved)`);
  send('toast', { text: `Gemini: ${wanted} isn't available to this key — switched to ${chosen}` });
};

// ---- request governor: every provider call is gated and counted here ----
const governor = require('./src/governor');
app.whenReady().then(() => governor.configure(store.get().governor || {})); // store is only usable once the app is ready (safeStorage)
function aiStats() { return governor.stats(); }
function broadcastStats() { send('ai:event', { type: 'stats', stats: aiStats() }); }
// Gate a background call. Returns null if allowed, else an error string.
function gate(kind) {
  const r = governor.allow(kind);
  if (!r.ok) { governor.reject(kind); log(`[governor] blocked ${kind}: ${r.reason}`); broadcastStats(); return r.reason; }
  governor.record(kind); broadcastStats();
  return null;
}
function noteProviderError(err) {
  const kind = governor.noteError(err);
  if (kind) { log(`[governor] ${kind === 'quota' ? 'QUOTA EXHAUSTED' : 'rate limited'} -> background calls suspended`, err.message); broadcastStats(); }
  return kind;
}
ipcMain.handle('ai:stats', () => aiStats());
ipcMain.handle('ai:pause', (_e, paused) => {
  governor.setPaused(!!paused);
  if (paused) { if (inflight) inflight.abort(); stopLive(); }
  log('[governor]', paused ? 'PAUSED by user' : 'resumed by user');
  broadcastStats();
  return aiStats();
});

// ---- local speech-to-text (free, offline) ----
const localStt = require('./src/providers/local-stt');
localStt.init(() => process.env.GHOST_MODELS || path.join(app.getPath('userData'), 'models')); // GHOST_MODELS: reuse real models in self-test
localStt.onRefineLog = (line) => { log('[stt:accuracy]', line); send('live:event', { type: 'status', text: line }); };
app.whenReady().then(() => { const t = store.get().transcription || {}; localStt.setModel(t.localModel); localStt.setRefine(t.refine !== false); });
ipcMain.handle('stt:model', async (_e, { download } = {}) => {
  if (download) {
    try { await localStt.ensureModel((p) => send('live:event', { type: 'status', text: `downloading speech model ${p.file} ${p.pct}%` })); }
    catch (err) { return { ...localStt.modelInfo(), error: err.message }; }
  }
  return localStt.modelInfo();
});

// ---- document library (papers, JDs, notes the assistant should know) ----
const docs = require('./src/docs');
docs.init(() => path.join(app.getPath('userData'), 'docs'));
const { dialog } = require('electron');
let digesting = false;
async function runPendingDigests() {
  if (digesting) return;
  digesting = true;
  try {
    for (const d of docs.list()) {
      if (d.digestStatus !== 'pending' || !d.enabled) continue;
      const blocked = gate('digest');
      if (blocked) { log('[docs] digest deferred', d.name, blocked); setTimeout(runPendingDigests, 120000); break; }
      docs.update(d.id, { digestStatus: 'working' });
      send('docs:event', { type: 'update', docs: docs.list() });
      try {
        const t0 = Date.now();
        const text = await providers.digest(store.get(), docs.text(d.id));
        docs.update(d.id, { digest: text, digestStatus: 'ready', digestAt: Date.now() });
        log('[docs] digest ready', d.name, `${text.length} chars in ${Date.now() - t0}ms`);
      } catch (err) {
        noteProviderError(err);
        docs.update(d.id, { digestStatus: 'failed', digestError: err.message });
        log('[docs] digest failed', d.name, err.message);
      }
      send('docs:event', { type: 'update', docs: docs.list() });
    }
  } finally { digesting = false; }
}
async function addDocFromPath(p) {
  const entry = await docs.add(p);
  log('[docs] added', entry.name, entry.kind, `${entry.chars} chars`);
  send('docs:event', { type: 'update', docs: docs.list() });
  runPendingDigests();
  return entry;
}
ipcMain.handle('docs:list', () => docs.list());
ipcMain.handle('docs:add', async (_e, opts = {}) => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add background documents, videos or audio',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Documents & media', extensions: ['tex', 'md', 'txt', 'pdf', 'docx', 'json', 'csv', 'html', 'bib', ...media.MEDIA_EXT] }, { name: 'Video / audio', extensions: media.MEDIA_EXT }, { name: 'All files', extensions: ['*'] }],
  });
  if (r.canceled) return { added: [], docs: docs.list() };
  const added = []; const errors = []; let background = 0;
  for (const p of r.filePaths) {
    try { if (media.isMediaPath(p)) { added.push(startMediaDoc(p, opts)); background++; } else added.push(await addDocFromPath(p)); }
    catch (e) { errors.push(`${path.basename(p)}: ${e.message}`); }
  }
  return { added, errors, background, docs: docs.list() };
});
ipcMain.handle('docs:addPath', async (_e, arg) => {
  const p = typeof arg === 'string' ? arg : (arg && arg.p); const opts = (arg && arg.opts) || {};
  try {
    if (media.isMediaPath(p)) return { ok: true, doc: startMediaDoc(p, opts), docs: docs.list(), background: true };
    return { ok: true, doc: await addDocFromPath(p), docs: docs.list() };
  } catch (e) { return { ok: false, error: e.message, docs: docs.list() }; }
});
ipcMain.handle('docs:addText', async (_e, { name, text }) => { const d = docs.addText(name || 'pasted text', text); runPendingDigests(); return { ok: true, doc: d, docs: docs.list() }; });
ipcMain.handle('docs:toggle', (_e, { id, enabled }) => { docs.update(id, { enabled: !!enabled }); if (enabled) runPendingDigests(); return docs.list(); });
ipcMain.handle('docs:remove', (_e, id) => docs.remove(id));
ipcMain.handle('docs:digest', (_e, id) => { docs.update(id, { digestStatus: 'pending', digest: '' }); runPendingDigests(); return docs.list(); });

// ---- links & videos as context ----
// Web pages / whole sites are fetched and stripped to text; videos and audio are
// transcribed on this machine (bundled ffmpeg + the offline Parakeet recogniser);
// YouTube uses the caption track, or Gemini reads the video when there is none.
const web = require('./src/web');
const media = require('./src/media');
const gemini = require('./src/providers/gemini');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function docProgress(id, text) { docs.update(id, { processing: text }); send('docs:event', { type: 'progress', id, text }); }
function docsChanged() { send('docs:event', { type: 'update', docs: docs.list() }); }
function docFailed(entry, err, what) {
  log(`[docs] ${what} failed`, entry.name, err.message);
  docs.update(entry.id, { processing: null, error: err.message });
  send('docs:event', { type: 'error', id: entry.id, text: `${entry.name}: ${err.message}` });
}

// JavaScript-only sites: load them in a hidden window and read the rendered text.
async function renderPage(url) {
  const { BrowserWindow, session } = require('electron');
  const ses = session.fromPartition('ghost-fetch'); // in-memory, separate cookies
  if (!ses._ghostNoDownloads) { ses._ghostNoDownloads = true; ses.on('will-download', (e) => e.preventDefault()); }
  const w = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, images: false, backgroundThrottling: false } });
  try {
    w.webContents.setAudioMuted(true);
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await Promise.race([w.loadURL(url, { userAgent: web.UA }).catch((e) => { if (!/ERR_ABORTED/.test(e.message)) throw e; }), sleep(25000)]);
    await sleep(1500);
    return await w.webContents.executeJavaScript('(() => ({ title: document.title, url: location.href, text: document.body ? document.body.innerText : "", links: [...document.querySelectorAll("a[href]")].map((a) => a.href) }))()', true);
  } finally { try { w.destroy(); } catch {} }
}

// Describe one video frame with the answering AI (opt-in "what's on screen" pass; throttled by the governor).
const FRAME_PROMPT = 'This is one frame from a video the user wants to study. In at most 4 short lines, state what is on screen that carries information: copy slide titles, bullet text, code, equations and captions verbatim; describe diagrams/whiteboards concretely. If it is only a person talking or a blank/transition frame, reply exactly: speaker on camera';
function frameDescriber(cfg) {
  return async (jpegBase64) => {
    for (let attempt = 0; ; attempt++) {
      const blocked = gate('digest');
      if (!blocked) break;
      if (attempt >= 6) throw new Error(blocked);
      await sleep(30000);
    }
    let out = '';
    for await (const t of providers.stream(providers.modeConfig(cfg, 'instant'), { messages: [{ role: 'user', text: FRAME_PROMPT, image: { data: jpegBase64, mime: 'image/jpeg' } }], system: 'You turn video frames into study notes. Be concrete and brief; copy visible text verbatim.' })) out += t;
    return out.trim();
  };
}

// One media job at a time (ffmpeg + the recogniser are heavy). The entry appears at once and fills in when done.
let mediaChain = Promise.resolve();
function startMediaDoc(input, { describeFrames = false, name = null } = {}) {
  const isUrl = /^https?:\/\//i.test(input);
  const entry = docs.addEntry({ name: name || (isUrl ? decodeURIComponent(input.split('/').pop().split('?')[0]) || input : path.basename(input)), kind: 'video', source: input, processing: 'queued…' });
  docsChanged();
  mediaChain = mediaChain.then(async () => {
    if (!docs.get(entry.id)) return; // removed while queued
    const cfg = store.get();
    try {
      const r = await media.transcribeFile(input, { onProgress: (p) => docProgress(entry.id, p.text), describeFrame: describeFrames ? frameDescriber(cfg) : null, frameEverySec: 60 });
      if (!docs.get(entry.id)) return;
      const head = `# ${entry.name}\nSource: ${input}\nDuration: ${media.fmtTime(r.seconds)} · transcribed on this computer (${localStt.REFINE_MODEL.id})${r.frames ? ' · on-screen notes about every 60 s' : ''}\n\n`;
      docs.setText(entry.id, head + r.text, { kind: r.hasVideo ? 'video' : 'audio', seconds: r.seconds });
      log('[docs] media ready', entry.name, `${r.lines} lines, ${r.frames} frames, ${media.fmtTime(r.seconds)}`);
      runPendingDigests();
    } catch (e) { docFailed(entry, e, 'media'); }
    docsChanged();
  });
  return entry;
}

// YouTube: captions are free and exact; without them (or for on-screen notes) Gemini reads the video itself.
async function youtubeDoc(c, onProgress, describeFrames) {
  const cfg = store.get();
  const gkey = cfg.gemini?.apiKey;
  let caps = null, capErr = null;
  try { caps = await media.youtubeCaptions(c.url, { onProgress }); } catch (e) { capErr = e; }
  const info = (caps || (capErr && capErr.info)) || {};
  const title = info.title || `YouTube ${c.id}`;
  const parts = [];
  if (caps) parts.push(`## Transcript (${caps.auto ? 'auto-generated captions' : 'captions'}, ${caps.lang})\n${caps.text}`);
  if (gkey && (!caps || describeFrames)) {
    const blocked = gate('digest'); if (blocked) throw new Error(blocked);
    onProgress({ text: `asking Gemini to ${caps ? 'describe what is on screen' : 'watch the video'} (can take a minute or two)…` });
    const g = await gemini.videoFromUrl({ apiKey: gkey, url: c.url, model: cfg.gemini?.model, mode: caps ? 'screen' : 'full' });
    parts.push(`## ${caps ? 'On screen' : 'Transcript and notes'} (Gemini ${g.model})\n${g.text}`);
  } else if (!caps) {
    throw new Error(`${capErr.message}. Add a Gemini API key (Gemini can watch YouTube directly), or download the video and drop the file here.`);
  }
  const head = `# ${title}\nSource: ${c.url}${info.seconds ? `\nDuration: ${media.fmtTime(info.seconds)}` : ''}\n\n`;
  return { text: head + parts.join('\n\n'), patch: { name: title, kind: 'video', seconds: info.seconds || null } };
}

function startUrlDoc(url, { wholeSite = true, describeFrames = false } = {}) {
  const c = web.classifyUrl(url);
  if (c.kind === 'media') return startMediaDoc(c.url, { describeFrames });
  const entry = docs.addEntry({ name: c.kind === 'youtube' ? `YouTube ${c.id}` : c.url, kind: c.kind === 'youtube' ? 'video' : 'web', source: c.url, processing: 'starting…' });
  docsChanged();
  (async () => {
    const onProgress = (p) => docProgress(entry.id, p.text);
    try {
      let text, patch;
      if (c.kind === 'youtube') ({ text, patch } = await youtubeDoc(c, onProgress, describeFrames));
      else {
        const r = await web.fetchSite(c.url, { wholeSite, render: renderPage, onProgress });
        text = r.text; patch = { name: r.name, pages: r.pages, kind: 'web' };
      }
      if (!docs.get(entry.id)) return;
      docs.setText(entry.id, text, patch);
      log('[docs] link ready', patch.name || entry.name, `${text.length} chars`);
      runPendingDigests();
    } catch (e) { docFailed(entry, e, 'link'); }
    docsChanged();
  })();
  return entry;
}

ipcMain.handle('docs:addUrl', (_e, { url, opts } = {}) => {
  const u = String(url || '').trim();
  if (!u || !(web.looksLikeUrl(u) || /^https?:\/\//i.test(u))) return { ok: false, error: 'That does not look like a link.', docs: docs.list() };
  try { return { ok: true, doc: startUrlDoc(u, opts || {}), docs: docs.list(), background: true }; }
  catch (e) { return { ok: false, error: e.message, docs: docs.list() }; }
});
app.on('will-quit', () => media.killAll());
app.whenReady().then(() => setTimeout(runPendingDigests, 3000));
// Warm the local speech engine in its worker thread shortly after launch (if the
// model is on disk) so a mid-call fallback from Gemini Live is instant.
app.whenReady().then(() => setTimeout(async () => { const ok = await localStt.warmUp(); log('[stt] local engine warm-up', ok ? 'ready' : 'skipped (model not downloaded yet)'); }, 2500));

// ---- long-term context: rolling summary + on-disk session ----
// AI transcript cleanup: fix garbled local speech-to-text with the answering
// provider (Haiku on Claude, flash-lite on Gemini, etc.). Governed like other
// background work. Only used when transcription is local (Gemini Live is already accurate).
ipcMain.handle('context:cleanup', async (_e, { lines, background }) => {
  const blocked = gate('cleanup');
  if (blocked) return { skipped: blocked };
  try { const map = await providers.cleanupTranscript(store.get(), { lines, background }); log(`[cleanup] ${Object.keys(map).length} lines polished`); return { map }; }
  catch (err) { noteProviderError(err); log('[cleanup] failed', err.message); return { error: err.message }; }
});

ipcMain.handle('context:summarize', async (_e, { previous, newText }) => {
  const blocked = gate('memory');
  if (blocked) return { skipped: blocked };
  try { return { text: await providers.summarize(store.get(), { previous, newText }) }; }
  catch (err) { noteProviderError(err); log('[memory] summarize failed', err.message); return { error: err.message }; }
});
const SESSION_FILE = () => path.join(app.getPath('userData'), 'session.json');
ipcMain.handle('session:save', (_e, data) => {
  try { require('fs').writeFileSync(SESSION_FILE(), JSON.stringify({ ...data, savedAt: Date.now() })); return true; }
  catch (err) { log('[session] save failed', err.message); return false; }
});
ipcMain.handle('session:load', () => {
  try { return JSON.parse(require('fs').readFileSync(SESSION_FILE(), 'utf8')); } catch { return null; }
});
ipcMain.handle('session:clear', () => { try { require('fs').unlinkSync(SESSION_FILE()); } catch {} return true; });

ipcMain.handle('audio:transcribe', async (_e, { wavBase64, context }) => {
  const blocked = gate('transcribe');
  if (blocked) return { error: blocked, code: 'GOVERNOR' };
  try { return { text: await providers.transcribe(store.get(), { wavBase64, context }) }; }
  catch (err) { noteProviderError(err); return { error: err.message || String(err), code: err.code || null }; }
});

ipcMain.handle('win:hide', () => win && win.hide());
ipcMain.handle('win:quit', () => app.quit());
ipcMain.handle('win:clickthrough', (_e, on) => setClickThrough(on));
ipcMain.handle('win:state', () => ({
  clickThrough,
  opacity: win ? win.getOpacity() : 1,
  platform: process.platform,
  loopbackAudio: process.platform === 'win32',
}));
ipcMain.handle('shell:open', (_e, url) => shell.openExternal(url));
ipcMain.handle('log:path', () => path.join(app.getPath('userData'), 'ghost.log'));
ipcMain.handle('providers:models', () => providers.MODELS);

// ---------------------------------------------------------------------------
// System audio (loopback) for getDisplayMedia() in the renderer.
// Electron only supports 'loopback' on Windows; on macOS you need a virtual
// audio device (BlackHole / Loopback) and then select it as the "mic".
// ---------------------------------------------------------------------------
function installDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      // Windows: WASAPI loopback captures the default output ("them") directly.
      // macOS: Electron has no loopback string; system audio there comes from a
      // virtual device (BlackHole) chosen as the call-audio device, so we grant
      // video only and let the renderer capture that device via getUserMedia.
      callback({ video: sources[0], audio: process.platform === 'win32' ? 'loopback' : undefined });
    } catch (e) {
      console.error('[ghost] display media handler failed', e);
      callback({});
    }
  }, { useSystemPicker: false });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture', 'audioCapture'].includes(permission));
  });
}

// ---------------------------------------------------------------------------
// Smoke test: used by `npm run smoke` / CI to prove the window boots.
// ---------------------------------------------------------------------------
async function runSmoke() {
  const fs = require('fs');
  const outDir = process.env.GHOST_SMOKE_OUT || app.getPath('temp');
  const shot = async (name) => fs.writeFileSync(path.join(outDir, name), (await win.webContents.capturePage()).toPNG());
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = {};
  win.webContents.on('console-message', (_e, level, msg, line, src) => { if (level >= 2) console.error('[renderer]', msg, `${path.basename(src)}:${line}`); });
  try {
    await wait(1200);
    if (process.env.GHOST_SMOKE === 'frames') {
      // fast mode: only the streaming-audio frame check (harness plays TTS meanwhile)
      results.frames = await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, 'test', 'smoke-frames.js'), 'utf8'));
      console.log('[ghost] SMOKE_OK', JSON.stringify(results, null, 2));
      return;
    }
    if (process.env.GHOST_SMOKE === 'media') {
      // real-app mp4 ingestion: renderer -> IPC -> ffmpeg -> offline recogniser -> docs
      const file = process.env.GHOST_SMOKE_FILE;
      results.media = await win.webContents.executeJavaScript(`(async () => {
        const events = [];
        const done = new Promise((resolve) => window.ghost.onDocsEvent((ev) => {
          events.push(ev.type + (ev.text ? ': ' + ev.text : ''));
          if (ev.type === 'update') { const d = ev.docs[ev.docs.length - 1]; if (d && !d.processing) resolve(d); }
          if (ev.type === 'error') resolve({ error: ev.text });
        }));
        const r = await window.ghost.docsAddPath(${JSON.stringify(file)}, { describeFrames: false });
        const d = await Promise.race([done, new Promise((res) => setTimeout(() => res({ error: 'timeout' }), 240000))]);
        return { start: { ok: r.ok, background: r.background, error: r.error, kind: r.doc && r.doc.kind }, events: events.slice(-6), doc: d };
      })()`);
      const text = results.media.doc && results.media.doc.id ? docs.text(results.media.doc.id) : '';
      results.media.textHead = text.slice(0, 400);
      console.log('[ghost] SMOKE_OK', JSON.stringify(results, null, 2));
      return;
    }
    await shot('ghost-smoke-1-empty.png');

    // 1. real screenshot path (desktopCapturer + resize + jpeg)
    const img = await captureScreen();
    results.screenshotBytes = Buffer.from(img.data, 'base64').length;
    fs.writeFileSync(path.join(outDir, 'ghost-smoke-0-screen.jpg'), Buffer.from(img.data, 'base64'));
    results.windowBounds = win.getBounds();

    // 2. chat error path with no key -> renderer shows error bubble
    await win.webContents.executeJavaScript(`
      window.__evt = []; window.ghost.onChatEvent(e => window.__evt.push(e));
      window.ghost.chatStart({ id: 'smoke', messages: [{ role: 'user', text: 'hi' }] });
    `);
    await wait(800);
    results.noKeyError = await win.webContents.executeJavaScript('JSON.stringify(window.__evt)');

    // 3. markdown renderer
    results.markdown = await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, 'test', 'smoke-markdown.js'), 'utf8'));

    // 4. render a fake assistant answer + open settings, screenshot both
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, 'test', 'smoke-chat.js'), 'utf8'));
    await wait(300);
    await shot('ghost-smoke-2-chat.png');
    await win.webContents.executeJavaScript("document.getElementById('btn-settings').click()");
    await wait(300);
    await shot('ghost-smoke-3-settings.png');
    await win.webContents.executeJavaScript("document.getElementById('btn-settings-close').click(); document.getElementById('btn-context').click()");
    await wait(300);
    await shot('ghost-smoke-4-context.png');
    await win.webContents.executeJavaScript("document.getElementById('btn-context-close').click()");

    // 4b. context assembly inside the real renderer
    results.context = await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, 'test', 'smoke-context.js'), 'utf8'));

    // 5. settings round-trip + real endpoint reachability with dummy keys
    results.settings = await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, 'test', 'smoke-settings.js'), 'utf8'));
    const cfgOnDisk = fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8');
    results.settings.keyEncryptedOnDisk = !cfgOnDisk.includes('DUMMY-ghost') && /"apiKey": "enc:/.test(cfgOnDisk);
    // regression: a window move triggers a bounds save — it must not clobber the keys
    win.setPosition(win.getPosition()[0] + 5, win.getPosition()[1]);
    await wait(400);
    const cfgAfterMove = fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8');
    results.settings.keySurvivesBoundsSave = /"apiKey": "enc:/.test(cfgAfterMove) && (cfgAfterMove.match(/"apiKey": "enc:/g) || []).length >= 2;
    results.settings.geminiAuthMapped = results.settings.geminiLive.ok === false && /invalid API key/.test(results.settings.geminiLive.error);
    results.settings.claudeAuthMapped = results.settings.claudeLive.ok === false && /invalid API key/.test(results.settings.claudeLive.error);

    // 4c. document library through the real IPC path (isolated userData): import a .tex,
    //     check it is listed and lands in the system prompt per mode
    {
      const r = await win.webContents.executeJavaScript(`window.ghost.docsAddPath(${JSON.stringify(path.join(__dirname, 'test', 'fixture.tex'))})`);
      const sysThink = providers.systemPrompt(store.get(), 'general', 'think');
      results.docs = {
        imported: !!r.ok && r.doc.kind === 'latex' && r.doc.chars > 300,
        listed: (await win.webContents.executeJavaScript('window.ghost.docsList()')).some((d) => d.name === 'fixture.tex'),
        inThinkPrompt: /BACKGROUND DOCUMENTS[\s\S]*fixture\.tex \(full text\)[\s\S]*# Method[\s\S]*mean ratio was \$1\.37\$/.test(sysThink),
        latexCleaned: !/documentclass|\\cite\{/.test(sysThink) && /\[cite\]/.test(sysThink),
      };
      results.docs.PASS = Object.values(results.docs).every((v) => v === true);
      if (r.ok) docs.remove(r.doc.id);
    }

    // 5a. session persistence round-trip (save -> load -> restore into the UI)
    results.session = await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, 'test', 'smoke-session.js'), 'utf8'));

    // 5b. streaming transcription end-to-end against the mock Live server (if GEMINI_LIVE_URL is set)
    if (process.env.GEMINI_LIVE_URL) {
      results.live = await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, 'test', 'smoke-live.js'), 'utf8'));
      await wait(200);
      // 5c. Gemini Live quota death mid-call -> automatic per-source fallback to local (needs the local model in userData)
      if (localStt.modelReady()) {
        results.liveFallback = await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, 'test', 'smoke-live-fallback.js'), 'utf8'));
        await wait(200);
        // 5d. Claude-only setup (no Gemini key): listening must still start, on the local engine
        results.claudeOnly = await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, 'test', 'smoke-claude-only.js'), 'utf8'));
        await wait(200);
      } else results.liveFallback = { skipped: 'local model not present in smoke userData' };
    }

    // 6. audio capture (system loopback + mic) actually yields PCM
    results.audio = await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, 'test', 'smoke-audio.js'), 'utf8'));

    results.contentProtection = 'setContentProtection(true) applied';
    console.log('[ghost] SMOKE_OK', JSON.stringify(results, null, 2));
  } catch (e) {
    console.error('[ghost] SMOKE_FAIL', e);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    app.dock?.hide();
    // Ask for mic access up front so the first "Listen" doesn't stall.
    systemPreferences.askForMediaAccess?.('microphone').catch(() => {});
  }
  installDisplayMediaHandler();
  createWindow();
  createTray();
  const failed = registerShortcuts();
  if (failed.length) send('toast', { text: `Shortcut(s) in use by another app: ${failed.join(', ')}` });
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); stopLive(); localStt.shutdown(); });
app.on('window-all-closed', () => app.quit());
