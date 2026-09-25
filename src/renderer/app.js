/* global renderMarkdown, AudioChunker */
(async function () {
  const $ = (id) => document.getElementById(id);
  const el = {
    dot: $('dot'), providerTag: $('provider-tag'), listenTag: $('listen-tag'),
    messages: $('messages'), empty: $('empty'), emptyWarn: $('empty-warn'),
    input: $('input'), attachShot: $('attach-shot'), send: $('btn-send'), stop: $('btn-stop'),
    transcript: $('transcript'), transcriptText: $('transcript-text'),
    toast: $('toast'), settings: $('settings'),
  };

  // ------------------------------------------------------------------ state
  let cfg = await window.ghost.getConfig();
  const MODELS = await window.ghost.models();
  const PROFILES = { general: 'General', interview: 'Technical interview', meeting: 'Meeting / call', sales: 'Sales / discovery', study: 'Study / exam prep' };

  let messages = [];         // [{role, text, display?, history?, image?}]
  let streaming = null;      // { id, el, text }
  let transcript = [];       // [{t, text, speaker?: 'you'|'them'}]
  let memory = { text: '', coveredUntil: 0, updates: 0 }; // rolling summary of transcript older than the live window
  let listener = null;       // AudioChunker
  const MAX_IMAGES_IN_CONTEXT = 2;

  // ------------------------------------------------------------------ ui helpers
  let toastTimer;
  function toast(text, isError = false) {
    el.toast.textContent = text;
    el.toast.classList.toggle('error', isError);
    el.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add('hidden'), isError ? 5000 : 2500);
  }
  function setDot(state, title) {
    el.dot.className = 'dot' + (state ? ' ' + state : '');
    el.dot.title = title || '';
  }
  function scrollBottom() { el.messages.scrollTop = el.messages.scrollHeight; }
  function shortcutLabel(k) { return (cfg.shortcuts?.[k] || '').replace('CmdOrCtrl', navigator.platform.startsWith('Mac') ? 'Cmd' : 'Ctrl'); }
  function keySet(p) { return p === 'gemini' ? cfg.gemini.apiKeySet : p === 'openai' ? (cfg.openai.apiKeySet || /localhost|127\.0\.0\.1/.test(cfg.openai.baseUrl || '')) : cfg.claude.apiKeySet; }
  function providerName(p) { return p === 'gemini' ? 'Gemini' : p === 'openai' ? (cfg.openai.preset || 'OpenAI-compatible') : 'Claude'; }
  // Mirrors providers.effectiveProvider(): the chosen provider if it has a key, else one that does.
  function effectiveProvider() { const c = cfg.provider || 'gemini'; return keySet(c) ? c : (['gemini', 'claude', 'openai'].find(keySet) || c); }
  function refreshHeader() {
    const p = effectiveProvider();
    el.providerTag.textContent = p === 'gemini' ? (cfg.gemini.model || 'gemini') : p === 'openai' ? `${cfg.openai.preset || 'openai'}: ${cfg.openai.model || ''}` : (cfg.claude.model || 'claude');
    $('k-ask').textContent = shortcutLabel('ask');
    $('k-answer').textContent = shortcutLabel('answerAudio');
    $('k-listen').textContent = shortcutLabel('listen');
    $('k-toggle').textContent = shortcutLabel('toggle');
    const hasKey = keySet(p);
    el.emptyWarn.classList.toggle('hidden', hasKey);
    el.emptyWarn.textContent = hasKey ? '' : 'No API key yet — open ⚙ and paste a Gemini, Claude, or OpenAI-compatible key.';
  }

  function addMessage(m) {
    el.empty.classList.add('hidden');
    const wrap = document.createElement('div');
    wrap.className = `msg ${m.role}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble' + (m.role === 'assistant' ? ' md' : '');
    if (m.role === 'user') {
      if (m.image) {
        const img = document.createElement('img');
        img.className = 'shot';
        img.src = `data:${m.image.mime};base64,${m.image.data}`;
        wrap.appendChild(img);
      }
      bubble.textContent = m.display || m.text;
    } else {
      bubble.innerHTML = renderMarkdown(m.text || '');
    }
    wrap.appendChild(bubble);
    el.messages.appendChild(wrap);
    scrollBottom();
    return bubble;
  }

  el.messages.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-copy]');
    if (btn) {
      navigator.clipboard.writeText(btn.nextElementSibling.textContent).then(() => { btn.textContent = 'copied'; setTimeout(() => (btn.textContent = 'copy'), 1200); });
    }
    const a = e.target.closest('a[href]');
    if (a) { e.preventDefault(); window.ghost.openExternal(a.href); }
  });

  // ------------------------------------------------------------------ persistence
  // Everything that makes up "context" is saved to disk (debounced) so a
  // restart mid-call loses nothing. Screenshots are dropped from the saved
  // chat history to keep the file small.
  let persistTimer = null;
  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      window.ghost.sessionSave({
        transcript: transcript.slice(-2000),
        memory,
        messages: messages.slice(-40).map((m) => ({ role: m.role, text: m.history || m.text, display: m.display })),
        lastAnsweredAt,
      });
    }, 1500);
  }
  async function restoreSession() {
    const s = await window.ghost.sessionLoad();
    if (!s || !s.savedAt) return false;
    const ageMin = (Date.now() - s.savedAt) / 60000;
    const hasContent = (s.transcript && s.transcript.length) || (s.messages && s.messages.length) || (s.memory && s.memory.text);
    if (!hasContent || ageMin > 6 * 60) return false;
    transcript = s.transcript || [];
    memory = s.memory || memory;
    lastAnsweredAt = s.lastAnsweredAt || 0;
    messages = (s.messages || []).map((m) => ({ ...m }));
    for (const m of messages) addMessage(m);
    if (transcript.length || memory.text) { el.transcript.classList.remove('hidden'); renderTranscript(); renderMemoryLine(); }
    const words = transcript.reduce((n, t) => n + t.text.split(/\s+/).length, 0);
    toast(`Resumed session from ${new Date(s.savedAt).toLocaleTimeString()} — ${words} transcript words${memory.text ? ', memory intact' : ''}. ↺ to start fresh.`);
    return true;
  }

  // ------------------------------------------------------------------ chat
  function contextMessages() {
    // Older turns are compacted: transcript blocks are dropped (the newest
    // turn carries fresh transcript + memory anyway) and only the last few
    // screenshots are kept, so context stays lean over a long call.
    const n = messages.length;
    let seen = 0;
    return messages
      .map((m, i) => (m.role === 'user' && i !== n - 1 && m.history ? { role: 'user', text: m.history, image: m.image } : m))
      .reverse()
      .map((m) => {
        if (m.image) { seen++; if (seen > MAX_IMAGES_IN_CONTEXT) return { role: m.role, text: m.text + '\n[earlier screenshot omitted]' }; }
        return m;
      })
      .reverse();
  }

  // ---- context assembly -------------------------------------------------
  // Raw transcript window sent verbatim; everything older is folded into
  // `memory` by the summariser, so the effective context is the whole call.
  const TRANSCRIPT_WINDOW_MS = 15 * 60 * 1000;
  const TRANSCRIPT_MAX_CHARS = 12000;
  let lastAnsweredAt = 0; // transcript entries after this are "NEW"

  function speakerTag(t) { return t.speaker === 'you' ? 'YOU: ' : t.speaker === 'them' ? 'THEM: ' : ''; }

  function transcriptBlock() {
    const now = Date.now();
    const entries = transcript.filter((t) => now - t.t < TRANSCRIPT_WINDOW_MS && t.t > memory.coveredUntil);
    let lines = entries.map((t) => {
      const age = Math.max(0, Math.round((now - t.t) / 1000));
      const tag = t.t > lastAnsweredAt ? 'NEW ' : '';
      return `[${tag}${age}s ago] ${speakerTag(t)}${t.text}`;
    });
    if (interimText && now - interimAt < 15000) lines.push(`[NEW, being said right now] ${interimSpeaker ? interimSpeaker.toUpperCase() + ': ' : ''}${interimText}`);
    while (lines.join('\n').length > TRANSCRIPT_MAX_CHARS && lines.length > 1) lines.shift();
    const words = entries.reduce((n, t) => n + t.text.split(/\s+/).length, 0) + (interimText ? interimText.split(/\s+/).length : 0);
    const parts = [];
    if (memory.text) parts.push(`CONVERSATION MEMORY (summary of everything said before the live transcript below):\n${memory.text}`);
    if (lines.length) parts.push(`LIVE TRANSCRIPT (oldest first, most recent last; ${listener ? 'still listening' : 'listening stopped'}):\n${lines.join('\n')}`);
    if (!parts.length) return null;
    return { text: parts.join('\n\n'), words, hasMemory: !!memory.text };
  }

  function buildUserMessage({ text, image, includeTranscript }) {
    const parts = [];
    const labels = [];
    const tb = includeTranscript ? transcriptBlock() : null;
    if (tb) { parts.push(tb.text); labels.push(`🎙 transcript (${tb.words} words${tb.hasMemory ? ' + memory' : ''})`); }
    if (image) { parts.push('SCREENSHOT: attached (my current screen).'); labels.push('📷 screen'); }
    if (text) { parts.push(`USER NOTE: ${text}`); }
    if (!parts.length) return null;
    if (!text) parts.push(tb ? 'Respond to what is most useful right now (see priority rules).' : 'Help me with what is on my screen.');
    const display = [text, labels.length ? `(${labels.join(' + ')})` : ''].filter(Boolean).join('\n');
    const history = text ? `${text} ${labels.length ? `(sent with ${labels.join(' + ')})` : ''}`.trim() : `(asked for help with ${labels.join(' + ') || 'context'})`;
    return { role: 'user', text: parts.join('\n\n'), display, history, ...(image ? { image } : {}) };
  }

  // ---- rolling memory ----------------------------------------------------
  // When transcript older than the live window (or beyond the char budget)
  // accumulates, fold it into the summary with the cheap model. Runs in the
  // background; never blocks an ask.
  let summarizing = false;
  async function maybeSummarize(force = false) {
    if (cfg.memory && cfg.memory.enabled === false) return;
    if (summarizing) return;
    const now = Date.now();
    const cutoff = now - TRANSCRIPT_WINDOW_MS;
    // candidates: not yet covered, and either older than the window or overflowing the budget
    let pending = transcript.filter((t) => t.t > memory.coveredUntil);
    const inWindowChars = pending.filter((t) => t.t > cutoff).reduce((n, t) => n + t.text.length + 20, 0);
    let fold = pending.filter((t) => t.t <= cutoff);
    if (inWindowChars > TRANSCRIPT_MAX_CHARS) {
      // overflow: fold the oldest half of the window too
      const inWin = pending.filter((t) => t.t > cutoff);
      fold = fold.concat(inWin.slice(0, Math.ceil(inWin.length / 2)));
    }
    const foldChars = fold.reduce((n, t) => n + t.text.length, 0);
    // Only worth a request once a meaningful amount has aged out of the window.
    if (!fold.length || (!force && foldChars < 1500)) return;
    summarizing = true;
    try {
      const newText = fold.map((t) => `${speakerTag(t)}${t.text}`).join('\n');
      const r = await window.ghost.summarize({ previous: memory.text, newText });
      if (r.skipped) return; // governor said no (budget / cooldown / paused) — try again later
      if (r.error) { setStatus(`memory update failed: ${r.error}`, true); return; }
      memory = { text: r.text, coveredUntil: fold[fold.length - 1].t, updates: (memory.updates || 0) + 1 };
      renderMemoryLine();
      persist();
    } finally { summarizing = false; }
  }
  function renderMemoryLine() {
    const line = $('memory-line');
    if (!memory.text) { line.classList.add('hidden'); return; }
    const firstT = transcript.length ? transcript[0].t : memory.coveredUntil;
    const mins = Math.max(1, Math.round((memory.coveredUntil - firstT) / 60000));
    line.textContent = `🧠 memory: ${memory.text.split(/\s+/).length} words covering ~${mins} min (${memory.updates} update${memory.updates === 1 ? '' : 's'}) — click to view`;
    line.title = memory.text;
    line.classList.remove('hidden');
  }
  $('memory-line').addEventListener('click', () => {
    if (!memory.text) return;
    addMessage({ role: 'assistant', text: `**Conversation memory**\n\n${memory.text}` });
  });
  setInterval(() => { if (transcript.length && listener) maybeSummarize(); }, 5 * 60 * 1000); // only while listening, every 5 min

  // If we're listening, push whatever audio is buffered right now through
  // transcription and wait for it, so "the thing that was just said" is in
  // the context. Bounded so a slow API can't stall the ask.
  async function catchUpTranscript(timeoutMs = 7000) {
    if (!listener) return;
    if (listenMode === 'live') {
      window.ghost.liveNudge();
      const t0 = Date.now();
      while (Date.now() - t0 < 700 && interimText && Date.now() - interimAt < 400) await new Promise((r) => setTimeout(r, 50));
      // give the accuracy pass a moment to correct the most recent lines (never more than ~2 s)
      const t1 = Date.now();
      while (Date.now() - t1 < 2000 && (transcript.some((t) => t.provisional) || (await window.ghost.livePendingRevisions()) > 0)) await new Promise((r) => setTimeout(r, 100));
      return;
    }
    setStatus('catching up on the last few seconds…');
    listener.flush();
    const t0 = Date.now();
    while (pendingTranscriptions.size && Date.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 100));
  }

  async function ask({ text, withScreenshot, includeTranscript = true, profile, auto = false }) {
    if (aiPaused) { toast('AI is paused — press ▶ to resume', true); return; }
    if (streaming) await stopStream();
    const t0 = performance.now();
    // Screenshot capture runs concurrently with the transcript catch-up.
    const shotP = withScreenshot ? (setDot('busy', 'Capturing…'), window.ghost.captureScreen().then((i) => ({ image: i }), (e) => ({ error: e }))) : null;
    if (includeTranscript) await catchUpTranscript();
    let image = null;
    if (shotP) {
      const r = await shotP;
      if (r.error) { toast(`Screenshot failed: ${r.error.message}`, true); setDot('error'); return; }
      image = r.image;
    }
    const userMsg = buildUserMessage({ text, image, includeTranscript });
    if (!userMsg) { toast('Nothing to ask yet — type something, attach a screenshot, or start listening.'); return; }
    if (auto) { userMsg.display = `(auto — question detected)\n${userMsg.display}`; userMsg.auto = true; }
    messages.push(userMsg);
    addMessage(userMsg);
    if (includeTranscript && transcript.length) lastAnsweredAt = Date.now();

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const bubble = addMessage({ role: 'assistant', text: '' });
    bubble.classList.add('cursor');
    streaming = { id, el: bubble, text: '', t0, ttft: 0, auto, withScreenshot: !!image };
    setDot('busy', 'Thinking…');
    el.send.classList.add('hidden'); el.stop.classList.remove('hidden');
    window.ghost.chatStart({ id, messages: contextMessages(), profile: profile || cfg.profile, mode: cfg.mode || 'instant' });
  }

  let renderPending = false;
  window.ghost.onChatEvent((ev) => {
    if (!streaming || ev.id !== streaming.id) return;
    if (ev.type === 'token') {
      if (!streaming.ttft) streaming.ttft = performance.now() - streaming.t0;
      streaming.text += ev.data;
      if (!renderPending) {
        renderPending = true;
        requestAnimationFrame(() => {
          renderPending = false;
          if (!streaming) return;
          const nearBottom = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 80;
          streaming.el.innerHTML = renderMarkdown(streaming.text);
          if (nearBottom) scrollBottom();
        });
      }
    } else if (ev.type === 'done' || ev.type === 'error') {
      const { el: bubble, text } = streaming;
      bubble.classList.remove('cursor');
      if (ev.type === 'error') {
        bubble.classList.add('error');
        bubble.textContent = ev.data;
        setDot('error', ev.data);
        toast(ev.data, true);
        messages.pop(); // don't keep the failed user turn in context twice
      } else {
        bubble.innerHTML = renderMarkdown(text + (ev.aborted ? '\n\n_[stopped]_' : ''));
        messages.push({ role: 'assistant', text });
        setDot(listener ? 'listening' : '', '');
        // latency readout: first word / total, so speed settings are visible
        const total = (performance.now() - streaming.t0) / 1000;
        const meta = document.createElement('div');
        meta.className = 'meta';
        const words = text.split(/\s+/).filter(Boolean).length;
        meta.innerHTML = `<span>${(cfg.mode || 'instant') === 'think' ? '🧠 think' : '⚡ instant'} · first word ${(streaming.ttft / 1000).toFixed(1)} s · total ${total.toFixed(1)} s · ${words} words${streaming.withScreenshot ? ' · with screenshot' : ''}${ev.model ? ` · ${ev.model}` : ''}</span>${streaming.auto ? '<span class="auto">auto-answered</span>' : ''}`;
        bubble.parentElement.appendChild(meta);
        persist();
      }
      streaming = null;
      el.send.classList.remove('hidden'); el.stop.classList.add('hidden');
    }
  });

  async function stopStream() { await window.ghost.chatStop(); }

  function resetConversation() {
    if (streaming) stopStream();
    messages = [];
    el.messages.querySelectorAll('.msg').forEach((n) => n.remove());
    el.empty.classList.remove('hidden');
    persist();
    toast('New conversation (transcript & memory kept — use "clear" in the transcript panel to drop them)');
  }

  function sendFromInput() {
    const text = el.input.value.trim();
    const withScreenshot = el.attachShot.checked;
    if (!text && !withScreenshot) return;
    el.input.value = ''; el.input.style.height = 'auto';
    el.attachShot.checked = false;
    ask({ text, withScreenshot });
  }

  el.send.addEventListener('click', sendFromInput);
  el.stop.addEventListener('click', stopStream);
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFromInput(); }
    if (e.key === 'Escape') window.ghost.hide();
  });
  el.input.addEventListener('input', () => { el.input.style.height = 'auto'; el.input.style.height = Math.min(120, el.input.scrollHeight) + 'px'; });

  function askEverything() { const t = el.input.value.trim(); el.input.value = ''; el.input.style.height = 'auto'; return ask({ text: t, withScreenshot: true, includeTranscript: true }); }
  $('btn-ask').addEventListener('click', askEverything);
  $('btn-answer').addEventListener('click', () => answerFromTranscript());

  // ---- response mode toggle (⚡ instant / 🧠 think) ----
  function renderMode() {
    const m = cfg.mode || 'instant';
    $('mode-instant').classList.toggle('on', m === 'instant');
    $('mode-think').classList.toggle('on', m === 'think');
  }
  async function setMode(m) {
    cfg = await window.ghost.setConfig({ mode: m });
    renderMode();
    toast(m === 'instant' ? '⚡ Instant: fast model, no thinking, short answers' : '🧠 Think: full model with thinking, full answers');
  }
  $('mode-instant').addEventListener('click', () => setMode('instant'));
  $('mode-think').addEventListener('click', () => setMode('think'));

  // ---- Pause AI (the "turn it off" button) + request counter ----
  let aiPaused = false;
  function renderStats(s) {
    if (!s) return;
    aiPaused = !!s.paused;
    const tag = $('req-tag');
    const c = s.counts || {};
    const bg = (c.memory || 0) + (c.digest || 0) + (c.transcribe || 0);
    tag.textContent = aiPaused ? `PAUSED · ${s.total} req` : `${s.total} req`;
    tag.title = `This session: ${c.ask || 0} answers · ${c.transcribe || 0} chunked transcriptions · ${c.memory || 0} memory summaries · ${c.digest || 0} digests · ${c.live || 0} live sessions` +
      `\nLast minute: ${s.lastMinute} (background budget ${s.maxPerMinute}/min)` +
      (s.cooldownSec ? `\nRate-limit cooldown: ${s.cooldownSec} s` : '') + (s.quotaMin ? `\nQuota exhausted — background calls off for ${s.quotaMin} min` : '') +
      (Object.keys(s.rejected || {}).length ? `\nBlocked: ${Object.entries(s.rejected).map(([k, v]) => `${k} ${v}`).join(', ')}` : '');
    tag.className = 'tag' + (s.quotaMin ? ' bad' : s.cooldownSec ? ' warn' : '');
    $('btn-pause').classList.toggle('on', aiPaused);
    $('btn-pause').textContent = aiPaused ? '▶' : '⏸';
    $('btn-pause').title = aiPaused ? 'Resume AI' : 'Pause AI: stop listening, cancel any reply, block every API call until resumed';
    document.body.classList.toggle('ai-paused', aiPaused);
  }
  async function togglePause() {
    const next = !aiPaused;
    if (next && listener) stopListening();
    renderStats(await window.ghost.aiPause(next));
    toast(next ? '⏸ AI paused — nothing will be sent to Gemini/Claude until you press ▶' : '▶ AI resumed');
  }
  $('btn-pause').addEventListener('click', togglePause);
  $('req-tag').addEventListener('click', () => toast($('req-tag').title.split('\n')[0]));
  window.ghost.onAiEvent((ev) => { if (ev.type === 'stats') renderStats(ev.stats); });
  window.ghost.aiStats().then(renderStats);
  $('btn-stop-listen').addEventListener('click', () => { if (listener) stopListening(); });
  $('btn-reset').addEventListener('click', resetConversation);
  $('btn-hide').addEventListener('click', () => { toast('Hidden — press ' + shortcutLabel('toggle') + ' or use the tray icon to bring Ghost back'); setTimeout(() => window.ghost.hide(), 700); });
  // Quit: flush state to disk first so nothing from the last second is lost.
  async function quitNow() { clearTimeout(persistTimer); await window.ghost.sessionSave({ transcript: transcript.slice(-2000), memory, messages: messages.slice(-40).map((m) => ({ role: m.role, text: m.history || m.text, display: m.display })), lastAnsweredAt }); window.ghost.quit(); }
  $('btn-quit-top').addEventListener('click', quitNow);
  window.ghost.onSaveNow(() => quitNow());

  // ------------------------------------------------------------------ listening
  const elStatus = $('transcript-status');
  const elInterim = $('transcript-interim');
  let meterTimer = null;
  let backoffUntil = 0;
  const pendingTranscriptions = new Set();
  let listenMode = null;     // 'live' | 'chunk' while listening
  let listenEngine = null;   // 'local' | 'gemini' | 'chunk' — what is actually transcribing
  let interimText = '';      // words currently being spoken (streaming mode)
  let interimSpeaker = '';
  let interimAt = 0;

  function renderTranscript() {
    const box = el.transcriptText;
    box.textContent = '';
    for (const t of transcript.slice(-400)) {
      if (t.speaker) {
        const s = document.createElement('span'); s.className = `spk ${t.speaker}`; s.textContent = t.speaker === 'you' ? 'You: ' : 'Them: ';
        box.appendChild(s);
      }
      const tn = document.createElement('span'); tn.textContent = t.text + '\n'; if (t.provisional) tn.className = 'prov';
      box.appendChild(tn);
    }
    box.scrollTop = box.scrollHeight;
  }
  // Does this utterance look like a question/request aimed at the user?
  const QUESTION_RE = /\?\s*$|^(?:so|okay|ok|and|but|alright|now|hey|um|uh)?[,\s]*(?:what|why|how|when|where|which|who|can you|could you|would you|will you|do you|did you|have you|are you|is there|tell me|walk me|talk me|explain|describe|give me|show me|let's talk about|let's discuss|any idea|thoughts on)\b/i;
  function isQuestion(text) { return QUESTION_RE.test(text.trim()); }

  // Pre-emptive answering: the moment the other side asks something, start
  // the (screenshot-free) answer so it's on screen before you'd have clicked.
  let autoTimer = null, lastAutoAt = 0;
  function maybeAutoAnswer(text, speaker) {
    if (cfg.autoAnswer !== true || speaker === 'you' || !isQuestion(text)) return; // strictly opt-in
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      if (streaming || Date.now() - lastAutoAt < 6000) return;
      lastAutoAt = Date.now();
      ask({ text: '', withScreenshot: false, includeTranscript: true, auto: true });
    }, 350);
  }

  function addTranscript(text, speaker, meta = {}) {
    const entry = { t: Date.now(), text, ...(speaker ? { speaker } : {}), ...(meta.uid ? { uid: meta.uid } : {}), ...(meta.provisional ? { provisional: true } : {}) };
    transcript.push(entry);
    if (!meta.uid) entry.id = `c${Date.now()}${Math.random().toString(36).slice(2, 5)}`; // stable id for cleanup mapping (chunk mode has no uid)
    renderTranscript();
    persist();
    maybeSummarize();
    if (!meta.provisional) maybeCleanup();
    maybeAutoAnswer(text, speaker);
  }

  // ---- AI cleanup: fix garbled local speech-to-text with the answering provider.
  // Auto: only runs when transcription is LOCAL (Gemini Live is already accurate).
  // Uses Haiku on Claude, flash-lite on Gemini, the preset instant model on NavyAI…
  let cleanupTimer = null, cleaning = false;
  function cleanupOn() {
    const m = cfg.aiCleanup || 'auto';
    if (m === 'off') return false;
    if (m === 'on') return true;
    return listenEngine === 'local'; // auto
  }
  function maybeCleanup() {
    if (!cleanupOn()) return;
    clearTimeout(cleanupTimer);
    cleanupTimer = setTimeout(runCleanup, 1200);
  }
  async function runCleanup() {
    if (cleaning || !cleanupOn()) return;
    const targets = transcript.filter((t) => !t.provisional && !t.cleaned && (t.uid || t.id)).slice(-12);
    if (!targets.length) return;
    cleaning = true;
    try {
      const key = (t) => t.uid || t.id;
      const lines = targets.map((t, i) => ({ n: i + 1, speaker: t.speaker, text: t.raw || t.text }));
      const background = [memory.text, (cfg.contextDocs || '').slice(0, 2000)].filter(Boolean).join('\n');
      const r = await window.ghost.cleanupTranscript({ lines, background });
      if (r.skipped || r.error) return;
      let changed = false;
      targets.forEach((t, i) => {
        t.cleaned = true;
        const fixed = r.map[String(i + 1)];
        if (typeof fixed === 'string' && fixed.trim() && fixed.trim() !== t.text) { if (!t.raw) t.raw = t.text; t.text = fixed.trim(); changed = true; }
      });
      if (changed) { renderTranscript(); persist(); }
    } catch (e) { /* non-fatal */ }
    finally { cleaning = false; }
  }
  function setInterim(text, speaker) {
    interimText = text || '';
    interimSpeaker = speaker || '';
    interimAt = Date.now();
    elInterim.textContent = interimText ? `… ${speaker ? (speaker === 'you' ? 'You: ' : 'Them: ') : ''}${interimText}` : '';
  }
  function setStatus(text, isErr = false) {
    elStatus.textContent = text;
    elStatus.classList.toggle('err', isErr);
  }
  let silenceWarned = false;
  function renderMeters() {
    // Loopback is captured after Windows' volume/mute stage: muted speakers =
    // pure digital silence. Say so instead of silently hearing nothing.
    if (listener && !silenceWarned && 'system' in listener.analysers && listener.sysFrames > 24 && listener.sysLiveFrames === 0) {
      silenceWarned = true;
      setStatus('system audio is pure silence — are your speakers muted / volume 0? Unmute (headphones are fine), or pick a capture device in ⚙', true);
    }
    const lv = listener ? listener.levels() : {};
    for (const name of ['system', 'mic']) {
      const bar = $(`lvl-${name}`);
      if (!(name in lv)) { bar.className = 'off'; bar.style.width = '0'; continue; }
      const pct = Math.min(100, Math.round(Math.sqrt(lv[name]) * 160)); // sqrt: make quiet speech visible
      bar.className = pct > 90 ? 'hot' : '';
      bar.style.width = pct + '%';
    }
  }

  // Events from the streaming transcribers in the main process (one per source).
  const liveErrors = new Set();
  window.ghost.onLiveEvent((ev) => {
    if (listenMode !== 'live') return;
    if (ev.type === 'interim') setInterim(ev.text, ev.speaker);
    else if (ev.type === 'final') {
      addTranscript(ev.text, ev.speaker, { uid: ev.uid, provisional: ev.provisional });
      setInterim('');
      setStatus(`${ev.speaker || 'heard'}: ${ev.text.split(/\s+/).length} words${ev.provisional ? ' (refining…)' : ''} · ${new Date().toLocaleTimeString()}`);
    } else if (ev.type === 'revise') {
      // accuracy pass finished for an utterance: replace the provisional line in place
      const e = transcript.find((t) => t.uid === ev.uid);
      if (e) { if (ev.text) e.text = ev.text; e.provisional = false; renderTranscript(); persist(); }
    } else if (ev.type === 'status') { if (/switched to local|using local offline/i.test(ev.text)) listenEngine = 'local'; setStatus(ev.text); }
    else if (ev.type === 'error') {
      liveErrors.add(ev.source);
      const active = (listener && Object.keys(listener.analysers)) || [];
      const allDead = active.every((s) => liveErrors.has(s));
      if (/quota/i.test(ev.text)) {
        // Quota is gone for the day/hour: nothing we do will help, so stop cleanly.
        stopListening();
        setStatus(`Gemini Live quota exhausted (free tier) — listening stopped, no more requests will be spent. Try later, or add billing in AI Studio.`, true);
        toast('Live transcription quota exhausted — stopped to save your requests', true);
      } else if (!allDead) {
        setStatus(`${ev.speaker} stream failed (${ev.text}); still listening to the other source`, true);
      } else if ((cfg.transcription.fallbackToChunk || 'pause') === 'chunk') {
        setStatus(`${ev.text} — switching to chunked mode`, true); switchToChunkMode();
      } else {
        stopListening();
        setStatus(`streaming stopped: ${ev.text}. Press 🎙 to retry (chunked fallback is off in ⚙ so nothing is spent automatically).`, true);
      }
    }
  });

  // Chunk-mode transcription (fallback path).
  async function transcribeChunk(wavBase64, info, state) {
    if (Date.now() < backoffUntil) { setStatus(`rate limited — resuming in ${Math.ceil((backoffUntil - Date.now()) / 1000)} s`, true); return; }
    if (state.inFlight >= 2) { setStatus('transcription backlog — skipping a chunk'); return; }
    state.inFlight++;
    const token = {}; pendingTranscriptions.add(token);
    setStatus(`transcribing ${info.seconds.toFixed(0)} s…`);
    try {
      const context = transcript.slice(-4).map((t) => t.text).join(' ');
      const r = await window.ghost.transcribe({ wavBase64, context });
      if (r.error) {
        if (r.code === 'RATE_LIMIT' || r.code === 'GOVERNOR') {
          state.limited = (state.limited || 0) + 1;
          backoffUntil = Date.now() + 60000;
          if (state.limited >= 3) { stopListening(); setStatus(`chunked transcription stopped after repeated rate limits (${r.error}) — nothing more will be spent. Press 🎙 to retry later.`, true); return; }
        }
        setStatus(r.error, true);
      } else if (r.text) {
        state.limited = 0;
        addTranscript(r.text);
        setStatus(`heard ${r.text.split(/\s+/).length} words · ${new Date().toLocaleTimeString()} (chunked mode)`);
      } else setStatus('chunk had no speech');
    } catch (e) {
      setStatus(`transcribe: ${e.message}`, true);
    } finally { state.inFlight--; pendingTranscriptions.delete(token); }
  }

  async function startCapture(mode) {
    const source = cfg.transcription.sourceOverride || cfg.transcription.source || 'both';
    const chunkSeconds = Math.max(3, Math.min(20, +cfg.transcription.chunkSeconds || 5));
    const state = { inFlight: 0 };
    const l = new AudioChunker({
      source,
      callDevice: cfg.transcription.callDevice || 'loopback',
      chunkSeconds,
      onStatus: (t) => setStatus(t),
      onFrame: mode === 'live' ? (src, b64) => window.ghost.liveAudio(src, b64) : null,
      onChunk: mode === 'chunk' ? (wav, info) => transcribeChunk(wav, info, state) : null,
      onError: (e) => { setStatus(e.message, true); stopListening(); },
    });
    const started = await l.start();
    listener = l;
    listenMode = mode;
    return started;
  }

  async function switchToChunkMode() {
    if (listenMode !== 'live') return;
    await window.ghost.liveStop();
    listener?.stop(); listener = null;
    try { await startCapture('chunk'); listenEngine = 'chunk'; } catch (e) { setStatus(`could not restart audio: ${e.message}`, true); stopListening(); }
  }

  async function toggleListen() {
    if (listener) { stopListening(); return; }
    if (aiPaused) { toast('AI is paused — press ▶ to resume before listening', true); return; }
    // No Gemini key? Fine — the main process falls back to the free local engine
    // automatically (transcription never depends on which provider answers).
    if ((cfg.transcription.engine || 'gemini') === 'gemini' && !cfg.gemini.apiKeySet) toast('No Gemini key — transcribing with the free local engine (works with Claude / NavyAI answers)');
    el.transcript.classList.remove('hidden');
    liveErrors.clear();
    silenceWarned = false;

    let mode = cfg.transcription.mode || 'live';
    let liveInfo = null;
    if (mode === 'live') {
      setStatus('connecting to Gemini Live…');
      const source = cfg.transcription.sourceOverride || cfg.transcription.source || 'both';
      const sources = source === 'both' ? ['system', 'mic'] : [source];
      const r = await window.ghost.liveStart({ sources });
      if (r.ok) liveInfo = r;
      else { mode = 'chunk'; setStatus(`streaming unavailable (${r.error}) — using chunked mode`, true); }
    }

    let started;
    try {
      started = await startCapture(mode);
    } catch (e) {
      if (mode === 'live') await window.ghost.liveStop();
      toast(`Could not start audio: ${e.message}`, true);
      setStatus(`could not start: ${e.message}`, true);
      return;
    }
    listenEngine = mode === 'chunk' ? 'chunk' : (String(liveInfo.model || '').startsWith('local:') ? 'local' : 'gemini');
    el.listenTag.classList.remove('hidden');
    $('btn-listen').classList.add('active');
    setDot('listening', 'Listening');
    meterTimer = setInterval(renderMeters, 100);
    const what = started.active.map((n) => (n === 'system' ? 'the call' : 'your mic')).join(' + ');
    const how = mode === 'live'
      ? (String(liveInfo.model).startsWith('local:') ? 'local offline transcription (free, no quota)' : `streaming via ${liveInfo.model}`) + (liveInfo.failed && liveInfo.failed.length ? ` (${liveInfo.failed.join('; ')})` : '')
      : `chunked every ${cfg.transcription.chunkSeconds || 10} s`;
    if (mode === 'live' || !elStatus.classList.contains('err')) setStatus(started.errors.length ? `listening to ${what}, ${how} (${started.errors.join('; ')})` : `listening to ${what}, ${how}`);
    toast(`Listening to ${what} — ${shortcutLabel('answerAudio')} to answer`);
  }

  function stopListening() {
    listener?.stop();
    listener = null;
    if (listenMode === 'live') window.ghost.liveStop();
    listenMode = null;
    clearInterval(meterTimer); meterTimer = null;
    renderMeters();
    setInterim('');
    el.listenTag.classList.add('hidden');
    $('btn-listen').classList.remove('active');
    setDot('', '');
    setStatus('stopped');
    persist();
  }

  function answerFromTranscript() {
    if (!transcript.length && !interimText && !memory.text) { toast('Nothing in the transcript yet.'); return; }
    ask({ text: '', withScreenshot: false, includeTranscript: true });
  }

  $('btn-listen').addEventListener('click', toggleListen);
  $('btn-clear-transcript').addEventListener('click', () => {
    transcript = []; memory = { text: '', coveredUntil: 0, updates: 0 }; lastAnsweredAt = 0;
    renderTranscript(); renderMemoryLine(); persist();
    toast('Transcript and memory cleared');
  });

  // ------------------------------------------------------------------ hotkeys from main
  window.ghost.onHotkey(({ action }) => {
    if (action === 'ask') askEverything();
    else if (action === 'answer-audio') answerFromTranscript(); // transcript only — fastest
    else if (action === 'toggle-listen') toggleListen();
    else if (action === 'reset') resetConversation();
  });
  window.ghost.onState((s) => {
    if ('clickThrough' in s) { document.body.classList.toggle('clickthrough', s.clickThrough); toast(s.clickThrough ? 'Click-through ON (mouse passes through)' : 'Click-through OFF'); }
    if ('opacity' in s) { $('s-opacity').value = s.opacity; $('s-opacity-val').textContent = Math.round(s.opacity * 100) + '%'; }
  });
  window.ghost.onToast(({ text, error }) => toast(text, !!error));

  // ------------------------------------------------------------------ settings
  const fillSelect = (sel, items, current) => {
    sel.innerHTML = '';
    const list = items.includes(current) || !current ? items : [current, ...items];
    for (const v of list) { const o = document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o); }
    sel.value = current || list[0];
  };

  function openSettings() {
    $('s-provider').value = cfg.provider;
    $('s-claude-key').value = '';
    $('s-claude-key').placeholder = cfg.claude.apiKeySet ? cfg.claude.apiKey : 'sk-ant-…';
    $('s-claude-status').textContent = cfg.claude.apiKeySet ? '(set — paste to replace)' : '(not set)';
    fillSelect($('s-claude-model'), MODELS.claude, cfg.claude.model);
    $('s-claude-workspace').value = cfg.claude.workspaceId || '';
    $('s-claude-effort').value = cfg.claude.effort || 'medium';
    $('s-claude-fallbacks').checked = cfg.claude.fallbacks !== false;
    $('s-gemini-key').value = '';
    $('s-gemini-key').placeholder = cfg.gemini.apiKeySet ? cfg.gemini.apiKey : 'AIza…';
    $('s-gemini-status').textContent = cfg.gemini.apiKeySet ? '(set — paste to replace)' : '(not set)';
    fillSelect($('s-gemini-model'), MODELS.gemini, cfg.gemini.model);
    $('s-fallback-provider').value = cfg.fallbackProvider || 'auto';
    $('s-openai-preset').value = cfg.openai.preset || 'groq';
    $('s-openai-key').value = '';
    $('s-openai-key').placeholder = cfg.openai.apiKeySet ? cfg.openai.apiKey : (cfg.openai.preset === 'ollama' ? '(none needed)' : 'gsk_… / csk-… / sk-or-…');
    $('s-openai-status').textContent = cfg.openai.apiKeySet ? '(set — paste to replace)' : '(not set)';
    $('s-openai-url').value = cfg.openai.baseUrl || '';
    $('s-openai-model').value = cfg.openai.model || '';
    $('s-openai-instant').value = (cfg.instantModel && cfg.instantModel.openai) || '';
    $('s-openai-vision').checked = !!cfg.openai.vision;
    updateOpenaiHint();
    $('s-audio-source').value = cfg.transcription.source || 'both';
    $('s-engine').value = cfg.transcription.engine || 'gemini';
    $('s-local-model').value = cfg.transcription.localModel || 'nemo-fastconformer-en-80ms';
    $('s-refine').checked = cfg.transcription.refine !== false;
    $('s-aicleanup').value = cfg.aiCleanup || 'auto';
    window.ghost.sttModel().then((m) => { $('s-model-status').textContent = m.ready ? `Local model ready (${(m.bytes / 1e6).toFixed(0)} MB, English streaming Zipformer, on disk)` : 'Local model not downloaded yet — it downloads automatically (~72 MB, once) the first time you press 🎙.'; });
    fillCallDevices();
    $('s-transcription-mode').value = cfg.transcription.mode || 'live';
    fillSelect($('s-live-model'), MODELS.live, cfg.transcription.liveModel);
    fillSelect($('s-transcription-model'), MODELS.transcription, cfg.transcription.model);
    $('s-chunk').value = cfg.transcription.chunkSeconds || 10;
    $('s-fallback').value = cfg.transcription.fallbackToChunk || 'pause';
    $('s-budget').value = (cfg.governor && cfg.governor.maxPerMinute) || 10;
    const prof = $('s-profile'); prof.innerHTML = '';
    for (const [k, v] of Object.entries(PROFILES)) { const o = document.createElement('option'); o.value = k; o.textContent = v; prof.appendChild(o); }
    prof.value = cfg.profile || 'general';
    $('s-custom').value = cfg.customPrompt || '';
    $('s-docs').value = cfg.contextDocs || '';
    updateDocsCount();
    $('s-docs-full-instant').checked = !!cfg.instantUsesFullDocs;
    window.ghost.docsList().then(renderDocs);
    $('s-memory').checked = !(cfg.memory && cfg.memory.enabled === false);
    fillSelect($('s-instant-gemini'), MODELS.gemini, (cfg.instantModel && cfg.instantModel.gemini) || 'gemini-2.5-flash-lite');
    fillSelect($('s-instant-claude'), MODELS.claude, (cfg.instantModel && cfg.instantModel.claude) || 'claude-haiku-4-5');
    $('s-instant-tokens').value = cfg.instantMaxTokens || 350;
    $('s-think-speed').value = cfg.thinkSpeed || 'balanced';
    $('s-auto-answer').checked = cfg.autoAnswer !== false;
    $('s-shot-edge').value = cfg.screenshotMaxEdge || 1280;
    $('s-max-tokens').value = cfg.maxTokens || 4096;
    $('s-opacity').value = cfg.opacity ?? 1;
    $('s-opacity-val').textContent = Math.round((cfg.opacity ?? 1) * 100) + '%';
    const sc = $('s-shortcuts'); sc.innerHTML = '';
    for (const [k, v] of Object.entries(cfg.shortcuts)) {
      const f = document.createElement('div'); f.className = 'field';
      f.innerHTML = `<label>${k}</label><input type="text" data-sc="${k}" value="${v.replace(/"/g, '&quot;')}" />`;
      sc.appendChild(f);
    }
    el.settings.classList.remove('hidden');
  }
  // Call-audio capture device: default-output loopback, or any recording endpoint
  // (Stereo Mix, Voicemeeter "Out B1/B2", BlackHole…) which is NOT affected by mute.
  async function fillCallDevices() {
    const sel = $('s-call-device');
    const current = cfg.transcription.callDevice || 'loopback';
    sel.innerHTML = '';
    const add = (v, label) => { const o = document.createElement('option'); o.value = v; o.textContent = label; sel.appendChild(o); };
    add('loopback', 'Default output loopback (what you hear — needs speakers unmuted)');
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
      for (const d of devs) add(d.deviceId, d.label || `input ${d.deviceId.slice(0, 6)}`);
    } catch {}
    sel.value = [...sel.options].some((o) => o.value === current) ? current : 'loopback';
  }

  // Live device finder: open a stream on every capturable device at once and show
  // a moving bar per device, so the user can SEE which one carries the call audio
  // (essential on machines with Voicemeeter / multiple outputs where loopback grabs
  // the wrong endpoint). Click a device to select it.
  let finderActive = null;
  async function toggleDeviceFinder() {
    const box = $('device-finder');
    if (finderActive) { stopDeviceFinder(); box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.innerHTML = '<div class="muted small">Play some audio (a call, YouTube…). The bar that moves is the device to pick. Click it.</div>';
    const ctx = new AudioContext();
    const rows = [];
    finderActive = { ctx, streams: [], raf: 0 };
    // the default-output loopback (getDisplayMedia)
    const sources = [];
    try {
      const lb = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      lb.getVideoTracks().forEach((t) => t.stop());
      if (lb.getAudioTracks().length) sources.push({ id: 'loopback', label: 'Default output loopback (what you hear)', stream: lb });
      else lb.getTracks().forEach((t) => t.stop());
    } catch {}
    // every input device
    let devs = [];
    try { devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications'); } catch {}
    for (const d of devs) {
      try { const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: d.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); sources.push({ id: d.deviceId, label: d.label || `input ${d.deviceId.slice(0, 6)}`, stream: s }); } catch {}
    }
    if (!sources.length) { box.innerHTML = '<div class="test-result err">Could not open any audio device (permission?).</div>'; stopDeviceFinder(); return; }
    box.innerHTML = '<div class="muted small">Play some audio — click the device whose bar moves:</div>';
    for (const src of sources) {
      finderActive.streams.push(src.stream);
      const an = ctx.createAnalyser(); an.fftSize = 1024;
      ctx.createMediaStreamSource(src.stream).connect(an);
      const row = document.createElement('div'); row.className = 'df-row';
      row.innerHTML = `<span class="df-bar"><span></span></span><span class="df-name">${src.label}</span>`;
      row.addEventListener('click', () => { $('s-call-device').value = [...$('s-call-device').options].some((o) => o.value === src.id) ? src.id : 'loopback'; if (src.id !== 'loopback' && ![...$('s-call-device').options].some((o) => o.value === src.id)) { const o = document.createElement('option'); o.value = src.id; o.textContent = src.label; $('s-call-device').appendChild(o); $('s-call-device').value = src.id; } toast(`Selected: ${src.label} — Save to use it`); stopDeviceFinder(); box.classList.add('hidden'); });
      box.appendChild(row);
      rows.push({ an, bar: row.querySelector('.df-bar > span') });
    }
    const buf = new Float32Array(1024);
    const tick = () => {
      for (const r of rows) { r.an.getFloatTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; const pct = Math.min(100, Math.round(Math.sqrt(s / buf.length) * 400)); r.bar.style.width = pct + '%'; r.bar.className = pct > 6 ? 'hot' : ''; }
      finderActive.raf = requestAnimationFrame(tick);
    };
    tick();
  }
  function stopDeviceFinder() {
    if (!finderActive) return;
    cancelAnimationFrame(finderActive.raf);
    finderActive.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    try { finderActive.ctx.close(); } catch {}
    finderActive = null;
  }
  $('s-find-device').addEventListener('click', toggleDeviceFinder);
  $('btn-settings-close').addEventListener('click', () => stopDeviceFinder());

  // ---- document library ----
  let docList = [];
  const URL_RE = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?$/i;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function fmtClock(sec) { sec = Math.round(sec || 0); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return (h ? `${h}:` : '') + `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`; }
  function fmtTokens(chars) { const t = Math.round(chars / 4); return t >= 1000 ? `${(t / 1000).toFixed(t >= 10000 ? 0 : 1)}k tok` : `${t} tok`; }
  function renderDocs(list) {
    docList = list || docList;
    const box = $('doc-list');
    box.innerHTML = '';
    const on = docList.filter((d) => d.enabled && !d.processing);
    const badge = $('ctx-count');
    badge.textContent = on.length; badge.classList.toggle('hidden', !on.length);
    $('ctx-total').textContent = on.length ? `(${on.length} item${on.length > 1 ? 's' : ''}, ${fmtTokens(on.reduce((n, d) => n + d.chars, 0))} full text · always included)` : '';
    if (!docList.length) { box.innerHTML = '<div class="muted small">Nothing saved yet — paste above, drop a file, or fetch a link / video.</div>'; return; }
    for (const d of docList) {
      const row = document.createElement('div');
      row.className = 'doc' + (d.enabled ? '' : ' off');
      const st = d.processing ? `<span class="working">${esc(d.processing)}</span>`
        : d.error ? `<span class="failed" title="${esc(d.error)}">failed — ${esc(d.error.slice(0, 70))}</span>`
        : d.digestStatus === 'ready' ? '<span class="ok">digest ready</span>'
        : d.digestStatus === 'working' ? '<span class="working">digesting…</span>'
        : d.digestStatus === 'pending' ? '<span class="working">digest queued</span>'
        : d.digestStatus === 'failed' ? `<span class="failed" title="${esc(d.digestError)}">digest failed</span>`
        : 'short — sent in full';
      const extra = d.kind === 'web' && d.pages ? ` · ${d.pages} page${d.pages > 1 ? 's' : ''}` : d.pages ? ` · ${d.pages} p` : d.seconds ? ` · ${fmtClock(d.seconds)}` : '';
      const size = d.processing ? '' : ` · ${fmtTokens(d.chars)}${d.truncated ? ' (truncated)' : ''}`;
      row.innerHTML = `<input type="checkbox" ${d.enabled ? 'checked' : ''} title="Include in context" />
        <span class="doc-name" title="${esc(d.source || d.name)}">${esc(d.name)}</span>
        <span class="doc-meta">${d.kind}${extra}${size} · ${st}</span>
        <button class="btn" data-act="digest" title="Regenerate digest">↻</button>
        <button class="btn" data-act="remove" title="Remove">✕</button>`;
      row.querySelector('input').addEventListener('change', async (e) => { renderDocs(await window.ghost.docsToggle(d.id, e.target.checked)); });
      row.querySelector('[data-act=digest]').addEventListener('click', async () => { renderDocs(await window.ghost.docsDigest(d.id)); });
      row.querySelector('[data-act=remove]').addEventListener('click', async () => { renderDocs(await window.ghost.docsRemove(d.id)); });
      box.appendChild(row);
    }
  }
  async function addDocFiles(files) {
    const errors = []; let bg = 0;
    for (const f of files) {
      const p = window.ghost.pathForFile(f);
      if (!p) { errors.push(`${f.name}: no path`); continue; }
      const r = await window.ghost.docsAddPath(p, { describeFrames: $('ctx-frames').checked });
      if (!r.ok) errors.push(`${f.name}: ${r.error}`); else { renderDocs(r.docs); if (r.background) bg++; }
    }
    if (errors.length) toast(errors.join(' | '), true);
    else if (bg) toast(`Transcribing ${bg} video/audio file${bg > 1 ? 's' : ''} on this computer — progress shows in the Context tab`);
    else if (files.length) toast(`Added ${files.length} document${files.length > 1 ? 's' : ''} — digest generating in the background`);
  }
  $('btn-doc-add').addEventListener('click', async () => {
    const r = await window.ghost.docsAdd({ describeFrames: $('ctx-frames').checked });
    renderDocs(r.docs);
    if (r.errors && r.errors.length) toast(r.errors.join(' | '), true);
    else if (r.background) toast(`Transcribing ${r.background} video/audio file${r.background > 1 ? 's' : ''} on this computer — progress shows below`);
    else if (r.added.length) toast(`Added ${r.added.length} document${r.added.length > 1 ? 's' : ''} — digest generating in the background`);
  });
  $('btn-doc-paste').addEventListener('click', async () => {
    const text = $('ctx-text').value.trim();
    if (URL_RE.test(text)) { $('ctx-text').value = ''; updateCtxLen(); addUrl(text); return; }
    if (text.length < 20) { toast('Paste something first.', true); return; }
    const guess = (text.match(/\\title\{([^}]*)\}/) || [])[1] || (text.match(/^#\s+(.+)$/m) || [])[1] || '';
    const name = $('ctx-name').value.trim() || guess.trim() || `pasted ${new Date().toLocaleString()}`;
    const r = await window.ghost.docsAddText(name, text);
    renderDocs(r.docs);
    $('ctx-text').value = ''; $('ctx-name').value = ''; updateCtxLen();
    toast(`Saved "${name}" — remembered from now on${r.doc.digestStatus === 'pending' ? '; making a digest for instant mode' : ''}`);
  });
  function updateCtxLen() {
    const n = $('ctx-text').value.length;
    $('ctx-len').textContent = n ? `(${n.toLocaleString()} chars ≈ ${fmtTokens(n)}${/\\documentclass|\\begin\{document\}/.test($('ctx-text').value) ? ', LaTeX detected — will be cleaned' : ''})` : '';
  }
  $('ctx-text').addEventListener('input', updateCtxLen);
  function openContext() { el.settings.classList.add('hidden'); $('context').classList.remove('hidden'); window.ghost.docsList().then(renderDocs); setTimeout(() => $('ctx-text').focus(), 50); }
  $('btn-context').addEventListener('click', openContext);
  $('btn-context-close').addEventListener('click', () => $('context').classList.add('hidden'));
  async function addUrl(url) {
    url = (url || '').trim();
    if (!URL_RE.test(url)) { toast('That does not look like a link.', true); return; }
    const r = await window.ghost.docsAddUrl(url, { wholeSite: $('ctx-whole-site').checked, describeFrames: $('ctx-frames').checked });
    if (!r.ok) { toast(r.error, true); return; }
    renderDocs(r.docs); $('ctx-url').value = '';
    toast(r.doc.kind === 'web' ? ($('ctx-whole-site').checked ? 'Fetching the site in the background — progress shows below' : 'Fetching the page…') : 'Getting the video in the background — progress shows below');
  }
  $('btn-doc-url').addEventListener('click', () => addUrl($('ctx-url').value));
  $('ctx-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addUrl($('ctx-url').value); } });
  // drag & drop anywhere on the window
  const drop = $('doc-drop');
  document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dropping'); drop.classList.add('over'); });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) { document.body.classList.remove('dropping'); drop.classList.remove('over'); } });
  document.addEventListener('drop', (e) => {
    e.preventDefault(); document.body.classList.remove('dropping'); drop.classList.remove('over');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) { openContext(); addDocFiles(files); return; }
    const link = ((e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain') || '').trim().split('\n')[0] || '').trim();
    if (link && URL_RE.test(link)) { openContext(); addUrl(link); }
  });
  window.ghost.onDocsEvent((ev) => {
    const prog = $('ctx-progress');
    if (ev.type === 'update') { renderDocs(ev.docs); if (!ev.docs.some((d) => d.processing)) prog.classList.add('hidden'); }
    else if (ev.type === 'progress') { prog.textContent = ev.text; prog.classList.remove('hidden'); const d = docList.find((x) => x.id === ev.id); if (d) { d.processing = ev.text; renderDocs(); } }
    else if (ev.type === 'error') toast(ev.text, true);
  });

  function updateDocsCount() {
    const n = $('s-docs').value.length;
    $('s-docs-count').textContent = n ? `(${n.toLocaleString()} chars ≈ ${Math.round(n / 4).toLocaleString()} tokens, sent with every request)` : '';
  }
  $('s-docs').addEventListener('input', updateDocsCount);

  async function saveSettings() {
    const shortcuts = {};
    document.querySelectorAll('[data-sc]').forEach((i) => { shortcuts[i.dataset.sc] = i.value.trim(); });
    const patch = {
      provider: $('s-provider').value,
      claude: { model: $('s-claude-model').value, effort: $('s-claude-effort').value, fallbacks: $('s-claude-fallbacks').checked, workspaceId: $('s-claude-workspace').value.trim() },
      gemini: { model: $('s-gemini-model').value },
      openai: { preset: $('s-openai-preset').value, baseUrl: $('s-openai-url').value.trim(), model: $('s-openai-model').value.trim(), vision: $('s-openai-vision').checked },
      fallbackProvider: $('s-fallback-provider').value,
      transcription: { engine: $('s-engine').value, localModel: $('s-local-model').value, refine: $('s-refine').checked, source: $('s-audio-source').value, callDevice: $('s-call-device').value || 'loopback', mode: $('s-transcription-mode').value, liveModel: $('s-live-model').value, model: $('s-transcription-model').value, chunkSeconds: Math.max(8, +$('s-chunk').value || 10), fallbackToChunk: $('s-fallback').value },
      governor: { maxPerMinute: Math.max(1, Math.min(60, +$('s-budget').value || 10)) },
      profile: $('s-profile').value,
      customPrompt: $('s-custom').value,
      contextDocs: $('s-docs').value,
      instantUsesFullDocs: $('s-docs-full-instant').checked,
      memory: { enabled: $('s-memory').checked },
      aiCleanup: $('s-aicleanup').value,
      instantModel: { gemini: $('s-instant-gemini').value, claude: $('s-instant-claude').value, openai: $('s-openai-instant').value.trim() },
      instantMaxTokens: Math.max(120, Math.min(1200, +$('s-instant-tokens').value || 350)),
      thinkSpeed: $('s-think-speed').value,
      autoAnswer: $('s-auto-answer').checked,
      screenshotMaxEdge: Math.max(640, Math.min(2048, +$('s-shot-edge').value || 1280)),
      maxTokens: +$('s-max-tokens').value || 4096,
      opacity: +$('s-opacity').value,
      shortcuts,
    };
    const ck = $('s-claude-key').value.trim(); if (ck) patch.claude.apiKey = ck;
    const gk = $('s-gemini-key').value.trim(); if (gk) patch.gemini.apiKey = gk;
    const ok = $('s-openai-key').value.trim(); if (ok) patch.openai.apiKey = ok;
    cfg = await window.ghost.setConfig(patch);
    // Dropdown left on a provider with no key while another one has one? Follow the key.
    const eff = effectiveProvider();
    if (eff !== (cfg.provider || 'gemini')) { cfg = await window.ghost.setConfig({ provider: eff }); toast(`Answering with ${providerName(eff)} (the only provider with a key)`); }
    el.settings.classList.add('hidden');
    refreshHeader();
    toast('Saved');
  }

  // Just saved a key for `provider` while the "answer with" dropdown points at a
  // provider with no key? Switch to the one that can actually answer.
  async function adoptProvider(provider) {
    const cur = cfg.provider || 'gemini';
    if (cur === provider || keySet(cur)) return;
    cfg = await window.ghost.setConfig({ provider });
    $('s-provider').value = provider;
    refreshHeader();
    toast(`Answering with ${providerName(provider)} now`);
  }

  async function testKey(provider) {
    const input = $(`s-${provider}-key`), out = $(`s-${provider}-test-result`), btn = $(`s-${provider}-test`);
    const typed = input.value.trim();
    if (!typed && !cfg[provider].apiKeySet) { out.className = 'test-result err'; out.textContent = 'Paste a key first.'; return; }
    // use the model currently selected in the dropdown (may be unsaved yet)
    await window.ghost.setConfig({ [provider]: { model: $(`s-${provider}-model`).value } });
    btn.disabled = true; out.className = 'test-result'; out.textContent = 'Testing…';
    const r = await window.ghost.testKey({ provider, apiKey: typed });
    btn.disabled = false;
    if (r.ok) {
      // A key that just answered is a key worth keeping: save it right away so
      // "tested but never pressed Save" can't happen.
      if (typed) { cfg = await window.ghost.setConfig({ [provider]: { apiKey: typed } }); input.value = ''; input.placeholder = cfg[provider].apiKey; $(`s-${provider}-status`).textContent = '(set — paste to replace)'; refreshHeader(); await adoptProvider(provider); }
      out.className = 'test-result ok'; out.textContent = `✓ ${r.model} answered in ${r.ms} ms${r.reply ? ` ("${r.reply}")` : ''}${typed ? ' — key saved' : ''}`;
    } else {
      // The key itself is fine (Google/Anthropic accepted it) but the model/quota/network misbehaved:
      // keep the key so the app can retry with fallbacks instead of having nothing at all.
      const keyProblem = /invalid API key|rejected this key|No API key|UNAUTHENTICATED|not scoped to a workspace|works across workspaces/i.test(r.error || '');
      if (typed && !keyProblem) { cfg = await window.ghost.setConfig({ [provider]: { apiKey: typed } }); input.value = ''; input.placeholder = cfg[provider].apiKey; $(`s-${provider}-status`).textContent = '(set — paste to replace)'; refreshHeader(); await adoptProvider(provider); }
      out.className = 'test-result err'; out.textContent = `✗ ${r.error}${typed && !keyProblem ? ' — (key saved anyway: the key was accepted, the model/quota was the problem)' : ''}`;
    }
  }
  $('s-claude-test').addEventListener('click', async () => {
    // the workspace id may be unsaved: push it first so the test sends the header
    await window.ghost.setConfig({ claude: { workspaceId: $('s-claude-workspace').value.trim() } });
    testKey('claude');
  });
  $('s-gemini-test').addEventListener('click', () => testKey('gemini'));
  $('s-openai-test').addEventListener('click', async () => {
    // base URL / preset may be unsaved: push them first so the test uses what's on screen
    await window.ghost.setConfig({ openai: { preset: $('s-openai-preset').value, baseUrl: $('s-openai-url').value.trim(), model: $('s-openai-model').value.trim() } });
    testKey('openai');
  });
  // presets fill URL + models; the user can still edit them
  function updateOpenaiHint() {
    const p = MODELS.openaiPresets[$('s-openai-preset').value] || {};
    $('s-openai-keyhint').innerHTML = p.keyUrl ? `Free key: <a href="${p.keyUrl}">${p.keyUrl}</a>` : ($('s-openai-preset').value === 'ollama' ? 'Runs on this PC — install Ollama and pull a model (e.g. <code>ollama pull llama3.2</code>). No key.' : '');
  }
  $('s-openai-preset').addEventListener('change', () => {
    const p = MODELS.openaiPresets[$('s-openai-preset').value] || {};
    if (p.baseUrl) $('s-openai-url').value = p.baseUrl;
    if (p.model) $('s-openai-model').value = p.model;
    $('s-openai-instant').value = p.instant || '';
    $('s-openai-vision').checked = !!p.visionDefault;
    updateOpenaiHint();
  });
  $('s-openai-keyhint').addEventListener('click', (e) => { const a = e.target.closest('a'); if (a) { e.preventDefault(); window.ghost.openExternal(a.href); } });

  $('btn-settings').addEventListener('click', openSettings);
  $('btn-settings-close').addEventListener('click', () => el.settings.classList.add('hidden'));
  $('btn-save').addEventListener('click', saveSettings);
  $('btn-quit').addEventListener('click', () => quitNow());
  $('s-opacity').addEventListener('input', (e) => { $('s-opacity-val').textContent = Math.round(e.target.value * 100) + '%'; window.ghost.setConfig({ opacity: +e.target.value }); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { el.settings.classList.add('hidden'); $('context').classList.add('hidden'); } });

  // ------------------------------------------------------------------ boot
  refreshHeader();
  renderMode();
  window.ghost.docsList().then(renderDocs); // context badge at launch
  const ws = await window.ghost.winState();
  document.body.classList.toggle('clickthrough', ws.clickThrough);
  if (!ws.loopbackAudio && (cfg.transcription.source || 'both') !== 'mic' && (cfg.transcription.callDevice || 'loopback') === 'loopback') {
    // Only Windows can capture system audio via built-in loopback. On macOS/Linux,
    // the "them" side needs a virtual device (BlackHole) picked as the call-audio
    // device — until one is chosen, fall back to mic-only so listening still works.
    cfg = await window.ghost.setConfig({ transcription: { source: 'mic' } });
  }
  await restoreSession();
  el.input.focus();
  // test hooks (renderer is isolated; nothing else can reach these)
  window.__ghost = {
    buildUserMessage, transcriptBlock, contextMessages, maybeSummarize, restoreSession, persist, isQuestion,
    messages: () => messages, transcript: () => transcript, memory: () => memory,
    setTranscript: (t) => { transcript = t; }, setMessages: (m) => { messages = m; }, setMemory: (m) => { memory = m; },
    setLastAnsweredAt: (t) => { lastAnsweredAt = t; }, setInterim,
    reloadConfig: async () => { cfg = await window.ghost.getConfig(); refreshHeader(); },
    toggleListen, stopListening, status: () => elStatus.textContent, interim: () => interimText, mode: () => listenMode,
  };
})();
