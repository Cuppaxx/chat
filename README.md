# Mingus Chatroom — signaling server

The free PeerJS cloud is the weak link. It rate-limits, it goes down, and when it's
unhappy two people in the same room can both end up on slot 0 seeing an empty room.
Running your own takes about five minutes and then never breaks again.

It only does matchmaking. Voice, video and chat stay peer-to-peer and never pass
through it, so the free tier is plenty. It also serves the chatroom page itself at
`/chat`, which is what gets around Neocities' `connect-src 'self'` header.

## Deploy to Render (free)

1. Put these files (`server.js`, `discord-bridge.js`, `opus-split.js`,
   `mingus-chatroom.html`, `package.json`, `README.md`) in a GitHub repo.
2. Go to render.com → **New** → **Web Service** → connect that repo.
3. Settings:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free**
4. Deploy. You get a URL like `mingus-signaling.onrender.com`.
5. Open it in a browser — it should say `mingus signaling server: up`.
6. The chatroom is at `/chat`. The signaling host is already baked into the page,
   so nobody needs to touch **⚙ Connection Settings**.

Railway and Fly.io work the same way with the same two commands.

**Render free tier sleeps after ~15 minutes idle.** First join after a nap takes
30–50 seconds while it wakes up. If that's annoying, ping `/health` every 10
minutes with a free uptime monitor, or pay the $7 tier.

## Environment variables

| Variable | Needed for | Default |
|---|---|---|
| `ADMIN_PASS` | an extra admin password of your own (optional) | — (the built-in one is a fingerprint in the code) |
| `DISCORD_TOKEN` | anything Discord | — |
| `DISCORD_GUILD_ID` | the *default* selection in the voice-channel picker | — |
| `DISCORD_CHANNEL_ID` | the *default* selection in the voice-channel picker | — |
| `FISH_API_KEY` | VERITY's fast voice | — |
| `FISH_MODEL` | which Fish model to bill against | `s2.1-pro-free` |
| `FISH_VOICE` | which voice VERITY uses | the public "Verity" voice |

Since 7.0 the Discord IDs are only defaults — the admin panel lists every server
and channel the bot can reach and lets you pick, so changing channel no longer
needs a redeploy.

### VERITY's voice (Fish Audio)

Without `FISH_API_KEY` VERITY still works: she falls back to Kokoro-82M running
in the caller's browser, which is free and needs no account but downloads ~86 MB
once and takes a few seconds per line.

With a key she uses `s2.1-pro-free`, which Fish publish at **$0.00 per million
UTF-8 bytes** (free through 30 November 2026, fair use, no uptime guarantee).
There is nothing to download and lines come back in well under a second. The
server caches every rendered line in memory and rate-limits to 40 lines a minute
per address, so the stock greetings and idle chatter cost one render each ever.

`/verity/tts` has to be server-side: `api.fish.audio` sends no CORS headers, and
the key would be readable by every visitor if it lived in the page.

If the account ever runs out of credit Fish answers `402`, and the chatroom says
so in chat and drops back to the on-device voice rather than going silent.

### Discord bridge

Needs `DISCORD_TOKEN` and a bot invited to your server with **Connect** and
**Speak** on the voice channel, plus **Send Messages** on any text channel you
want to post into.

Relaying a Discord *text* channel back into the chatroom additionally needs the
**Message Content** privileged intent switched on in the Discord developer
portal. Without it Discord delivers empty message bodies and nothing appears.
Posting outbound never needs it.

The server never decodes audio in either direction — the browser holding the
bridge mixes and encodes once, and Discord's Opus packets are forwarded raw for
the browser to decode. That is what keeps it inside Render's 0.1 free CPU.

## This does not fix TURN

Different job. Signaling is how you find each other; TURN is how you reach each
other when both sides are behind NAT. You need both. Get a free TURN key
(metered.ca gives 20GB/month) and paste it into the same settings panel.

Worth knowing what that 20 GB is actually spent on: **only relayed connections**.
Direct peer-to-peer connections cost nothing at all, and nothing — voice, video
or files — is ever stored on the server. Turning the voice quality up costs the
server nothing; it costs relay quota, and only for the people whose network
forces a relay. The chatroom's **🔬 Audio report** button shows which of your
connections are relayed.

## Passwords

- **admin** — everything: bans, IP bans, IP tracing, room lock, trolls, the
  Discord bridge, theatre lead. The admin password is **not in the page
  source**: the page and `server.js` hold only a one-way PBKDF2 fingerprint
  of it, and the server checks every admin request (IP tracing, bans, the
  Discord bridge) against that. Wrong guesses are limited to 8 a minute per
  address. To add a password of your own on top, set `ADMIN_PASS` in the
  Render environment. To replace the built-in one, generate a new fingerprint
  (salt, 150,000 rounds, SHA-256) and put it in both `ADMIN_FP` blocks.
- **moderator** (`MingMod22`) — server mute/unmute, the forced mic limiter,
  a five-minute kick, announcements (MEGA included) and VERITY's Donald Trump
  mode. Nothing else - no IP tracing. A message signed with the mod password
  asking for anything outside that list is ignored by every other client, so a
  mod cannot widen their own powers by editing their copy of the page.

The old admin password (`MingMing67`, still `ADMIN_PASS` in the page) now only
signs peer-to-peer moderation messages. It is readable by anyone, so it no
longer unlocks the panel and the server refuses it for everything.

---

Note: the server files are syntax-checked but were not run end-to-end — the
sandbox they were written in can't reach the npm registry, so `npm install`
couldn't be tested here. If the deploy errors on boot, the log will say which
package.
