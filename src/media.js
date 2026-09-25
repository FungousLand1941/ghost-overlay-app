// Video / audio as context.
//   Local files & direct media links: the bundled ffmpeg pulls 16 kHz mono PCM,
//   an energy-based segmenter cuts it at pauses, and the offline Parakeet
//   recogniser transcribes each piece (free; nothing leaves the machine).
//   Optionally key frames are described by the answering AI (slides, code).
//   YouTube links: the video's caption track (free); without one the caller can
//   have Gemini read the video itself (gemini.videoFromUrl).
const { spawn } = require('child_process');
const path = require('path');
const localStt = require('./providers/local-stt');
const { UA, decodeEntities } = require('./web');

const MEDIA_EXT = ['mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'ts', 'mpg', 'mpeg', '3gp', 'mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'wma', 'aiff', 'aif'];
const isMediaPath = (p) => MEDIA_EXT.includes(path.extname(String(p)).slice(1).toLowerCase());
const RATE = 16000;

function ffmpegPath() {
  let p = null;
  try { p = require('ffmpeg-static'); } catch { return null; }
  return p ? p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1') : null;
}
function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const ms = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h ? `${h}:${ms}` : ms;
}

// ---------------------------------------------------------------- ffmpeg
const active = new Set();
function killAll() { for (const p of active) { try { p.kill(); } catch {} } active.clear(); }
function run(args, { onStdout = null } = {}) {
  const ff = ffmpegPath();
  if (!ff) return Promise.reject(new Error('ffmpeg is not available in this build'));
  return new Promise((resolve, reject) => {
    let proc;
    try { proc = spawn(ff, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return reject(e); }
    active.add(proc);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-65536); });
    proc.on('error', (e) => { active.delete(proc); reject(e); });
    const closed = new Promise((r) => proc.on('close', r));
    (async () => {
      try {
        if (onStdout) for await (const chunk of proc.stdout) await onStdout(chunk); // async iteration = back-pressure
        else proc.stdout.resume();
      } catch (e) { try { proc.kill(); } catch {} active.delete(proc); return reject(e); }
      const code = await closed;
      active.delete(proc);
      resolve({ code, stderr });
    })();
  });
}
const inputArgs = (input) => (/^https?:\/\//i.test(input) ? ['-user_agent', UA, '-i', input] : ['-i', input]);

// Duration + which streams exist. (ffmpeg with no output exits 1 but prints the info we need.)
async function probe(input) {
  const { stderr } = await run(['-nostdin', '-hide_banner', ...inputArgs(input)]);
  const d = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const seconds = d ? (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]) : 0;
  const streams = stderr.split('\n').filter((l) => /Stream #\d+:\d+/.test(l));
  const hasVideo = streams.some((l) => /: Video:/.test(l) && !/attached pic/.test(l));
  const hasAudio = streams.some((l) => /: Audio:/.test(l));
  if (!hasAudio && !hasVideo) throw new Error(`could not read this file: ${(stderr.trim().split('\n').pop() || 'unknown format').trim()}`);
  return { seconds, hasVideo, hasAudio };
}

// ---------------------------------------------------------------- segmenter
// Cuts a 16 kHz stream into 12–35 s pieces at pauses (energy dips), so the
// offline recogniser sees natural phrases and memory stays flat.
class Segmenter {
  constructor({ minSec = 12, maxSec = 35, silenceMs = 300, onSegment } = {}) {
    this.min = Math.round(minSec * RATE); this.max = Math.round(maxSec * RATE);
    this.frame = RATE / 50; // 20 ms
    this.silenceFrames = Math.max(1, Math.round(silenceMs / 20));
    this.buf = new Float32Array(this.max + RATE * 2); this.len = 0; this.offset = 0;
    this.onSegment = onSegment;
    this.segments = 0;
  }
  push(samples) {
    let i = 0;
    while (i < samples.length) {
      const n = Math.min(this.buf.length - this.len, samples.length - i);
      this.buf.set(samples.subarray(i, i + n), this.len); this.len += n; i += n;
      this.drain();
    }
  }
  drain() {
    while (this.len >= this.min) {
      let cut = this.findCut(this.min, Math.min(this.len, this.max));
      if (cut < 0) { if (this.len >= this.max) cut = this.max; else return; }
      this.emit(cut);
    }
  }
  // Middle of the first pause (>= silenceMs below an adaptive floor) between from..to, or -1.
  findCut(from, to) {
    const f = this.frame, n = Math.floor(to / f);
    const rms = new Float32Array(n);
    for (let k = 0; k < n; k++) { let e = 0; const b = k * f; for (let j = b; j < b + f; j++) e += this.buf[j] * this.buf[j]; rms[k] = Math.sqrt(e / f); }
    const sorted = Float32Array.from(rms).sort();
    const floor = sorted[Math.floor(n * 0.2)] || 0, loud = sorted[Math.floor(n * 0.8)] || 0;
    // a pause = well below the speech level; steady loud audio has no pauses (forced cut at max)
    const thr = Math.max(0.004, Math.min(floor * 2.5, loud * 0.35));
    let run = 0;
    for (let k = Math.floor(from / f); k < n; k++) {
      if (rms[k] >= thr) { run = 0; continue; }
      run++;
      if (run >= this.silenceFrames) {
        const start = k - run + 1;
        while (k + 1 < n && rms[k + 1] < thr) { k++; run++; }
        return Math.floor((start + run / 2) * f);
      }
    }
    return -1;
  }
  emit(cut) {
    const samples = this.buf.slice(0, cut); // fresh buffer: transferable to the worker
    const startSample = this.offset;
    this.buf.copyWithin(0, cut, this.len); this.len -= cut; this.offset += cut;
    let peak = 0; for (let j = 0; j < samples.length; j += 4) { const a = Math.abs(samples[j]); if (a > peak) peak = a; }
    this.segments++;
    this.onSegment({ samples, startSample, quiet: peak < 0.01 });
  }
  flush() { if (this.len >= RATE * 0.4) this.emit(this.len); this.len = 0; }
}

async function ensureRecognizer(onProgress) {
  const m = localStt.REFINE_MODEL;
  if (!localStt.modelInfo(m).ready) await localStt.ensureModel((p) => onProgress({ text: `downloading the speech model (once, ~670 MB): ${p.file} ${p.pct}%` }), m);
  onProgress({ text: 'loading the speech recogniser…' });
  await localStt.startRefiner();
}

// ---------------------------------------------------------------- file / direct link -> text
async function transcribeFile(input, { onProgress = () => {}, describeFrame = null, frameEverySec = 60 } = {}) {
  if (!ffmpegPath()) throw new Error('ffmpeg is not bundled in this build');
  onProgress({ text: 'reading the file…' });
  const info = await probe(input);
  if (!info.hasAudio && !(describeFrame && info.hasVideo)) throw new Error('this file has no audio track');
  const lines = [];
  let warn = '';
  if (info.hasAudio) {
    await ensureRecognizer(onProgress);
    let pending = 0, done = 0, chain = Promise.resolve();
    const waiters = [];
    const seg = new Segmenter({
      onSegment: ({ samples, startSample, quiet }) => {
        if (quiet) return;
        pending++;
        chain = chain.then(async () => {
          const t = startSample / RATE;
          try { const text = await localStt.transcribeSamples(samples); if (text) lines.push({ t, text }); }
          catch (e) { lines.push({ t, text: `[unrecognised audio: ${e.message}]` }); }
          done = (startSample + samples.length) / RATE; pending--;
          onProgress({ text: `transcribing ${fmtTime(done)}${info.seconds ? ` / ${fmtTime(info.seconds)}` : ''}`, pct: info.seconds ? Math.min(99, Math.round((done / info.seconds) * 100)) : 0 });
          waiters.splice(0).forEach((w) => w());
        });
      },
    });
    let carry = Buffer.alloc(0);
    const toF32 = (chunk) => {
      const b = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const n = Math.floor(b.length / 4);
      carry = Buffer.from(b.subarray(n * 4));
      const ab = new ArrayBuffer(n * 4); Buffer.from(ab).set(b.subarray(0, n * 4));
      return new Float32Array(ab);
    };
    const { code, stderr } = await run(['-nostdin', '-hide_banner', '-loglevel', 'error', ...inputArgs(input), '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], {
      onStdout: async (chunk) => { seg.push(toF32(chunk)); while (pending > 6) await new Promise((r) => waiters.push(r)); },
    });
    seg.flush();
    await chain;
    if (code !== 0) {
      const last = (stderr.trim().split('\n').pop() || '').trim();
      if (!lines.length && !seg.segments) throw new Error(`ffmpeg could not decode this file: ${last}`);
      warn = `decoding stopped early: ${last}`;
    }
  }
  let frames = [];
  if (describeFrame && info.hasVideo) {
    const shots = await extractFrames(input, { everySec: frameEverySec, onProgress });
    for (let i = 0; i < shots.length; i++) {
      onProgress({ text: `describing the screen ${i + 1} / ${shots.length} (${fmtTime(shots[i].t)})` });
      try {
        const d = (await describeFrame(shots[i].jpeg.toString('base64'), shots[i].t) || '').trim();
        if (d && !/^(?:speaker on camera|nothing|blank)\.?$/i.test(d)) frames.push({ t: shots[i].t, text: d });
      } catch (e) {
        frames.push({ t: shots[i].t, text: `[screen not described: ${e.message}]` });
        if (/quota|rate limit|paused/i.test(e.message)) break;
      }
    }
  }
  const all = [...lines.map((l) => ({ ...l, kind: 'say' })), ...frames.map((f) => ({ ...f, kind: 'screen' }))].sort((a, b) => a.t - b.t);
  const text = all.map((l) => `[${fmtTime(l.t)}] ${l.kind === 'screen' ? 'ON SCREEN: ' : ''}${l.text}`).join('\n') + (warn ? `\n\n[${warn}]` : '');
  return { text, seconds: info.seconds, hasVideo: info.hasVideo, lines: lines.length, frames: frames.length };
}

// One JPEG every `everySec` seconds, near-duplicates dropped (a slide that
// stays up for five minutes is one frame), with the real timestamps.
async function extractFrames(input, { everySec = 60, maxFrames = 240, onProgress = () => {} } = {}) {
  onProgress({ text: 'pulling key frames…' });
  const chunks = [];
  const { stderr } = await run(['-nostdin', '-hide_banner', '-loglevel', 'info', ...inputArgs(input), '-an', '-sn', '-dn',
    '-vf', `fps=1/${everySec},mpdecimate,scale=768:-2,showinfo`, '-fps_mode', 'vfr', '-frames:v', String(maxFrames),
    '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '6', '-'], { onStdout: (c) => { chunks.push(c); } });
  const buf = Buffer.concat(chunks);
  const times = [...stderr.matchAll(/pts_time:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));
  const SOI = Buffer.from([0xff, 0xd8, 0xff]), EOI = Buffer.from([0xff, 0xd9]);
  const out = []; let i = 0;
  while (i < buf.length) {
    const s = buf.indexOf(SOI, i); if (s < 0) break;
    const e = buf.indexOf(EOI, s + 3); if (e < 0) break;
    out.push({ jpeg: buf.subarray(s, e + 2), t: times[out.length] ?? out.length * everySec });
    i = e + 2;
  }
  return out;
}

// ---------------------------------------------------------------- YouTube captions
function youtubeId(url) { const m = String(url || '').match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/); return m ? m[1] : null; }
function parseCaptionTracks(html) {
  const key = '"captionTracks":';
  const i = html.indexOf(key); if (i < 0) return [];
  const a = html.indexOf('[', i + key.length); if (a < 0) return [];
  let depth = 0, j = a;
  for (; j < html.length; j++) {
    const c = html[j];
    if (c === '"') { j++; while (j < html.length && html[j] !== '"') { if (html[j] === '\\') j++; j++; } continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (!depth) break; }
  }
  try { return JSON.parse(html.slice(a, j + 1)); } catch { return []; }
}
function pickTrack(tracks) {
  const en = (t) => /^en(?:-|$)/i.test(t.languageCode || '');
  return tracks.find((t) => en(t) && t.kind !== 'asr') || tracks.find(en) || tracks.find((t) => t.kind !== 'asr') || tracks[0];
}
// json3 caption events -> [{t, text}] in ~20 s lines.
function json3ToLines(j, { bucketSec = 20 } = {}) {
  const lines = []; let cur = null;
  for (const ev of (j && j.events) || []) {
    if (!ev.segs) continue;
    const text = ev.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const t = (ev.tStartMs || 0) / 1000;
    if (!cur || t - cur.t >= bucketSec) { cur = { t, text }; lines.push(cur); } else cur.text += ` ${text}`;
  }
  return lines;
}
// YouTube's internal player API as the Android app: the caption URLs it hands out
// download without the browser-only token the watch page's URLs now need.
const YT_ANDROID = { name: 'ANDROID', version: '20.10.38', ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip' };
async function youtubePlayer(id) {
  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': YT_ANDROID.ua, 'x-youtube-client-name': '3', 'x-youtube-client-version': YT_ANDROID.version, 'accept-language': 'en-US,en;q=0.8' },
    body: JSON.stringify({ context: { client: { clientName: YT_ANDROID.name, clientVersion: YT_ANDROID.version, androidSdkVersion: 30, hl: 'en', gl: 'US' } }, videoId: id, contentCheckOk: true, racyCheckOk: true }),
  });
  if (!res.ok) throw new Error(`YouTube returned HTTP ${res.status}`);
  return res.json();
}
// timedtext XML (what the Android client serves): <p t="ms" d="ms">text<s> more</s></p>
function timedtextToLines(xml, { bucketSec = 20 } = {}) {
  const lines = []; let cur = null;
  for (const m of String(xml || '').matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const tm = m[1].match(/\bt="(\d+)"/); if (!tm) continue;
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const t = +tm[1] / 1000;
    if (!cur || t - cur.t >= bucketSec) { cur = { t, text }; lines.push(cur); } else cur.text += ` ${text}`;
  }
  return lines;
}
async function youtubeInfo(url) {
  const id = youtubeId(url); if (!id) throw new Error('not a YouTube link');
  let j = null;
  try { j = await youtubePlayer(id); } catch {}
  if (j && j.videoDetails) {
    const status = (j.playabilityStatus && j.playabilityStatus.status) || '';
    return {
      id, title: (j.videoDetails.title || '').trim(), seconds: +(j.videoDetails.lengthSeconds || 0),
      tracks: (j.captions && j.captions.playerCaptionsTracklistRenderer && j.captions.playerCaptionsTracklistRenderer.captionTracks) || [],
      unavailable: !!status && status !== 'OK', reason: (j.playabilityStatus && j.playabilityStatus.reason) || '',
    };
  }
  // fallback: scrape the watch page
  const res = await fetch(`https://www.youtube.com/watch?v=${id}&hl=en`, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.8', cookie: 'CONSENT=YES+cb.20240101-00-p0.en+FX+000; SOCS=CAI' } });
  if (!res.ok) throw new Error(`YouTube returned HTTP ${res.status}`);
  const html = await res.text();
  const title = decodeEntities((html.match(/<meta\s+name="title"\s+content="([^"]*)"/) || html.match(/<title>([^<]*)<\/title>/) || [])[1] || '').replace(/\s*-\s*YouTube$/, '').trim();
  const seconds = +((html.match(/"lengthSeconds":"(\d+)"/) || [])[1] || 0);
  return { id, title, seconds, tracks: parseCaptionTracks(html), unavailable: /"status":"(?:ERROR|LOGIN_REQUIRED|UNPLAYABLE)"/.test(html), reason: '' };
}
async function youtubeCaptions(url, { onProgress = () => {} } = {}) {
  onProgress({ text: 'looking up the YouTube video…' });
  const info = await youtubeInfo(url);
  const noCaps = (msg) => { const e = new Error(msg); e.code = 'NO_CAPTIONS'; e.info = info; return e; };
  if (!info.tracks.length) throw noCaps(info.unavailable ? `this video is not available (${info.reason || 'private, age-restricted or removed'})` : 'this video has no captions');
  const track = pickTrack(info.tracks);
  onProgress({ text: `fetching captions (${track.languageCode}${track.kind === 'asr' ? ', auto-generated' : ''})…` });
  const res = await fetch(`${track.baseUrl}${track.baseUrl.includes('?') ? '&' : '?'}fmt=json3`, { headers: { 'user-agent': YT_ANDROID.ua } });
  if (!res.ok) throw new Error(`caption download failed (HTTP ${res.status})`);
  const body = await res.text();
  if (!body.trim()) throw noCaps('YouTube refused the caption download for this video');
  let lines;
  if (/^\s*</.test(body)) lines = timedtextToLines(body);
  else { try { lines = json3ToLines(JSON.parse(body)); } catch { throw noCaps('YouTube sent captions in an unexpected format'); } }
  if (!lines.length) throw noCaps('the caption track is empty');
  return { ...info, lang: track.languageCode, auto: track.kind === 'asr', lines, text: lines.map((l) => `[${fmtTime(l.t)}] ${l.text}`).join('\n') };
}

module.exports = { MEDIA_EXT, isMediaPath, ffmpegPath, fmtTime, probe, run, Segmenter, transcribeFile, extractFrames, killAll, youtubeId, youtubeInfo, youtubeCaptions, parseCaptionTracks, pickTrack, json3ToLines, timedtextToLines };
