// Request governor: the single place that decides whether a Gemini/Claude
// call may go out. User-initiated answers always may (the user asked for
// them); background work (memory summaries, document digests, chunked
// transcription) is throttled and stops entirely after a rate-limit error
// or when the user pauses the AI. Everything is counted so the UI can show
// exactly where requests go.
const BACKGROUND = new Set(['memory', 'digest', 'transcribe']);

const state = {
  paused: false,
  maxPerMinute: 10,          // background budget (free tier is ~10–15 RPM total)
  cooldownUntil: 0,          // after a 429: no background calls until then
  quotaExhaustedUntil: 0,    // after a daily-quota error: no background calls until then
  recent: [],                // [{t, kind}] last 5 minutes
  counts: {},                // kind -> total this session
  rejected: {},              // kind -> blocked this session
  last429At: 0,
};

function prune(now = Date.now()) { state.recent = state.recent.filter((r) => now - r.t < 5 * 60 * 1000); }
function inLastMinute(now = Date.now()) { prune(now); return state.recent.filter((r) => now - r.t < 60 * 1000).length; }

// Returns { ok: true } or { ok: false, reason }.
function allow(kind) {
  const now = Date.now();
  if (state.paused) return { ok: false, reason: 'AI is paused' };
  if (BACKGROUND.has(kind)) {
    if (now < state.quotaExhaustedUntil) return { ok: false, reason: `quota exhausted — background calls off for ${Math.ceil((state.quotaExhaustedUntil - now) / 60000)} min` };
    if (now < state.cooldownUntil) return { ok: false, reason: `rate-limit cooldown ${Math.ceil((state.cooldownUntil - now) / 1000)} s` };
    if (inLastMinute(now) >= state.maxPerMinute) return { ok: false, reason: `over ${state.maxPerMinute} requests/min` };
  }
  return { ok: true };
}

function record(kind) { state.recent.push({ t: Date.now(), kind }); state.counts[kind] = (state.counts[kind] || 0) + 1; }
function reject(kind) { state.rejected[kind] = (state.rejected[kind] || 0) + 1; }

// Call with any provider error; sets cooldowns when it looks like a limit.
function noteError(err) {
  const msg = String((err && err.message) || err || '');
  const now = Date.now();
  if (/exhausted|quota|RESOURCE_EXHAUSTED|daily/i.test(msg)) { state.quotaExhaustedUntil = now + 30 * 60 * 1000; state.last429At = now; return 'quota'; }
  if (/rate.?limit|429|too many requests|RATE_LIMIT/i.test(msg) || (err && err.code === 'RATE_LIMIT')) { state.cooldownUntil = now + 90 * 1000; state.last429At = now; return 'rate'; }
  return null;
}

function setPaused(p) { state.paused = !!p; }
function configure({ maxPerMinute } = {}) { if (maxPerMinute) state.maxPerMinute = Math.max(1, +maxPerMinute); }
function stats() {
  const now = Date.now();
  return {
    paused: state.paused,
    lastMinute: inLastMinute(now),
    maxPerMinute: state.maxPerMinute,
    counts: { ...state.counts },
    rejected: { ...state.rejected },
    total: Object.values(state.counts).reduce((a, b) => a + b, 0),
    cooldownSec: Math.max(0, Math.ceil((state.cooldownUntil - now) / 1000)),
    quotaMin: Math.max(0, Math.ceil((state.quotaExhaustedUntil - now) / 60000)),
    last429At: state.last429At,
  };
}
function reset() { Object.assign(state, { paused: false, cooldownUntil: 0, quotaExhaustedUntil: 0, recent: [], counts: {}, rejected: {}, last429At: 0 }); }

module.exports = { allow, record, reject, noteError, setPaused, configure, stats, reset, BACKGROUND };
