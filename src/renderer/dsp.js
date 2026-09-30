// Signal processing shared by the renderer capture path (audio.js) and the
// offline accuracy benchmark (test/stt-bench.js), so what is measured is what
// ships. Pure functions/closures, no browser or Node APIs.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GhostDSP = api;
})(typeof self !== 'undefined' ? self : this, function () {
  function bessel0(x) {
    let sum = 1, term = 1; const q = (x * x) / 4;
    for (let k = 1; k < 50; k++) { term *= q / (k * k); sum += term; if (term < 1e-12 * sum) break; }
    return sum;
  }

  // Streaming Kaiser-windowed-sinc resampler for any rate pair (48k / 44.1k -> 16k).
  // ~80 dB stop-band: nothing above the new Nyquist folds back into the speech
  // band (the old two-pole filter only managed a few dB there), and the
  // pass-band stays flat to ~7 kHz. Phase is carried across calls, so frame
  // boundaries are seamless. ~200 taps per output sample: trivial CPU at 16 kHz.
  function createResampler(inRate, outRate, { zeroCrossings = 32, beta = 8.6, cutoff = 0.94 } = {}) {
    if (inRate === outRate) return { process: (x) => x, reset() {} };
    const ratio = inRate / outRate;
    const fc = 0.5 * cutoff * Math.min(1, outRate / inRate); // cut-off, cycles per input sample
    const T = Math.ceil(zeroCrossings / (2 * fc));           // kernel half-width, input samples
    const R = 64;                                            // kernel table resolution per input sample
    const table = new Float32Array(T * R + 2);
    const b0 = bessel0(beta);
    for (let i = 0; i < table.length; i++) {
      const t = i / R;
      if (t > T) { table[i] = 0; continue; }
      const x = 2 * fc * t;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      table[i] = 2 * fc * sinc * bessel0(beta * Math.sqrt(1 - (t / T) * (t / T))) / b0;
    }
    let buf = new Float32Array(0), pos = 0; // pos: centre of the next output, in input samples from buf[0]
    return {
      process(x) {
        const b = new Float32Array(buf.length + x.length); b.set(buf); b.set(x, buf.length);
        const out = new Float32Array(Math.max(0, Math.ceil((b.length - T - pos) / ratio) + 1));
        let o = 0;
        while (pos + T < b.length) {
          const k0 = Math.max(0, Math.ceil(pos - T)), k1 = Math.floor(pos + T);
          let acc = 0;
          for (let k = k0; k <= k1; k++) {
            const d = Math.abs(pos - k) * R; const i = d | 0;
            acc += b[k] * (table[i] + (table[i + 1] - table[i]) * (d - i));
          }
          out[o++] = acc; pos += ratio;
        }
        const keep = Math.max(0, Math.min(b.length, Math.floor(pos - T)));
        buf = b.slice(keep); pos -= keep;
        return out.subarray(0, o);
      },
      reset() { buf = new Float32Array(0); pos = 0; },
    };
  }

  // 2nd-order high-pass: removes DC offset and mains/desk rumble below the voice.
  function createHighpass(rate, freq = 70, q = 0.707) {
    const w = (2 * Math.PI * freq) / rate, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
    const a0 = 1 + al, b0 = (1 + cs) / 2 / a0, b1 = -(1 + cs) / a0, b2 = b0, a1 = (-2 * cs) / a0, a2 = (1 - al) / a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return {
      process(x) {
        for (let i = 0; i < x.length; i++) {
          const v = x[i]; const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
          x2 = x1; x1 = v; y2 = y1; y1 = y; x[i] = y;
        }
        return x;
      },
    };
  }

  // Slow, click-free level control. Gain follows a peak envelope (instant
  // attack, ~3 s release), is ramped linearly across each frame, and is capped
  // so a frame can never clip — no limiter, no distortion. Frames that are only
  // noise (below `floor`) don't move the envelope, so silence isn't pumped up.
  function createAgc({ rate = 16000, target = 0.25, maxGain = 16, floor = 0.0015, releaseSec = 3 } = {}) {
    let env = 0, gain = 1;
    return {
      process(x) {
        const n = x.length; if (!n) return x;
        let peak = 0; for (let i = 0; i < n; i++) { const a = x[i] < 0 ? -x[i] : x[i]; if (a > peak) peak = a; }
        if (peak > floor) env = peak > env ? peak : env + (peak - env) * (1 - Math.exp(-(n / rate) / releaseSec));
        let next = env > floor ? Math.min(maxGain, Math.max(1, target / env)) : gain;
        let start = gain;
        if (peak > 0) { const cap = 0.95 / peak; if (start > cap) start = cap; if (next > cap) next = cap; }
        const step = (next - start) / n;
        let g = start; for (let i = 0; i < n; i++) { x[i] *= g; g += step; }
        gain = next;
        return x;
      },
      get gain() { return gain; },
    };
  }

  // Is this mic frame only the speakers bleeding into the microphone?
  // The speaker->mic coupling (mic level / system level while the system is
  // playing) is learned from the quietest such frames — the ones where the user
  // is not talking. A mic frame well above that is the user speaking over the
  // other side and is kept. On headphones the coupling is ~0, so nothing the
  // user says is ever dropped. Until enough frames are seen it is conservative.
  function createEchoGate({ sysActive = 0.002, windowMs = 450, warmup = 25, history = 160, margin = 2.5, percentile = 0.2, micFloor = 0.004 } = {}) {
    const sys = [];    // recent system frames { at, rms }
    const ratios = []; // mic/system level ratios observed while the system was playing
    let coupling = null;
    return {
      system(rms, at) { sys.push({ at, rms }); while (sys.length && sys[0].at < at - 2000) sys.shift(); },
      mic(rms, at) {
        let ref = 0;
        for (const f of sys) if (f.at >= at - windowMs && f.at <= at + 60 && f.rms > ref) ref = f.rms;
        if (ref < sysActive) return { duck: false, ref, coupling };
        const ratio = rms / ref;
        ratios.push(ratio); if (ratios.length > history) ratios.shift();
        if (ratios.length < warmup) return { duck: true, ref, coupling, warming: true };
        coupling = ratios.slice().sort((a, b) => a - b)[Math.floor(ratios.length * percentile)];
        return { duck: !(rms > micFloor && ratio > coupling * margin), ref, coupling };
      },
      get coupling() { return coupling; },
      get samples() { return ratios.length; },
    };
  }

  function rmsOf(x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return x.length ? Math.sqrt(s / x.length) : 0; }

  return { createResampler, createHighpass, createAgc, createEchoGate, rmsOf };
});
