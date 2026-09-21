// Audio capture in the renderer (getUserMedia / getDisplayMedia live here).
//
// Sources: 'system' (loopback: what you hear = the other people on the call),
// 'mic' (you), or 'both'. Each source gets its own processing node so that:
//   - streaming mode can send each source to its own transcription session
//     (=> transcript lines labelled YOU / THEM), with the mic ducked while the
//     speakers are clearly louder (so your speakers don't get transcribed as you);
//   - chunk mode (fallback) mixes them into one WAV every N seconds.
(function () {
  const TARGET_RATE = 16000;
  const SILENCE_RMS = 0.0025;

  class AudioChunker {
    constructor({ source, callDevice, chunkSeconds, onChunk, onFrame, onError, onStatus }) {
      this.source = source; // 'system' | 'mic' | 'both'
      this.callDevice = callDevice || 'loopback'; // 'loopback' or an audioinput deviceId for the call audio
      this.chunkSeconds = chunkSeconds;
      this.sysFrames = 0; this.sysLiveFrames = 0; // for the "system audio is digital silence" warning
      this.onChunk = onChunk;   // chunk mode: (wavBase64, info) every chunkSeconds (mixed)
      this.onFrame = onFrame;   // stream mode: (sourceName, pcm16Base64, info) every ~256 ms per source
      this.onError = onError;
      this.onStatus = onStatus || (() => {});
      this.buffers = { system: [], mic: [] };
      this.running = false;
      this.streams = [];
      this.analysers = {};
      this.procs = [];
      this.agc = {};
      this.micQueue = [];
      this.lastRms = { system: 0, mic: 0 };
      this.stats = { chunksSent: 0, chunksSkippedSilent: 0, framesSent: 0, framesDucked: 0, lastRms: 0 };
    }

    async start() {
      const wantSystem = this.source === 'system' || this.source === 'both';
      const wantMic = this.source === 'mic' || this.source === 'both';
      const errors = [];

      // Capture at the device's NATIVE rate (usually 48 kHz) and downsample
      // ourselves with an anti-aliasing filter. Forcing a 16 kHz AudioContext
      // makes some drivers (and loopback) resample badly or hand back near-silence.
      this.ctx = new AudioContext();
      this.rate = this.ctx.sampleRate;
      this.ds = {}; // per-source downsampler state (fractional carry + filter memory)
      const sink = this.ctx.createGain(); sink.gain.value = 0; // keeps the graph alive without playback
      sink.connect(this.ctx.destination);

      const attach = (name, stream) => {
        const src = this.ctx.createMediaStreamSource(stream);
        const an = this.ctx.createAnalyser(); an.fftSize = 1024;
        src.connect(an);
        // ScriptProcessor is deprecated but universally available in Electron and
        // far simpler than shipping an AudioWorklet file for this.
        const proc = this.ctx.createScriptProcessor(4096, 1, 1);
        proc.onaudioprocess = (e) => {
          if (!this.running) return;
          const f32 = new Float32Array(e.inputBuffer.getChannelData(0));
          this._onSamples(name, f32);
        };
        src.connect(proc); proc.connect(sink);
        this.procs.push(proc);
        this.analysers[name] = an;
        this.streams.push(stream);
        stream.getAudioTracks()[0].addEventListener('ended', () => {
          this.onStatus(`${name} audio source ended`);
          if (this.streams.every((s) => s.getAudioTracks().every((t) => t.readyState === 'ended'))) { this.stop(); this.onError?.(new Error('All audio sources ended.')); }
        });
      };

      if (wantSystem) {
        try {
          let s;
          if (this.callDevice && this.callDevice !== 'loopback') {
            // A specific capture endpoint for the call audio (Stereo Mix, a
            // Voicemeeter "Out B" bus, BlackHole on macOS…). Raw: no AEC/AGC,
            // this is a line signal, not a microphone.
            s = await navigator.mediaDevices.getUserMedia({
              audio: { deviceId: { exact: this.callDevice }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false,
            });
          } else {
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
          const s = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
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
      return { active: Object.keys(this.analysers), errors };
    }

    _onSamples(name, f32) {
      let sum = 0; for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
      const rms = Math.sqrt(sum / f32.length);
      this.lastRms[name] = rms;
      this.stats.lastRms = rms;
      if (name === 'system') { this.sysFrames++; if (rms > 0.00002) this.sysLiveFrames++; }

      if (this.onChunk) this.buffers[name].push(f32);

      if (this.onFrame) {
        const now = performance.now();
        let pcm = this.rate === TARGET_RATE ? f32 : this._downsample(name, f32);
        if (!pcm.length) return;
        if (name === 'system') {
          // loopback is captured post-volume-slider, so "active" is an absolute floor
          // well above its silence level (~1e-5) but below quiet speech (~1e-2)
          if (rms > 0.002) this.lastSysActiveAt = now;
          this._emitFrame(name, pcm, rms);
          return;
        }
        // Mic frames are held for one frame so we can judge them against the
        // system activity that overlaps them (the mic hears the speakers ~50–200 ms
        // late); while the other side is talking, the mic frame is sent as
        // silence so it is never transcribed as "you". Verified on the real API:
        // level-ratio ducking failed (loopback ~2 % vs auto-gained mic), this works.
        if ('system' in this.analysers) {
          this.micQueue.push({ pcm, rms, at: now });
          while (this.micQueue.length > 1) {
            const f = this.micQueue.shift();
            const duck = this.lastSysActiveAt !== undefined && this.lastSysActiveAt > f.at - 700;
            if (duck) { this.stats.framesDucked++; this._emitFrame('mic', new Float32Array(f.pcm.length), 0); }
            else this._emitFrame('mic', f.pcm, f.rms);
          }
          return;
        }
        this._emitFrame(name, pcm, rms);
      }
    }

    // Proper anti-aliased downsample to 16 kHz. A 2-pole low-pass (~7.2 kHz)
    // removes the high frequencies that would otherwise alias, then we decimate
    // at the exact fractional ratio, carrying the phase across frames so there
    // are no clicks or drift at frame boundaries. Far cleaner than picking
    // samples with linear interpolation (which aliases and sounds "underwater").
    _downsample(name, f32) {
      const st = this.ds[name] || (this.ds[name] = { phase: 0, z1: 0, z2: 0 });
      const ratio = this.rate / TARGET_RATE;
      // one-pole-ish low-pass (cascaded) — cutoff near TARGET_RATE/2.2
      const a = Math.exp(-2 * Math.PI * (TARGET_RATE / 2.2) / this.rate);
      const b = 1 - a;
      const lp = new Float32Array(f32.length);
      let z1 = st.z1, z2 = st.z2;
      for (let i = 0; i < f32.length; i++) { z1 = b * f32[i] + a * z1; z2 = b * z1 + a * z2; lp[i] = z2; }
      st.z1 = z1; st.z2 = z2;
      const outLen = Math.floor((f32.length - st.phase) / ratio) + 1;
      const out = new Float32Array(Math.max(0, outLen));
      let o = 0, p = st.phase;
      while (p < f32.length) {
        const i0 = Math.floor(p), frac = p - i0, i1 = i0 + 1 < f32.length ? i0 + 1 : i0;
        out[o++] = lp[i0] * (1 - frac) + lp[i1] * frac;
        p += ratio;
      }
      st.phase = p - f32.length;
      return o === out.length ? out : out.subarray(0, o);
    }

    _emitFrame(name, pcm, rms) {
      // Gentle AGC per source. Loopback audio arrives post-volume-slider (often ~2 %),
      // so quiet speech needs lifting — but ASR hates the distortion that an
      // aggressive gain + hard clip introduces. So: target a modest 0.28 peak,
      // cap gain at 8x, smooth the envelope (attack fast, release slow) to avoid
      // pumping, and use a soft limiter (tanh knee) instead of a hard clip so
      // transients are rounded, not squared off.
      let peak = 0; for (let i = 0; i < pcm.length; i++) { const a = Math.abs(pcm[i]); if (a > peak) peak = a; }
      if (peak > 0) {
        const env = this.agc[name] || peak;
        this.agc[name] = peak > env ? env * 0.6 + peak * 0.4 /* attack */ : env * 0.985 + peak * 0.015 /* release */;
        if (this.agc[name] > 0.004) {
          const g = Math.min(8, Math.max(1, 0.28 / this.agc[name]));
          if (g > 1.03) {
            for (let i = 0; i < pcm.length; i++) {
              let v = pcm[i] * g;
              if (v > 0.85 || v < -0.85) v = Math.tanh(v); // soft knee only near the rails
              pcm[i] = v;
            }
          }
        }
      }
      this.stats.framesSent++;
      this.onFrame(name, b64(pcmToInt16(pcm)), { rms, peak });
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

      const wav = encodeWav(this.rate === TARGET_RATE ? pcm : resample(pcm, this.rate, TARGET_RATE), TARGET_RATE);
      this.stats.chunksSent++;
      this.onChunk(b64(wav), { seconds: len / this.rate, rms });
    }

    stop() {
      this.running = false;
      clearInterval(this.timer);
      for (const p of this.procs) { try { p.disconnect(); } catch {} }
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

  function resample(pcm, from, to) {
    const ratio = from / to;
    const out = new Float32Array(Math.floor(pcm.length / ratio));
    for (let i = 0; i < out.length; i++) {
      const p = i * ratio, i0 = Math.floor(p), i1 = Math.min(i0 + 1, pcm.length - 1), t = p - i0;
      out[i] = pcm[i0] * (1 - t) + pcm[i1] * t;
    }
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
