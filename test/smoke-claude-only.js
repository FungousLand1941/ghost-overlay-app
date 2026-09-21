// Claude-only setup (no Gemini key at all) must still transcribe: the renderer
// must not refuse to start, and the main process must fall back to the local engine.
(async () => {
  const g = window.__ghost;
  const out = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await window.ghost.setConfig({ provider: 'claude', claude: { apiKey: 'sk-ant-DUMMY-claude-only-0000000000000000' }, gemini: { apiKey: null }, transcription: { engine: 'gemini', localFallback: true } });
  await g.reloadConfig();
  const statuses = [];
  const off = window.ghost.onLiveEvent((ev) => { if (ev.type === 'status') statuses.push(ev.text); });
  g.setTranscript([]);
  await g.toggleListen();
  await sleep(2500);
  out.mode = g.mode();
  out.fellBackToLocal = statuses.some((s) => /Gemini Live unavailable \(no Gemini API key\) → using local offline transcription/.test(s));
  out.localReady = statuses.some((s) => /local offline transcription ready/.test(s));
  out.statusLine = g.status();
  g.stopListening();
  off();
  // restore: put the gemini key back for the remaining steps
  await window.ghost.setConfig({ provider: 'gemini', gemini: { apiKey: 'AIzaDUMMY-ghost-smoke-key-0000000000' } });
  await g.reloadConfig();
  out.PASS = out.mode === 'live' && out.fellBackToLocal && out.localReady;
  return out;
})();
