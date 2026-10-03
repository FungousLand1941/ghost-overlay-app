// Audio capture in the renderer (getUserMedia / getDisplayMedia live here).
//
// Sources: 'system' (loopback: what you hear = the other people on the call),
// 'mic' (you), or 'both'. Each source gets its own processing node so that:
//   - streaming mode can send each source to its own transcription session
//     (=> transcript lines labelled YOU / THEM), with the mic silenced only
//     while it is carrying nothing but your speakers' bleed (see GhostDSP.createEchoGate);
//   - chunk mode (fallback) mixes them into one WAV every N seconds.
//
// Signal chain per source (dsp.js, shared with test/stt-bench.js):
//   device rate -> windowed-sinc resample to 16 kHz -> 70 Hz high-pass -> click-free gain -> int16
/* global GhostDSP */
(function () {
  const TARGET_RATE = 16000;
  const SILENCE_RMS = 0.0025;
  const BLOCK = 4096;

  class AudioChunker {
    constructor({ source, callDevice, chunkSeconds, onChunk, onFrame, onError, onStatus }) {
      this.source = source; // 'system' | 'mic' | 'both'
      this.callDevice = callDevice || 'loopback'; // 'loopback' or an audioinput deviceId for the call audio
      this.chunkSeconds = chunkSeconds;
      this.sysFrames = 0; this.sysLiveFrames = 0; // for the "system audio is digital silence" warning
      this.onChunk = onChunk;   // chunk mode: (wavBase64, info) every chunkSeconds (mixed)
      this.onFrame = onFrame;   // stream mode: (sourceName, pcm16Base64, info) every ~85 ms per source
      this.onError = onError;
      this.onStatus = onStatus || (() => {});
      this.buffers = { system: [], mic: [] };
      this.running = false;
      this.streams = [];
      this.analysers = {};
      this.procs = [];
      this.chain = {};   // per source: { rs, hp, agc }
      this.micQueue = [];
      this.gate = GhostDSP.createEchoGate({ micFloor: 0.0015 });
      this.lastRms = { system: 0, mic: 0 };
      this.stats = { chunksSent: 0, chunksSkippedSilent: 0, framesSent: 0, framesDucked: 0, lastRms: 0, engine: '' };
    }

    async start() {
      const wantSystem = this.source === 'system' || this.source === 'both';
      const wantMic = this.source === 'mic' || this.source === 'both';
      const errors = [];

      // Capture at the device's NATIVE rate (usually 48 kHz) and resample
      // ourselves. Forcing a 16 kHz AudioContext makes some drivers (and
      // loopback) resample badly or hand back near-silence.
      // 'playback' = large audio buffers. Ghost never plays sound, so it has no use for the default
      // low-latency (few ms) buffers — and with those the audio engine misses its deadlines whenever
      // the CPU is busy, which silently DROPS captured audio (measured: up to 7 % lost on a loaded laptop).
      this.ctx = new AudioContext({ latencyHint: 'playback' });
      this.rate = this.ctx.sampleRate;
      const sink = this.ctx.createGain(); sink.gain.value = 0; // keeps the graph alive without playback
      sink.connect(this.ctx.destination);

      // Capture on the audio thread when possible: a ScriptProcessor runs on the
      // UI thread and drops audio whenever the page is busy (e.g. rendering a
      // long answer) — dropped audio is dropped words.
      let worklet = false;
      try { await this.ctx.audioWorklet.addModule('capture-worklet.js'); worklet = true; } catch { worklet = false; }
      this.stats.engine = worklet ? 'worklet' : 'scriptprocessor';

      const attach = (name, stream) => {
        const src = this.ctx.createMediaStreamSource(stream);
        const an = this.ctx.createAnalyser(); an.fftSize = 1024;
        src.connect(an);
        this.chain[name] = { rs: GhostDSP.createResampler(this.rate, TARGET_RATE), hp: GhostDSP.createHighpass(TARGET_RATE), agc: GhostDSP.createAgc({ rate: TARGET_RATE }) };
        let node;
        if (worklet) {
          node = new AudioWorkletNode(this.ctx, 'ghost-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
          node.port.onmessage = (e) => { if (this.running) this._onSamples(name, e.data.buf, Math.max(0, (this.ctx.currentTime - e.data.t) * 1000)); };
        } else {
          node = this.ctx.createScriptProcessor(BLOCK, 1, 1);
          node.onaudioprocess = (e) => { if (this.running) this._onSamples(name, new Float32Array(e.inputBuffer.getChannelData(0))); };
        }
        src.connect(node); node.connect(sink);
        this.procs.push(node);
        this.analysers[name] = an;
        this.streams.push(stream);
        stream.getAudioTracks()[0].addEventListener('ended', () => {
          this.onStatus(`${name} audio source ended`);
          if (this.streams.every((s) => s.getAudioTracks().every((t) => t.readyState === 'ended'))) { this.stop(); this.onError?.(new Error('All audio sources ended.')); }
        });
      };

      // Test hook: recorded audio instead of the devices (see main.js 'test:audio'); null in normal use.
      let fake = null;
      try { fake = window.ghost && window.ghost.testAudio ? await window.ghost.testAudio() : null; } catch { fake = null; }
      const fakeStream = (bytes) => {
        const f32 = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
        const buf = this.ctx.createBuffer(1, f32.length, fake.rate); buf.copyToChannel(f32, 0);
        const src = this.ctx.createBufferSource(); src.buffer = buf; src.loop = true;
        const dest = this.ctx.createMediaStreamDestination(); src.connect(dest); src.start();
        (this._fakeSources || (this._fakeSources = [])).push(src);
        return dest.stream;
      };

      if (wantSystem) {
        try {
          let s = fake && fake.system ? fakeStream(fake.system) : null;
          if (!s && this.callDevice && this.callDevice !== 'loopback') {
            // A specific capture endpoint for the call audio (Stereo Mix, a
            // Voicemeeter "Out B" bus, BlackHole on macOS…). Raw: no AEC/AGC,
            // this is a line signal, not a microphone.
            try {
              s = await navigator.mediaDevices.getUserMedia({
                audio: { deviceId: { exact: this.callDevice }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false,
              });
            } catch (e) {
              // the saved device is gone (unplugged, driver removed): don't go deaf, use the default output
              this.onStatus(`saved call-audio device unavailable (${e.name || e.message}) — using the default output instead`);
            }
          }
          if (!s) {
            // Default-output loopback. main.js answers this with audio:'loopback'
            // on Windows; the video track is mandatory for the API but dropped here.
            // NOTE: loopback is captured AFTER the Windows volume/mute stage —
            // muted speakers = digital silence here (we detect and warn).
            s = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
            s.getVideoTracks().forEach((t) => t.stop());
            if (!s.getAudioTracks().length) throw new Error('no system audio track (on macOS use a virtual audio device such as BlackHole and pick it as the call audio device)');
          }
          attach('system', s);
        } catch (e) { errors.push(`system audio: ${e.message}`); }
      }
      if (wantMic) {
        try {
          // Browser AGC is off on purpose: it would re-amplify speaker bleed up to
          // speech level whenever you are quiet, which makes bleed and your voice
          // indistinguishable by level. We apply our own click-free gain later.
          const s = fake && fake.mic ? fakeStream(fake.mic) : await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false }, video: false,
          });
          attach('mic', s);
        } catch (e) { errors.push(`microphone: ${e.message}`); }
      }

      if (!this.streams.length) {
        this.stop();
        throw new Error(errors.join('; ') || 'no audio source');
      }
      if (errors.length) this.onStatus(`Partial: ${errors.join('; ')}`);

      this.running = true;
      if (this.onChunk) this.timer = setInterval(() => this.flush(), this.chunkSeconds * 1000);
      return { active: Object.keys(this.analysers), errors, engine: this.stats.engine };
    }

    // waitMs: how long the block sat between being captured and this thread processing it (worklet path)
    _onSamples(name, f32, waitMs = 0) {
      this.wait = waitMs;
      const t0 = performance.now();
      try { this._process(name, f32); } finally { this.stats.dspMs = (this.stats.dspMs || 0) + (performance.now() - t0); this.stats.blocks = (this.stats.blocks || 0) + 1; }
    }

    _process(name, f32) {
      const rms = GhostDSP.rmsOf(f32);
      this.lastRms[name] = rms;
      this.stats.lastRms = rms;
      if (name === 'system') { this.sysFrames++; if (rms > 0.00002) this.sysLiveFrames++; }

      if (this.onChunk) this.buffers[name].push(f32);

      if (this.onFrame) {
        const now = performance.now();
        const c = this.chain[name];
        const pcm = c.hp.process(Float32Array.from(c.rs.process(f32)));
        if (!pcm.length) return;
        if (name === 'system') {
          // loopback is captured post-volume-slider, so "active" is an absolute floor
          // well above its silence level (~1e-5) but below quiet speech (~1e-2)
          if (rms > 0.002) this.lastSysActiveAt = now;
          this.gate.system(GhostDSP.subRms(f32, this.rate), now);
          this._emitFrame(name, pcm, rms);
          return;
        }
        // Mic frames are held for one frame so they can be judged against the
        // system audio that overlaps them (the mic hears the speakers ~50–200 ms
        // late). A frame that is only speaker bleed is sent as silence so it is
        // never transcribed as "you"; a frame where you are talking — even over
        // the other side — is kept. On headphones nothing is ever silenced.
        if ('system' in this.analysers) {
          this.micQueue.push({ pcm, rms, env: GhostDSP.subRms(f32, this.rate), at: now });
          while (this.micQueue.length > 1) {
            const f = this.micQueue.shift();
            if (this.gate.mic(f.env, f.at).duck) { this.stats.framesDucked++; this._emitFrame('mic', new Float32Array(f.pcm.length), 0, true); }
            else this._emitFrame('mic', f.pcm, f.rms);
          }
          return;
        }
        this._emitFrame(name, pcm, rms);
      }
    }

    _emitFrame(name, pcm, rms, silent) {
      if (!silent) this.chain[name].agc.process(pcm);
      let peak = 0; for (let i = 0; i < pcm.length; i++) { const a = pcm[i] < 0 ? -pcm[i] : pcm[i]; if (a > peak) peak = a; }
      this.stats.framesSent++;
      this.onFrame(name, b64(pcmToInt16(pcm)), { rms, peak, wait: this.wait || 0 });
    }

    // Instantaneous RMS per source, 0..1 — for the UI level meters.
    levels() {
      const out = {};
      for (const [name, an] of Object.entries(this.analysers)) {
        const buf = new Float32Array(an.fftSize);
        an.getFloatTimeDomainData(buf);
        let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        out[name] = Math.sqrt(sum / buf.length);
      }
      return out;
    }

    // Chunk mode: mix whatever each source captured since the last flush.
    flush() {
      const names = Object.keys(this.analysers);
      const per = names.map((n) => { const bufs = this.buffers[n]; this.buffers[n] = []; return concat(bufs); });
      const len = Math.max(0, ...per.map((p) => p.length));
      if (!len) return;
      const pcm = new Float32Array(len);
      for (const p of per) for (let i = 0; i < p.length; i++) pcm[i] += p[i];
      if (per.length > 1) for (let i = 0; i < len; i++) pcm[i] = Math.max(-1, Math.min(1, pcm[i]));

      // crude VAD: skip near-silent chunks (saves API calls / rate limit)
      let sum = 0; for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
      const rms = Math.sqrt(sum / pcm.length);
      if (rms < SILENCE_RMS) { this.stats.chunksSkippedSilent++; return; }

      // normalise quiet audio a bit so the STT model gets a healthy signal
      let peak = 0; for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
      if (peak > 0 && peak < 0.3) { const g = Math.min(0.9 / peak, 8); for (let i = 0; i < pcm.length; i++) pcm[i] *= g; }

      const out16k = this.rate === TARGET_RATE ? pcm : Float32Array.from(GhostDSP.createResampler(this.rate, TARGET_RATE).process(pcm));
      const wav = encodeWav(out16k, TARGET_RATE);
      this.stats.chunksSent++;
      this.onChunk(b64(wav), { seconds: len / this.rate, rms });
    }

    stop() {
      this.running = false;
      clearInterval(this.timer);
      for (const p of this.procs) { try { p.port && (p.port.onmessage = null); p.disconnect(); } catch {} }
      try { this.ctx?.close(); } catch {}
      this.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
      this.streams = []; this.procs = [];
      this.analysers = {};
      this.buffers = { system: [], mic: [] };
    }
  }

  function concat(bufs) {
    const len = bufs.reduce((n, b) => n + b.length, 0);
    const out = new Float32Array(len);
    let off = 0; for (const b of bufs) { out.set(b, off); off += b.length; }
    return out;
  }

  function pcmToInt16(pcm) {
    const out = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) { const s = Math.max(-1, Math.min(1, pcm[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
    return out.buffer;
  }

  function encodeWav(pcm, rate) {
    const buf = new ArrayBuffer(44 + pcm.length * 2);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, pcm.length * 2, true);
    let o = 44;
    for (let i = 0; i < pcm.length; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buf;
  }

  function b64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  window.AudioChunker = AudioChunker;
})();
