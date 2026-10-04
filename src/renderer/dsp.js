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
  function createEchoGate({ subMs = 10, historySec = 4.5, fitSec = 3, maxLagMs = 350, corrMin = 0.5, prominence = 0.25, margin = 2.0, hangoverMs = 400, sysActive = 0.002, micFloor = 0.0015, unsureFloor = 0.02, epCorr = 0.6, epStable = 3 } = {}) {
    const N = Math.round((historySec * 1000) / subMs);
    const sysEnv = new Float32Array(N), micEnv = new Float32Array(N);
    const W = Math.round((fitSec * 1000) / subMs), L = Math.round(maxLagMs / subMs);
    let written = 0, last = { corr: 0, gain: 0, lag: 0 }, seen = null, keepUntil = -1, stable = 0, lastLag = -99, userLevel = 0, epLag = -99, epAt = 0, epCount = 0;
    const put = (ring, env, at) => { const end = Math.floor(at / subMs); for (let i = 0; i < env.length; i++) { const k = end - env.length + 1 + i; if (k >= 0) ring[((k % N) + N) % N] = env[i]; } };
    return {
      // env: per-10 ms rms values of the frame that ends at time `at` (ms)
      system(env, at) { put(sysEnv, env, at); written += env.length; },
      // hint (optional, from the echo canceller): { user, converged } — whether what is left after
      // removing the predicted bleed is more than residue, and whether the canceller has learned the path
      mic(env, at, hint) {
        put(micEnv, env, at);
        const end = Math.floor(at / subMs);
        let sysMax = 0, active = 0; for (let k = end - W - L; k <= end; k++) { const v = sysEnv[((k % N) + N) % N]; if (v > sysMax) sysMax = v; if (v > sysActive) active++; }
        let mic = 0; for (let i = 0; i < env.length; i++) mic += env[i]; mic /= env.length || 1;
        if (sysMax < sysActive) {
          // the other side is silent: anything speech-like on the mic is you — learn how loud you are
          if (mic > micFloor * 4) { userLevel = userLevel ? userLevel * 0.9 + mic * 0.1 : mic; keepUntil = at + hangoverMs; } // you are mid-sentence: stay open if the other side cuts in
          return { duck: false, corr: 0, predicted: 0 };
        }
        // no evidence yet: less than ~1 s of call audio in the window to correlate against -> conservative
        if (written < W || active < 100) {
          if (hint && hint.user && (hint.converged || mic > Math.max(unsureFloor, userLevel * 0.4))) keepUntil = at + hangoverMs;
          return { duck: at <= keepUntil ? false : true, corr: 0, predicted: 0, warming: true, why: 'warming' };
        }
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
        // Is what the mic picks up really the call audio? Real speaker bleed shows up as strong evidence
        // again and again, always at the SAME delay (it is a physical path); a chance match between two
        // unrelated voices on headphones comes once, at some random delay.
        // This decides whether a canceller that has NOT learned the path means "there is no bleed"
        // (headphones: trust the mic) or "there is bleed and the canceller is failing" (keep the old rules).
        const strong = evidence;
        if (best.corr >= epCorr && stable >= epStable) {
          if (Math.abs(best.lag - epLag) <= 2) { if (at - epAt > 2000) { epCount++; epAt = at; } }
          else { epLag = best.lag; epAt = at; epCount = 1; }
        }
        const realBleed = epCount >= 2 && at - epAt < 60000;
        // (a canceller that has listened for 6 s of call audio and found nothing to cancel says there is
        // probably no bleed at all — headphones — and a remembered coupling was then a chance match: forget it fast)
        const memoryMs = hint && !hint.converged && !realBleed ? 3000 : 60000;
        if (!evidence && seen && at - seen.at < memoryMs) { pred = seen.gain * delayedLevel(seen.lag); evidence = true; } // the physical coupling does not change on this timescale
        // speech is continuous: once a frame is clearly you, hold the gate open briefly so the
        // quiet troughs between your syllables are not zeroed (that would chop words)
        let isUser;
        // the canceller has learned the path: it knows sample by sample what the bleed is, so what it
        // leaves is judged against its own residue instead of a level guess (quiet words survive)
        // (unless the envelope says, right now and unmistakably, that this frame is the call audio at the
        // level bleed would have: then the canceller has lost the path — a device hiccup — and is not believed)
        if (hint && hint.converged) isUser = hint.user && !(strong && mic <= margin * predicted);
        else if (evidence) isUser = mic > micFloor && mic > margin * pred;
        // No correlation evidence yet (quiet speakers, or the fit has not settled) while the other side is
        // talking: do not assume the mic is clean. Keep it only if it is at your own speaking level —
        // learned from when you spoke alone — or, before that is known, clearly loud. Quiet bleed stays out;
        // on headphones your voice still passes.
        // With a canceller that has found no echo to remove either (headphones), whatever is on the mic is you.
        else isUser = hint && !realBleed ? hint.user : mic > Math.max(unsureFloor, userLevel * 0.4);
        if (isUser) keepUntil = at + hangoverMs;
        const duck = !isUser && at > keepUntil;
        return { duck, corr: best.corr, predicted: pred, gain, lag: last.lag, why: hint && hint.converged ? 'canceller' : evidence ? 'level' : 'unsure' };
      },
      get coupling() { return last.gain; },
      get corr() { return last.corr; },
    };
  }

  // ---- echo canceller ----
  // The gate above can only keep or silence a whole frame, by level: when you talk
  // over the call on speakers, any of your words that are not clearly louder than
  // the bleed are lost with it. This removes the bleed itself: an adaptive filter
  // learns how the call audio arrives at the microphone (delay, loudness, tone,
  // room) and subtracts its prediction, leaving your voice. The gate then judges
  // what is left, where the bleed is 10–30 dB weaker.
  // Partitioned-block frequency-domain NLMS, 16 kHz: 32 ms blocks, 12 partitions =
  // 384 ms of echo path, from 64 ms before to 320 ms after the call audio (so a mic
  // whose capture runs slightly ahead of the loopback's is still covered).
  // The two streams are lined up by the AUDIO CLOCK, not by counting samples: they
  // start at different moments and their blocks reach the page unevenly under load,
  // and pairing them by count would misalign them for good. Each block says where on
  // the clock it ends; the call audio is kept on that timeline, and every piece of
  // microphone audio is matched with the call audio from the same instant.
  // Nothing from the microphone is ever dropped or replaced by silence: if the call
  // audio for an instant is late, the mic waits for it (up to 0.5 s), then goes on
  // without it. So mic() returns however much is ready — sometimes less, sometimes
  // more than it was given — and `outEnd` says where on the clock that output ends.
  // The step shrinks with the error power, so your own voice (which the filter
  // cannot predict) slows learning instead of corrupting it. It can never make
  // things worse: a block that comes out louder than it went in is passed through.
  function createFft(n) {
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2), rev = new Uint32Array(n);
    let bits = 0; while ((1 << bits) < n) bits++;
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); }
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b); rev[i] = r; }
    return (re, im, inverse) => {
      for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
      for (let size = 2; size <= n; size *= 2) {
        const half = size / 2, step = n / size;
        for (let i = 0; i < n; i += size) for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cos[k], wi = inverse ? sin[k] : -sin[k], a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
      if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    };
  }
  function createFifo() {
    let buf = new Float32Array(8192), n = 0;
    return {
      get length() { return n; },
      push(x) { if (n + x.length > buf.length) { const b = new Float32Array(Math.max(buf.length * 2, n + x.length)); b.set(buf.subarray(0, n)); buf = b; } buf.set(x, n); n += x.length; },
      take(k) { const out = buf.slice(0, k); buf.copyWithin(0, k, n); n -= k; return out; },
      drop(k) { buf.copyWithin(0, k, n); n -= k; },
    };
  }
  function createEchoCanceller({ block = 512, parts = 12, mu = 0.5, robust = 32, micDelay = 1024, userFloor = 0.003, rhoDown = 0.3, rhoUp = 1.005, keep = 6, matureBlocks = 190, maxWait = 8000 } = {}) {
    const B = block, N = 2 * B, P = parts, fft = createFft(N);
    const mk = () => Array.from({ length: P }, () => new Float64Array(N));
    const Xr = mk(), Xi = mk(), Wr = mk(), Wi = mk();
    const refBuf = new Float64Array(N), Yr = new Float64Array(N), Yi = new Float64Array(N), Er = new Float64Array(N), Ei = new Float64Array(N), sum = new Float64Array(N), pw = new Float64Array(N);
    const RING = 1 << 17, MASK = RING - 1, ring = new Float32Array(RING); // the call audio on the clock (~8 s)
    let refEnd = -1;                       // clock position (16 kHz samples) just past the newest call audio
    const micIn = createFifo(); let micPos = -1; // microphone audio waiting, and the clock position of its first sample
    const D = micDelay;
    let head = 0, inPow = 0, outPow = 0, refSeen = 0;
    const px = new Float64Array(P);
    let active = 0, rho = 1, noise = 0, accE = 0, accY = 0, accN = 0; // rho: residue power / predicted-bleed power when only bleed is present
    const stats = { blocks: 0, passed: 0, starved: 0, resync: 0, gaps: 0 };
    function step(d, x) {
      refBuf.copyWithin(0, B); refBuf.set(x, B);
      head = (head + P - 1) % P;
      const xr = Xr[head], xi = Xi[head]; xr.set(refBuf); xi.fill(0); fft(xr, xi, false);
      Yr.fill(0); Yi.fill(0); sum.fill(0);
      for (let p = 0; p < P; p++) {
        const ar = Xr[(head + p) % P], ai = Xi[(head + p) % P], wr = Wr[p], wi = Wi[p];
        for (let k = 0; k < N; k++) { Yr[k] += wr[k] * ar[k] - wi[k] * ai[k]; Yi[k] += wr[k] * ai[k] + wi[k] * ar[k]; sum[k] += ar[k] * ar[k] + ai[k] * ai[k]; }
      }
      fft(Yr, Yi, true);
      const e = new Float32Array(B); let ed = 0, ee = 0, ex = 0;
      let ey = 0;
      for (let i = 0; i < B; i++) { const y = Yr[B + i]; e[i] = d[i] - y; ey += y * y; ed += d[i] * d[i]; ee += e[i] * e[i]; ex += x[i] * x[i]; }
      stats.blocks++;
      const out2 = Math.min(ee, ed);
      accE += out2; accY += ey; accN += B;
      // the quietest the microphone gets = its noise floor (rises slowly, falls at once)
      noise = noise ? (out2 / B < noise ? out2 / B : noise * 1.01) : out2 / B;
      // how much of the predicted bleed is left over: learned from the moments with the least left
      // (those are bleed alone), creeping up slowly in case the room changes
      if (ey / B > 1e-6) { const r = out2 / ey; rho = r < rho ? (1 - rhoDown) * rho + rhoDown * r : Math.min(1, rho * rhoUp); }
      // call audio anywhere in the filter's reach (not just this block: the bleed of a word arrives
      // after the word, often while the call itself has already gone quiet)
      px[head] = ex / B; let reach = 0; for (let p = 0; p < P; p++) reach += px[p];
      if (reach < 1e-9) return d; // the call has been silent: nothing to remove, nothing to learn
      if (reach > 1e-6) active++;
      Er.fill(0); Ei.fill(0); for (let i = 0; i < B; i++) Er[B + i] = e[i];
      fft(Er, Ei, false);
      // normalise by the call audio's power in each band, smoothed over time (a band that happens to
      // be empty in this instant must not get a huge step), with a floor relative to the whole spectrum
      let mean = 0; for (let k = 0; k < N; k++) { pw[k] = pw[k] ? 0.8 * pw[k] + 0.2 * sum[k] : sum[k]; mean += pw[k]; }
      const floor = 0.01 * (mean / N) + 1e-9;
      for (let p = 0; p < P; p++) {
        const ar = Xr[(head + p) % P], ai = Xi[(head + p) % P], wr = Wr[p], wi = Wi[p];
        for (let k = 0; k < N; k++) {
          const g = mu / (pw[k] + robust * P * (Er[k] * Er[k] + Ei[k] * Ei[k]) + floor);
          wr[k] += g * (ar[k] * Er[k] + ai[k] * Ei[k]);
          wi[k] += g * (ar[k] * Ei[k] - ai[k] * Er[k]);
        }
      }
      // keep each partition a causal B-tap filter
      for (let c = 0; c < P; c++) { const cr = Wr[c], ci = Wi[c]; fft(cr, ci, true); for (let i = B; i < N; i++) cr[i] = 0; ci.fill(0); fft(cr, ci, false); }
      inPow = 0.98 * inPow + 0.02 * (ed / B); outPow = 0.98 * outPow + 0.02 * (Math.min(ee, ed) / B);
      if (ee > ed) { stats.passed++; return d; } // never louder than what came in
      return e;
    }
    return {
      stats, last: { user: true, converged: false, residue: 1 }, outEnd: 0,
      // call audio (16 kHz). endPos: clock position just past its last sample (omitted: right after the previous block)
      ref(pcm, endPos) {
        if (!pcm.length) return;
        if (endPos == null) endPos = (refEnd < 0 ? 0 : refEnd) + pcm.length;
        let start = endPos - pcm.length;
        if (refEnd >= 0 && Math.abs(start - refEnd) <= 3) start = refEnd; // resampler jitter: stay seamless
        else if (refEnd >= 0) stats.resync++;
        if (refEnd >= 0 && start > refEnd) { stats.gaps++; for (let p = Math.max(refEnd, start - RING); p < start; p++) ring[p & MASK] = 0; } // a gap in the call audio: silence
        for (let i = 0; i < pcm.length; i++) ring[(start + i) & MASK] = pcm[i];
        refEnd = Math.max(refEnd, start + pcm.length); refSeen += pcm.length;
      },
      // microphone audio (16 kHz) -> the call audio removed; returns what is ready (see above)
      mic(pcm, endPos) {
        const expect = micPos < 0 ? -1 : micPos + micIn.length;
        if (endPos == null) endPos = (expect < 0 ? 0 : expect) + pcm.length;
        let start = endPos - pcm.length;
        if (expect >= 0 && Math.abs(start - expect) <= 3) start = expect;
        const outs = [];
        if (expect >= 0 && start !== expect) { // the mic stream jumped (a stall, a device change): let what is waiting through as it is
          stats.resync++;
          if (micIn.length) outs.push(micIn.take(micIn.length));
        }
        if (!micIn.length) micPos = start;
        micIn.push(pcm);
        const x = new Float32Array(B);
        while (micIn.length >= B) {
          const from = micPos + D;                  // call audio for this block of the mic (with 64 ms of look-ahead)
          if (refEnd < from + B && refSeen && micIn.length - B < maxWait) break; // not here yet: wait for it
          if (refEnd < from + B && refSeen) stats.starved++;
          for (let i = 0; i < B; i++) { const p = from + i; x[i] = p < refEnd && p >= refEnd - RING ? ring[p & MASK] : 0; }
          outs.push(step(micIn.take(B), x));
          micPos += B;
        }
        this.outEnd = micPos;
        // verdict for this stretch: is there more on the mic than the residue of the predicted bleed?
        // Only bleed is ever silenced: with no bleed predicted (headphones, the call silent, a noisy room)
        // everything is kept — noise is the recognizer's business, not the gate's.
        const pe = accN ? accE / accN : 0, py = accN ? accY / accN : 0;
        if (accN) this.last = { user: py < noise + 1e-9 || pe > keep * rho * py + 4 * noise + userFloor * userFloor * 0.1, converged: rho < 0.25, mature: active > matureBlocks, residue: rho };
        accE = accY = accN = 0;
        if (outs.length === 1) return outs[0];
        const n = outs.reduce((s, o) => s + o.length, 0), r = new Float32Array(n); let o = 0; for (const a of outs) { r.set(a, o); o += a.length; }
        return r;
      },
      // microphone audio still waiting for its call audio (samples)
      get pending() { return micIn.length; },
      // how much quieter the microphone is after cancelling, in dB (0 = nothing removed)
      get reduction() { return inPow > 1e-9 && outPow > 0 ? 10 * Math.log10(inPow / outPow) : 0; },
    };
  }

  function rmsOf(x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return x.length ? Math.sqrt(s / x.length) : 0; }
  // rms per `subMs` sub-block of a frame at `rate` (the envelopes the echo gate works on)
  function subRms(x, rate, subMs = 10) {
    const n = Math.max(1, Math.round((subMs / 1000) * rate)), out = new Float32Array(Math.max(1, Math.floor(x.length / n)));
    for (let k = 0; k < out.length; k++) { let s = 0; for (let i = k * n; i < (k + 1) * n; i++) s += x[i] * x[i]; out[k] = Math.sqrt(s / n); }
    return out;
  }

  return { createResampler, createHighpass, createAgc, createEchoGate, createEchoCanceller, rmsOf, subRms };
});
