// Worker thread hosting the streaming recognizer and the voice-activity
// detector, so model load and per-frame decoding never block the main process.
//
// Two jobs per audio source:
//   * Silero VAD           -> where each stretch of speech starts and ends (cheap, always on time)
//   * streaming recognizer -> live partial text (expensive, best effort)
// Every speech segment is handed over WITH its audio (padded a little on both
// sides, levelled) so the accuracy pass (a second worker) transcribes it —
// whether or not the streaming model heard words in it. The streaming model's
// text for the same audio goes along as the reference the accuracy pass must
// cover.
//
// REAL-TIME GUARANTEE. The streaming model costs ~0.4 s of CPU per second of
// audio per source; with two sources talking non-stop on a busy machine that
// exceeds real time and the queue would grow without bound (minutes behind).
// So the VAD and the audio ring always run first, and the streaming model is
// shed whenever the worker is behind: frames it cannot afford are skipped, live
// partials pause, and finished lines keep arriving on time from the accuracy
// pass. It also skips plain silence.
//
// NON-STOP TALK. With no pause long enough for the VAD to close a segment, a
// line would only appear when the VAD's time limit hit — and that limit cuts at
// the next tiny dip, usually mid-sentence, leaving a fragment of the next
// sentence on the end (which the accuracy model tends to drop). Instead, once
// speech has run for a few seconds we look BACK for the best real pause (the
// longest quiet gap — where one sentence or one voice ends) and cut there. The
// streaming text is split at the same instant using its token timestamps. So
// lines land every few seconds, each a clean stretch transcribed exactly once.
//
// Protocol (postMessage):
//   -> { type:'init', modelDir, files, modelType, vadModel }  <- { type:'ready', ms, vad } | { type:'init-error', error }
//   -> { type:'open', id, kind }                    (creates a stream for an audio source; kind 'mic' | 'call')
//   -> { type:'audio', id, samples, t }             <- { type:'interim', id, text } / { type:'final', id, uid, text, audio, seconds, start, end, snapshot? }
//   -> { type:'nudge', id }                         (Ask pressed: snapshot what is being said right now)
//   -> { type:'sync', id }                          <- { type:'synced', id } once everything before it is processed
//   -> { type:'close', id }
// 'final'.text is the streaming model's hypothesis for the segment and may be ''.
// A uid can arrive more than once (a snapshot, then the finished segment): the line is updated in place.
const { parentPort } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const { makeFastGain, levelSegment } = require('./stt-level');

const RATE = 16000;
const PRE_PAD = Math.round(0.40 * RATE);  // kept before the detected start: soft onsets, first consonants
const POST_PAD = Math.round(0.25 * RATE); // kept after the detected end: trailing syllables
const CONTIG_PAD = RATE * 3;              // reach-back for the segment that follows a cut
const KEEP = RATE * 45;                   // recent audio kept per stream
const MAX_SEG = RATE * 30;                // longest segment handed to the accuracy pass
const MIN_SEG = Math.round(0.2 * RATE);
const PREROLL = Math.round(0.6 * RATE);   // fed to the recognizer before the point where speech was noticed
const HANG = Math.round(1.2 * RATE);      // keep decoding this long after speech ends (trailing words, pause detection)
const LONG_SPEECH = RATE * 5;             // unbroken speech longer than this gets cut at its best pause
const MIN_PIECE = Math.round(2.5 * RATE); // ...leaving at least this much in the piece that is cut off
const NOISY_CUT = RATE * 8;               // unbroken speech this long with no clean pause: accept a dip to the noise floor as the pause
const FORCE_CUT = RATE * 12;             // speech with no pause at all is cut at its quietest instant once it is this long
const SNAP_EVERY = RATE * 9;              // safety net: speech with no usable pause still gets a line this often
const SHED_ON = 900, SHED_OFF = 250;      // ms behind real time: stop / resume the streaming model
const SILENT_PEAK = 0.0015;               // below this a frame is plain silence (idle loopback, gated mic)
const DEBUG = !!process.env.GHOST_STT_DEBUG; // log every segment's boundaries

let sherpa = null;
let rec = null;
let vadCfg = null;
const streams = new Map(); // id -> stream state
let uidCounter = 0;
let lastShedNote = 0;

function tidy(text) {
  const t = text.trim().toLowerCase();
  if (!t) return '';
  return t.replace(/\bi\b/g, 'I').replace(/^./, (c) => c.toUpperCase());
}
function makeVad() {
  if (!vadCfg) return null;
  try { return new sherpa.Vad(vadCfg, 60); }
  catch (e) { parentPort.postMessage({ type: 'log', text: `voice-activity detector unavailable (${e.message}); using the recognizer's own pause detection` }); vadCfg = null; return null; }
}
const log = (id, text) => parentPort.postMessage({ type: 'log', id, text });

// ---- per-stream ring of recent audio, addressed by absolute sample index
function ringPush(st, samples) {
  st.chunks.push({ start: st.total, data: samples });
  st.total += samples.length;
  while (st.chunks.length > 1 && st.chunks[0].start + st.chunks[0].data.length < st.total - KEEP) st.chunks.shift();
}
function ringSlice(st, a, b) {
  a = Math.max(a, st.chunks.length ? st.chunks[0].start : 0); b = Math.min(b, st.total);
  const out = new Float32Array(Math.max(0, b - a));
  for (const c of st.chunks) {
    const cs = c.start, ce = cs + c.data.length;
    if (ce <= a) continue; if (cs >= b) break;
    const from = Math.max(a, cs), to = Math.min(b, ce);
    out.set(c.data.subarray(from - cs, to - cs), from - a);
  }
  return out;
}

// ---- streaming text. The recognizer keeps one growing hypothesis since its last
// reset; `tokBase` marks where the not-yet-handed-over part of it begins, and its
// token timestamps (seconds since `recBase`) let us split it at an audio position.
function pendingText(st) {
  const r = rec.getResult(st.s);
  const toks = r.tokens || [];
  if (st.tokBase >= toks.length) return st.tokBase === 0 ? tidy(r.text || '') : '';
  return tidy(toks.slice(st.tokBase).join(''));
}
// text of the tokens spoken before absolute sample `cut`; advances tokBase past them
function takeTextBefore(st, cut) {
  const r = rec.getResult(st.s);
  const toks = r.tokens || [], ts = r.timestamps || [];
  if (!toks.length || ts.length !== toks.length || !st.recContig) return null; // cannot split reliably
  const t = (cut - st.recBase) / RATE;
  let i = st.tokBase;
  while (i < toks.length && ts[i] <= t) i++;
  while (i < toks.length && !/^[\s▁]/.test(toks[i])) i++; // finish the word the cut landed in
  const left = tidy(toks.slice(st.tokBase, i).join(''));
  st.tokBase = i;
  return left;
}
function resetText(id, st) {
  rec.reset(st.s); st.fed = st.total; st.tokBase = 0; st.recBase = st.total; st.recContig = true;
  if (st.last) parentPort.postMessage({ type: 'interim', id, text: '' });
  st.last = ''; st.textStart = -1;
}

// Streaming model: decode what has arrived since it was last fed. After a
// stretch it sat out (silence, or shedding) it restarts a little before "now".
function feedRecognizer(id, st, frameLen) {
  if (st.needReset) { resetText(id, st); st.needReset = false; st.fed = -1; }
  let start = st.fed;
  if (st.fed < 0 || st.total - st.fed > frameLen + PREROLL) {
    // it sat out a stretch: time no longer lines up with the audio
    start = Math.max(st.lastSegEnd, st.total - frameLen - PREROLL);
    if (!st.last) { rec.reset(st.s); st.tokBase = 0; st.recBase = start; st.recContig = true; } else st.recContig = false;
  }
  const x = ringSlice(st, start, st.total);
  st.fed = st.total;
  if (!x.length) return;
  st.s.acceptWaveform({ sampleRate: RATE, samples: x });
  while (rec.isReady(st.s)) rec.decode(st.s);
  const text = pendingText(st);
  if (text !== st.last) {
    if (!st.last && text) st.textStart = Math.max(st.lastSegEnd, st.total - x.length - RATE); // the streaming model lags ~1 s
    st.last = text;
    parentPort.postMessage({ type: 'interim', id, text });
  }
}
// The streaming model lags the audio by about a second: push a short silent tail
// through it so its text covers everything up to "now".
const TAIL = new Float32Array(Math.round(0.8 * RATE));
function finishText(st) {
  try {
    if (st.fed >= 0 && st.fed < st.total && st.total - st.fed <= RATE * 2) { const x = ringSlice(st, st.fed, st.total); if (x.length) st.s.acceptWaveform({ sampleRate: RATE, samples: x }); st.fed = st.total; }
    st.s.acceptWaveform({ sampleRate: RATE, samples: TAIL });
    while (rec.isReady(st.s)) rec.decode(st.s);
    return pendingText(st) || st.last;
  } catch { return st.last; }
}
function secondOpinion(audio) {
  try {
    const s = rec.createStream();
    s.acceptWaveform({ sampleRate: RATE, samples: audio });
    s.acceptWaveform({ sampleRate: RATE, samples: new Float32Array(RATE) }); // tail so the last frames decode
    while (rec.isReady(s)) rec.decode(s);
    return tidy(rec.getResult(s).text);
  } catch { return ''; }
}

// Hand one speech segment [startAbs, endAbs) over, padded, never overlapping the previous one.
// opts.keep: the speech continues past endAbs (a cut at a pause) — the recognizer is not reset
// and only the text spoken before the cut goes with this segment.
function emitSegment(id, st, startAbs, endAbs, why = 'vad', postPad = POST_PAD, opts = {}) {
  // After a cut the VAD restarts cold and finds the next sentence late: reach back
  // to where the previous segment ended so no audio between the two is skipped.
  const from = Math.max(startAbs - (st.contig ? CONTIG_PAD : PRE_PAD), st.lastSegEnd);
  st.contig = false;
  const to = Math.min(endAbs + postPad, st.total, from + MAX_SEG);
  if (to - Math.max(startAbs, st.lastSegEnd) < MIN_SEG) return; // already covered by the previous segment
  const raw = ringSlice(st, from, to);
  // A segment that is mostly silenced frames is speaker bleed chopped by the mic's echo gate,
  // not speech: the accuracy pass would turn the fragments into nonsense words. Drop it.
  // (mic only: call audio is legitimately all-zero between sentences; only the interior of the segment counts)
  let zeros = 0, inner = 0;
  if (st.kind === 'mic') for (let i = PRE_PAD; i < raw.length - POST_PAD; i++) { inner++; if (raw[i] === 0) zeros++; }
  st.lastSegEnd = Math.min(endAbs, to);
  st.snapAt = 0;
  const dirty = st.dirty; st.dirty = st.shed; // the streaming model sat out part of this segment
  let split = null; // the streaming text of the words before a keep-cut, when it can be split off
  const done = () => {
    if (!opts.keep) { resetText(id, st); return; }
    if (dirty || split === null) {
      // The words before the cut could not be split off the streaming text (it sat out part of this
      // speech, or its timing is not contiguous). Left there, they would be glued onto the NEXT line's
      // text — the accuracy pass would then distrust its own correct result and keep garbled, repeated
      // words. Restart the streaming model at the cut instead, on the audio after it.
      rec.reset(st.s); st.tokBase = 0; st.recBase = st.lastSegEnd; st.fed = st.lastSegEnd; st.recContig = true;
      st.last = ''; st.textStart = -1; parentPort.postMessage({ type: 'interim', id, text: '' });
      return;
    }
    st.last = pendingText(st); st.textStart = st.last ? st.lastSegEnd : -1; parentPort.postMessage({ type: 'interim', id, text: st.last });
  };
  if (inner > 0 && zeros > inner * 0.4) { done(); st.openUid = null; if (DEBUG) log(id, `segment dropped: ${Math.round((100 * zeros) / inner)}% silenced (echo-gate fragments)`); return; }
  // level the segment with look-ahead: a quiet talker and a loud one end up equally loud
  const audio = levelSegment(raw);
  // The streaming model's text for exactly this audio: shown at once, and the reference
  // the accuracy pass has to cover (it must not drop a voice).
  let text = '';
  if (!dirty) { if (opts.keep) { split = takeTextBefore(st, endAbs); text = split ?? ''; } else text = finishText(st); }
  if (!text && !dirty && !opts.keep && !st.openUid && Date.now() - st.lastLagAt > 3000) {
    // The streaming model listened to all of this and heard nothing. Before the
    // accuracy pass guesses at it (it will find words in anything), get a second
    // opinion: the streaming model on the levelled audio. Two models hearing
    // nothing = noise, not speech: drop it. (Skipped whenever the worker has been
    // behind recently: this costs CPU, and then the accuracy pass decides alone.)
    text = secondOpinion(audio);
    if (!text) { done(); if (DEBUG) log(id, `segment dropped (${(audio.length / RATE).toFixed(1)} s): no speech heard by either model`); return; }
  }
  done();
  if (!audio.length) return;
  // a snapshot already put a line on screen for this speech: finish that line rather than add one
  const uid = st.openUid || `${id}-${++uidCounter}`;
  st.openUid = null;
  if (DEBUG) log(id, `segment ${uid} ${why}: speech ${(startAbs / RATE).toFixed(2)}–${(endAbs / RATE).toFixed(2)} s, audio ${(from / RATE).toFixed(2)}–${(to / RATE).toFixed(2)} s, streaming text: "${text.slice(0, 60)}"${dirty ? ' (streaming shed)' : ''}`);
  parentPort.postMessage({ type: 'final', id, uid, text, audio, seconds: audio.length / RATE, start: from / RATE, end: to / RATE }, [audio.buffer]);
}
function drainVad(id, st) {
  while (!st.vad.isEmpty()) {
    const seg = st.vad.front(false);
    st.vad.pop();
    const startAbs = st.vadBase + seg.start;
    emitSegment(id, st, startAbs, startAbs + seg.samples.length);
  }
}
// Centre of the quietest 60 ms in [a, b): where a pause (or the gap between two words) actually is.
function quietestPoint(st, a, b) {
  a = Math.max(a, st.chunks.length ? st.chunks[0].start : 0, st.lastSegEnd);
  const x = ringSlice(st, a, b);
  const W = 960; let best = Infinity, at = x.length;
  for (let i = 0; i + W <= x.length; i += 160) { let s = 0; for (let j = i; j < i + W; j++) s += x[j] * x[j]; if (s < best) { best = s; at = i + W / 2; } }
  return a + at;
}
// Restart the VAD at `cut` (absolute sample) with the audio after it, so the speech in progress carries on as a new segment.
function restartVadAt(st, cut) {
  st.vad.reset(); st.vadBase = cut;
  const tail = ringSlice(st, cut, st.total);
  if (tail.length) st.vad.acceptWaveform(st.fast(tail));
  st.lastSegEnd = Math.max(st.lastSegEnd, cut);
  st.speechStart = cut; st.wasDet = st.vad.isDetected();
  st.contig = true;
}
// Unbroken speech: find the best real pause so far — the longest quiet gap of at
// least 100 ms, at least MIN_PIECE after the start — and cut there. That is where a
// sentence or a voice ends, so the piece handed over is clean.
function cutAtBestPause(id, st) {
  const segStart = Math.max(st.speechStart, st.lastSegEnd);
  const a = segStart + MIN_PIECE, b = st.total - Math.round(0.25 * RATE);
  if (b - a < RATE / 2) return false;
  const x = ringSlice(st, a, b);
  const W = 320, n = Math.floor(x.length / W); if (n < 8) return false;
  const r = new Float32Array(n);
  for (let k = 0; k < n; k++) { let s = 0; for (let j = k * W; j < (k + 1) * W; j++) s += x[j] * x[j]; r[k] = Math.sqrt(s / W); }
  const sorted = Float32Array.from(r).sort();
  const loud = sorted[Math.floor(n * 0.9)], floor = sorted[Math.floor(n * 0.08)];
  // a pause is quiet relative to the speech — or, when there is steady noise under the speech
  // (a fan, a street, a bad line), as quiet as this audio ever gets: the noise floor itself
  // (only once the speech has run long without a cut: used from the start, the noise-floor rule cuts
  // ordinary noisy conversation at every dip, mid-sentence)
  const thr = Math.max(loud * 0.08, st.total - segStart >= NOISY_CUT ? floor * 1.7 : 0, 2e-4);
  let bestLen = 0, bestAt = -1, run = 0;
  for (let k = 0; k <= n; k++) {
    if (k < n && r[k] < thr) { run++; continue; }
    if (run >= 5 && run > bestLen) { bestLen = run; bestAt = k - run / 2; }
    run = 0;
  }
  let cut;
  if (bestAt >= 0) cut = a + Math.round(bestAt * W);
  // No pause at all (music, several people at once, heavy noise): a line still has to end. Cut at the
  // quietest instant of the last few seconds rather than let one line grow without limit and
  // be rewritten over and over while what was said earlier falls out of it.
  else if (st.total - segStart >= FORCE_CUT) cut = quietestPoint(st, Math.max(a, st.total - RATE * 6), b);
  else return false;
  emitSegment(id, st, segStart, cut, 'pause-cut', 0, { keep: st.recContig && !st.dirty });
  restartVadAt(st, cut);
  return true;
}
// Steady noise can hold the VAD "open" across real pauses. The recognizer heard a
// pause after words — but it notices ~1 s late, when the next sentence may have
// begun. So cut at the pause itself (the quietest recent point).
function splitAtPause(id, st) {
  const cut = quietestPoint(st, st.total - RATE * 1.5, st.total - 800);
  st.vad.flush();
  while (!st.vad.isEmpty()) {
    const seg = st.vad.front(false); st.vad.pop();
    const s0 = st.vadBase + seg.start;
    if (s0 < cut) emitSegment(id, st, s0, Math.min(s0 + seg.samples.length, cut), 'pause-split', 0);
  }
  if (st.last) emitSegment(id, st, st.textStart >= 0 ? st.textStart : st.lastSegEnd, cut, 'pause-split', 0);
  restartVadAt(st, cut);
}
// A snapshot of the speech in progress, under a uid that the finished segment
// will reuse, so the line is updated in place. Two uses:
//   Ask pressed  – the answer needs what is being said right now, but cutting the
//                  audio here could split a word. Nothing is reset, nothing is lost.
//   safety net   – speech with no usable pause for a long time still gets a line.
function snapshot(id, st, rolling = false) {
  const speaking = st.vad ? st.vad.isDetected() : false;
  if (!st.last && !speaking) return;
  let from, to = st.total;
  if (rolling) { from = Math.max(st.lastSegEnd, st.speechStart - PRE_PAD); to = quietestPoint(st, st.total - Math.round(0.8 * RATE), st.total - Math.round(0.1 * RATE)); }
  else from = st.textStart >= 0 ? Math.max(st.lastSegEnd, st.textStart - RATE * 1.5) : Math.max(st.lastSegEnd, st.speechStart - PRE_PAD, st.total - RATE * 12);
  from = Math.max(from, to - MAX_SEG);
  const audio = levelSegment(ringSlice(st, from, to));
  if (audio.length < MIN_SEG) return;
  if (!st.openUid) st.openUid = `${id}-${++uidCounter}`;
  const text = st.dirty ? '' : st.last;
  if (DEBUG) log(id, `segment ${st.openUid} ${rolling ? 'rolling ' : ''}snapshot: audio ${(from / RATE).toFixed(2)}–${(to / RATE).toFixed(2)} s, streaming text: "${text.slice(0, 60)}"`);
  parentPort.postMessage({ type: 'final', id, uid: st.openUid, text, audio, seconds: audio.length / RATE, start: from / RATE, end: to / RATE, snapshot: true }, [audio.buffer]);
}
// Commit everything in progress (the stream is closing).
function flush(id, st) {
  if (st.vad) {
    st.vad.flush(); drainVad(id, st);
    st.vad.reset(); st.vadBase = st.total;
  }
  // words the streaming model has that no VAD segment covered
  if (st.last) emitSegment(id, st, st.textStart >= 0 ? st.textStart : Math.max(st.lastSegEnd, st.total - RATE * 10), st.total, 'flush');
  st.contig = true;
}

let pressure = false; // the accuracy pass is queueing: leave it the CPU (see local-stt.js updatePressure)
function onAudio(m) {
  const st = streams.get(m.id); if (!st) return;
  const samples = m.samples;
  if (!samples || !samples.length) return;
  ringPush(st, samples);

  // How far behind real time are we? (m.t = when the main process sent this frame)
  const lag = m.t ? Date.now() - m.t : 0;
  if (lag > SHED_OFF) st.lastLagAt = Date.now();
  if (lag > st.statLag) st.statLag = lag;
  if (++st.statN >= 120) { parentPort.postMessage({ type: 'stat', id: m.id, lag: st.statLag, shed: st.shed }); st.statN = 0; st.statLag = 0; } // every ~10 s
  if (!st.shed && (lag > SHED_ON || pressure)) {
    st.shed = true; st.dirty = true;
    if (lag > SHED_ON && Date.now() - lastShedNote > 15000) { lastShedNote = Date.now(); log(m.id, `recognizer ${(lag / 1000).toFixed(1)} s behind: pausing live partial words to catch up (finished lines keep coming from the accuracy pass)`); }
  } else if (st.shed && lag < SHED_OFF && !pressure) { st.shed = false; st.needReset = true; }

  // 1. voice activity — always, cheap, on a fast-levelled copy so quiet speech is caught from its first syllable
  let speech = true, det = false;
  if (st.vad) {
    st.vad.acceptWaveform(st.fast(samples));
    det = st.vad.isDetected();
    if (det && !st.wasDet) st.speechStart = Math.max(st.lastSegEnd, st.total - samples.length - Math.round(0.3 * RATE));
    st.wasDet = det;
    if (det) st.speechUntil = st.total + HANG;
    let peak = 0; for (let i = 0; i < samples.length; i += 2) { const a = samples[i] < 0 ? -samples[i] : samples[i]; if (a > peak) peak = a; }
    // plain silence (idle loopback, a gated mic) is not worth the streaming model's time;
    // anything with energy still is, so soft speech the VAD misses can be caught by the recognizer
    speech = det || st.total < st.speechUntil || peak >= SILENT_PEAK;
  }

  // 2. streaming partials — best effort
  if (st.shed) st.dirty = true;
  else if (speech) feedRecognizer(m.id, st, samples.length);

  // 3. segments
  if (st.vad) {
    drainVad(m.id, st);
    const running = st.total - Math.max(st.speechStart, st.lastSegEnd);
    if (det && running >= LONG_SPEECH && st.total >= st.nextCutCheck) {
      // unbroken speech: hand over everything up to its best pause (checked twice a second)
      st.nextCutCheck = st.total + RATE / 2;
      cutAtBestPause(m.id, st);
    }
    // ...and if there has been no usable pause at all for a long time, show a snapshot so the line is not blank
    if (det && st.total - Math.max(st.speechStart, st.snapAt, st.lastSegEnd) >= SNAP_EVERY) { st.snapAt = st.total; snapshot(m.id, st, true); }
    if (!st.shed && st.last && rec.isEndpoint(st.s) && st.vad.isEmpty()) {
      // The recognizer heard words and then a pause, but the VAD did not close a segment:
      // very soft speech it never fired on, or noise holding it open.
      if (!st.vad.isDetected()) emitSegment(m.id, st, st.textStart >= 0 ? st.textStart : st.lastSegEnd, st.total, 'recognizer-pause');
      else splitAtPause(m.id, st);
    }
  } else if (!st.shed && rec.isEndpoint(st.s)) {
    if (st.last) emitSegment(m.id, st, st.textStart >= 0 ? st.textStart : st.lastSegEnd, st.total);
    else resetText(m.id, st);
  }
}

parentPort.on('message', (m) => {
  try {
    if (m.type === 'audio') onAudio(m);
    else if (m.type === 'pressure') pressure = !!m.on;
    else if (m.type === 'init') {
      const t0 = Date.now();
      sherpa = require('sherpa-onnx-node');
      const d = m.modelDir, f = m.files;
      rec = new sherpa.OnlineRecognizer({
        featConfig: { sampleRate: RATE, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: path.join(d, f.encoder), decoder: path.join(d, f.decoder), joiner: path.join(d, f.joiner) },
          tokens: path.join(d, f.tokens), numThreads: 2, provider: 'cpu', debug: 0,
          ...(m.modelType ? { modelType: m.modelType } : {}),
        },
        decodingMethod: 'greedy_search',
        enableEndpoint: true,
        rule1MinTrailingSilence: 2.0, rule2MinTrailingSilence: 0.9, rule3MinUtteranceLength: 25,
      });
      // maxSpeechDuration is only the fallback: long speech is normally cut at its best pause well before this
      vadCfg = m.vadModel && fs.existsSync(m.vadModel)
        ? { sileroVad: { model: m.vadModel, threshold: 0.4, minSilenceDuration: 0.55, minSpeechDuration: 0.2, windowSize: 512, maxSpeechDuration: 14 }, sampleRate: RATE, numThreads: 1, provider: 'cpu', debug: 0 }
        : null;
      if (vadCfg && !makeVad()) vadCfg = null; // make sure it actually loads
      parentPort.postMessage({ type: 'ready', ms: Date.now() - t0, vad: !!vadCfg });
    } else if (m.type === 'open') {
      if (!rec) throw new Error('recognizer not initialised');
      streams.set(m.id, {
        s: rec.createStream(), last: '', textStart: -1, fed: -1, needReset: false, tokBase: 0, recBase: 0, recContig: true,
        vad: makeVad(), fast: makeFastGain(), vadBase: 0, wasDet: false, speechStart: 0, speechUntil: 0, snapAt: 0, nextCutCheck: 0,
        total: 0, chunks: [], lastSegEnd: 0, openUid: null, contig: false, kind: m.kind || 'call',
        shed: false, dirty: false, lastLagAt: 0, statLag: 0, statN: 0,
      });
    } else if (m.type === 'nudge') {
      const st = streams.get(m.id); if (st) snapshot(m.id, st);
    } else if (m.type === 'sync') {
      parentPort.postMessage({ type: 'synced', id: m.id });
    } else if (m.type === 'close') {
      const st = streams.get(m.id); if (!st) return;
      flush(m.id, st);
      try { st.s.inputFinished?.(); } catch {}
      streams.delete(m.id);
    }
  } catch (e) {
    parentPort.postMessage({ type: m.type === 'init' ? 'init-error' : 'error', id: m.id, error: e.message || String(e) });
  }
});
