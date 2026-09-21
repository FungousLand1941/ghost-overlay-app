// Simulates: listening on a call, friend asks "what is a binary tree",
// user clicks Ask. Captures the exact request the provider would send.
const http = require('http');
const server = http.createServer((req, res) => {
  if (req.method === 'GET') { res.writeHead(404); return res.end(); } // model list: unknown -> provider doesn't filter
  let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
    const j = JSON.parse(body);
    server.captured = j;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] })}\r\n\r\n`);
  });
});
server.listen(0, async () => {
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${server.address().port}/models`;
  const providers = require('../src/providers');
  const cfg = { provider: 'gemini', gemini: { apiKey: 'test-key', model: 'gemini-2.5-flash' }, maxTokens: 512, profile: 'general', customPrompt: '' };
  const now = Date.now();
  // this is what app.js buildUserMessage() produces for the Ask button (transcript + screenshot, no note)
  const userText = [
    'LIVE TRANSCRIPT (oldest first, most recent last; still listening):',
    `[38s ago] okay so for the index we store everything in a tree`,
    `[NEW 9s ago] yeah`,
    `[NEW 4s ago] wait what is a binary tree can you explain that`,
    '',
    'SCREENSHOT: attached (my current screen).',
    '',
    'Respond to what is most useful right now (see priority rules).',
  ].join('\n');
  const messages = [{ role: 'user', text: userText, image: { mime: 'image/jpeg', data: Buffer.from('img').toString('base64') } }];
  let out = '';
  for await (const t of providers.stream(cfg, { messages, system: providers.systemPrompt(cfg), signal: undefined })) out += t;
  const req = server.captured;
  const sys = req.systemInstruction.parts[0].text;
  const parts = req.contents[0].parts;
  console.log('--- system prompt (first 400 chars) ---\n' + sys.slice(0, 400) + '…\n');
  console.log('--- user parts ---'); for (const p of parts) console.log(p.inlineData ? `[inlineData ${p.inlineData.mimeType}]` : p.text);
  const checks = {
    systemHasPriorityRules: sys.includes('Decide what is most useful right now, in this priority'),
    systemHasSayThis: sys.includes('"say this" block'),
    systemExplainsNEW: sys.includes('Lines marked NEW'),
    userHasQuestionMarkedNew: parts.some((p) => p.text && p.text.includes('[NEW 4s ago] wait what is a binary tree')),
    imageBeforeText: !!parts[0].inlineData,
  };
  console.log('\n' + JSON.stringify(checks, null, 2));
  const ok = Object.values(checks).every(Boolean);
  console.log(ok ? 'SCENARIO PASS' : 'SCENARIO FAIL');
  process.exitCode = ok ? 0 : 1;
  server.unref(); server.closeAllConnections();
});
