// Capture DSP (src/renderer/dsp.js): resampler fidelity and alias rejection,
// seamless frame boundaries, click-free gain that never clips, rumble filter,
// and the echo gate (headphones / speakers / talking over the other side).
const dsp = require('../src/renderer/dsp');

let n = 0;
function check(name, ok, extra) { n++; if (!ok) { console.error('FAIL', name, extra ?? ''); process.exit(1); } console.log('ok', name); }
const sine = (rate, hz, sec, amp = 1) => { const a = new Float32Array(Math.round(rate * sec)); for (let i = 0; i < a.length; i++) a[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate); return a; };
const rms = (a, from = 0, to = a.length) => { let s = 0; for (let i = from; i < to; i++) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, to - from)); };
const peak = (a) => { let p = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i]) > p) p = Math.abs(a[i]); return p; };
const db = (x) => 20 * Math.log10(Math.max(x, 1e-12));
const resampleAll = (inRate, x, frame = 0) => {
  const rs = dsp.createResampler(inRate, 16000);
  if (!frame) return Float32Array.from(rs.process(x));
  const parts = []; for (let i = 0; i < x.length; i += frame) parts.push(Float32Array.from(rs.process(x.subarray(i, Math.min(x.length, i + frame)))));
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
};

// 1. resampler: pass-band, stop-band, length, frame seamlessness
for (const rate of [48000, 44100]) {
  const y1k = resampleAll(rate, sine(rate, 1000, 1));
  check(`${rate}->16k: 1 kHz passes at unity (±0.1 dB)`, Math.abs(db(rms(y1k, 2000, y1k.length - 2000) / Math.SQRT1_2)) < 0.1, db(rms(y1k, 2000, y1k.length - 2000) / Math.SQRT1_2));
  const y7k = resampleAll(rate, sine(rate, 7000, 1));
  check(`${rate}->16k: 7 kHz still within 1 dB`, Math.abs(db(rms(y7k, 2000, y7k.length - 2000) / Math.SQRT1_2)) < 1, db(rms(y7k, 2000, y7k.length - 2000) / Math.SQRT1_2));
  for (const hz of [9000, 12000, 15000]) {
    const y = resampleAll(rate, sine(rate, hz, 1));
    check(`${rate}->16k: ${hz} Hz (would alias) rejected by > 60 dB`, db(rms(y, 2000, y.length - 2000) / Math.SQRT1_2) < -60, db(rms(y, 2000, y.length - 2000) / Math.SQRT1_2));
  }
  check(`${rate}->16k: output length matches the rate ratio`, Math.abs(y1k.length - 16000) <= 40, y1k.length);
  const x = sine(rate, 440, 1.3);
  const whole = resampleAll(rate, x), framed = resampleAll(rate, x, 4096);
  let maxd = 0; for (let i = 0; i < Math.min(whole.length, framed.length); i++) maxd = Math.max(maxd, Math.abs(whole[i] - framed[i]));
  check(`${rate}->16k: 4096-sample frames give the same signal as one pass (no seams)`, maxd < 1e-5 && Math.abs(whole.length - framed.length) <= 1, [maxd, whole.length, framed.length]);
}
check('same rate is a pass-through', dsp.createResampler(16000, 16000).process(sine(16000, 300, 0.1)).length === 1600);

// 2. high-pass
const hp = dsp.createHighpass(16000);
const dc = new Float32Array(16000).fill(0.5); hp.process(dc);
check('high-pass removes DC', Math.abs(dc[dc.length - 1]) < 1e-3, dc[dc.length - 1]);
const v = sine(16000, 1000, 1, 0.5); dsp.createHighpass(16000).process(v);
check('high-pass leaves the voice band alone', Math.abs(db(rms(v, 4000) / (0.5 * Math.SQRT1_2))) < 0.1);

// 3. AGC: lifts quiet audio, never clips, no gain steps, does not pump silence
const frames = (x, f = 1365) => { const out = []; for (let i = 0; i < x.length; i += f) out.push(x.slice(i, i + f)); return out; };
{
  const agc = dsp.createAgc({ rate: 16000 });
  const quiet = frames(sine(16000, 300, 3, 0.01)).map((f) => agc.process(f));
  const last = quiet[quiet.length - 2];
  check('AGC lifts very quiet audio (peak 0.01 -> ~0.16, max gain 16x)', peak(last) > 0.15 && peak(last) < 0.17, peak(last));
  const loud = agc.process(sine(16000, 300, 0.085, 0.9));
  check('sudden loud frame after quiet never clips', peak(loud) <= 0.951, peak(loud));
  const sig = sine(16000, 200, 3, 0.02); const out = frames(sig).map((f) => dsp.createAgc && f); // placeholder to keep shapes equal
  const agc2 = dsp.createAgc({ rate: 16000 }); const y = new Float32Array(sig.length); let o = 0; for (const f of frames(sig)) { const p = agc2.process(f); y.set(p, o); o += p.length; }
  let maxStep = 0; for (let i = 1; i < y.length; i++) maxStep = Math.max(maxStep, Math.abs(y[i] - y[i - 1]));
  const expected = 2 * Math.PI * 200 / 16000 * peak(y); // steepest slope of a clean sine at the output level
  check('gain changes are ramped (no clicks at frame boundaries)', maxStep < expected * 1.25 && out.length > 0, [maxStep, expected]);
  const agc3 = dsp.createAgc({ rate: 16000 }); agc3.process(sine(16000, 300, 0.085, 0.05));
  const g0 = agc3.gain; for (let i = 0; i < 100; i++) agc3.process(new Float32Array(1365).map(() => (Math.random() - 0.5) * 0.001));
  check('silence / noise floor does not pump the gain up', agc3.gain === g0, [g0, agc3.gain]);
}

// 4. echo gate — 10 ms envelopes, 80 ms frames, speech-like modulation, 120 ms speaker->mic delay
{
  const SUB = 8; // sub-blocks per frame
  const rnd = (() => { let a = 12345; return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; }; })();
  // a talker: syllable-rate modulation with pauses; returns level at 10 ms step k
  const talker = (rate, level, seed) => { let pauseUntil = -1; return (k) => { if (k % 150 === seed) pauseUntil = k + 40; if (k < pauseUntil) return 0; return level * (0.25 + Math.abs(Math.sin(2 * Math.PI * rate * k * 0.01))) * (0.85 + 0.3 * rnd()); }; };
  const run = (scenario, frames = 220) => {
    const gate = dsp.createEchoGate();
    const sysHist = []; let kept = 0, ducked = 0, userKept = 0, userTotal = 0, bleedKept = 0, bleedTotal = 0, lastUser = -99;
    for (let f = 0; f < frames; f++) {
      const sysEnv = new Float32Array(SUB), micEnv = new Float32Array(SUB);
      let user = false;
      for (let i = 0; i < SUB; i++) {
        const k = f * SUB + i; const s = scenario.sys(k); sysHist[k] = s; sysEnv[i] = s;
        const u = scenario.user ? scenario.user(k) : 0; if (u > 0.01) user = true;
        const echo = scenario.coupling * (sysHist[k - 12] || 0); // 120 ms behind
        micEnv[i] = Math.sqrt(echo * echo + u * u + 0.0005 * 0.0005);
      }
      const at = (f + 1) * SUB * 10;
      gate.system(sysEnv, at);
      const r = gate.mic(micEnv, at);
      if (f < 40) continue; // warm-up (the gate stays conservative for its first 3 s)
      const sysOn = sysEnv.some((v) => v > 0.002);
      if (r.duck) ducked++; else kept++;
      if (user) { lastUser = f; userTotal++; if (!r.duck) userKept++; }
      else if (sysOn && scenario.coupling > 0 && f - lastUser > 6) { bleedTotal++; if (!r.duck) bleedKept++; } // bleed outside the 400 ms hold-open after your words
    }
    return { kept, ducked, userKept, userTotal, bleedKept, bleedTotal };
  };
  const other = talker(4, 0.05, 20);
  // speakers, user silent: the mic carries only bleed (30 % of the loopback level)
  const r1 = run({ sys: other, coupling: 0.3 });
  check('speakers, user silent: the bleed is silenced', r1.bleedTotal > 100 && r1.bleedKept / r1.bleedTotal < 0.05, r1);
  // speakers, and the user talks over the other side in bursts, louder than the bleed
  const you = talker(3.3, 0.1, 77); // a normal voice into the laptop mic: well above the bleed
  const r2 = run({ sys: other, coupling: 0.3, user: (k) => (Math.floor(k / 120) % 3 === 0 ? you(k) : 0) });
  check('speakers, user talks over them: the user is kept, the bleed between is still silenced', r2.userKept / r2.userTotal > 0.9 && r2.bleedKept / r2.bleedTotal < 0.15, r2);
  // headphones: no bleed at all; the mic is noise floor except when the user speaks
  const r3 = run({ sys: other, coupling: 0, user: (k) => (Math.floor(k / 120) % 2 === 0 ? you(k) : 0) });
  check('headphones: nothing the user says is ever silenced', r3.userKept === r3.userTotal, r3);
  // other side silent: never silences
  const r4 = run({ sys: () => 0.0001, coupling: 0.3, user: you });
  check('other side silent: mic is never silenced', r4.ducked === 0 && r4.userKept === r4.userTotal, r4);
  // quiet speakers through a noise-suppressed mic: the bleed is faint and its envelope is mangled, so no
  // correlation can be established. With the other side talking and no evidence, the mic must not be trusted.
  {
    const gate = dsp.createEchoGate(); let kept = 0, total = 0;
    for (let f = 0; f < 200; f++) {
      const sysEnv = new Float32Array(SUB), micEnv = new Float32Array(SUB);
      for (let i = 0; i < SUB; i++) { sysEnv[i] = other(f * SUB + i); micEnv[i] = 0.004 + 0.012 * rnd(); } // unrelated to the call envelope, below speaking level
      const at = (f + 1) * SUB * 10; gate.system(sysEnv, at);
      const r = gate.mic(micEnv, at);
      if (f >= 40 && sysEnv.some((v) => v > 0.002)) { total++; if (!r.duck) kept++; }
    }
    check('unsure (faint, uncorrelated bleed): the mic is not trusted while the other side talks', kept / total < 0.05, [kept, total]);
  }
  // quiet speakers: bleed at only 5 % of the loopback level is still recognised as bleed
  const r5 = run({ sys: talker(4, 0.2, 20), coupling: 0.05 });
  check('faint bleed (5 %) still silenced', r5.bleedKept / r5.bleedTotal < 0.1, r5);
}
// 5. loudness tools used by the recognizer worker
{
  const { makeFastGain, levelSegment } = require('../src/providers/stt-level');
  // a loud talker (2 s), a gap, then a talker 24 dB quieter (2 s)
  const loud = sine(16000, 220, 2, 0.3), gap = new Float32Array(16000 * 0.7), quiet = sine(16000, 220, 2, 0.3 * 10 ** (-24 / 20));
  const seg = new Float32Array(loud.length + gap.length + quiet.length); seg.set(loud, 0); seg.set(quiet, loud.length + gap.length);
  const out = levelSegment(seg);
  const rLoud = rms(out, 8000, 24000), rQuiet = rms(out, loud.length + gap.length + 8000, loud.length + gap.length + 24000);
  check('levelSegment: a talker 24 dB quieter ends up within 1.5 dB of the loud one', Math.abs(db(rQuiet / rLoud)) < 1.5, db(rQuiet / rLoud));
  check('levelSegment: output at a healthy level and never clipped', rLoud > 0.05 && rLoud < 0.12 && peak(out) <= 0.99, [rLoud, peak(out)]);
  let maxStep = 0; for (let i = 1; i < out.length; i++) maxStep = Math.max(maxStep, Math.abs(out[i] - out[i - 1]));
  check('levelSegment: gain is smooth (no steps)', maxStep < (2 * Math.PI * 220 / 16000) * peak(out) * 1.3, maxStep);
  check('levelSegment: silence stays silence', rms(out, loud.length + 2000, loud.length + gap.length - 2000) === 0);
  const faint = levelSegment(sine(16000, 300, 1.5, 0.002));
  check('levelSegment: very faint speech (peak 0.002) is brought up to a usable level', rms(faint, 4000, 20000) > 0.05, rms(faint, 4000, 20000));
  const fg = makeFastGain();
  const stream = new Float32Array(seg.length); for (let i = 0; i < seg.length; i += 1365) stream.set(fg(seg.subarray(i, Math.min(seg.length, i + 1365))), i);
  const q0 = loud.length + gap.length;
  check('fast gain (detector copy): the quiet talker starts rising immediately and is at full level within ~1 s', rms(stream, q0 + 1600, q0 + 4800) > 0.0134 * 1.2 && rms(stream, q0 + 16000, q0 + 20000) > 0.08, [rms(stream, q0 + 1600, q0 + 4800), rms(stream, q0 + 16000, q0 + 20000)]);
  check('fast gain: never exceeds full scale', peak(stream) <= 1);
}

// 6. echo canceller — speech-like signals (modulated noise), a speaker->mic path with delay, tone and room decay
{
  const RATE = 16000, F = 1365, SEC = 30, N = RATE * SEC;
  const voice = (seed, rate) => { let a = seed >>> 0, lp = 0, lp2 = 0; const x = new Float32Array(N); for (let i = 0; i < N; i++) { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; const w = a / 2147483648 - 1; lp += 0.3 * (w - lp); lp2 += 0.05 * (w - lp2); const t = i / RATE; const env = Math.max(0, Math.sin(2 * Math.PI * rate * t)) * (Math.sin(2 * Math.PI * 0.23 * t + seed) > -0.6 ? 1 : 0); x[i] = 0.25 * env * (lp - lp2); } return x; };
  const call = voice(7, 3.1), you = voice(99, 2.3);
  const bleed = new Float32Array(N); { const d = Math.round(0.11 * RATE), comb = Math.round(0.047 * RATE); let lp = 0; for (let i = d; i < N; i++) { lp += 0.35 * (call[i - d] - lp); bleed[i] = 0.3 * lp + (i >= comb ? 0.3 * bleed[i - comb] : 0); } }
  // blocks carry their clock position; output comes back at its own clock position (aec.outEnd)
  const through = (mic, opts, jitter = false) => {
    const aec = dsp.createEchoCanceller(opts); const out = new Float32Array(N); const verdicts = []; let got = 0;
    let r = 5; const rand = () => { r = (Math.imul(r, 1664525) + 1013904223) >>> 0; return r / 4294967296; };
    const sq = [], mq = [];
    for (let o = 0; o + F <= N; o += F) {
      sq.push(o); if (!jitter || o >= 8 * F) mq.push(o); // jitter: the mic opens 8 blocks late, and blocks arrive in bursts
      for (const s of sq.splice(0, jitter && rand() < 0.5 ? Math.max(0, sq.length - 4) : sq.length)) aec.ref(call.subarray(s, s + F), s + F);
      for (const m of mq.splice(0, jitter && rand() < 0.5 ? Math.max(0, mq.length - 4) : mq.length)) { const res = aec.mic(mic.subarray(m, m + F), m + F); out.set(res, aec.outEnd - res.length); got += res.length; if (res.length) verdicts.push({ ...aec.last, o: aec.outEnd - res.length }); }
    }
    return { out, verdicts, aec, got };
  };
  const LATE = 0;
  // speakers, you silent: the bleed is removed and what is left is judged as residue
  const a = through(bleed);
  check('canceller: speaker bleed is at least 15 dB quieter after 10 s', db(rms(bleed, 10 * RATE, N - LATE)) - db(rms(a.out, 10 * RATE + LATE, N)) >= 15, db(rms(bleed, 10 * RATE, N - LATE)) - db(rms(a.out, 10 * RATE + LATE, N)));
  const late = a.verdicts.filter((v) => v.o > 10 * RATE && rms(bleed, v.o - LATE, v.o - LATE + F) > 0.004);
  check('canceller: knows it has learned the path, and calls bleed-only stretches "not you"', late.every((v) => v.converged) && late.filter((v) => v.user).length <= late.length * 0.05, late.filter((v) => v.user).length + '/' + late.length);
  // speakers, you talking over the call: your voice comes through intact
  const mix = bleed.map((v, i) => v + you[i]);
  const b = through(mix);
  let err = 0, ref = 0; for (let i = 12 * RATE; i < N - LATE; i++) { const e = b.out[i + LATE] - you[i]; err += e * e; ref += you[i] * you[i]; }
  check('canceller: your voice over the call is preserved (what is left differs from your voice alone by < -10 dB)', 10 * Math.log10(err / ref) < -10, 10 * Math.log10(err / ref));
  const talking = b.verdicts.filter((v) => v.o > 12 * RATE && rms(you, v.o - LATE, v.o - LATE + F) > 0.03);
  check('canceller: stretches where you talk over the call are called "you"', talking.filter((v) => v.user).length >= talking.length * 0.97, talking.filter((v) => v.user).length + '/' + talking.length);
  // headphones: the mic has nothing to do with the call audio — nothing may be removed or marked as bleed
  const c = through(you);
  check('canceller: on headphones your voice is not attenuated (within 1 dB)', Math.abs(db(rms(c.out, 5 * RATE + LATE, N)) - db(rms(you, 5 * RATE, N - LATE))) < 1, db(rms(c.out, 5 * RATE + LATE, N)) - db(rms(you, 5 * RATE, N - LATE)));
  const hp = c.verdicts.filter((v) => rms(you, Math.max(0, v.o - LATE), Math.max(F, v.o - LATE + F)) > 0.03);
  check('canceller: on headphones everything you say is called "you"', hp.filter((v) => v.user).length >= hp.length * 0.99, hp.filter((v) => v.user).length + '/' + hp.length);
  // never louder than the input, whatever happens
  let worse = 0; for (let o = LATE; o + F <= N; o += F) if (rms(b.out, o, o + F) > rms(mix, o - LATE, o - LATE + F) * 1.5 + 0.002) worse++;
  check('canceller: never makes the microphone louder', worse === 0, worse);
  // the call audio stops arriving: your voice still comes out
  { const aec = dsp.createEchoCanceller(); let got = 0; for (let o = 0; o + F <= 5 * RATE; o += F) got += aec.mic(you.subarray(o + 5 * RATE, o + 5 * RATE + F), o + F).length; check('canceller: with no call audio at all, every microphone sample comes straight through', got >= 5 * RATE - F - 512, got); }
  // the call audio stops arriving mid-way (its capture ended): the mic waits at most 0.5 s, then carries on
  { const aec = dsp.createEchoCanceller(); let fed = 0, got = 0; for (let o = 0; o + F <= 20 * RATE; o += F) { if (o < 5 * RATE) aec.ref(call.subarray(o, o + F), o + F); got += aec.mic(you.subarray(o, o + F), o + F).length; fed += F; } check('canceller: when the call audio stops arriving, the mic is held back by at most 0.5 s, never lost', fed - got <= 8000 + 1024 + 512, fed - got); }
  // a loaded computer: the mic opens late and the two streams' blocks arrive in uneven bursts
  {
    const j = through(bleed, {}, true);
    const e1 = db(rms(bleed, 12 * RATE, N - 9000)) - db(rms(j.out, 12 * RATE, N - 9000));
    check('canceller: uneven delivery and a late mic do not misalign it (bleed still 15 dB quieter)', e1 >= 15, e1);
    const jm = through(mix, {}, true);
    let err2 = 0, ref2 = 0; for (let i = 12 * RATE; i < N - 9000; i++) { const e = jm.out[i] - you[i]; err2 += e * e; ref2 += you[i] * you[i]; }
    check('canceller: …and your voice still comes through intact (< -10 dB difference)', 10 * Math.log10(err2 / ref2) < -10, 10 * Math.log10(err2 / ref2));
    check('canceller: …and no microphone audio is lost (only the last ≤0.5 s still waiting)', jm.got >= N - 8 * F - F - 8000 - 1024 - 512, [jm.got, N - 8 * F]);
  }
}
console.log(`dsp: ${n} checks passed`);
