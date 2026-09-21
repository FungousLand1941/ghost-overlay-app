// Regression: with only a Claude key set (dropdown still on the Gemini default),
// Ghost must answer with Claude instead of "No Gemini API key set".
const assert = require('assert');
const providers = require('../src/providers');

let n = 0;
function check(name, ok) { n++; if (!ok) { console.error('FAIL', name); process.exit(1); } console.log('ok', name); }

const claudeOnly = { provider: 'gemini', claude: { apiKey: 'sk-ant-x' }, gemini: {}, openai: {} };
check('claude-only: effective provider is claude', providers.effectiveProvider(claudeOnly) === 'claude');
check('claude-only: claude answers first', providers.fallbackOrder(claudeOnly)[0] === 'claude');
check('claude-only + fallback none: still claude', providers.fallbackOrder({ ...claudeOnly, fallbackProvider: 'none' }).join(',') === 'claude');

const both = { provider: 'gemini', claude: { apiKey: 'sk-ant-x' }, gemini: { apiKey: 'AIza-x' }, openai: {} };
check('both keys: chosen provider wins', providers.effectiveProvider(both) === 'gemini');
check('both keys, chose claude: claude', providers.effectiveProvider({ ...both, provider: 'claude' }) === 'claude');

const navyOnly = { provider: 'claude', claude: {}, gemini: {}, openai: { apiKey: 'sk-navy-x', baseUrl: 'https://api.navy/v1' } };
check('openai-compat only: openai answers', providers.effectiveProvider(navyOnly) === 'openai');

const none = { provider: 'gemini', claude: {}, gemini: {}, openai: {} };
check('no keys: falls back to the chosen name', providers.effectiveProvider(none) === 'gemini');
(async () => {
  let err = null;
  try { for await (const _ of providers.stream(none, { messages: [{ role: 'user', text: 'hi' }], system: '' })) {} } catch (e) { err = e; }
  check('no keys: stream() explains that no provider has a key', !!err && /No API key set for any provider/.test(err.message));
  assert.ok(!/No Gemini API key set/.test(err.message));
  console.log(`provider-order: ${n} checks passed`);
})();
