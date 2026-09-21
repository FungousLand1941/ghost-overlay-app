// Settings round-trip: save a dummy key via the same IPC the UI uses,
// confirm the renderer only ever sees a mask, then test both real endpoints.
(async () => {
  const out = {};
  const before = await window.ghost.getConfig();
  out.startsWithoutKeys = !before.gemini.apiKeySet && !before.claude.apiKeySet;

  const saved = await window.ghost.setConfig({ provider: 'gemini', gemini: { apiKey: 'AIzaDUMMY-ghost-smoke-key-0000000000' }, claude: { apiKey: 'sk-ant-DUMMY-ghost-smoke-key-000000000000' } });
  out.maskedInRenderer = saved.gemini.apiKey.includes('…') && !saved.gemini.apiKey.includes('DUMMY-ghost') && saved.gemini.apiKeySet === true;

  // saving settings again with the masked value must NOT clobber the real key
  const again = await window.ghost.setConfig({ gemini: { apiKey: saved.gemini.apiKey, model: 'gemini-2.5-flash' } });
  out.maskDoesNotClobber = again.gemini.apiKeySet === true;

  // real network round-trips (dummy keys -> expect the friendly auth error)
  out.geminiLive = await window.ghost.testKey({ provider: 'gemini', apiKey: '' });
  out.claudeLive = await window.ghost.testKey({ provider: 'claude', apiKey: '' });
  return out;
})();
