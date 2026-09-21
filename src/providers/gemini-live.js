// Streaming speech-to-text over the Gemini Live API (BidiGenerateContent).
//
// We open one WebSocket, stream raw 16 kHz PCM frames as they are captured,
// and read transcription back as it happens:
//   serverContent.interimInputTranscription.text  -> partial (updates while speaking)
//   serverContent.inputTranscription.text         -> committed text
//   serverContent.turnComplete                    -> utterance boundary
// The model is asked to stay silent so this costs transcription only.
//
// Docs: https://ai.google.dev/api/live
const WebSocket = require('ws');
const { EventEmitter } = require('events');

// GEMINI_LIVE_URL override exists only so test/mock-live.js can exercise this offline.
const WS_URL = process.env.GEMINI_LIVE_URL || 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

// Tried in order until one accepts the setup message.
const LIVE_MODELS = [
  'gemini-3.8-live',
  'gemini-3.1-flash-live-preview',
  'gemini-live-2.5-flash-preview',
  'gemini-2.5-flash-live',
  'gemini-2.0-flash-live-001',
];

const SILENT_INSTRUCTION = 'You are a silent transcription relay. Never answer, comment, or summarise. Whenever you must produce a turn, reply with exactly one character: "."';

class LiveTranscriber extends EventEmitter {
  constructor({ apiKey, model, sampleRate = 16000 }) {
    super();
    this.apiKey = apiKey;
    this.preferredModel = process.env.GHOST_LIVE_MODEL || model; // env: test override only
    this.sampleRate = sampleRate;
    this.ws = null;
    this.ready = false;
    this.closedByUs = false;
    this.turnText = '';      // committed text for the current utterance
    this.interim = '';
    this.reconnects = 0;
    this.modelInUse = null;
    this.queue = [];         // audio frames buffered while (re)connecting
  }

  // Resolves with the model name once setupComplete arrives. Tries a small
  // matrix per model (full setup, minimal setup, AUDIO modality for
  // native-audio models, query-param auth) and logs every attempt.
  async connect() {
    const candidates = [this.preferredModel, ...LIVE_MODELS].filter((m, i, a) => m && a.indexOf(m) === i);
    const attempts = [];
    // Verified against the real API (see test/live-ab.ps1): every current Live
    // model is AUDIO-output only, and input transcription needs VAD on. So
    // 'audio' goes first; the TEXT variants remain for future/half-cascade models.
    let VARIANTS = [
      { auth: 'header', variant: 'audio' },
      { auth: 'header', variant: 'full' },
      { auth: 'header', variant: 'lean' },
      { auth: 'header', variant: 'minimal' },
      { auth: 'query', variant: 'audio' },
    ];
    if (process.env.GHOST_LIVE_VARIANT) VARIANTS = VARIANTS.filter((v) => v.variant === process.env.GHOST_LIVE_VARIANT);
    let badKey = false;
    for (const model of candidates) {
      for (const v of VARIANTS) {
        try {
          this.emit('log', `connect attempt model=${model} auth=${v.auth} variant=${v.variant}`);
          await this._open(model, v.auth, v.variant);
          this.modelInUse = model; this.authInUse = v.auth;
          this.emit('log', `connected model=${model} auth=${v.auth} variant=${v.variant}`);
          this.emit('status', `live transcription connected (${model}${v.variant !== 'full' ? `, ${v.variant} setup` : ''})`);
          this._flushQueue();
          return model;
        } catch (e) {
          attempts.push(`${model}/${v.auth}/${v.variant}: ${e.message}`);
          this.emit('log', `failed model=${model} auth=${v.auth} variant=${v.variant}: ${e.message}`);
          if (/API key|401|403|PERMISSION_DENIED|UNAUTHENTICATED/i.test(e.message)) { badKey = true; break; }
          if (/not found|unsupported model|does not exist|is not supported/i.test(e.message)) break; // next model
        }
      }
      if (badKey) break;
    }
    const err = new Error(attempts[0] ? `${attempts[0]}${attempts.length > 1 ? ` (+${attempts.length - 1} more attempts, see ghost.log)` : ''}` : 'could not connect');
    err.attempts = attempts;
    throw err;
  }

  _open(model, auth, variant = 'full') {
    this.variant = variant;
    return new Promise((resolve, reject) => {
      const url = auth === 'query' ? `${WS_URL}?key=${encodeURIComponent(this.apiKey)}` : WS_URL;
      const ws = new WebSocket(url, { headers: auth === 'header' ? { 'x-goog-api-key': this.apiKey } : {} });
      let settled = false;
      const fail = (msg) => { if (!settled) { settled = true; try { ws.close(); } catch {} reject(new Error(msg)); } };
      const timer = setTimeout(() => fail('timeout waiting for setupComplete'), 8000);

      ws.on('open', () => {
        const setup = variant === 'full'
          ? {
              model: `models/${model}`,
              generationConfig: { responseModalities: ['TEXT'], maxOutputTokens: 8, temperature: 0 },
              systemInstruction: { parts: [{ text: SILENT_INSTRUCTION }] },
              inputAudioTranscription: {},
              realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 500 } },
              sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
            }
          : variant === 'lean'
            ? {
                model: `models/${model}`,
                generationConfig: { responseModalities: ['TEXT'] },
                systemInstruction: { parts: [{ text: SILENT_INSTRUCTION }] },
                inputAudioTranscription: {},
                realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 500 } },
              }
          : variant === 'audio-novad'
            // native-audio model, and turn detection OFF: the model never gets a
            // turn so it never generates; we only receive the input transcription.
            ? { model: `models/${model}`, generationConfig: { responseModalities: ['AUDIO'] }, systemInstruction: { parts: [{ text: SILENT_INSTRUCTION }] }, inputAudioTranscription: {}, realtimeInputConfig: { automaticActivityDetection: { disabled: true } } }
          : variant === 'audio'
            // native-audio models only speak AUDIO; we still just read the input transcription
            ? { model: `models/${model}`, generationConfig: { responseModalities: ['AUDIO'] }, systemInstruction: { parts: [{ text: SILENT_INSTRUCTION }] }, inputAudioTranscription: {}, realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 500 } } }
            : { model: `models/${model}`, generationConfig: { responseModalities: ['TEXT'] }, inputAudioTranscription: {} };
        ws.send(JSON.stringify({ setup }));
      });
      ws.on('unexpected-response', (_req, res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => fail(`HTTP ${res.statusCode} ${body.slice(0, 200)}`));
      });
      ws.on('error', (e) => fail(e.message));
      ws.on('close', (code, reason) => {
        clearTimeout(timer);
        const why = `${code} ${Buffer.isBuffer(reason) ? reason.toString() : reason || ''}`.trim();
        if (!settled) return fail(`closed during setup: ${why}`);
        this.emit('log', `socket closed: ${why} (framesSent=${this.framesSent || 0})`);
        this.ready = false;
        if (this.ws === ws) this.ws = null;
        if (this.closedByUs) return;
        // Quota exhausted: reconnecting would only spend more quota. Stop and say so.
        if (/exhausted|quota|RESOURCE_EXHAUSTED/i.test(why)) { const e = new Error(`Gemini Live quota exhausted: ${why}`); e.code = 'QUOTA'; this.closedByUs = true; this.emit('error', e); return; }
        if (/^1007|^1008|not supported|invalid argument/i.test(why)) { const e = new Error(`live transcription rejected by server: ${why}`); e.code = 'REJECTED'; this.emit('error', e); return; }
        this._reconnect(why);
      });
      ws.on('message', (data) => {
        let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.setupComplete !== undefined && !settled) {
          settled = true; clearTimeout(timer);
          this.ws = ws; this.ready = true; this.framesSent = 0;
          // only forgive past drops once this connection has lived a while
          setTimeout(() => { if (this.ws === ws && this.ready) this.reconnects = 0; }, 15000);
          resolve();
          return;
        }
        if (!settled) { if (msg.error) fail(msg.error.message || JSON.stringify(msg.error)); else this.emit('log', `pre-setup message: ${data.toString().slice(0, 300)}`); return; }
        this._handle(msg);
      });
    });
  }

  _handle(msg) {
    if (msg.sessionResumptionUpdate?.newHandle) { this.resumeHandle = msg.sessionResumptionUpdate.newHandle; return; }
    if ((this.logged = (this.logged || 0) + 1) <= 20) this.emit('log', `server: ${JSON.stringify(msg).slice(0, 300)}`);
    if (msg.goAway) { this.emit('status', 'server asked us to reconnect'); try { this.ws?.close(); } catch {} return; }
    const sc = msg.serverContent;
    if (!sc) return;
    if (sc.modelTurn) { const bytes = (sc.modelTurn.parts || []).reduce((n, p) => n + (p.inlineData?.data?.length || 0) + (p.text?.length || 0), 0); this.emit('log', `modelTurn (${bytes} bytes)`); }
    if (sc.interimInputTranscription?.text != null) {
      this.interim = sc.interimInputTranscription.text;
      this.emit('interim', this.interim);
    }
    if (sc.inputTranscription?.text) {
      const t = sc.inputTranscription.text;
      // Servers have sent both deltas and cumulative text; accept either.
      if (t.startsWith(this.turnText)) this.turnText = t;
      else if (!this.turnText.endsWith(t)) this.turnText += t;
      this.interim = '';
      this.emit('interim', this.turnText); // show committed-so-far as the live line
    }
    if (sc.turnComplete) this._commit();
  }

  _commit() {
    const text = this.turnText.trim();
    this.turnText = ''; this.interim = '';
    if (text) this.emit('final', text);
    this.emit('interim', '');
  }

  _reconnect(why) {
    if (this.closedByUs) return;
    if (this.reconnects >= 4) { this.emit('error', new Error(`live transcription dropped (${why})`)); return; }
    this.reconnects++;
    const delay = 300 * this.reconnects;
    this.emit('status', `reconnecting live transcription… (${why})`);
    setTimeout(async () => {
      if (this.closedByUs) return;
      try { await this._open(this.modelInUse, this.authInUse || 'header', this.variant); this.emit('status', 'live transcription reconnected'); this._flushQueue(); }
      catch (e) { this.emit('log', `reconnect attempt ${this.reconnects} failed: ${e.message}`); this.resumeHandle = null; this._reconnect(e.message); }
    }, delay);
  }

  sendAudio(base64Pcm16) {
    const frame = JSON.stringify({ realtimeInput: { audio: { data: base64Pcm16, mimeType: `audio/pcm;rate=${this.sampleRate}` } } });
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) { this.ws.send(frame); this.framesSent = (this.framesSent || 0) + 1; }
    else { this.queue.push(frame); if (this.queue.length > 40) this.queue.shift(); } // keep ~10 s
  }

  _flushQueue() {
    if (!this.ready) return;
    for (const f of this.queue) this.ws.send(f);
    this.queue = [];
  }

  // Ask the server to finalise whatever it has (used by "Ask" catch-up).
  nudge() {
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
  }

  close() {
    this.closedByUs = true;
    this._commit();
    try { this.ws?.close(); } catch {}
    this.ws = null; this.ready = false;
  }
}

module.exports = { LiveTranscriber, LIVE_MODELS };
