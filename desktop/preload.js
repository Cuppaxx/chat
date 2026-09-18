/* ============================================================================
   The bridge between the room and the shell.

   Deliberately tiny and deliberately one-directional in spirit: the page can
   ask for the handful of OS things it cannot do itself, and nothing more. No
   Node, no filesystem, no process. The page is loaded from the network, so the
   surface it can reach has to be a list somebody can read in one sitting -
   which is this file.
   ============================================================================ */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const hotkeyHandlers = [];
ipcRenderer.on('shell:hotkey', () => {
  hotkeyHandlers.forEach((fn) => { try { fn(); } catch (e) {} });
});

contextBridge.exposeInMainWorld('mingusDesktop', {
  /* true, so the page can tell it is running in the app rather than a tab */
  isDesktop: true,

  /* version, hotkey, auto-launch state, etc. */
  info: () => ipcRenderer.invoke('shell:info'),

  /* An Electron accelerator such as "Control+Shift+M", or null to clear it.
     Resolves {ok:true} or {ok:false,error} - Windows refuses a combination
     something else already holds, and the page should say so rather than
     silently appear to have set it. */
  setHotkey: (accel) => ipcRenderer.invoke('shell:setHotkey', accel || null),
  onHotkey: (fn) => { if (typeof fn === 'function') hotkeyHandlers.push(fn); },

  setAutoLaunch: (on) => ipcRenderer.invoke('shell:setAutoLaunch', !!on),
  setCloseToTray: (on) => ipcRenderer.invoke('shell:setCloseToTray', !!on),

  /* a real OS notification, for when the window is behind something */
  notify: (title, body) => ipcRenderer.invoke('shell:notify', { title, body }),
  /* the number on the taskbar icon */
  setUnread: (n) => ipcRenderer.invoke('shell:setUnread', n | 0),
  /* orange flash in the taskbar */
  flash: () => ipcRenderer.invoke('shell:flash'),
  /* keeps the tray menu's Mute/Unmute label honest */
  setMuted: (m) => ipcRenderer.invoke('shell:setMuted', !!m),

  minimizeToTray: () => ipcRenderer.invoke('shell:minimizeToTray'),
  quit: () => ipcRenderer.invoke('shell:quit'),

  /* self-update (1.1.0+): the shell finds, downloads and installs a new
     version on its own and reports each step here, so the page can put up
     its "needs an update" screen. checkUpdate asks it to look now. */
  onUpdate: (fn) => { if (typeof fn === 'function') ipcRenderer.on('shell:update', (e, u) => { try { fn(u); } catch (err) {} }); },
  checkUpdate: () => ipcRenderer.invoke('shell:checkUpdate'),

  /* the offline page uses these two */
  retry: () => ipcRenderer.invoke('shell:retry'),
  openLocalCopy: () => ipcRenderer.invoke('shell:openLocal'),
});
