// Provider abstraction. Internal message shape used by the renderer:
//   { role: 'user'|'assistant', text: string, image?: { mime, data(base64) } }
const claude = require('./claude');
const gemini = require('./gemini');
const openai = require('./openai');
const prompts = require('./prompts');
const docsLib = require('../docs');

const { LIVE_MODELS } = require('./gemini-live');

const PROVIDERS = { claude, gemini, openai };
const PROVIDER_LABEL = { claude: 'Claude', gemini: 'Gemini', openai: 'OpenAI-compatible' };

const MODELS = {
  live: LIVE_MODELS,
  claude: ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5'],
  // names are auto-resolved against the key's live model list at request time (see gemini.js)
  gemini: ['gemini-3.1-flash-lite', 'gemini-3.1-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemma-3-27b-it', 'gemma-3-12b-it'],
  transcription: ['gemini-2.5-flash-lite', 'gemini-2.5-flash'],
  openaiPresets: openai.PRESETS,
};

function hasKey(cfg, p) { return p === 'openai' ? !!(cfg.openai && (cfg.openai.apiKey || /localhost|127\.0\.0\.1/.test(cfg.openai.baseUrl || ''))) : !!(cfg[p] && cfg[p].apiKey); }

function systemPrompt(cfg, profileOverride, mode) {
  const profile = profileOverride || cfg.profile || 'general';
  const base = prompts.PROFILES[profile]?.prompt || prompts.PROFILES.general.prompt;
  const custom = (cfg.customPrompt || '').trim();
  const notes = (cfg.contextDocs || '').trim().slice(0, 200000);
  // Document library: think mode gets full text, instant mode gets digests
  // (unless the user opted for full text there too).
  const library = docsLib.contextFor(mode === 'think' ? 'think' : 'instant', { instantUsesFull: !!cfg.instantUsesFullDocs });
  return [
    prompts.CORE, base,
    prompts.MODES[mode] || '',
    custom && `Additional instructions from the user:\n${custom}`,
    notes && `BACKGROUND NOTES provided by the user (résumé, job description, agenda, notes — use whenever relevant):\n<<<\n${notes}\n>>>`,
    library && `BACKGROUND DOCUMENTS provided by the user. These are reference material you may be asked about at any time — quote specifics (numbers, names, definitions) from them when relevant:\n<<<\n${library}\n>>>`,
  ].filter(Boolean).join('\n\n');
}

// Dense digest of one document (cheap model), for instant mode.
async function digest(cfg, text) {
  const system = prompts.DIGEST;
  const messages = [{ role: 'user', text: `DOCUMENT:\n${text.slice(0, 400000)}\n\nWrite the digest now.` }];
  let out = '';
  if (cfg.gemini?.apiKey) {
    const c = { ...cfg, maxTokens: 2000, speed: 'fast', gemini: { ...cfg.gemini, model: cfg.gemini.model || 'gemini-2.5-flash' } };
    for await (const t of gemini.stream({ cfg: c, apiKey: cfg.gemini.apiKey, messages, system })) out += t;
  } else if (cfg.claude?.apiKey) {
    const c = { ...cfg, maxTokens: 2000, speed: 'balanced', claude: { ...cfg.claude, model: cfg.claude.model || 'claude-haiku-4-5' } };
    for await (const t of claude.stream({ cfg: c, apiKey: cfg.claude.apiKey, messages, system })) out += t;
  } else throw new Error('no API key');
  return out.trim();
}

// Effective config for a response mode.
//   instant: small fast model, thinking off, short output cap.
//   think:   the configured model, thinking per cfg.thinkSpeed, full output.
function modeConfig(cfg, mode) {
  if (mode === 'think') return { ...cfg, speed: cfg.thinkSpeed || 'balanced' };
  const im = cfg.instantModel || {};
  const preset = openai.PRESETS[cfg.openai?.preset] || {};
  return {
    ...cfg,
    speed: 'fast',
    maxTokens: cfg.instantMaxTokens || 350,
    gemini: { ...cfg.gemini, model: im.gemini || cfg.gemini?.model },
    claude: { ...cfg.claude, model: im.claude || cfg.claude?.model },
    openai: { ...cfg.openai, model: im.openai || preset.instant || cfg.openai?.model },
  };
}

// Fold older transcript into a running summary so a long call keeps its
// context without resending everything. Uses the cheapest capable model.
async function summarize(cfg, { previous, newText }) {
  const system = prompts.SUMMARY;
  const user = `${previous ? `PREVIOUS SUMMARY:\n${previous}\n\n` : ''}NEW TRANSCRIPT TO FOLD IN:\n${newText}\n\nWrite the updated summary now.`;
  const messages = [{ role: 'user', text: user }];
  let out = '';
  if (cfg.gemini?.apiKey) {
    const c = { ...cfg, maxTokens: 1200, gemini: { ...cfg.gemini, model: cfg.transcription?.model || 'gemini-2.5-flash-lite' } };
    for await (const t of gemini.stream({ cfg: c, apiKey: cfg.gemini.apiKey, messages, system })) out += t;
  } else if (cfg.claude?.apiKey) {
    const c = { ...cfg, maxTokens: 1200, claude: { ...cfg.claude, model: 'claude-haiku-4-5', effort: 'low' } };
    for await (const t of claude.stream({ cfg: c, apiKey: cfg.claude.apiKey, messages, system })) out += t;
  } else throw new Error('no API key');
  return out.trim();
}

// Clean raw speech-to-text using context. `lines` = [{n, speaker, text}]; returns
// { n: cleanedText }. Uses the cheapest model of whichever provider is configured.
async function cleanupTranscript(cfg, { lines, background }) {
  const system = prompts.CLEANUP;
  const body = lines.map((l) => `${l.n}. ${l.speaker ? l.speaker.toUpperCase() + ': ' : ''}${l.text}`).join('\n');
  const user = `${background ? `BACKGROUND (real vocabulary / names / summary):\n${background.slice(0, 8000)}\n\n` : ''}TRANSCRIPT LINES:\n${body}\n\nReturn the JSON now.`;
  const messages = [{ role: 'user', text: user }];
  const order = fallbackOrder(cfg);
  const p = order[0];
  const model = p === 'gemini' ? (cfg.transcription?.model || 'gemini-2.5-flash-lite')
    : p === 'claude' ? 'claude-haiku-4-5'
    : ((cfg.instantModel && cfg.instantModel.openai) || (openai.PRESETS[cfg.openai?.preset] || {}).instant || cfg.openai?.model);
  const c = { ...cfg, provider: p, speed: 'fast', maxTokens: 1500, [p]: { ...cfg[p], model } };
  let out = '';
  for await (const t of PROVIDERS[p].stream({ cfg: c, apiKey: cfg[p]?.apiKey, messages, system })) out += t;
  const m = out.match(/\{[\s\S]*\}/); if (!m) return {};
  try { const j = JSON.parse(m[0]); const r = {}; for (const k of Object.keys(j)) if (typeof j[k] === 'string') r[k] = j[k]; return r; }
  catch { return {}; }
}

// Which provider should answer, and who can step in when it runs dry.
// Cross-provider fallback (cfg.fallbackProvider: 'auto' | 'none' | provider id):
// when the main provider's daily quota is used up on every model it has, the
// same request goes to another configured provider (e.g. Gemini -> Groq).
function fallbackOrder(cfg) {
  const main = cfg.provider || 'gemini';
  const pref = cfg.fallbackProvider || 'auto';
  if (pref === 'none') return [main];
  const others = pref === 'auto' ? ['openai', 'gemini', 'claude'] : [pref];
  return [main, ...others.filter((p) => p !== main && PROVIDERS[p] && hasKey(cfg, p))];
}

async function* stream(cfg, { messages, system, signal }) {
  const order = fallbackOrder(cfg);
  const main = order[0];
  if (!hasKey(cfg, main)) throw new Error(`No ${PROVIDER_LABEL[main]} API key set. Open settings (⚙) and paste one.`);
  const tried = [];
  for (let i = 0; i < order.length; i++) {
    const p = order[i];
    try {
      const gen = PROVIDERS[p].stream({ cfg, apiKey: cfg[p]?.apiKey, messages, system, signal });
      const first = await gen.next();
      if (i > 0) yield `_[${tried.join('; ')} → answered by ${PROVIDER_LABEL[p]}]_\n\n`;
      if (!first.done) yield first.value;
      yield* gen;
      return;
    } catch (err) {
      const dry = err.code === 'RATE_LIMIT' && (err.allModelsExhausted || err.quotaKind === 'day');
      if (!dry || i === order.length - 1) { if (tried.length) err.message += ` (fallbacks: ${tried.join('; ')})`; throw err; }
      tried.push(`${PROVIDER_LABEL[p]}: daily quota used up`);
    }
  }
}

// Audio transcription needs a model that accepts audio -> Gemini only.
async function transcribe(cfg, { wavBase64, context }) {
  const key = cfg.gemini?.apiKey;
  if (!key) throw new Error('Live listening needs a Gemini API key (Claude does not accept audio input). Add one in settings.');
  return gemini.transcribe({ apiKey: key, model: cfg.transcription?.model || 'gemini-2.5-flash', wavBase64, context });
}

// One tiny real request so the settings panel can confirm a key works.
async function testKey(cfg, { provider, apiKey }) {
  const impl = PROVIDERS[provider];
  if (!impl) throw new Error(`unknown provider ${provider}`);
  const key = apiKey || cfg[provider]?.apiKey;
  if (!key && !(provider === 'openai' && /localhost|127\.0\.0\.1/.test(cfg.openai?.baseUrl || ''))) throw new Error('No API key to test.');
  const t0 = Date.now();
  let text = '';
  const msgs = [{ role: 'user', text: 'Reply with the single word: OK' }];
  const testCfg = { ...cfg, maxTokens: 16, [provider]: { ...(cfg[provider] || {}), apiKey: key, effort: 'low' } };
  for await (const tok of impl.stream({ cfg: testCfg, apiKey: key, messages: msgs, system: 'You are a connectivity test. Reply with exactly: OK' })) text += tok;
  return { ok: true, model: testCfg[provider].model, ms: Date.now() - t0, reply: text.trim().slice(0, 40) };
}

module.exports = { MODELS, PROVIDER_LABEL, hasKey, fallbackOrder, stream, transcribe, testKey, summarize, digest, cleanupTranscript, systemPrompt, modeConfig, PROFILES: prompts.PROFILES };
