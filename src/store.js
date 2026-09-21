// Tiny JSON settings store. API keys are encrypted at rest with Electron's
// safeStorage (DPAPI on Windows, Keychain on macOS, libsecret on Linux).
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const FILE = () => path.join(app.getPath('userData'), 'config.json');
const SECRET_KEYS = ['claude.apiKey', 'gemini.apiKey', 'openai.apiKey'];

const mod = process.platform === 'darwin' ? 'Cmd' : 'Ctrl';

const DEFAULTS = {
  provider: 'gemini',                       // 'claude' | 'gemini'
  claude: { apiKey: '', model: 'claude-haiku-4-5', effort: 'medium', fallbacks: true, workspaceId: '' }, // Haiku 4.5: fastest + cheapest Claude; workspaceId needed for org-level keys
  gemini: { apiKey: '', model: 'gemini-2.5-flash' },
  // Any OpenAI-compatible endpoint. Groq/Cerebras free tiers are the fastest answers available.
  openai: { apiKey: '', preset: 'navy', baseUrl: 'https://api.navy/v1', model: 'gemini-2.5-flash-lite', vision: true },
  fallbackProvider: 'auto',   // when the main provider's daily quota is gone: 'auto' = any other configured provider | 'none' | provider id
  // source: 'both' | 'system' | 'mic'. flash-lite: same transcription quality,
  // higher free-tier rate limit. 8 s chunks keep us under ~8 req/min.
  // mode 'live' streams audio over the Gemini Live API (sub-second words);
  // 'chunk' uploads N-second WAVs (fallback, also used automatically if live fails).
  // fallbackToChunk: if streaming fails, 'pause' (default — never spends requests on its own) or 'chunk' (upload clips every chunkSeconds; costs ~6 req/min at 10 s)
  // engine: 'local' = free offline streaming STT on your CPU (default, no quota); 'gemini' = Gemini Live API (uses quota)
  // engine 'gemini' = Gemini Live API (most accurate; uses Live quota) with automatic per-source fallback to the
  // local offline engine when it can't connect / is rejected / runs out of quota (localFallback). 'local' = offline only.
  transcription: { engine: 'gemini', localFallback: true, localModel: 'nemo-fastconformer-en-80ms', refine: true, mode: 'live', liveModel: 'gemini-3.8-live', model: 'gemini-2.5-flash-lite', chunkSeconds: 10, source: 'both', callDevice: 'loopback', fallbackToChunk: 'pause' },
  governor: { maxPerMinute: 10 }, // background-request budget (memory summaries, digests, chunked transcription)
  contextDocs: '',            // free-text notes the user wants in every prompt (résumé, JD, agenda…)
  instantUsesFullDocs: false, // instant mode: digests (fast) unless this is on
  memory: { enabled: true },  // rolling summary of older transcript
  aiCleanup: 'auto',          // fix garbled local transcript with the answering provider: 'auto' (only when local STT) | 'on' | 'off'
  configVersion: 17,
  profile: 'general',
  customPrompt: '',
  maxTokens: 4096,
  screenshotMaxEdge: 1280,      // smaller = fewer vision tokens = faster Ask
  speed: 'fast',                // legacy; see mode / thinkSpeed
  mode: 'instant',              // 'instant' (small model, no thinking, ~80 words) | 'think' (full model + thinking)
  instantModel: { gemini: 'gemini-2.5-flash-lite', claude: 'claude-haiku-4-5' },
  instantMaxTokens: 350,
  thinkSpeed: 'balanced',       // thinking level in think mode: 'balanced' | 'thorough'
  autoAnswer: false,            // opt-in: start answering as soon as a question is heard (spends requests without a click)
  opacity: 1,
  bounds: null,
  shortcuts: {
    toggle:       `${mod}+\\`,
    ask:          `${mod}+Enter`,
    answerAudio:  `${mod}+Shift+Enter`,
    listen:       `${mod}+Shift+L`,
    clickThrough: `${mod}+Shift+M`,
    reset:        `${mod}+Shift+R`,
    stop:         `${mod}+Shift+X`,
    moveLeft:     `${mod}+Alt+Left`,
    moveRight:    `${mod}+Alt+Right`,
    moveUp:       `${mod}+Alt+Up`,
    moveDown:     `${mod}+Alt+Down`,
    opacityDown:  `${mod}+Alt+[`,
    opacityUp:    `${mod}+Alt+]`,
    quit:         `${mod}+Shift+Q`,
  },
};

let cache = null;

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') out[k] = deepMerge(base[k], v);
    else out[k] = v;
  }
  return out;
}

function getPath(obj, dotted) { return dotted.split('.').reduce((o, k) => (o ? o[k] : undefined), obj); }
function setPath(obj, dotted, val) {
  const ks = dotted.split('.');
  let o = obj;
  for (const k of ks.slice(0, -1)) { o[k] = o[k] || {}; o = o[k]; }
  o[ks[ks.length - 1]] = val;
}

function enc(s) {
  if (!s) return '';
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(s).toString('base64');
  return 'raw:' + s;
}
function dec(s) {
  if (!s) return '';
  if (s.startsWith('enc:')) {
    try { return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')); } catch { return ''; }
  }
  if (s.startsWith('raw:')) return s.slice(4);
  return s;
}

// Encrypted values we could NOT decrypt (e.g. keychain unavailable): keep the
// original ciphertext so a later save() never replaces a real key with ''.
const preserved = {};

function readDisk() { try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { return {}; } }

function load() {
  if (cache) return cache;
  const disk = readDisk();
  // safeStorage only works once the app is ready. Before that, hand out a
  // throwaway view (secrets blank) and DON'T cache or migrate, otherwise the
  // blank secrets would be written back over the real ones on the next save.
  if (!app.isReady()) {
    const tmp = deepMerge(DEFAULTS, disk);
    for (const k of SECRET_KEYS) setPath(tmp, k, '');
    return tmp;
  }
  cache = deepMerge(DEFAULTS, disk);
  for (const k of SECRET_KEYS) {
    const raw = getPath(cache, k);
    const plain = dec(raw);
    if (raw && !plain) preserved[k] = raw; // undecryptable now; keep ciphertext on disk
    setPath(cache, k, plain);
  }
  migrate(disk);
  return cache;
}

// Upgrade settings written by older versions, but only where the user still
// had the old defaults (never override an explicit choice).
function migrate(disk) {
  const from = disk.configVersion || 1;
  if (from < 2) {
    const t = disk.transcription || {};
    if (!t.source || t.source === 'system') cache.transcription.source = 'both';
    if (!t.model || t.model === 'gemini-2.5-flash') cache.transcription.model = 'gemini-2.5-flash-lite';
    if (!t.chunkSeconds || t.chunkSeconds === 6) cache.transcription.chunkSeconds = 8;
  }
  if (from < 3) {
    const t = disk.transcription || {};
    if (!t.mode) cache.transcription.mode = 'live';
    if (!t.liveModel) cache.transcription.liveModel = 'gemini-3.8-live';
    if (!t.chunkSeconds || t.chunkSeconds === 8 || t.chunkSeconds === 6) cache.transcription.chunkSeconds = 5;
  }
  if (from < 4) { /* new keys have defaults; nothing to convert */ }
  if (from < 5 && (!disk.screenshotMaxEdge || disk.screenshotMaxEdge === 1568)) cache.screenshotMaxEdge = 1280;
  if (from < 7) cache.autoAnswer = false; // was on by default in v5–6; nobody opted in, so switch it off
  if (from < 8) {
    // chunked fallback used to kick in automatically at 5 s (= 12 req/min, blew the free tier)
    if (!disk.transcription || disk.transcription.chunkSeconds === 5 || !disk.transcription.chunkSeconds) cache.transcription.chunkSeconds = 10;
    cache.transcription.fallbackToChunk = 'pause';
  }
  if (from < 9) cache.transcription.engine = 'local'; // free offline STT; Gemini quota is for answers
  if (from < 10 && (!disk.claude || !disk.claude.model || disk.claude.model === 'claude-opus-5')) cache.claude.model = 'claude-haiku-4-5';
  if (from < 11) { cache.transcription.engine = 'gemini'; cache.transcription.localFallback = true; } // accuracy first; local is the safety net
  if (from < 13 && !(disk.openai && disk.openai.apiKey)) { // v12 default was Groq; nobody saved a key yet -> NavyAI (vision + many free models)
    cache.openai = { ...cache.openai, preset: 'navy', baseUrl: 'https://api.navy/v1', model: 'gemini-2.5-flash-lite', vision: true };
  }
  if (from < 15) cache.transcription.localModel = 'nemo-fastconformer-en-80ms'; // more robust local engine
  if (from < 16) cache.transcription.refine = true; // accuracy pass on local transcription
  if (from < 17) cache.aiCleanup = 'auto'; // AI cleanup of garbled local transcript
  if (from < 14 && cache.openai && cache.openai.preset === 'navy') { cache.openai.model = 'gemini-2.5-flash-lite'; cache.instantModel = { ...(cache.instantModel || {}), openai: 'gemini-2.5-flash-lite' }; } // user asked for flash-lite on NavyAI
  if (from !== DEFAULTS.configVersion) { cache.configVersion = DEFAULTS.configVersion; save(); }
}

function save() {
  if (!cache || !app.isReady()) return; // never write from a pre-ready (blank-secret) view
  const out = JSON.parse(JSON.stringify(cache));
  for (const k of SECRET_KEYS) {
    const plain = getPath(out, k);
    setPath(out, k, plain ? enc(plain) : (preserved[k] || ''));
  }
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(out, null, 2));
}

module.exports = {
  defaults: DEFAULTS,
  get: () => load(),
  patch(p) {
    const base = load();
    if (!app.isReady()) return base; // ignore writes before ready
    for (const k of SECRET_KEYS) { const v = getPath(p, k); if (typeof v === 'string' && v) delete preserved[k]; } // a new key replaces a preserved one
    cache = deepMerge(base, p); save(); return cache;
  },
  // Renderer-safe view: keys are masked, only "has key" is exposed.
  getPublic() {
    const c = JSON.parse(JSON.stringify(load()));
    for (const k of SECRET_KEYS) {
      const v = getPath(c, k);
      setPath(c, k, v ? `${v.slice(0, 6)}…${v.slice(-4)}` : '');
      setPath(c, k + 'Set', !!v);
    }
    return c;
  },
};
