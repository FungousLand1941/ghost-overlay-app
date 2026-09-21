(async () => {
  const out = {};
  // 'both' is the default: system loopback (the call) + mic (you), mixed.
  const chunks = [];
  const c = new AudioChunker({ source: 'both', chunkSeconds: 1, onChunk: (b64, info) => chunks.push(info), onError: () => {}, onStatus: () => {} });
  try {
    const started = await c.start();
    out.active = started.active; out.startErrors = started.errors; out.sampleRate = c.rate;
    let peak = { system: 0, mic: 0 };
    const t0 = Date.now();
    while (Date.now() - t0 < 2600) {
      const lv = c.levels();
      for (const k of Object.keys(lv)) peak[k] = Math.max(peak[k] || 0, lv[k]);
      await new Promise((r) => setTimeout(r, 50));
    }
    out.peakLevels = peak;
    out.chunksEmitted = chunks.length;
    out.chunkInfo = chunks.map((i) => ({ seconds: +i.seconds.toFixed(2), rms: +i.rms.toFixed(4) }));
    out.silentSkipped = c.stats.chunksSkippedSilent;
  } catch (e) { out.error = e.message; } finally { c.stop(); }
  return out;
})();
