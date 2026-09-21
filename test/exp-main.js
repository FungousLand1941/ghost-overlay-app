// Experiment: which BrowserWindow configs actually get WDA_EXCLUDEFROMCAPTURE on Windows?
const { app, BrowserWindow } = require('electron');
const transparent = process.env.EXP_TRANSPARENT === '1';
const when = process.env.EXP_WHEN || 'before'; // before | after | delayed
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 300, height: 200, frame: false, transparent, show: false, alwaysOnTop: true, skipTaskbar: true, title: 'GhostExp', ...(process.env.EXP_TYPE ? { type: process.env.EXP_TYPE } : {}) });
  if (when === 'before') win.setContentProtection(true);
  win.loadURL('data:text/html,<body style="background:%23222;color:%23fff">exp</body>');
  if (when === 'cycle3') { win.on('show', () => win.setContentProtection(true)); setTimeout(() => { win.hide(); setTimeout(() => win.show(), 500); }, 1500); }
  win.once('ready-to-show', () => {
    win.show();
    if (when === 'after') win.setContentProtection(true);
    if (when === 'delayed') setTimeout(() => win.setContentProtection(true), 1000);
    // set once after show, then hide+show WITHOUT re-setting: does it persist?
    if (when === 'cycle') { win.setContentProtection(true); setTimeout(() => { win.hide(); setTimeout(() => win.show(), 500); }, 500); }
    // same but with opacity change + resize in between
    if (when === 'cycle2') { win.setContentProtection(true); setTimeout(() => { win.setOpacity(0.7); win.setSize(400, 300); win.hide(); setTimeout(() => win.show(), 500); }, 500); }
  });
});
