(() => {
  document.getElementById('empty').classList.add('hidden');
  const m = document.getElementById('messages');
  m.insertAdjacentHTML('beforeend', '<div class="msg user"><div class="bubble">Solve the problem on screen</div></div>');
  const md = [
    '**Two-sum, O(n) with a hash map.**', '',
    '```python',
    'def two_sum(nums, target):',
    '    seen = {}',
    '    for i, n in enumerate(nums):',
    '        if target - n in seen:',
    '            return [seen[target - n], i]',
    '        seen[n] = i',
    '```', '',
    '- Time **O(n)**, space **O(n)**',
    '- Edge cases: duplicates, negative numbers, no solution',
  ].join('\n');
  m.insertAdjacentHTML('beforeend', '<div class="msg assistant"><div class="bubble md">' + renderMarkdown(md) + '</div></div>');
  return true;
})();
