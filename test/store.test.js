// Regression: API keys must survive (1) store reads before app-ready, where
// safeStorage cannot decrypt, and (2) any decryption failure — save() must never
// overwrite a stored key with ''. Uses a fake `electron` module.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-store-'));
const state = { ready: false, cryptoOk: true };
const fakeElectron = {
  app: { isReady: () => state.ready, getPath: () => tmp },
  safeStorage: {
    isEncryptionAvailable: () => state.ready,
    encryptString: (s) => { if (!state.ready) throw new Error('not ready'); return Buffer.from('X' + s); },
    decryptString: (b) => { if (!state.ready || !state.cryptoOk) throw new Error('cannot decrypt'); return b.toString().slice(1); },
  },
};
require.cache[require.resolve('electron')] = { id: 'electron', filename: 'electron', loaded: true, exports: fakeElectron };
const fresh = () => { delete require.cache[require.resolve('../src/store')]; return require('../src/store'); };
const disk = () => JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));

let failures = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n} ${x}`); if (!c) failures++; };

// seed a config with real (encrypted) keys, written while ready
state.ready = true;
let store = fresh();
store.patch({ gemini: { apiKey: 'AQ.real-gemini' }, claude: { apiKey: 'sk-ant-real' } });
check('seed: keys encrypted on disk', /^enc:/.test(disk().gemini.apiKey) && /^enc:/.test(disk().claude.apiKey));

// 1. the bug: a read BEFORE ready, then a normal save after ready
state.ready = false;
store = fresh();
const early = store.get();
check('pre-ready read: secrets blank in the view', early.gemini.apiKey === '' && early.claude.apiKey === '');
store.patch({ bounds: { x: 1 } });                      // e.g. window moved before ready
check('pre-ready patch: nothing written', /^enc:/.test(disk().gemini.apiKey));
state.ready = true;
check('after ready: real keys come back', store.get().gemini.apiKey === 'AQ.real-gemini' && store.get().claude.apiKey === 'sk-ant-real');
store.patch({ bounds: { x: 2 } });                      // the save that used to wipe keys
check('post-ready save keeps keys', /^enc:/.test(disk().gemini.apiKey) && /^enc:/.test(disk().claude.apiKey));

// 2. decryption failure after ready (keychain hiccup): ciphertext must be preserved
state.cryptoOk = false;
store = fresh();
check('undecryptable: in-memory blank', store.get().gemini.apiKey === '');
const before = disk().gemini.apiKey;
store.patch({ bounds: { x: 3 } });
check('undecryptable: original ciphertext preserved on disk', disk().gemini.apiKey === before && before.startsWith('enc:'));
state.cryptoOk = true;
store = fresh();
check('keys readable again once decryption works', store.get().gemini.apiKey === 'AQ.real-gemini');

// 3. a newly pasted key replaces a preserved one
state.cryptoOk = false; store = fresh(); store.get();
state.cryptoOk = true;
store.patch({ gemini: { apiKey: 'AQ.new-key' } });
store = fresh();
check('new key replaces preserved ciphertext', store.get().gemini.apiKey === 'AQ.new-key');

// 4. config-version migration on a pre-ready read must not save
state.ready = false;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ ...disk(), configVersion: 1 }));
store = fresh(); store.get();
check('migration deferred until ready (no write)', disk().configVersion === 1);
state.ready = true; store = fresh(); store.get();
check('migration runs once ready, keys intact', disk().configVersion === store.defaults.configVersion && /^enc:/.test(disk().gemini.apiKey));

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exitCode = failures ? 1 : 0;
fs.rmSync(tmp, { recursive: true, force: true });
