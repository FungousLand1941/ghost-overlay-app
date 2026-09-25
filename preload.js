const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('ghost', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  models: () => ipcRenderer.invoke('providers:models'),

  captureScreen: () => ipcRenderer.invoke('screen:capture'),
  chatStart: (args) => ipcRenderer.invoke('chat:start', args),
  chatStop: () => ipcRenderer.invoke('chat:stop'),
  transcribe: (args) => ipcRenderer.invoke('audio:transcribe', args),
  testKey: (args) => ipcRenderer.invoke('provider:test', args),
  liveStart: (args) => ipcRenderer.invoke('live:start', args),
  liveAudio: (source, data) => ipcRenderer.send('live:audio', { source, data }),
  summarize: (args) => ipcRenderer.invoke('context:summarize', args),
  cleanupTranscript: (args) => ipcRenderer.invoke('context:cleanup', args),
  sessionSave: (data) => ipcRenderer.invoke('session:save', data),
  sessionLoad: () => ipcRenderer.invoke('session:load'),
  sessionClear: () => ipcRenderer.invoke('session:clear'),
  liveNudge: () => ipcRenderer.invoke('live:nudge'),
  livePendingRevisions: () => ipcRenderer.invoke('live:pendingRevisions'),
  liveStop: () => ipcRenderer.invoke('live:stop'),
  onLiveEvent: on('live:event'),

  sttModel: (args) => ipcRenderer.invoke('stt:model', args || {}),

  // request governor / pause
  aiStats: () => ipcRenderer.invoke('ai:stats'),
  aiPause: (paused) => ipcRenderer.invoke('ai:pause', paused),
  onAiEvent: on('ai:event'),

  // document library
  docsList: () => ipcRenderer.invoke('docs:list'),
  docsAdd: (opts) => ipcRenderer.invoke('docs:add', opts || {}), // file picker
  docsAddPath: (p, opts) => ipcRenderer.invoke('docs:addPath', opts ? { p, opts } : p), // drag & drop / tests
  docsAddUrl: (url, opts) => ipcRenderer.invoke('docs:addUrl', { url, opts: opts || {} }), // web page / whole site / YouTube / media link
  docsAddText: (name, text) => ipcRenderer.invoke('docs:addText', { name, text }),
  docsToggle: (id, enabled) => ipcRenderer.invoke('docs:toggle', { id, enabled }),
  docsRemove: (id) => ipcRenderer.invoke('docs:remove', id),
  docsDigest: (id) => ipcRenderer.invoke('docs:digest', id),
  onDocsEvent: on('docs:event'),
  pathForFile: (file) => webUtils.getPathForFile(file),

  hide: () => ipcRenderer.invoke('win:hide'),
  quit: () => ipcRenderer.invoke('win:quit'),
  setClickThrough: (on) => ipcRenderer.invoke('win:clickthrough', on),
  winState: () => ipcRenderer.invoke('win:state'),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),

  onChatEvent: on('chat:event'),
  onHotkey: on('hotkey'),
  onState: on('state'),
  onToast: on('toast'),
  onSaveNow: on('app:save-now'),
});
