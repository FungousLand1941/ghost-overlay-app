renderMarkdown([
  '# T', '',
  '- a **b** `c`', '  - nested', '',
  '```js', 'let x = 1 < 2;', '```', '',
  '| h | i |', '|---|---|', '| 1 | 2 |',
].join('\n'));
