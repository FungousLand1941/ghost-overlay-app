// Offline test of src/providers/gemini.js against a local server that speaks
// Gemini's real wire format (streamGenerateContent?alt=sse and generateContent).
//   node test/mock-gemini.js
const http = require('http');

const server = http.createServer((req, res) => {
  // model listing (used to filter the fallback chain): advertise the models this mock serves
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro', 'gemma-3-27b-it'].map((n) => ({ name: `models/${n}`, supportedGenerationMethods: ['generateContent'] })) }));
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = JSON.parse(body);
    server.lastBody = j; server.lastUrl = req.url;
    if (req.headers['x-goog-api-key'] !== 'test-key') {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }));
    }
    const sysText = j.systemInstruction?.parts?.[0]?.text || '';
    // quota simulations (Google's real 429 shape: QuotaFailure + RetryInfo details)
    if (/QUOTA_DAY_TEST/.test(sysText) && /flash-lite/.test(req.url)) {
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details.', status: 'RESOURCE_EXHAUSTED', details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaDimensions: { model: 'gemini-2.5-flash-lite' }, quotaValue: '1000' }] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3600s' } ] } }));
    }
    if (/OVERLOAD_TEST/.test(sysText) && /flash-lite/.test(req.url)) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 503, message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.', status: 'UNAVAILABLE' } }));
    }
    if (/QUOTA_MINUTE_TEST/.test(sysText)) {
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED', details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaDimensions: { model: 'gemini-2.5-flash-lite' } }] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' } ] } }));
    }
    if (req.url.includes('streamGenerateContent') && /running memory/.test(sysText)) {
      // summariser call: echo a marker plus whether previous summary + new text arrived
      const u = j.contents[0].parts[0].text;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: `SUMMARY prev=${/PREVIOUS SUMMARY:/.test(u)} new=${/NEW TRANSCRIPT TO FOLD IN:/.test(u)} model=${req.url.split('/models/')[1].split(':')[0]}` }] }, finishReason: 'STOP' }] })}\r\n\r\n`);
      return;
    }
    if (req.url.includes('streamGenerateContent')) {
      // echo back what we received so the test can assert on request shape
      const sys = j.systemInstruction?.parts?.[0]?.text || '';
      const last = j.contents[j.contents.length - 1];
      const hasImage = last.parts.some((p) => p.inlineData);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunks = ['**Two', '-sum**: ', `img=${hasImage} `, `sys=${sys.length > 0} `, `turns=${j.contents.length}`];
      let i = 0;
      const t = setInterval(() => {
        if (i < chunks.length) {
          res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: chunks[i] }], role: 'model' }, index: 0 }] })}\r\n\r\n`);
          i++;
        } else {
          res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '' }], role: 'model' }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } })}\r\n\r\n`);
          clearInterval(t); res.end();
        }
      }, 20);
      return;
    }
    if (req.url.includes('generateContent')) {
      const audio = j.contents[0].parts.find((p) => p.inlineData);
      const okWav = audio && audio.inlineData.mimeType === 'audio/wav' && Buffer.from(audio.inlineData.data, 'base64').slice(0, 4).toString() === 'RIFF';
      const thinkingOff = j.generationConfig?.thinkingConfig?.thinkingBudget === 0;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: okWav && thinkingOff ? 'so what is the time complexity of your approach' : `[silence]` }], role: 'model' }, finishReason: 'STOP' }] }));
    }
    res.writeHead(404); res.end();
  });
});

server.listen(0, async () => {
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${server.address().port}/models`;
  const gemini = require('../src/providers/gemini');
  const providers = require('../src/providers');
  let failures = 0;
  const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };

  // 1. streaming chat with image + system prompt + multi-turn
  const cfg = { provider: 'gemini', gemini: { apiKey: 'test-key', model: 'gemini-2.5-flash' }, maxTokens: 512, profile: 'interview' };
  const messages = [
    { role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' },
    { role: 'user', text: 'solve this', image: { mime: 'image/jpeg', data: Buffer.from('fake').toString('base64') } },
  ];
  let out = '';
  for await (const t of providers.stream(cfg, { messages, system: providers.systemPrompt(cfg) })) out += t;
  check('stream: tokens concatenated in order', out.startsWith('**Two-sum**: '), JSON.stringify(out));
  check('stream: image forwarded as inlineData', out.includes('img=true'));
  check('stream: system prompt forwarded', out.includes('sys=true'));
  check('stream: roles merged correctly (3 turns)', out.includes('turns=3'));

  // 2. invalid key -> friendly error
  let err = null;
  try { for await (const _ of gemini.stream({ cfg, apiKey: 'bad', messages, system: 'x' })) {} } catch (e) { err = e; }
  check('stream: invalid key maps to friendly error', err && /invalid API key/.test(err.message), err && err.message);

  // 3. transcription: WAV + thinking disabled + silence filtering
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(40)]).toString('base64');
  const text = await gemini.transcribe({ apiKey: 'test-key', model: 'gemini-2.5-flash', wavBase64: wav, context: 'earlier words' });
  check('transcribe: sends WAV with thinking off, returns text', text === 'so what is the time complexity of your approach', JSON.stringify(text));
  const silent = await gemini.transcribe({ apiKey: 'test-key', model: 'gemini-2.0-flash', wavBase64: Buffer.from('nope').toString('base64') });
  check('transcribe: [silence] filtered to empty string', silent === '');

  // 3a. speed setting -> Gemini thinking budget (the big latency lever)
  server.lastBody = null;
  const cfgFast = { provider: 'gemini', gemini: { apiKey: 'test-key', model: 'gemini-2.5-flash' }, maxTokens: 64, speed: 'fast' };
  for await (const _ of providers.stream(cfgFast, { messages: [{ role: 'user', text: 'x' }], system: 'y' })) {}
  check('speed=fast disables thinking on 2.5 flash', server.lastBody && server.lastBody.generationConfig.thinkingConfig && server.lastBody.generationConfig.thinkingConfig.thinkingBudget === 0, JSON.stringify(server.lastBody && server.lastBody.generationConfig));
  for await (const _ of providers.stream({ ...cfgFast, speed: 'thorough' }, { messages: [{ role: 'user', text: 'x' }], system: 'y' })) {}
  check('speed=thorough leaves thinking at model default', server.lastBody && !server.lastBody.generationConfig.thinkingConfig);
  for await (const _ of providers.stream({ ...cfgFast, gemini: { apiKey: 'test-key', model: 'gemini-2.5-pro' } }, { messages: [{ role: 'user', text: 'x' }], system: 'y' })) {}
  check('2.5 pro never gets thinkingBudget 0 (unsupported)', server.lastBody && !server.lastBody.generationConfig.thinkingConfig);

  // 3a'. response modes: instant = small model, no thinking, short cap; think = main model + thinking
  const base = { provider: 'gemini', gemini: { apiKey: 'test-key', model: 'gemini-2.5-flash' }, claude: { apiKey: '', model: 'claude-opus-5' }, maxTokens: 4096, instantModel: { gemini: 'gemini-2.5-flash-lite', claude: 'claude-haiku-4-5' }, instantMaxTokens: 350, thinkSpeed: 'balanced' };
  const inst = providers.modeConfig(base, 'instant');
  check('instant: flash-lite, 350 tokens, fast', inst.gemini.model === 'gemini-2.5-flash-lite' && inst.maxTokens === 350 && inst.speed === 'fast' && inst.claude.model === 'claude-haiku-4-5');
  const think = providers.modeConfig(base, 'think');
  check('think: main model, full tokens, balanced thinking', think.gemini.model === 'gemini-2.5-flash' && think.maxTokens === 4096 && think.speed === 'balanced');
  for await (const _ of providers.stream(inst, { messages: [{ role: 'user', text: 'x' }], system: providers.systemPrompt(inst, 'general', 'instant') })) {}
  check('instant request: lite model, thinking off, 350 cap, INSTANT prompt', /flash-lite/.test(server.lastUrl || '') && server.lastBody.generationConfig.thinkingConfig.thinkingBudget === 0 && server.lastBody.generationConfig.maxOutputTokens === 350 && /INSTANT MODE/.test(server.lastBody.systemInstruction.parts[0].text), server.lastUrl);
  for await (const _ of providers.stream(think, { messages: [{ role: 'user', text: 'x' }], system: providers.systemPrompt(think, 'general', 'think') })) {}
  check('think request: main model, thinking budget, THINK prompt', /gemini-2\.5-flash:/.test(server.lastUrl || '') && server.lastBody.generationConfig.thinkingConfig.thinkingBudget === 1024 && /THINK MODE/.test(server.lastBody.systemInstruction.parts[0].text), server.lastUrl);

  // 3a''. quota handling: daily cap on flash-lite -> automatic fallback to flash, with a visible note
  const liteCfg = { provider: 'gemini', gemini: { apiKey: 'test-key', model: 'gemini-2.5-flash-lite' }, maxTokens: 64, speed: 'fast' };
  let outDay = '';
  for await (const t of providers.stream(liteCfg, { messages: [{ role: 'user', text: 'x' }], system: 'QUOTA_DAY_TEST' })) outDay += t;
  check('daily quota -> falls back to another model', /gemini-2\.5-flash:/.test(server.lastUrl) && /daily quota used up → answered with gemini-2\.5-flash/.test(outDay), outDay.slice(0, 120));
  // per-minute limit with a short retry -> surfaces a precise error, no silent fallback
  let errMin = null;
  try { for await (const _ of providers.stream(liteCfg, { messages: [{ role: 'user', text: 'x' }], system: 'QUOTA_MINUTE_TEST' })) {} } catch (e) { errMin = e; }
  check('per-minute limit -> precise error with retry seconds', errMin && errMin.code === 'RATE_LIMIT' && errMin.quotaKind === 'minute' && errMin.retrySec === 7 && /requests-per-minute limit on gemini-2\.5-flash-lite — retry in 7s/.test(errMin.message), errMin && errMin.message);

  // 3a'''. configured model not visible to this key -> auto-resolve to the best available, with a note
  let resolved = null; gemini.onModelResolved = (e) => { resolved = e; };
  let outRes = '';
  for await (const t of providers.stream({ provider: 'gemini', gemini: { apiKey: 'test-key', model: 'gemini-9-does-not-exist' }, maxTokens: 64, speed: 'fast' }, { messages: [{ role: 'user', text: 'x' }], system: 'y' })) outRes += t;
  check('unavailable model -> resolved to best available (flash-lite) + note + hook', /gemini-2\.5-flash-lite:/.test(server.lastUrl) && /isn't available to this key → using gemini-2\.5-flash-lite/.test(outRes) && resolved && resolved.wanted === 'gemini-9-does-not-exist' && resolved.chosen === 'gemini-2.5-flash-lite', outRes.slice(0, 100));
  gemini.onModelResolved = null;
  check('pickAvailable: keeps a configured model that exists', gemini.pickAvailable(['gemini-3.1-flash-lite', 'gemini-2.5-flash'], 'gemini-2.5-flash') === 'gemini-2.5-flash');
  check('pickAvailable: prefers 3.x lite when the wanted one is gone', gemini.pickAvailable(['gemini-3.1-flash-lite', 'gemini-3.1-flash'], 'gemini-2.5-flash-lite') === 'gemini-3.1-flash-lite');
  check('pickAvailable: no list -> unchanged', gemini.pickAvailable(null, 'anything') === 'anything');

  // 3a''''. overloaded model (503 "high demand") -> next available model, no 60 s hang
  let outOv = '';
  for await (const t of providers.stream(liteCfg, { messages: [{ role: 'user', text: 'x' }], system: 'OVERLOAD_TEST' })) outOv += t;
  check('503 overloaded -> falls back to the next model with a note', /gemini-2\.5-flash:/.test(server.lastUrl) && /gemini-2\.5-flash-lite: overloaded \/ slow → answered with gemini-2\.5-flash/.test(outOv), outOv.slice(0, 120));

  // 3b. rolling-memory summariser uses the cheap transcription model
  const sum = await providers.summarize({ gemini: { apiKey: 'test-key' }, transcription: { model: 'gemini-2.5-flash-lite' } }, { previous: 'old summary', newText: 'THEM: hello\nYOU: hi' });
  check('summarize: cheap model, previous + new folded', sum === 'SUMMARY prev=true new=true model=gemini-2.5-flash-lite', sum);
  // 3c. background context docs land in the system prompt
  const sysp = providers.systemPrompt({ profile: 'general', customPrompt: '', contextDocs: 'RESUME: 5 years of Go' });
  check('systemPrompt: background notes included', /BACKGROUND NOTES[\s\S]*RESUME: 5 years of Go/.test(sysp));

  // 4. missing key path through providers.transcribe
  let err2 = null;
  try { await providers.transcribe({ gemini: { apiKey: '' } }, { wavBase64: wav }); } catch (e) { err2 = e; }
  check('transcribe: missing key explains Gemini requirement', err2 && /Gemini API key/.test(err2.message));

  server.unref(); server.closeAllConnections();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
});
