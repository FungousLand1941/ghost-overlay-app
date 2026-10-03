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
  // Bleed is a delayed, attenuated copy of the call audio; your voice is not.
  // Both sources keep a 10 ms level envelope over the last few seconds. For each
  // mic frame the mic envelope is correlated with the system envelope over a
  // range of delays (0–350 ms): a strong correlation means bleed is present,
  // and the fitted gain at the best delay predicts how loud that bleed should
  // be right now. The frame is silenced only if bleed is present AND the mic
  // is no louder than the predicted bleed. So: speakers with you silent ->
  // silenced; you talking over the other side -> kept (well above the
  // prediction); headphones -> no correlation, nothing is ever silenced.
  // Until ~1 s of overlap has been seen it stays conservative.
  function createEchoGate({ subMs = 10, historySec = 4.5, fitSec = 3, maxLagMs = 350, corrMin = 0.5, prominence = 0.25, margin = 2.0, hangoverMs = 400, sysActive = 0.002, micFloor = 0.0015, unsureFloor = 0.02 } = {}) {
    const N = Math.round((historySec * 1000) / subMs);
    const sysEnv = new Float32Array(N), micEnv = new Float32Array(N);
    const W = Math.round((fitSec * 1000) / subMs), L = Math.round(maxLagMs / subMs);
    let written = 0, last = { corr: 0, gain: 0, lag: 0 }, seen = null, keepUntil = -1, stable = 0, lastLag = -99, userLevel = 0;
    const put = (ring, env, at) => { const end = Math.floor(at / subMs); for (let i = 0; i < env.length; i++) { const k = end - env.length + 1 + i; if (k >= 0) ring[((k % N) + N) % N] = env[i]; } };
    return {
      // env: per-10 ms rms values of the frame that ends at time `at` (ms)
      system(env, at) { put(sysEnv, env, at); written += env.length; },
      mic(env, at) {
        put(micEnv, env, at);
        const end = Math.floor(at / subMs);
        let sysMax = 0, active = 0; for (let k = end - W - L; k <= end; k++) { const v = sysEnv[((k % N) + N) % N]; if (v > sysMax) sysMax = v; if (v > sysActive) active++; }
        let mic = 0; for (let i = 0; i < env.length; i++) mic += env[i]; mic /= env.length || 1;
        if (sysMax < sysActive) {
          // the other side is silent: anything speech-like on the mic is you — learn how loud you are
          if (mic > micFloor * 4) userLevel = userLevel ? userLevel * 0.9 + mic * 0.1 : mic;
          return { duck: false, corr: 0, predicted: 0 };
        }
        // no evidence yet: less than ~1 s of call audio in the window to correlate against -> conservative
        if (written < W || active < 100) return { duck: at <= keepUntil ? false : true, corr: 0, predicted: 0, warming: true };
        // best-correlated delay on log envelopes (robust to peaks), gain by least squares on linear ones
        let best = { corr: -1, lag: 0 }; const corrs = [];
        const lm = new Float32Array(W), ls = new Float32Array(W);
        for (let i = 0; i < W; i++) lm[i] = Math.log(micEnv[(((end - W + 1 + i) % N) + N) % N] + 1e-4);
        let mm = 0; for (let i = 0; i < W; i++) mm += lm[i]; mm /= W;
        for (let lag = 0; lag <= L; lag++) {
          let ms = 0; for (let i = 0; i < W; i++) { ls[i] = Math.log(sysEnv[(((end - W + 1 + i - lag) % N) + N) % N] + 1e-4); ms += ls[i]; } ms /= W;
          let sxy = 0, sxx = 0, syy = 0;
          for (let i = 0; i < W; i++) { const a = lm[i] - mm, b = ls[i] - ms; sxy += a * b; sxx += a * a; syy += b * b; }
          const corr = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
          corrs.push(corr);
          if (corr > best.corr) best = { corr, lag };
        }
        let num = 0, den = 0;
        for (let i = 0; i < W; i++) { const m = micEnv[(((end - W + 1 + i) % N) + N) % N], s = sysEnv[(((end - W + 1 + i - best.lag) % N) + N) % N]; num += m * s; den += s * s; }
        const gain = den > 0 ? num / den : 0;
        // level of the delayed call audio under this frame, plus half of its last-300 ms peak:
        // the mic keeps ringing after the call audio stops (room decay), at a falling level
        const delayedLevel = (lag) => { let cur = 0, m = 0; for (let k = end - env.length + 1 - lag - 30; k <= end - lag; k++) { const v = sysEnv[((k % N) + N) % N]; if (v > m) m = v; if (k > end - env.length - lag && v > cur) cur = v; } return Math.max(cur, 0.5 * m); };
        const predicted = gain * delayedLevel(best.lag);
        // real bleed arrives at one fixed delay: a sharp correlation peak that stays put frame to frame;
        // a chance correlation between two unrelated voices is broad and wanders
        const sorted = corrs.slice().sort((a, b) => a - b), median = sorted[sorted.length >> 1];
        const peaked = best.corr - median >= prominence;
        stable = peaked && Math.abs(best.lag - lastLag) <= 2 ? stable + 1 : 0; lastLag = best.lag;
        last = { corr: best.corr, gain, lag: best.lag * subMs };
        // While you talk over the other side the correlation drops (your voice is
        // not in the call audio), so remember the coupling from the last clean
        // bleed and keep predicting with it for a few seconds: bleed right after
        // your words is still recognised as bleed.
        // remember the coupling from clean bleed (strong, stable correlation); while you talk the fit is
        // polluted by your own voice, so never let it inflate the remembered gain quickly
        if (best.corr >= 0.6 && stable >= 3 && gain > 0 && (!seen || gain <= seen.gain * 1.3 || at - seen.at > 60000)) seen = { gain, lag: best.lag, at };
        // strong correlation = bleed dominates the mic right now: the fresh fit is clean, use it;
        // otherwise (you are talking, or a pause) predict with the remembered clean coupling
        let pred = predicted, evidence = best.corr >= 0.6 && stable >= 3;
        if (!evidence && seen && at - seen.at < 60000) { pred = seen.gain * delayedLevel(seen.lag); evidence = true; } // the physical coupling does not change on this timescale
        // speech is continuous: once a frame is clearly you, hold the gate open briefly so the
        // quiet troughs between your syllables are not zeroed (that would chop words)
        let isUser;
        if (evidence) isUser = mic > micFloor && mic > margin * pred;
        // No correlation evidence yet (quiet speakers, or the fit has not settled) while the other side is
        // talking: do not assume the mic is clean. Keep it only if it is at your own speaking level —
        // learned from when you spoke alone — or, before that is known, clearly loud. Quiet bleed stays out;
        // on headphones your voice still passes.
        else isUser = mic > Math.max(unsureFloor, userLevel * 0.4);
        if (isUser) keepUntil = at + hangoverMs;
        const duck = !isUser && at > keepUntil;
        return { duck, corr: best.corr, predicted: pred, gain, lag: last.lag };
      },
      get coupling() { return last.gain; },
      get corr() { return last.corr; },
    };
  }

  function rmsOf(x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return x.length ? Math.sqrt(s / x.length) : 0; }
  // rms per `subMs` sub-block of a frame at `rate` (the envelopes the echo gate works on)
  function subRms(x, rate, subMs = 10) {
    const n = Math.max(1, Math.round((subMs / 1000) * rate)), out = new Float32Array(Math.max(1, Math.floor(x.length / n)));
    for (let k = 0; k < out.length; k++) { let s = 0; for (let i = k * n; i < (k + 1) * n; i++) s += x[i] * x[i]; out[k] = Math.sqrt(s / n); }
    return out;
  }

  return { createResampler, createHighpass, createAgc, createEchoGate, rmsOf, subRms };
});
