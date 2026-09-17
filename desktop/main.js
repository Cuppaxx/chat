/* ============================================================================
   Mingus Chatroom — desktop shell

   The room itself stays exactly where it is: this loads the live page from the
   server rather than bundling a copy, so a deploy reaches the desktop app at
   the same moment it reaches everybody in a browser and there is never a second
   thing to keep updated. A bundled copy ships alongside only as a fallback for
   when the server is asleep or the connection is down.

   What the shell adds is the handful of things a browser tab genuinely cannot
   do, which is the whole reason to want a desktop app in the first place:

     - a global hotkey that works while the window is behind something else
     - a tray icon, so closing the window does not drop you out of the call
     - real OS notifications, with an unread badge on the taskbar
     - a screen-share picker that can offer individual windows, not just tabs
     - start with Windows
     - no address bar, no tab strip, and a window that remembers where it was
   ============================================================================ */
'use strict';

const {
  app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, shell,
  session, nativeImage, screen, desktopCapturer, Notification, dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');

const ROOM_URL = process.env.MINGUS_URL || 'https://mingus-signaling.onrender.com/chat';
const ORIGIN = (() => { try { return new URL(ROOM_URL).origin; } catch (e) { return ''; } })();
const DEV = process.argv.includes('--dev');

let win = null;
let tray = null;
let quitting = false;
let hotkey = null;              // the accelerator currently registered

// ---------------------------------------------------------------- state file
// Window position and the few desktop-only preferences. Kept next to the app's
// own data rather than in the page's localStorage, because they have to be
// known before the page has loaded.
const STATE_FILE = () => path.join(app.getPath('userData'), 'shell-state.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')) || {}; } catch (e) { return {}; }
}
function saveState(patch) {
  try {
    const s = Object.assign(loadState(), patch);
    fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true });
    fs.writeFileSync(STATE_FILE(), JSON.stringify(s, null, 2));
  } catch (e) {}
}

function iconPath() {
  const p = path.join(__dirname, 'build', 'icon.png');
  return fs.existsSync(p) ? p : null;
}

// ---------------------------------------------------------------- the window
function boundsWithinAScreen(b) {
  // A monitor that is no longer attached would otherwise put the window
  // somewhere nobody can reach.
  if (!b || typeof b.x !== 'number') return false;
  return screen.getAllDisplays().some((d) => {
    const w = d.workArea;
    return b.x < w.x + w.width && b.x + b.width > w.x &&
           b.y < w.y + w.height && b.y + b.height > w.y;
  });
}

function createWindow() {
  const st = loadState();
  const saved = boundsWithinAScreen(st.bounds) ? st.bounds : null;

  win = new BrowserWindow({
    width: saved ? saved.width : 1280,
    height: saved ? saved.height : 880,
    x: saved ? saved.x : undefined,
    y: saved ? saved.y : undefined,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#07051a',      // the page's own dark background, so there
    show: false,                     // is no white flash before it paints
    autoHideMenuBar: true,
    icon: iconPath() || undefined,
    title: 'Mingus Chatroom',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
      backgroundThrottling: false,   // a minimised window must keep the call up
    },
  });

  if (st.maximized) win.maximize();

  win.once('ready-to-show', () => {
    win.show();
    if (DEV) win.webContents.openDevTools({ mode: 'detach' });
  });

  const remember = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    saveState({ bounds: win.getNormalBounds(), maximized: win.isMaximized() });
  };
  win.on('resize', remember);
  win.on('move', remember);
  win.on('maximize', remember);
  win.on('unmaximize', remember);

  // Closing the window keeps the call alive in the tray, the way Discord does.
  // Actually quitting is the tray menu or File > Quit.
  win.on('close', (e) => {
    if (quitting) return;
    const st2 = loadState();
    if (st2.closeToTray === false) { quitting = true; return; }
    e.preventDefault();
    win.hide();
    if (!st2.trayNoticeShown) {
      saveState({ trayNoticeShown: true });
      notify('Still running', 'Mingus is in the tray so your call stays up. Right-click the tray icon to quit properly.');
    }
  });

  win.on('closed', () => { win = null; });

  // Links to anywhere else belong in the real browser, not in here.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (new URL(url).origin === ORIGIN) return { action: 'allow' };
    } catch (e) {}
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    try {
      if (new URL(url).origin !== ORIGIN) { e.preventDefault(); shell.openExternal(url); }
    } catch (e2) {}
  });

  loadRoom();
  return win;
}

function loadRoom() {
  win.loadURL(ROOM_URL).catch(() => showOffline('could not reach the server'));
  win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (isMainFrame) showOffline(desc || ('error ' + code));
  });
}

// The server sleeps on Render's free tier, so "it did not load" is a normal
// thing to hit rather than an emergency. Say what happened and offer a retry
// instead of showing Chromium's error page.
function showOffline(why) {
  const local = path.join(process.resourcesPath || __dirname, 'mingus-chatroom.html');
  const html = path.join(__dirname, 'offline.html');
  if (fs.existsSync(html)) {
    win.loadFile(html, { query: { why: String(why), url: ROOM_URL, local: fs.existsSync(local) ? '1' : '' } });
  }
}
ipcMain.handle('shell:retry', () => { loadRoom(); });
ipcMain.handle('shell:openLocal', () => {
  const local = path.join(process.resourcesPath || __dirname, 'mingus-chatroom.html');
  if (fs.existsSync(local)) win.loadFile(local);
});

// ---------------------------------------------------------------- permissions
function wirePermissions() {
  const ses = session.defaultSession;

  // The room is the app. Asking the person to approve their own microphone
  // every launch would be theatre, so the room's own origin is allowed and
  // everything else is refused.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = (details && details.requestingUrl) || (wc && wc.getURL()) || '';
    let ok = false;
    try { ok = new URL(url).origin === ORIGIN || url.startsWith('file://'); } catch (e) {}
    const allowed = ['media', 'display-capture', 'clipboard-read', 'clipboard-sanitized-write',
                     'notifications', 'fullscreen', 'pointerLock'];
    callback(ok && allowed.includes(permission));
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => {
    try { return origin === ORIGIN || String(origin).startsWith('file://'); } catch (e) { return false; }
  });

  // Screen sharing. In a browser this is the tab picker; here it can offer
  // every window and monitor on the machine, which is the point.
  if (ses.setDisplayMediaRequestHandler) {
    ses.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 320, height: 200 },
          fetchWindowIcons: true,
        });
        if (!sources.length) return callback({});
        const payload = sources.map((s) => ({
          id: s.id, name: s.name,
          thumb: s.thumbnail ? s.thumbnail.toDataURL() : '',
          icon: s.appIcon ? s.appIcon.toDataURL() : '',
          screen: s.id.startsWith('screen'),
        }));
        // the page draws the picker, so it matches the rest of the room
        const chosen = await win.webContents.executeJavaScript(
          'window.__mingusPickSource && window.__mingusPickSource(' + JSON.stringify(payload) + ')'
        ).catch(() => null);
        const pick = sources.find((s) => s.id === chosen) || null;
        if (!pick) return callback({});
        // audio: 'loopback' shares the machine's sound along with the picture
        callback({ video: pick, audio: 'loopback' });
      } catch (e) {
        callback({});
      }
    }, { useSystemPicker: false });
  }
}

// ---------------------------------------------------------------- global hotkey
// Electron's globalShortcut only reports the key going DOWN, never coming back
// up, so a true hold-to-talk is not possible with it - that needs a low-level
// keyboard hook and a native module. What IS possible, and is what most people
// actually leave configured anyway, is a toggle that works while the window is
// behind something else.
function setHotkey(accel) {
  try { globalShortcut.unregisterAll(); } catch (e) {}
  hotkey = null;
  if (!accel) return { ok: true, accel: null };
  try {
    const ok = globalShortcut.register(accel, () => {
      if (!win || win.isDestroyed()) return;
      win.webContents.send('shell:hotkey');
    });
    if (!ok) return { ok: false, error: 'Windows would not give us that combination — something else has it.' };
    hotkey = accel;
    saveState({ hotkey: accel });
    return { ok: true, accel };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ---------------------------------------------------------------- tray
function buildTray() {
  const img = iconPath() ? nativeImage.createFromPath(iconPath()) : nativeImage.createEmpty();
  tray = new Tray(img.isEmpty() ? img : img.resize({ width: 16, height: 16 }));
  tray.setToolTip('Mingus Chatroom');
  refreshTrayMenu();
  tray.on('click', () => {
    if (!win) { createWindow(); return; }
    if (win.isVisible() && !win.isMinimized()) win.hide();
    else { win.show(); win.focus(); }
  });
}
function refreshTrayMenu(state) {
  if (!tray) return;
  const st = loadState();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Mingus Chatroom', enabled: false },
    { type: 'separator' },
    { label: 'Open', click: () => { if (win) { win.show(); win.focus(); } else createWindow(); } },
    { label: (state && state.muted) ? 'Unmute' : 'Mute',
      click: () => { if (win) win.webContents.send('shell:hotkey'); } },
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (mi) => { app.setLoginItemSettings({ openAtLogin: mi.checked, args: ['--hidden'] }); } },
    { label: 'Close button hides to tray', type: 'checkbox',
      checked: st.closeToTray !== false,
      click: (mi) => { saveState({ closeToTray: mi.checked }); refreshTrayMenu(); } },
    { type: 'separator' },
    { label: 'Reload', click: () => { if (win) win.reload(); } },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

function notify(title, body) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, icon: iconPath() || undefined, silent: false });
    n.on('click', () => { if (win) { win.show(); win.focus(); } });
    n.show();
  } catch (e) {}
}

// ---------------------------------------------------------------- ipc
ipcMain.handle('shell:info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  url: ROOM_URL,
  hotkey: loadState().hotkey || null,
  autoLaunch: app.getLoginItemSettings().openAtLogin,
  closeToTray: loadState().closeToTray !== false,
}));
ipcMain.handle('shell:setHotkey', (e, accel) => setHotkey(accel));
ipcMain.handle('shell:setAutoLaunch', (e, on) => {
  app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
  refreshTrayMenu();
  return app.getLoginItemSettings().openAtLogin;
});
ipcMain.handle('shell:setCloseToTray', (e, on) => {
  saveState({ closeToTray: !!on }); refreshTrayMenu(); return !!on;
});
ipcMain.handle('shell:notify', (e, { title, body }) => { notify(String(title || ''), String(body || '')); });
ipcMain.handle('shell:setUnread', (e, n) => {
  n = Math.max(0, n | 0);
  if (!win || win.isDestroyed()) return;
  // a number on the taskbar icon, the way a chat app should
  try {
    if (!n) { win.setOverlayIcon(null, ''); tray && tray.setToolTip('Mingus Chatroom'); return; }
    const label = n > 9 ? '9+' : String(n);
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">' +
      '<circle cx="16" cy="16" r="15" fill="#e0192f" stroke="#fff" stroke-width="2"/>' +
      '<text x="16" y="22" font-family="Segoe UI,sans-serif" font-size="' + (n > 9 ? 14 : 17) +
      '" font-weight="700" fill="#fff" text-anchor="middle">' + label + '</text></svg>'
    ).toString('base64');
    const img = nativeImage.createFromDataURL('data:image/svg+xml;base64,' + svg);
    win.setOverlayIcon(img, n + ' unread');
    tray && tray.setToolTip('Mingus Chatroom — ' + n + ' unread');
  } catch (err) {}
});
ipcMain.handle('shell:setMuted', (e, muted) => { refreshTrayMenu({ muted: !!muted }); });
ipcMain.handle('shell:flash', () => { if (win && !win.isFocused()) win.flashFrame(true); });
ipcMain.handle('shell:minimizeToTray', () => { if (win) win.hide(); });
ipcMain.handle('shell:quit', () => { quitting = true; app.quit(); });

// ---------------------------------------------------------------- boot
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (!win.isVisible()) win.show(); if (win.isMinimized()) win.restore(); win.focus(); }
  });

  // WebRTC wants these; without them screen capture and some cameras misbehave
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
  app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');

  app.whenReady().then(() => {
    wirePermissions();
    createWindow();
    buildTray();
    const st = loadState();
    if (st.hotkey) setHotkey(st.hotkey);
    if (process.argv.includes('--hidden') && win) win.hide();
  });

  app.on('window-all-closed', () => { /* stay in the tray */ });
  app.on('activate', () => { if (!win) createWindow(); });
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (e) {} });
}
