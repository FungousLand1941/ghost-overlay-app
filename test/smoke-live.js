// End-to-end streaming transcription inside the real app: real audio capture
// -> IPC frames -> WebSocket (mock Live server) -> events -> transcript UI.
(async () => {
  const g = window.__ghost;
  const out = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  g.setTranscript([]);
  await window.ghost.setConfig({ transcription: { engine: 'gemini' } }); // this smoke exercises the Gemini Live path against the mock server
  await g.reloadConfig();
  await g.toggleListen();
  await sleep(300);
  out.mode = g.mode();
  out.statusAfterStart = g.status();
  // the mock scripts a transcript by frame count (~256 ms per frame): wait for ~12 frames
  await sleep(3500);
  out.transcript = g.transcript().map((t) => t.text);
  out.speakers = [...new Set(g.transcript().map((t) => t.speaker))].sort();
  out.transcriptPanelText = document.getElementById('transcript-text').textContent;
  out.statusAfter = g.status();
  out.meterSystemVisible = document.getElementById('lvl-system').className !== 'off';
  // Ask catch-up path in live mode should return quickly
  const t0 = Date.now();
  const built = g.buildUserMessage({ text: '', image: null, includeTranscript: true });
  out.askContextHasLiveWords = !!built && built.text.includes('wait what is a binary tree');
  out.catchupMs = Date.now() - t0;
  g.stopListening();
  out.stoppedStatus = g.status();
  out.askContextLabelled = !!built && /THEM: wait what is a binary tree/.test(built.text) && /YOU: /.test(built.text);
  out.PASS = out.mode === 'live' && out.transcript.length >= 2 && out.transcript[0] === 'wait what is a binary tree' && out.askContextHasLiveWords && out.speakers.join(',') === 'them,you' && out.askContextLabelled;
  return out;
})();
