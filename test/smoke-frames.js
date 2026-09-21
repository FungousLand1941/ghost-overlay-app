// Frame-level check of the streaming audio path: run the capture in stream mode
// for a few seconds (the harness plays TTS through the speakers meanwhile) and
// report, per source, how many frames were emitted, how many were ducked to
// silence, and the loudest frame actually handed to the transport.
(async () => {
  const out = { system: { frames: 0, zero: 0, maxRms: 0, maxInt16: 0 }, mic: { frames: 0, zero: 0, maxRms: 0, maxInt16: 0 } };
  const source = (await window.ghost.getConfig()).transcription.sourceOverride || 'both';
  out.source = source;
  const c = new AudioChunker({
    source, chunkSeconds: 5,
    onFrame: (name, b64, info) => {
      const s = out[name]; s.frames++;
      const bin = atob(b64); let max = 0;
      for (let i = 0; i < bin.length; i += 2) { const v = (bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8)) << 16 >> 16; max = Math.max(max, Math.abs(v)); }
      if (max === 0) s.zero++;
      s.maxInt16 = Math.max(s.maxInt16, max);
      s.maxRms = Math.max(s.maxRms, info.rms);
    },
    onError: () => {}, onStatus: () => {},
  });
  try {
    const started = await c.start();
    out.active = started.active;
    await new Promise((r) => setTimeout(r, 6000));
    out.framesDucked = c.stats.framesDucked;
    out.lastSysActiveAt = c.lastSysActiveAt;
  } catch (e) { out.error = e.message; } finally { c.stop(); }
  return out;
})();
