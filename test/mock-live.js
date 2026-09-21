// Mock of the Gemini Live API WebSocket protocol, used offline by
// `node test/mock-live.js --selftest` (unit test of LiveTranscriber) and by the
// Electron smoke run (GEMINI_LIVE_URL=ws://127.0.0.1:<port>).
const { WebSocketServer } = require('ws');

function startMock(port = 0) {
  const wss = new WebSocketServer({ port });
  wss.on('connection', (ws, req) => {
    const k = req.headers['x-goog-api-key'] || (req.url.match(/[?&]key=([^&]+)/) || [])[1] || ''; const authed = k === 'test-key' || k.includes('DUMMY');
    if (!authed) { ws.close(1008, 'API key not valid'); return; }
    let frames = 0; let goAwaySent = false;
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.setup) {
        if (!/^models\/gemini-/.test(msg.setup.model) || /bad-model/.test(msg.setup.model)) { ws.close(1008, `model ${msg.setup.model} not found`); return; }
        if (/quota-test/.test(msg.setup.model)) ws.quotaDies = true; // this "model" runs out of quota after 3 frames
        ws.send(JSON.stringify({ setupComplete: {} }));
        return;
      }
      if (msg.realtimeInput?.audio) {
        frames++;
        const mt = msg.realtimeInput.audio.mimeType;
        if (mt !== 'audio/pcm;rate=16000') { ws.close(1008, `bad mimeType ${mt}`); return; }
        // Scripted transcript: interim partials, then committed deltas, then turn end.
        if (frames === 2) ws.send(JSON.stringify({ serverContent: { interimInputTranscription: { text: 'wait what' } } }));
        if (frames === 3) ws.send(JSON.stringify({ serverContent: { interimInputTranscription: { text: 'wait what is a binary' } } }));
        if (frames === 4) ws.send(JSON.stringify({ serverContent: { inputTranscription: { text: 'wait what is a ' } } }));
        if (frames === 5) ws.send(JSON.stringify({ serverContent: { inputTranscription: { text: 'binary tree' } } }));
        if (frames === 6) ws.send(JSON.stringify({ serverContent: { modelTurn: { parts: [{ text: '.' }] }, turnComplete: true } }));
        // second utterance uses cumulative-style transcription
        if (frames === 8) ws.send(JSON.stringify({ serverContent: { inputTranscription: { text: 'like the' } } }));
        if (frames === 9) ws.send(JSON.stringify({ serverContent: { inputTranscription: { text: 'like the data structure' }, turnComplete: true } }));
        if (frames === 11 && !goAwaySent && process.env.MOCK_LIVE_GOAWAY) { goAwaySent = true; ws.send(JSON.stringify({ goAway: { timeLeft: '0s' } })); setTimeout(() => ws.close(1000, 'goaway'), 50); }
        // quota simulation: the real server closes with 1011 + this text once the free tier is used up
        if (frames === 3 && (process.env.MOCK_LIVE_QUOTA || ws.quotaDies)) { ws.close(1011, 'Resource has been exhausted (e.g. check quota).'); return; }
        return;
      }
      if (msg.realtimeInput?.audioStreamEnd) {
        ws.send(JSON.stringify({ serverContent: { inputTranscription: { text: 'nudged' }, turnComplete: true } }));
      }
    });
  });
  return wss;
}

if (require.main === module) {
  const wss = startMock(+process.env.MOCK_LIVE_PORT || 0);
  wss.on('listening', () => console.log(`MOCK_LIVE_URL=ws://127.0.0.1:${wss.address().port}`));
  if (process.argv.includes('--selftest')) {
    wss.on('listening', async () => {
      process.env.GEMINI_LIVE_URL = `ws://127.0.0.1:${wss.address().port}`;
      process.env.MOCK_LIVE_GOAWAY = '1';
      const { LiveTranscriber } = require('../src/providers/gemini-live');
      let failures = 0;
      const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n} ${x}`); if (!c) failures++; };
      const frame = Buffer.alloc(8192).toString('base64');
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      // 1. connects, falls back from a bad model name, uses header auth
      const t = new LiveTranscriber({ apiKey: 'test-key', model: 'gemini-bad-model' });
      const events = [];
      ['interim', 'final', 'status', 'error'].forEach((k) => t.on(k, (v) => events.push([k, v instanceof Error ? v.message : v])));
      const model = await t.connect();
      check('connect: skipped bad model, fell back', model === 'gemini-3.8-live', model);

      // 2. streams frames, gets interim then final with delta + cumulative handling
      for (let i = 0; i < 10; i++) { t.sendAudio(frame); await sleep(30); }
      await sleep(200);
      const finals = events.filter((e) => e[0] === 'final').map((e) => e[1]);
      const interims = events.filter((e) => e[0] === 'interim').map((e) => e[1]);
      check('interim partials surfaced', interims.includes('wait what is a binary'), JSON.stringify(interims));
      check('final: deltas joined', finals[0] === 'wait what is a binary tree', JSON.stringify(finals));
      check('final: cumulative text handled', finals[1] === 'like the data structure', JSON.stringify(finals));

      // 3. goAway -> reconnect, frames keep flowing
      t.sendAudio(frame); await sleep(600);
      check('goAway triggered reconnect', events.some((e) => e[0] === 'status' && /reconnected/.test(e[1])), JSON.stringify(events.filter((e) => e[0] === 'status')));
      check('still connected after reconnect', t.ready === true);

      // 4. nudge finalises
      t.nudge(); await sleep(150);
      check('nudge -> final', events.filter((e) => e[0] === 'final').map((e) => e[1]).includes('nudged'));

      // 4b. quota exhausted -> one error with code QUOTA, NO reconnect attempts
      process.env.MOCK_LIVE_QUOTA = '1';
      const q = new LiveTranscriber({ apiKey: 'test-key', model: 'gemini-3.8-live' });
      const qEvents = [];
      ['status', 'error', 'log'].forEach((k) => q.on(k, (v) => qEvents.push([k, v instanceof Error ? { msg: v.message, code: v.code } : v])));
      await q.connect();
      for (let i = 0; i < 5; i++) { q.sendAudio(frame); await sleep(30); }
      await sleep(600);
      delete process.env.MOCK_LIVE_QUOTA;
      const qErr = qEvents.find((e) => e[0] === 'error');
      check('quota: error surfaced with code QUOTA', qErr && qErr[1].code === 'QUOTA', JSON.stringify(qErr));
      check('quota: no reconnect attempted', !qEvents.some((e) => e[0] === 'status' && /reconnect/i.test(e[1])) && !qEvents.some((e) => e[0] === 'log' && /reconnect attempt/.test(e[1])));
      q.close();

      // 5. bad key -> clear error, no model loop
      const bad = new LiveTranscriber({ apiKey: 'wrong', model: 'gemini-3.8-live' });
      let err = null; try { await bad.connect(); } catch (e) { err = e; }
      check('bad key rejected', err && /API key/.test(err.message), err && err.message);

      t.close();
      console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
      process.exitCode = failures ? 1 : 0;
      wss.close();
    });
  }
}
module.exports = { startMock };
