// Document library: LaTeX cleaning, storage, and what each mode gets.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-docs-'));
const docs = require('../src/docs');
docs.init(() => tmp);

let failures = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n} ${x}`); if (!c) failures++; };

(async () => {
  // 1. LaTeX cleaning
  const tex = `\\documentclass{article}
\\usepackage{amsmath} % preamble noise
\\title{Barriers for Nike}
\\begin{document}
\\maketitle
\\begin{abstract}
We prove that $\\rho(n) \\le 2$ for all $n$. % trailing comment
\\end{abstract}
\\section{Introduction}
Prior work~\\cite{foo2020,bar2021} showed \\textbf{bounds} of $O(n^2)$; see Section~\\ref{sec:method}.
\\begin{figure}[h]
\\centering
\\includegraphics[width=0.5\\textwidth]{fig1.png}
\\caption{Growth of $\\rho$ with $n$.}
\\label{fig:growth}
\\end{figure}
\\subsection{Method}\\label{sec:method}
\\begin{itemize}
\\item First step.
\\item Second step with $x = 1$.
\\end{itemize}
\\begin{theorem}[Main]
For every $n$, $\\rho(n) \\le 2$.
\\end{theorem}
\\end{document}`;
  const clean = docs.cleanLatex(tex);
  check('latex: preamble dropped', !/documentclass|usepackage/.test(clean));
  check('latex: comments dropped', !/preamble noise|trailing comment/.test(clean));
  check('latex: sections -> headings', /# Introduction/.test(clean) && /## Method/.test(clean) && /## Abstract/.test(clean));
  check('latex: math kept', /\$\\rho\(n\) \\le 2\$/.test(clean) && /\$O\(n\^2\)\$/.test(clean));
  check('latex: cite/ref noise reduced', /\[cite\]/.test(clean) && /\[sec:method\]/.test(clean) && !/\\cite/.test(clean));
  check('latex: figure reduced to its caption', /\[Figure fig:growth: Growth of \$\\rho\$ with \$n\$\.\]/.test(clean) && !/includegraphics/.test(clean));
  check('latex: items and theorem kept', /- First step\./.test(clean) && /\*\*Theorem \(Main\)\.\*\*/.test(clean));
  check('latex: bold unwrapped', /showed bounds of/.test(clean));

  // 2. storage + contextFor per mode
  const p = path.join(tmp, 'paper.tex');
  fs.writeFileSync(p, tex.replace('\\end{document}', 'Filler sentence for length. '.repeat(400) + '\n\\end{document}')); // > DIGEST_MIN_CHARS
  const entry = await docs.add(p);
  check('add: stored + pending digest', entry.kind === 'latex' && entry.chars >= docs.DIGEST_MIN_CHARS && entry.digestStatus === 'pending', JSON.stringify({ kind: entry.kind, chars: entry.chars, st: entry.digestStatus }));
  const short = docs.addText('notes.txt', 'Short note: the deadline is Friday.');
  check('addText: short doc never needs a digest', short.digestStatus === 'not-needed');

  const think = docs.contextFor('think');
  check('think: full text of the paper', /# Introduction/.test(think) && /\(full text\)/.test(think));
  const instantNoDigest = docs.contextFor('instant');
  check('instant before digest: full text is sent (it fits)', /\(full text\)/.test(instantNoDigest) && /# Introduction/.test(instantNoDigest));
  docs.update(entry.id, { digest: 'DIGEST: rho(n) <= 2 for all n; method: two steps.', digestStatus: 'ready' });
  const instant = docs.contextFor('instant');
  check('instant after digest: digest replaces the full text', /\(digest\)/.test(instant) && /DIGEST: rho/.test(instant) && !/# Introduction/.test(instant));
  check('instant: short doc still in full', /deadline is Friday/.test(instant));
  check('instant with full override', /# Introduction/.test(docs.contextFor('instant', { instantUsesFull: true })));
  docs.update(entry.id, { enabled: false });
  check('disabled doc excluded', !/rho/.test(docs.contextFor('think')));
  docs.remove(entry.id); docs.remove(short.id);
  check('remove: gone', docs.list().length === 0 && !fs.existsSync(path.join(tmp, `${entry.id}.txt`)));

  // 3. cap
  docs.addText('big', 'x'.repeat(1000));
  const over = docs.contextFor('think', { capChars: 100 });
  check('cap: a doc that does not fit sends its beginning + is flagged for per-question retrieval', /beginning only/.test(over) && over.length < 400 && docs.partialDocs('think', { capChars: 100 }).length === 1);

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exitCode = failures ? 1 : 0;
  fs.rmSync(tmp, { recursive: true, force: true });
})();
