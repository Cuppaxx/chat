# Mingus Chatroom — signaling server

The free PeerJS cloud is the weak link. It rate-limits, it goes down, and when it's
unhappy two people in the same room can both end up on slot 0 seeing an empty room.
Running your own takes about five minutes and then never breaks again.

It only does matchmaking. Voice, video and chat stay peer-to-peer and never pass
through it, so the free tier is plenty.

## Deploy to Render (free)

1. Put these three files (`server.js`, `package.json`, `README.md`) in a new GitHub repo.
2. Go to render.com → **New** → **Web Service** → connect that repo.
3. Settings:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free**
4. Deploy. You get a URL like `mingus-signaling.onrender.com`.
5. Open it in a browser — it should say `mingus signaling server: up`.
6. In the chatroom, **⚙ Connection Settings** → Signaling server:
   `mingus-signaling.onrender.com:443`
7. Save, then hit **Invite Players to Party**. The copied link now carries the
   server setting, so anyone who clicks it uses your server automatically.

Railway and Fly.io work the same way with the same two commands.

**Render free tier sleeps after ~15 minutes idle.** First join after a nap takes
30–50 seconds while it wakes up. If that's annoying, ping `/health` every 10
minutes with a free uptime monitor, or pay the $7 tier.

## This does not fix TURN

Different job. Signaling is how you find each other; TURN is how you reach each
other when both sides are behind NAT. You need both. Get a free TURN key
(metered.ca gives 20GB/month) and paste it into the same settings panel.

---

Note: these files are syntax-checked but were not run end-to-end — the sandbox
they were written in can't reach the npm registry, so `npm install` couldn't be
tested here. If the deploy errors on boot, the log will say which package.
