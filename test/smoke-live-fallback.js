// Gemini Live dies of quota mid-call (mock model "gemini-quota-test" closes with
// 1011 RESOURCE_EXHAUSTED after 3 frames) -> each source must switch to the
// local offline engine on its own, listening keeps going, and the user sees why.
(async () => {
  const g = window.__ghost;
  const out = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  g.setTranscript([]);
  await window.ghost.setConfig({ transcription: { engine: 'gemini', localFallback: true, liveModel: 'gemini-quota-test' } });
  await g.reloadConfig();
  const statuses = [];
  const off = window.ghost.onLiveEvent((ev) => { if (ev.type === 'status') statuses.push(ev.text); });
  await g.toggleListen();
  out.startedMode = g.mode();
  await sleep(7000); // 3 frames ≈ 0.8 s, then the switch (local engine is pre-warmed in its worker; cold load would be ~6 s)
  out.stillListening = g.mode() === 'live';
  out.switchedToLocal = statuses.some((s) => /switched to local offline transcription/.test(s));
  out.bothSourcesSwitched = ['them', 'you'].every((sp) => statuses.some((s) => s.startsWith(`${sp}:`) && /switched to local/.test(s)));
  out.noHardError = !/quota exhausted \(free tier\) — listening stopped/.test(g.status());
  out.statusNow = g.status();
  g.stopListening();
  off();
  await window.ghost.setConfig({ transcription: { liveModel: 'gemini-3.8-live' } });
  await g.reloadConfig();
  out.PASS = out.startedMode === 'live' && out.stillListening && out.switchedToLocal && out.bothSourcesSwitched && out.noHardError;
  return out;
})();
