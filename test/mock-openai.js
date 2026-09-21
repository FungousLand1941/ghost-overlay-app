// OpenAI-compatible provider (Groq/Cerebras/OpenRouter/Ollama) against a mock of
// the wire format, plus cross-provider fallback: Gemini out of daily quota on
// every model -> the same request is answered by the OpenAI-compatible provider.
const http = require('http');

function sseChunk(text, finish) {
  return `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: text ? { content: text } : {}, finish_reason: finish || null }] })}\n\n`;
}

// ---- mock OpenAI-compatible server
const oa = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
    oa.lastReq = { url: req.url, headers: req.headers, body: JSON.parse(body) };
    const auth = req.headers.authorization || '';
    if (auth !== 'Bearer gsk_test') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Invalid API Key', type: 'invalid_request_error' } })); }
    const j = oa.lastReq.body;
    if (j.model === 'daily-dead') { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3600' }); return res.end(JSON.stringify({ error: { message: 'Rate limit reached for model daily-dead: Limit 14400 per day, used 14400. Please try again in 1h.', type: 'tokens' } })); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const sys = j.messages[0].content; const last = j.messages[j.messages.length - 1];
    const hasImg = Array.isArray(last.content) && last.content.some((p) => p.type === 'image_url');
    const txt = Array.isArray(last.content) ? last.content.find((p) => p.type === 'text').text : last.content;
    res.write(sseChunk(`model=${j.model} `)); res.write(sseChunk(`img=${hasImg} `)); res.write(sseChunk(`sys=${/^You are Ghost/.test(sys)} `)); res.write(sseChunk(`note=${/screenshot omitted/.test(txt)}`, 'stop'));
    res.end('data: [DONE]\n\n');
  });
});

// ---- mock Gemini that is out of daily quota on every model
const gm = http.createServer((req, res) => {
  if (req.method === 'GET') { res.writeHead(404); return res.end(); } // model list unavailable -> no filtering
  let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota', status: 'RESOURCE_EXHAUSTED', details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3600s' } ] } }));
  });
});

let failures = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n} ${x}`); if (!c) failures++; };

oa.listen(0, () => gm.listen(0, async () => {
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${gm.address().port}/models`;
  const openai = require('../src/providers/openai');
  const providers = require('../src/providers');
  const base = `http://127.0.0.1:${oa.address().port}/v1`;
  const cfgOA = { provider: 'openai', openai: { apiKey: 'gsk_test', preset: 'groq', baseUrl: base, model: 'llama-3.3-70b-versatile', vision: false }, maxTokens: 64 };
  const collect = async (gen) => { let s = ''; for await (const t of gen) s += t; return s; };

  // 1. streaming + system prompt + model
  let out = await collect(openai.stream({ cfg: cfgOA, apiKey: 'gsk_test', messages: [{ role: 'user', text: 'hi' }], system: providers.systemPrompt(cfgOA, 'general', 'instant') }));
  check('openai: SSE parsed, model + system forwarded', /model=llama-3\.3-70b-versatile img=false sys=true/.test(out), out);
  check('openai: bearer auth header', oa.lastReq.headers.authorization === 'Bearer gsk_test');
  // 2. image with a non-vision model -> dropped with a note; with vision -> sent as image_url
  out = await collect(openai.stream({ cfg: cfgOA, apiKey: 'gsk_test', messages: [{ role: 'user', text: 'screen?', image: { mime: 'image/jpeg', data: 'AAAA' } }], system: 'You are Ghost' }));
  check('openai: no-vision model drops the screenshot with a note', /^_\[screenshot omitted/.test(out) && /img=false/.test(out) && /note=true/.test(out), out.slice(0, 80));
  out = await collect(openai.stream({ cfg: { ...cfgOA, openai: { ...cfgOA.openai, vision: true } }, apiKey: 'gsk_test', messages: [{ role: 'user', text: 'screen?', image: { mime: 'image/jpeg', data: 'AAAA' } }], system: 'You are Ghost' }));
  check('openai: vision model gets image_url part', /img=true/.test(out));
  // 3. errors
  let err = null; try { await collect(openai.stream({ cfg: cfgOA, apiKey: 'bad', messages: [{ role: 'user', text: 'x' }], system: 's' })); } catch (e) { err = e; }
  check('openai: 401 -> invalid API key', err && /invalid API key/.test(err.message), err && err.message);
  err = null; try { await collect(openai.stream({ cfg: { ...cfgOA, openai: { ...cfgOA.openai, model: 'daily-dead' } }, apiKey: 'gsk_test', messages: [{ role: 'user', text: 'x' }], system: 's' })); } catch (e) { err = e; }
  check('openai: 429 daily -> RATE_LIMIT/day with retry', err && err.code === 'RATE_LIMIT' && err.quotaKind === 'day' && err.retrySec === 3600, err && err.message);
  // 4. modeConfig: instant uses the preset's instant model
  const inst = providers.modeConfig(cfgOA, 'instant');
  check('instant mode -> preset instant model', inst.openai.model === 'llama-3.1-8b-instant', inst.openai.model);
  // 5. cross-provider fallback: Gemini dead on every model -> Groq answers, with a note
  const cfgG = { provider: 'gemini', gemini: { apiKey: 'g-test', model: 'gemini-2.5-flash' }, openai: cfgOA.openai, fallbackProvider: 'auto', maxTokens: 64, speed: 'fast' };
  out = await collect(providers.stream(cfgG, { messages: [{ role: 'user', text: 'hi' }], system: 'You are Ghost' }));
  check('fallback: Gemini daily-dead -> answered by OpenAI-compatible with note', /^_\[Gemini: daily quota used up → answered by OpenAI-compatible\]_/.test(out) && /model=llama-3\.3-70b-versatile/.test(out), out.slice(0, 120));
  check('fallback order respects config', providers.fallbackOrder(cfgG).join(',') === 'gemini,openai' && providers.fallbackOrder({ ...cfgG, fallbackProvider: 'none' }).join(',') === 'gemini');
  err = null; try { await collect(providers.stream({ ...cfgG, fallbackProvider: 'none' }, { messages: [{ role: 'user', text: 'hi' }], system: 's' })); } catch (e) { err = e; }
  check('fallback off -> the Gemini error surfaces', err && /daily free-tier quota/.test(err.message), err && err.message.slice(0, 100));

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exitCode = failures ? 1 : 0;
  oa.closeAllConnections(); gm.closeAllConnections(); oa.unref(); gm.unref();
}));
