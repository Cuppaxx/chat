/* ===================== DISCORD BRIDGE =====================
   Pipes the Mingus Chatroom voice call into a Discord voice channel, on demand,
   from the 🔗 button in the chatroom's admin panel.

   The server never touches audio. The browser that pressed the button mixes
   every peer + its own mic with WebAudio, encodes once with MediaRecorder
   (Opus in WebM) and streams the chunks here over a WebSocket. @discordjs/voice
   demuxes WebM/Opus natively, so this is a dumb pipe: bytes in, bytes out.
   That is what fits in Render's 0.1 free CPU.

   Render -> Environment needs:
     DISCORD_TOKEN, DISCORD_GUILD_ID, DISCORD_CHANNEL_ID

   Scope: chatroom -> Discord only. Discord cannot yet be heard in the chatroom.
*/

const { PassThrough } = require('stream');

const state = {
  active: false,
  client: null,
  connection: null,
  player: null,
  feed: null,       // PassThrough carrying WebM/Opus from the browser
  socket: null,     // the browser holding the bridge open
  startedAt: 0,
  bytes: 0,
  lastError: '',
};

function log(...a) { console.log('[bridge]', ...a); }

function status() {
  return {
    active: state.active,
    seconds: state.active ? Math.round((Date.now() - state.startedAt) / 1000) : 0,
    kb: Math.round(state.bytes / 1024),
    configured: !!(process.env.DISCORD_TOKEN && process.env.DISCORD_GUILD_ID && process.env.DISCORD_CHANNEL_ID),
    lastError: state.lastError || null,
  };
}

async function joinDiscord() {
  const token = process.env.DISCORD_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  const channelId = process.env.DISCORD_CHANNEL_ID;
  if (!token || !guildId || !channelId) {
    throw new Error('DISCORD_TOKEN / DISCORD_GUILD_ID / DISCORD_CHANNEL_ID not set in Render environment');
  }

  // required lazily so the server still boots if the deps are missing
  const { Client, GatewayIntentBits } = require('discord.js');
  const {
    joinVoiceChannel, createAudioPlayer, createAudioResource,
    StreamType, NoSubscriberBehavior, entersState, VoiceConnectionStatus,
  } = require('@discordjs/voice');

  if (!state.client) {
    log('logging in to Discord…');
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
    await client.login(token);
    await new Promise((res) => (client.isReady() ? res() : client.once('clientReady', res)));
    state.client = client;
    log('logged in as', client.user && client.user.tag);
  }

  const guild = await state.client.guilds.fetch(guildId);
  log('joining voice channel', channelId, 'in', guild.name);
  state.connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,    // we only send
    selfMute: false,
  });
  state.connection.on('error', (e) => { state.lastError = String(e && e.message || e); log('connection error', state.lastError); });
  state.connection.on('stateChange', (o, n) => log('voice', o.status, '->', n.status));
  try {
    await entersState(state.connection, VoiceConnectionStatus.Ready, 20000);
  } catch (e) {
    throw new Error('could not reach the voice channel in 20s (check the bot has Connect + Speak on that channel): ' + (e && e.message || e));
  }
  log('voice connection ready');

  state.feed = new PassThrough({ highWaterMark: 1 << 20 });
  const resource = createAudioResource(state.feed, { inputType: StreamType.WebmOpus });
  // The browser sends a chunk every ~200 ms, but the player polls every 20 ms
  // and by default gives up after 5 empty polls (100 ms). That made it go
  // idle right after the first chunk while audio kept arriving. Gaps are
  // normal here, so never stop on them; the WebSocket closing is what ends
  // the bridge.
  state.player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: Number.MAX_SAFE_INTEGER },
  });
  state.player.on('error', (e) => { state.lastError = String(e && e.message || e); log('player error', state.lastError); });
  state.player.on('stateChange', (o, n) => {
    log('player', o.status, '->', n.status);
    if (n.status === 'idle' && state.active) {
      state.lastError = 'player stopped (' + (o.status) + ' -> idle) while the bridge was active';
      log(state.lastError);
    }
  });
  state.player.play(resource);
  state.connection.subscribe(state.player);

  state.active = true;
  state.startedAt = Date.now();
  state.bytes = 0;
  state.lastError = '';
}

function leaveDiscord(reason) {
  log('tearing down:', reason || 'requested');
  try { if (state.player) state.player.stop(true); } catch (e) {}
  try { if (state.feed) state.feed.end(); } catch (e) {}
  try { if (state.connection) state.connection.destroy(); } catch (e) {}
  try { if (state.socket && state.socket.readyState === 1) state.socket.close(); } catch (e) {}
  state.player = null; state.feed = null; state.connection = null; state.socket = null;
  state.active = false;
  // the Discord client stays logged in so the next link is instant
}

/**
 * Register the HTTP routes. Call this BEFORE app.use('/', peerServer).
 */
function attachBridgeRoutes(app, adminPass) {
  function requireAdmin(req, res, next) {
    const pass = (req.body && req.body.pass) || req.query.pass;
    if (pass !== adminPass) return res.status(403).json({ ok: false, error: 'bad password' });
    next();
  }

  app.get('/bridge/status', requireAdmin, (req, res) => res.json({ ok: true, ...status() }));

  app.post('/bridge/join', requireAdmin, async (req, res) => {
    if (state.active) return res.json({ ok: true, already: true, ...status() });
    try {
      await joinDiscord();
      res.json({ ok: true, ...status() });
    } catch (e) {
      state.lastError = String(e && e.message || e);
      log('join failed:', state.lastError);
      leaveDiscord('join failed');
      res.json({ ok: false, error: state.lastError });
    }
  });

  app.post('/bridge/leave', requireAdmin, (req, res) => {
    leaveDiscord('admin asked');
    res.json({ ok: true, ...status() });
  });

  log('bridge routes mounted at /bridge/*');
}

/**
 * Take over WebSocket upgrades for /bridge/feed. Call this AFTER
 * app.use('/', peerServer) — PeerJS's own ws server answers every upgrade on
 * the http server and replies 400 to any path that is not /peerjs, which
 * would kill our socket. So we pull every existing 'upgrade' listener off,
 * and re-dispatch: /bridge/feed -> us, everything else -> them, untouched.
 */
function attachBridgeFeed(server, adminPass) {
  const WebSocket = require('ws');
  const wss = new WebSocket.Server({ noServer: true });

  const others = server.listeners('upgrade').slice();
  server.removeAllListeners('upgrade');
  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch (e) {}
    if (pathname !== '/bridge/feed') {
      for (const fn of others) fn.call(server, req, socket, head);
      return;
    }
    let pass = null;
    try { pass = new URL(req.url, 'http://x').searchParams.get('pass'); } catch (e) {}
    if (pass !== adminPass) { try { socket.destroy(); } catch (e) {} return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    log('browser attached to the feed');
    if (state.socket && state.socket !== ws) { try { state.socket.close(); } catch (e) {} }
    state.socket = ws;

    ws.on('message', (data) => {
      if (!state.feed) return;
      state.bytes += data.length || 0;
      try { state.feed.write(data); } catch (e) {
        state.lastError = String(e && e.message || e);
      }
    });
    ws.on('close', () => {
      log('browser detached');
      if (state.socket === ws) leaveDiscord('browser closed the feed');
    });
    ws.on('error', () => {});
  });

  log('bridge feed listening at /bridge/feed');
}

module.exports = { attachBridgeRoutes, attachBridgeFeed, status, leaveDiscord };
