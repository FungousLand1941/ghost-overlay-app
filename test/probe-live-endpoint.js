// Probe how the REAL Live endpoint responds to header vs query auth and a
// given model, using a dummy key. Prints the raw close code/reason or HTTP body.
const WebSocket = require('ws');
const URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const key = process.env.PROBE_KEY || 'AIzaDUMMYkey000000000000000000000000000';
const model = process.argv[2] || 'gemini-3.8-live';
function attempt(auth) {
  return new Promise((resolve) => {
    const url = auth === 'query' ? `${URL}?key=${key}` : URL;
    const ws = new WebSocket(url, { headers: auth === 'header' ? { 'x-goog-api-key': key } : {} });
    const t = setTimeout(() => { resolve(`${auth}: timeout`); ws.terminate(); }, 8000);
    ws.on('unexpected-response', (_r, res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { clearTimeout(t); resolve(`${auth}: HTTP ${res.statusCode} ${b.slice(0, 300)}`); }); });
    ws.on('error', (e) => { clearTimeout(t); resolve(`${auth}: error ${e.message}`); });
    ws.on('open', () => ws.send(JSON.stringify({ setup: { model: `models/${model}`, generationConfig: { responseModalities: ['TEXT'] }, inputAudioTranscription: {} } })));
    ws.on('message', (d) => { clearTimeout(t); resolve(`${auth}: message ${d.toString().slice(0, 300)}`); ws.close(); });
    ws.on('close', (c, r) => { clearTimeout(t); resolve(`${auth}: close ${c} ${r.toString().slice(0, 300)}`); });
  });
}
(async () => { console.log('model:', model); console.log(await attempt('header')); console.log(await attempt('query')); })();
