// Offline check of the microphone path (echo canceller + echo gate) on the same
// audio test/app-lag.js plays into the app, in seconds instead of minutes, with
// ground truth: we know which samples are your voice and which are speaker bleed.
//   node test/echo-sim.js [--scenario speakers|headphones|noise] [--minutes 2] [--no-aec]
// Reports: how much of your speech was silenced, how much bleed got through,
// and how many dB the canceller removed.
const dsp = require('../src/renderer/dsp.js');
const { makeTracks, RATE } = require('./app-lag.js');

const NO_AEC = process.argv.includes('--no-aec');
// --jitter: deliver the two streams' blocks unevenly and start the mic late, as a loaded computer does
const JITTER = process.argv.includes('--jitter');
const FRAME = 1365; // one 4096-sample capture block at 48 kHz, resampled

async function run() {
  const { pcm } = await makeTracks();
  const gate = dsp.createEchoGate({ micFloor: 0.0015, ...(process.env.GATE ? JSON.parse(process.env.GATE) : {}) });
  const aec = NO_AEC ? null : dsp.createEchoCanceller(process.env.AEC ? JSON.parse(process.env.AEC) : {});
  const hold = [];
  let rnd = 99; const rand = () => { rnd = (Math.imul(rnd, 1664525) + 1013904223) >>> 0; return rnd / 4294967296; };
  const sysQ = [], micQ = []; const micStart = JITTER ? 9 : 0; // mic opens ~0.75 s after the call audio
  let userFrames = 0, userLost = 0, bleedFrames = 0, bleedKept = 0, bleedIn = 0, bleedOut = 0, firstMin = { userFrames: 0, userLost: 0, bleedFrames: 0, bleedKept: 0 };
  const why = {}, leakWhy = {};
  const frames = Math.floor(pcm.mic.length / FRAME);
  for (let f = 0; f < frames; f++) {
    const o = f * FRAME, at = ((f + 1) * FRAME * 1000) / RATE;
    sysQ.push(f); if (f >= micStart) micQ.push(f);
    // blocks reach the page in bursts: sometimes one stream's are held back for a few blocks
    const takeSys = JITTER ? (rand() < 0.5 ? sysQ.length : Math.max(0, sysQ.length - 4)) : sysQ.length;
    const takeMic = JITTER ? (rand() < 0.5 ? micQ.length : Math.max(0, micQ.length - 4)) : micQ.length;
    for (const g of sysQ.splice(0, takeSys)) {
      const sys = pcm.call.subarray(g * FRAME, g * FRAME + FRAME);
      gate.system(dsp.subRms(sys, RATE), ((g + 1) * FRAME) / 16);
      if (aec) aec.ref(sys, (g + 1) * FRAME);
    }
    const ready = [];
    for (const g of micQ.splice(0, takeMic)) {
      const raw = pcm.mic.subarray(g * FRAME, g * FRAME + FRAME);
      if (!aec) { ready.push({ clean: raw, s: g * FRAME }); continue; }
      const clean = aec.mic(raw, (g + 1) * FRAME);
      if (clean.length) ready.push({ clean, s: aec.outEnd - clean.length, hint: aec.last });
    }
    for (const x of ready) {
    hold.push({ ...x, at: ((x.s + x.clean.length) / 16) });
    if (hold.length < 2) continue; // the app holds mic frames one frame, too
    const h = hold.shift();
    const r = gate.mic(dsp.subRms(h.clean, RATE), h.at, h.hint);
    // ground truth for the samples this output frame covers
    const s = h.s, L = h.clean.length;
    const u = dsp.rmsOf(pcm.user.subarray(s, s + L));
    const b = dsp.rmsOf(pcm.mic.subarray(s, s + L).map((v, i) => v - pcm.user[s + i]));
    const early = h.at < 60000;
    if (u > 0.01) { userFrames++; if (r.duck) { userLost++; why[r.why] = (why[r.why] || 0) + 1; } if (early) { firstMin.userFrames++; if (r.duck) firstMin.userLost++; } }
    else if (u < 0.0005 && b > 0.004) {
      bleedFrames++; const outRms = dsp.rmsOf(h.clean);
      if (h.at > 10000) { bleedIn += b * b; bleedOut += outRms * outRms; }
      if (!r.duck) { bleedKept++; leakWhy[r.why] = (leakWhy[r.why] || 0) + 1; if (early) firstMin.bleedKept++; }
      if (early) firstMin.bleedFrames++;
    }
    }
  }
  const p = (a, b) => `${b ? ((100 * a) / b).toFixed(1) : '0.0'} %`;
  console.log(`echo-sim${NO_AEC ? ' (gate only)' : ''}${JITTER ? ' (uneven delivery, mic opens late)' : ''}: ${(frames * FRAME / RATE / 60).toFixed(1)} min`);
  console.log(`  your speech silenced:   ${p(userLost, userFrames)} of ${userFrames} frames   (first minute ${p(firstMin.userLost, firstMin.userFrames)})`);
  console.log(`  speaker bleed let through: ${p(bleedKept, bleedFrames)} of ${bleedFrames} frames   (first minute ${p(firstMin.bleedKept, firstMin.bleedFrames)})`);
  console.log(`  silenced by: ${JSON.stringify(why)} · let through by: ${JSON.stringify(leakWhy)}`);
  if (aec) console.log(`  canceller: bleed ${bleedIn ? (10 * Math.log10(bleedIn / (bleedOut || 1e-12))).toFixed(1) : 'n/a'} dB quieter after it · ${JSON.stringify(aec.stats)}`);
  return { userLost: userLost / (userFrames || 1), bleedKept: bleedKept / (bleedFrames || 1) };
}
if (require.main === module) run().catch((e) => { console.error(e); process.exit(1); });
module.exports = { run };
