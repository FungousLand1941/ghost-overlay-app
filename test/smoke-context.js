// Context assembly: transcript with ages + NEW marking + speaker labels,
// memory block, screenshot, note, and history compaction — inside the real renderer.
(() => {
  const g = window.__ghost;
  const now = Date.now();
  const out = {};
  g.setMemory({ text: '', coveredUntil: 0, updates: 0 });
  g.setTranscript([
    { t: now - 40000, text: 'so yeah the project uses a tree structure for the index', speaker: 'them' },
    { t: now - 12000, text: 'okay makes sense', speaker: 'you' },
    { t: now - 3000, text: 'wait what is a binary tree exactly', speaker: 'them' },
  ]);
  g.setLastAnsweredAt(now - 20000);

  // 1. Ask button: screenshot + transcript, no note
  const m1 = g.buildUserMessage({ text: '', image: { mime: 'image/jpeg', data: 'x' }, includeTranscript: true });
  out.hasTranscriptBlock = m1.text.includes('LIVE TRANSCRIPT');
  out.oldLineNotNew = /\[40s ago\] THEM: so yeah/.test(m1.text);
  out.youLabelled = /\[NEW 12s ago\] YOU: okay makes sense/.test(m1.text);
  out.recentLineIsNew = /\[NEW 3s ago\] THEM: wait what is a binary tree exactly/.test(m1.text);
  out.screenshotLabelled = m1.text.includes('SCREENSHOT: attached') && !!m1.image;
  out.priorityInstruction = m1.text.includes('Respond to what is most useful right now');
  out.displayCompact = /^\(🎙 transcript \(\d+ words\) \+ 📷 screen\)$/.test(m1.display);

  // 2. memory: summary included, covered entries excluded from the live window
  g.setMemory({ text: 'Setting: a technical chat. Facts: the index uses a tree.', coveredUntil: now - 30000, updates: 1 });
  const m1b = g.buildUserMessage({ text: '', image: null, includeTranscript: true });
  out.memoryIncluded = m1b.text.startsWith('CONVERSATION MEMORY') && m1b.text.includes('the index uses a tree');
  out.coveredLinesDropped = !m1b.text.includes('so yeah the project') && m1b.text.includes('wait what is a binary tree');
  out.memoryLabel = /\+ memory\)/.test(m1b.display);
  g.setMemory({ text: '', coveredUntil: 0, updates: 0 });

  // 3. typed note wins, transcript still attached
  const m2 = g.buildUserMessage({ text: 'explain like I am 5', image: null, includeTranscript: true });
  out.noteLabelled = m2.text.endsWith('USER NOTE: explain like I am 5');
  out.noteDisplay = m2.display.startsWith('explain like I am 5');

  // 4. no context at all -> null
  g.setTranscript([]);
  out.emptyIsNull = g.buildUserMessage({ text: '', image: null, includeTranscript: true }) === null;

  // 5. history compaction: older transcript blocks dropped, only last 2 images kept
  g.setTranscript([{ t: now - 2000, text: 'q' }]);
  const img = { mime: 'image/jpeg', data: 'zz' };
  const u = (t, i) => g.buildUserMessage({ text: t, image: i, includeTranscript: true });
  g.setMessages([u('one', img), { role: 'assistant', text: 'a1' }, u('two', img), { role: 'assistant', text: 'a2' }, u('three', img), { role: 'assistant', text: 'a3' }, u('four', null)]);
  const ctx = g.contextMessages();
  out.olderTurnsCompacted = ctx[0].text.startsWith('one (sent with') && !ctx[0].text.includes('LIVE TRANSCRIPT');
  out.latestTurnFull = ctx[6].text.includes('LIVE TRANSCRIPT') && ctx[6].text.endsWith('USER NOTE: four');
  out.oldestImageDropped = !ctx[0].image && ctx[0].text.includes('[earlier screenshot omitted]');
  out.recentImagesKept = !!ctx[2].image && !!ctx[4].image;
  g.setMessages([]); g.setTranscript([]);

  // 6. question detection for auto-answer
  const yes = ['What is a binary tree?', 'so can you walk me through your approach', 'Tell me about a time you failed', 'how would you scale this', 'okay, why did you pick Postgres'];
  const no = ['yeah that makes sense', 'we use a tree for the index', 'I think so too.', 'let me share my screen'];
  out.questionsDetected = yes.every((q) => g.isQuestion(q));
  out.statementsIgnored = no.every((q) => !g.isQuestion(q));

  out.ALL = Object.values(out).every((v) => v === true);
  return out;
})();
