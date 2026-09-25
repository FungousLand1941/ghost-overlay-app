// Generic OpenAI-compatible chat provider: Groq, Cerebras, OpenRouter, Ollama,
// Together, Mistral, LM Studio… anything exposing POST {baseUrl}/chat/completions.
// Fast free tiers (Groq, Cerebras) make this the best "instant" engine.

const PRESETS = {
  // NavyAI: unified API, 100+ free models incl. Gemini/DeepSeek/Mistral with vision; key "sk-navy-…"
  navy:       { label: 'NavyAI (free, 150+ models, vision)', baseUrl: 'https://api.navy/v1', model: 'gemini-2.5-flash-lite', instant: 'gemini-2.5-flash-lite', vision: 'gemini-2.5-flash-lite', visionDefault: true, keyUrl: 'https://api.navy' },
  groq:       { label: 'Groq (free, fastest)',        baseUrl: 'https://api.groq.com/openai/v1',  model: 'llama-3.3-70b-versatile', instant: 'llama-3.1-8b-instant', vision: 'meta-llama/llama-4-scout-17b-16e-instruct', keyUrl: 'https://console.groq.com/keys' },
  cerebras:   { label: 'Cerebras (free, very fast)',  baseUrl: 'https://api.cerebras.ai/v1',       model: 'llama-3.3-70b',           instant: 'llama3.1-8b',           vision: '',                                        keyUrl: 'https://cloud.cerebras.ai' },
  openrouter: { label: 'OpenRouter (free models)',    baseUrl: 'https://openrouter.ai/api/v1',     model: 'meta-llama/llama-3.3-70b-instruct:free', instant: 'meta-llama/llama-3.3-70b-instruct:free', vision: 'google/gemma-3-27b-it:free', keyUrl: 'https://openrouter.ai/keys' },
  ollama:     { label: 'Ollama (local, no key)',      baseUrl: 'http://localhost:11434/v1',        model: 'llama3.2',                instant: 'llama3.2',              vision: 'llava',                                   keyUrl: '' },
  custom:     { label: 'Custom OpenAI-compatible',    baseUrl: '',                                 model: '',                        instant: '',                      vision: '',                                        keyUrl: '' },
};

function toMessages(messages, system, allowImages) {
  const out = [{ role: 'system', content: system }];
  let dropped = false;
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const imgs = [...(m.image?.data ? [m.image] : []), ...(m.images || [])];
    if (imgs.length && allowImages) {
      const content = [];
      for (const im of imgs) { if (im.label) content.push({ type: 'text', text: im.label }); content.push({ type: 'image_url', image_url: { url: `data:${im.mime || 'image/jpeg'};base64,${im.data}` } }); }
      content.push({ type: 'text', text: m.text || 'Here is my screen.' });
      out.push({ role, content });
    } else {
      out.push({ role, content: (m.text || '') + (imgs.length && !allowImages ? (dropped = true, '\n[screenshot omitted: this model has no vision]') : '') });
    }
  }
  return { out, dropped };
}

// Minimal SSE parser over a fetch body (OpenAI: "data: {...}" lines, "data: [DONE]").
async function* sse(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of block.split('\n')) if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
}

async function* stream({ cfg, apiKey, messages, system, signal }) {
  const o = cfg.openai || {};
  const baseUrl = (o.baseUrl || PRESETS.groq.baseUrl).replace(/\/+$/, '');
  const model = o.model || PRESETS.groq.model;
  const label = o.preset && PRESETS[o.preset] ? PRESETS[o.preset].label.split(' ')[0] : 'OpenAI-compatible';
  const { out, dropped } = toMessages(messages, system, !!o.vision);
  const body = { model, messages: out, stream: true, max_tokens: cfg.maxTokens || 4096, temperature: 0.4 };
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (/openrouter/.test(baseUrl)) { headers['HTTP-Referer'] = 'https://github.com/ghost-overlay'; headers['X-Title'] = 'Ghost'; }
  let res;
  try { res = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal }); }
  catch (e) { throw new Error(`${label}: network error (${e.message}) — is the server reachable? ${baseUrl}`); }
  if (!res.ok) {
    let msg = `${res.status}`; let j = null;
    try { j = await res.json(); msg = j.error?.message || j.message || JSON.stringify(j); } catch { msg = await res.text().catch(() => msg); }
    if (res.status === 401 || res.status === 403) throw new Error(`${label}: invalid API key — the server said: "${String(msg).slice(0, 140)}"`);
    if (res.status === 404) throw new Error(`${label}: model not found (${model}) — ${msg.slice(0, 120)}`);
    if (res.status === 429) {
      const retry = +(res.headers.get('retry-after') || 0);
      const kind = /day|daily|per day|TPD|RPD/i.test(msg) ? 'day' : /token/i.test(msg) ? 'tokens' : 'minute';
      const e = new Error(`${label} rate limit: ${kind === 'day' ? `daily quota for ${model} used up` : kind === 'tokens' ? `tokens-per-minute limit on ${model}` : `requests-per-minute limit on ${model}`}${retry ? ` — retry in ${retry}s` : ''}`);
      e.code = 'RATE_LIMIT'; e.quotaKind = kind; e.retrySec = retry; e.model = model; e.raw = msg.slice(0, 300);
      throw e;
    }
    throw new Error(`${label} ${res.status}: ${msg.slice(0, 200)}`);
  }
  if (dropped) yield '_[screenshot omitted: this model has no vision — pick a vision model or use Gemini/Claude for screen questions]_\n\n';
  let finish = null;
  for await (const data of sse(res.body)) {
    if (data === '[DONE]') break;
    let j; try { j = JSON.parse(data); } catch { continue; }
    const ch = j.choices?.[0];
    if (ch?.finish_reason) finish = ch.finish_reason;
    const t = ch?.delta?.content; if (t) yield t;
    if (j.error) throw new Error(`${label}: ${j.error.message || JSON.stringify(j.error)}`);
  }
  if (finish === 'length') yield '\n\n_[Cut off at max tokens — raise "Max tokens" in settings.]_';
}

module.exports = { stream, PRESETS };
