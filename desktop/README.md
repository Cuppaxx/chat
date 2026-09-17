# Mingus Chatroom — Windows app

A desktop shell around the room. It does **not** contain a copy of the chatroom:
it loads the live page from the server, so every deploy reaches the app the
moment it reaches everyone in a browser and there is never a second thing to
keep updated. A bundled copy ships alongside only as a fallback for when the
server is asleep.

What the shell adds is the handful of things a browser tab cannot do:

| | |
|---|---|
| **Global mute hotkey** | works while Mingus is behind another window |
| **Tray icon** | closing the window keeps your call up |
| **Notifications** | a real Windows toast when somebody whispers you |
| **Taskbar badge** | unread count on the icon |
| **Screen share picker** | any window or monitor, not just browser tabs |
| **Start with Windows** | opens straight to the tray |
| **No browser chrome** | no address bar, no tab strip, remembers its position |

---

## Building it

You need **Node.js** once. It is not currently installed on this machine.

1. Install it from <https://nodejs.org> — the LTS build, default options.
   Close and reopen your terminal afterwards so `node` is on PATH.

2. Then, from the repo root:

```bash
cd desktop
npm install
npm run dist
```

The first `npm install` pulls down Electron and is about 300 MB. It only
happens once.

`npm run dist` writes two things into `desktop/dist/`:

- **`Mingus Chatroom Setup 1.0.0.exe`** — a normal installer, with Start menu
  and desktop shortcuts
- **`Mingus Chatroom 1.0.0.exe`** — portable, runs from anywhere, installs
  nothing

Either is the whole app. Send someone the portable one and it just runs.

### Trying it without building

```bash
cd desktop
npm install
npm start
```

That opens the real app straight away. `npm run dev` does the same with
devtools open.

### Pointing it somewhere else

```bash
set MINGUS_URL=http://localhost:3000/chat
npm start
```

Useful for testing a server change before deploying it.

---

## Windows will warn about it

The installer is unsigned, so SmartScreen shows *"Windows protected your PC"*.
**More info → Run anyway.** That is expected for any unsigned app and is not a
problem with this one.

Getting rid of the warning needs a code-signing certificate — a few hundred a
year from a certificate authority. Worth it if you hand this out widely; not
worth it for a handful of friends who can click through once.

---

## Two honest limitations

**The hotkey is a toggle, not hold-to-talk.** Electron's global shortcut API
reports a key going *down* and never coming back *up*, so hold-to-talk is not
possible with it. Real hold-to-talk needs a low-level keyboard hook, which means
a native module and a working C++ compiler on whichever machine builds the app.
That is a lot of build fragility for a feature most people leave on toggle
anyway. If you want it, say so and it can be added as an optional dependency
that the app uses when present and ignores when not.

**The app trusts the page it loads.** The preload exposes a small, fixed list of
functions — hotkey, tray, notification, badge, screen picker — and nothing else:
no filesystem, no Node, no shell. That list is all of `preload.js` and is short
enough to read in one sitting. It is still worth knowing that whatever the
server serves can call those, so the app is exactly as trustworthy as the
server is.

---

## Files

| | |
|---|---|
| `main.js` | the window, tray, hotkeys, permissions, screen capture |
| `preload.js` | the entire bridge between the page and the shell |
| `offline.html` | shown when the server cannot be reached, with a retry |
| `build/icon.png` | app icon; electron-builder makes the `.ico` from it |

The page's own half lives in `mingus-chatroom.html`, behind
`if (window.mingusDesktop)`. In a browser none of it runs.
