// Top functions by self time in a .cpuprofile (from GHOST_PROFILE): node test/profile-top.js <file> [n]
const fs = require('fs');
const p = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const N = +process.argv[3] || 18;
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const self = new Map();
const dts = p.timeDeltas || [];
for (let i = 0; i < p.samples.length; i++) self.set(p.samples[i], (self.get(p.samples[i]) || 0) + (dts[i] || 0));
const agg = new Map(); let total = 0;
for (const [id, us] of self) { const f = byId.get(id).callFrame; const key = `${f.functionName || '(anonymous)'}  ${String(f.url).split('/').pop()}:${f.lineNumber + 1}`; agg.set(key, (agg.get(key) || 0) + us); total += us; }
console.log(`total ${(total / 1e6).toFixed(1)} s sampled`);
for (const [k, us] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, N)) console.log(`${(us / 1e6).toFixed(2).padStart(7)} s  ${((100 * us) / total).toFixed(1).padStart(5)} %  ${k}`);
