// Gemini via the REST API (no SDK needed; Node 18+ fetch + SSE).
// GEMINI_BASE_URL override exists only so test/mock-gemini.js can exercise this file offline.
const BASE = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/models';

function toGeminiContents(messages) {
  const out = [];
  for (const m of messages) {
    const parts = [];
    if (m.image?.data) parts.push({ inlineData: { mimeType: m.image.mime || 'image/jpeg', data: m.image.data } });
    parts.push({ text: m.text || (m.image ? 'Here is my screen.' : '') });
    const role = m.role === 'assistant' ? 'model' : 'user';
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.parts.push(...parts);
    else out.push({ role, parts });
  }
  return out;
}

const FIRST_BYTE_TIMEOUT_MS = 15000; // an overloaded model can hang for a minute; we'd rather try the next one

async function request(apiKey, model, method, body, signal, timeoutMs = FIRST_BYTE_TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  if (signal) signal.addEventListener('abort', () => ac.abort(signal.reason), { once: true });
  let res;
  try {
    res = await fetch(`${BASE}/${encodeURIComponent(model)}:${method}`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (signal && signal.aborted) throw e;
    const err = new Error(`Gemini: ${model} did not respond within ${timeoutMs / 1000}s`);
    err.code = 'OVERLOADED'; err.model = model;
    throw err;
  }
  clearTimeout(timer);
  if (!res.ok) {
    let msg = `${res.status}`; let j = null;
    try { j = await res.json(); msg = j.error?.message || JSON.stringify(j); } catch { msg = await res.text().catch(() => msg); }
    if (res.status === 400 && /API key/i.test(msg)) throw new Error('Gemini: invalid API key.');
    if (res.status === 401 || res.status === 403) throw new Error(`Gemini ${res.status}: Google rejected this key (${(j && j.error && j.error.status) || 'UNAUTHENTICATED'}). If it starts with "AQ." make sure it was created in AI Studio → API keys (not copied from a sign-in page) and that the key/project isn't restricted or deleted.`);
    if (res.status === 429) {
      // Say exactly which limit tripped: Google's error carries QuotaFailure violations + RetryInfo.
      const details = (j && j.error && j.error.details) || [];
      const viol = details.find((d) => /QuotaFailure/.test(d['@type'] || ''))?.violations?.[0] || {};
      const retry = details.find((d) => /RetryInfo/.test(d['@type'] || ''))?.retryDelay || '';
      const qid = viol.quotaId || viol.quotaMetric || '';
      const kind = /PerDay|Daily/i.test(qid + msg) ? 'day' : /Token/i.test(qid) ? 'tokens' : 'minute';
      const retrySec = parseInt(String(retry).replace(/[^0-9]/g, ''), 10) || 0;
      const human = kind === 'day'
        ? `daily free-tier quota for ${model} is used up (resets ~midnight Pacific)`
        : kind === 'tokens' ? `tokens-per-minute limit on ${model} (prompt too large for the free tier right now)` : `requests-per-minute limit on ${model}`;
      const e = new Error(`Gemini rate limit: ${human}${retrySec ? ` — retry in ${retrySec}s` : ''}${qid ? ` [${qid.replace(/^.*\//, '')}]` : ''}`);
      e.code = 'RATE_LIMIT'; e.quotaKind = kind; e.retrySec = retrySec; e.model = model; e.raw = msg.slice(0, 300);
      throw e;
    }
    if (res.status === 404) throw new Error(`Gemini: model not found (${model}).`);
    if (res.status === 503 || res.status === 502 || /high demand|overloaded|UNAVAILABLE/i.test(msg)) {
      const e = new Error(`Gemini: ${model} is overloaded right now (${res.status}: ${msg.slice(0, 90)})`);
      e.code = 'OVERLOADED'; e.model = model;
      throw e;
    }
    throw new Error(`Gemini ${res.status} (${model}): ${msg}`);
  }
  return res;
}

// Minimal SSE parser over a fetch body.
async function* sse(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    // Google emits CRLF line endings; normalise so the blank-line event split works.
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (data) yield data;
    }
  }
}

// Each Gemini model has its own free-tier quota. When one is exhausted (daily
// cap, or tokens-per-minute), retry the same request on a sibling model
// instead of dead-ending the click. Order: cheapest/fastest first.
// Preference order; filtered against Google's live model list (models get retired
// without notice — gemini-2.0-flash did). Gemma models share the key but have
// their own, separate daily quota, so they're a real fallback when Gemini's is gone.
const FALLBACK_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemma-3-27b-it', 'gemma-3-12b-it', 'gemini-2.0-flash-lite', 'gemini-2.0-flash'];

let modelListCache = { at: 0, names: null };
async function listModels(apiKey) {
  if (modelListCache.names && Date.now() - modelListCache.at < 60 * 60 * 1000) return modelListCache.names;
  try {
    const res = await fetch(`${BASE}?pageSize=200`, { headers: { 'x-goog-api-key': apiKey } });
    if (!res.ok) throw new Error(String(res.status));
    const j = await res.json();
    const names = (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => String(m.name).replace(/^models\//, ''));
    if (names.length) modelListCache = { at: Date.now(), names };
    return names;
  } catch { return modelListCache.names || null; } // unknown -> don't filter
}

// Google retires model names and new keys/projects only see current ones, so
// never trust a configured name blindly: if it isn't in this key's live model
// list, pick the best available by preference (cheap/fast first) and remember it.
const PREFERRED = [
  'gemini-3.1-flash-lite', 'gemini-3-flash-lite', 'gemini-3.1-flash', 'gemini-3-flash', 'gemini-3-flash-preview',
  'gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemma-3-27b-it', 'gemma-3-12b-it', 'gemini-2.0-flash-lite', 'gemini-2.0-flash',
];
function pickAvailable(available, wanted) {
  if (!available || !available.length) return wanted;
  if (wanted && available.includes(wanted)) return wanted;
  const byPref = PREFERRED.find((m) => available.includes(m));
  if (byPref) return byPref;
  const fuzzy = available.find((m) => /flash-lite/.test(m)) || available.find((m) => /flash/.test(m) && !/live|tts|image|audio|embedding/.test(m));
  return fuzzy || wanted;
}
async function resolveModel(apiKey, wanted, purpose) {
  const available = await listModels(apiKey);
  const chosen = pickAvailable(available, wanted);
  if (chosen !== wanted) { try { module.exports.onModelResolved?.({ wanted, chosen, purpose }); } catch {} }
  return { chosen, available };
}

async function* stream({ cfg, apiKey, messages, system, signal }) {
  const wanted = cfg.gemini?.model || 'gemini-2.5-flash';
  const { chosen: primary, available } = await resolveModel(apiKey, wanted, 'chat');
  if (primary !== wanted) yield `_[${wanted} isn't available to this key → using ${primary}]_\n\n`;
  const fallbacks = (available && available.length ? PREFERRED.filter((m) => available.includes(m)) : FALLBACK_MODELS).filter((m) => m !== primary);
  const chain = [primary, ...fallbacks];
  const tried = [];
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    try {
      const gen = streamOnce(model, { cfg, apiKey, messages, system, signal });
      const first = await gen.next();               // errors (incl. 429) surface here, before any output
      if (i > 0) yield `_[${tried.join('; ')} → answered with ${model}]_\n\n`;
      if (!first.done) yield first.value;
      yield* gen;
      return;
    } catch (err) {
      const notFound = /model not found/i.test(err.message);
      const overloaded = err.code === 'OVERLOADED';
      const canFallback = cfg.noModelFallback !== true && (notFound || overloaded || (err.code === 'RATE_LIMIT' && (err.quotaKind === 'day' || err.quotaKind === 'tokens' || (err.retrySec || 0) > 20)));
      if (!canFallback || i === chain.length - 1) {
        if (tried.length) err.message += ` (also tried: ${tried.join('; ')})`;
        if (err.code === 'RATE_LIMIT' && tried.length) err.allModelsExhausted = true; // lets the provider layer try another provider
        throw err;
      }
      tried.push(`${model}: ${notFound ? 'not available' : overloaded ? 'overloaded / slow' : err.quotaKind === 'day' ? 'daily quota used up' : err.quotaKind === 'tokens' ? 'token limit' : 'rate limited'}`);
    }
  }
}

async function* streamOnce(model, { cfg, apiKey, messages, system, signal }) {
  const generationConfig = { maxOutputTokens: cfg.maxTokens || 4096, temperature: 0.4 };
  // "Thinking" is the single biggest latency cost on 2.5 Flash (1–4 s before the
  // first word). Fast mode turns it off; balanced gives it a small budget.
  // (2.5 Pro cannot disable thinking; 2.0 models don't support the field.)
  const speed = cfg.speed || 'fast';
  if (/2\.5-flash/.test(model)) {
    if (speed === 'fast') generationConfig.thinkingConfig = { thinkingBudget: 0 };
    else if (speed === 'balanced') generationConfig.thinkingConfig = { thinkingBudget: 1024 };
  }
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: toGeminiContents(messages),
    generationConfig,
  };
  const res = await request(apiKey, model, 'streamGenerateContent?alt=sse', body, signal);
  let finish = null;
  for await (const data of sse(res.body)) {
    let j; try { j = JSON.parse(data); } catch { continue; }
    const cand = j.candidates?.[0];
    if (cand?.finishReason) finish = cand.finishReason;
    for (const p of cand?.content?.parts || []) if (p.text) yield p.text;
    if (j.promptFeedback?.blockReason) yield `\n\n_[Blocked by Gemini safety: ${j.promptFeedback.blockReason}]_`;
  }
  if (finish === 'MAX_TOKENS') yield '\n\n_[Cut off at max tokens — raise "Max tokens" in settings.]_';
  else if (finish === 'SAFETY') yield '\n\n_[Gemini stopped for safety reasons.]_';
}

const TRANSCRIBE_PROMPT = `You are a verbatim speech-to-text engine. Transcribe the speech in this audio clip exactly.
Rules:
- Output ONLY the transcript text. No labels, no quotes, no commentary, no markdown.
- If there is no intelligible speech, output exactly: [silence]
- Do not repeat text from the previous context; only transcribe the new audio.`;

async function transcribe({ apiKey, model: wantedModel, wavBase64, context }) {
  const { chosen: model } = await resolveModel(apiKey, wantedModel, 'transcribe');
  const parts = [{ text: TRANSCRIBE_PROMPT }];
  if (context) parts.push({ text: `Previous context (for continuity only, do not repeat):\n${context.slice(-600)}` });
  parts.push({ inlineData: { mimeType: 'audio/wav', data: wavBase64 } });
  const generationConfig = { maxOutputTokens: 1024, temperature: 0 };
  // 2.5 Flash "thinks" by default and thinking tokens count against
  // maxOutputTokens; transcription doesn't need it, so turn it off there.
  if (/2\.5-flash/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  const res = await request(apiKey, model, 'generateContent', {
    contents: [{ role: 'user', parts }],
    generationConfig,
  });
  const j = await res.json();
  const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text || /^\[?silence\]?\.?$/i.test(text)) return '';
  return text;
}

// Gemini can read a public YouTube video straight from its URL (free tier: ~8 h of video a day).
const VIDEO_PROMPTS = {
  full: `Watch this whole video. Output plain text in this order:
1. TRANSCRIPT — everything said, as [mm:ss] timestamped lines, verbatim (drop filler words only). If the video is longer than ~40 minutes, keep the first 30 minutes verbatim and condense the rest densely (every point, term and number, fewer words).
2. ON SCREEN — timestamped list of what appears on screen that matters: slide titles and bullet text (verbatim), code, equations, diagrams (describe), captions. Skip the presenter's face.
3. KEY FACTS — dense bullets: every fact, definition, number, name and conclusion in the video.`,
  screen: `Watch this whole video and list, as [mm:ss] timestamped plain-text lines, what appears ON SCREEN that carries information: slide titles and bullet text (verbatim), code, equations, diagrams (describe concretely), captions and names. Skip frames that only show the presenter. Then add KEY FACTS: dense bullets of every fact, definition, number and conclusion.`,
};
function pickVideoModel(available, wanted) {
  const ok = (m) => /^gemini-.*flash/.test(m) && !/live|tts|image|audio|embedding|8b/.test(m);
  if (!available || !available.length) return wanted && ok(wanted) ? wanted : 'gemini-2.5-flash';
  if (wanted && ok(wanted) && available.includes(wanted)) return wanted;
  return ['gemini-2.5-flash', 'gemini-3.1-flash', 'gemini-3-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3-flash-lite', 'gemini-2.0-flash'].find((m) => available.includes(m))
    || available.find(ok) || 'gemini-2.5-flash';
}
async function videoFromUrl({ apiKey, url, model: wanted, mode = 'full', prompt }) {
  const model = pickVideoModel(await listModels(apiKey), wanted);
  const generationConfig = { maxOutputTokens: 8192, temperature: 0.2 };
  if (/2\.5-flash/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  const res = await request(apiKey, model, 'generateContent', {
    contents: [{ role: 'user', parts: [{ fileData: { fileUri: url } }, { text: prompt || VIDEO_PROMPTS[mode] || VIDEO_PROMPTS.full }] }],
    generationConfig,
  }, null, 300000);
  const j = await res.json();
  const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) throw new Error(`Gemini returned nothing for that video (${j.candidates?.[0]?.finishReason || (j.promptFeedback && j.promptFeedback.blockReason) || 'no candidates'})`);
  return { model, text };
}

module.exports = { stream, transcribe, videoFromUrl, pickVideoModel, listModels, resolveModel, pickAvailable, PREFERRED, onModelResolved: null };
