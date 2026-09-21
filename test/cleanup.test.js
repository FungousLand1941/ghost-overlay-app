// AI transcript cleanup: garbled ASR lines + context -> corrected lines (JSON).
const http = require('http');
const server = http.createServer((req, res) => {
  if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ models: [{ name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] }] })); }
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const j = JSON.parse(b);
    const sys = j.systemInstruction?.parts?.[0]?.text || '';
    const user = j.contents[0].parts[0].text;
    // assert it's the cleanup prompt with background + lines
    const ok = /clean up raw automatic speech-to-text/i.test(sys) && /BACKGROUND/.test(user) && /hashmap handle collision/.test(user);
    const out = ok ? '{"1":"How does a hash map handle collisions?","2":"Yeah, exactly.","3":""}' : '{}';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: out }] }, finishReason: 'STOP' }] })}\r\n\r\n`);
  });
});
server.listen(0, async () => {
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${server.address().port}/models`;
  const providers = require('../src/providers');
  let failures = 0; const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n} ${x}`); if (!c) failures++; };
  const cfg = { provider: 'gemini', gemini: { apiKey: 'test-key', model: 'gemini-2.5-flash-lite' }, transcription: { model: 'gemini-2.5-flash-lite' } };
  const lines = [
    { n: 1, speaker: 'them', text: 'would you would the hel does a hashmap handle collision' },
    { n: 2, speaker: 'you', text: 'ya ya exactly' },
    { n: 3, speaker: 'them', text: 'mm mm' },
  ];
  const map = await providers.cleanupTranscript(cfg, { lines, background: 'Topic: data structures. Terms: hash map, collisions, chaining.' });
  check('line 1 corrected', map['1'] === 'How does a hash map handle collisions?', JSON.stringify(map));
  check('line 2 corrected', map['2'] === 'Yeah, exactly.');
  check('line 3 (noise) empty', map['3'] === '');
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exitCode = failures ? 1 : 0; server.unref(); server.closeAllConnections();
});
