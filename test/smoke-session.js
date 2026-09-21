// Session persistence round-trip inside the real renderer: save -> load -> restore into the UI.
(async () => {
  const g = window.__ghost;
  const out = {};
  const now = Date.now();
  g.setTranscript([{ t: now - 5000, text: 'persisted line', speaker: 'them' }]);
  g.setMemory({ text: 'memory survives restarts', coveredUntil: now - 10000, updates: 2 });
  g.setMessages([{ role: 'user', text: 'hi', display: 'hi', history: 'hi' }, { role: 'assistant', text: 'hello' }]);
  g.persist();
  await new Promise((r) => setTimeout(r, 1800)); // debounce
  const saved = await window.ghost.sessionLoad();
  out.savedTranscript = !!saved && saved.transcript[0].text === 'persisted line' && saved.transcript[0].speaker === 'them';
  out.savedMemory = !!saved && saved.memory.text === 'memory survives restarts';
  out.savedMessages = !!saved && saved.messages.length === 2 && saved.messages[1].text === 'hello';
  // wipe in-memory state and restore from disk
  g.setTranscript([]); g.setMemory({ text: '', coveredUntil: 0, updates: 0 }); g.setMessages([]);
  document.querySelectorAll('#messages .msg').forEach((n) => n.remove());
  const restored = await g.restoreSession();
  out.restored = restored === true && g.transcript().length === 1 && g.memory().text === 'memory survives restarts' && g.messages().length === 2;
  out.restoredRendered = document.querySelectorAll('#messages .msg').length === 2;
  await window.ghost.sessionClear();
  g.setTranscript([]); g.setMemory({ text: '', coveredUntil: 0, updates: 0 }); g.setMessages([]);
  document.querySelectorAll('#messages .msg').forEach((n) => n.remove());
  out.PASS = Object.values(out).every((v) => v === true);
  return out;
})();
