// Request governor: background calls are budgeted, stop after a 429 / quota
// error, and everything stops when paused; user asks are counted but never throttled.
const g = require('../src/governor');
let failures = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n} ${x}`); if (!c) failures++; };

g.reset(); g.configure({ maxPerMinute: 3 });
check('ask allowed', g.allow('ask').ok);
for (let i = 0; i < 3; i++) { check(`memory #${i + 1} allowed within budget`, g.allow('memory').ok); g.record('memory'); }
check('4th background call blocked by budget', !g.allow('memory').ok && /requests\/min/.test(g.allow('memory').reason));
check('ask still allowed over budget', g.allow('ask').ok);
check('stats count', g.stats().counts.memory === 3 && g.stats().lastMinute === 3);

g.reset();
check('429 -> rate cooldown', g.noteError(new Error('Gemini: rate limited (free tier ~10 req/min) — backing off.')) === 'rate');
check('background blocked during cooldown', !g.allow('transcribe').ok && /cooldown/.test(g.allow('transcribe').reason));
check('digest blocked during cooldown', !g.allow('digest').ok);
check('ask allowed during cooldown', g.allow('ask').ok);

g.reset();
check('quota -> long suspension', g.noteError(new Error('1011 Resource has been exhausted (e.g. check quota).')) === 'quota');
check('background blocked after quota', !g.allow('memory').ok && /quota/.test(g.allow('memory').reason));
check('quota window is ~30 min', g.stats().quotaMin >= 29);

g.reset(); g.setPaused(true);
check('paused blocks asks', !g.allow('ask').ok && /paused/.test(g.allow('ask').reason));
check('paused blocks live', !g.allow('live').ok);
g.setPaused(false);
check('resume allows again', g.allow('ask').ok && g.allow('live').ok);

check('non-limit errors ignored', g.noteError(new Error('Gemini 400: bad request')) === null);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exitCode = failures ? 1 : 0;
