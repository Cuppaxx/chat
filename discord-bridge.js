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

   Both directions, still with no decoding here:
     chatroom -> Discord : browser sends WebM/Opus chunks up the socket; piped to the player.
     Discord -> chatroom : the receiver hands us each speaker's raw Opus packets; each is
                           sent down the same socket as a binary frame [u8 0xD1][u16 slot][opus].
                           A JSON text frame {t:'speaker',slot,id,name} announces every new slot.
                           The browser decodes with WebCodecs and mixes it into the room.
*/

const { PassThrough } = require('stream');

const state = {
  active: false,
  client: null,
  connection: null,
  player: null,
  feed: null,       // PassThrough carrying WebM/Opus from the browser
  socket: null,     // the browser holding the bridge open
  rx: {},           // discord userId -> { slot, stream }
  nextSlot: 1,
  rxPackets: 0,
  txPackets: 0,     // 20 ms packets handed to the Discord player
  rxBytes: 0,
  clientStats: null,
  clientStatsAt: 0,
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
    txPackets: state.txPackets,
    rx: {
      packets: state.rxPackets,
      kb: Math.round(state.rxBytes / 1024),
      speakers: Object.keys(state.rx).map((id) => ({ slot: state.rx[id].slot, name: state.rx[id].name })),
      socketBuffered: state.socket ? state.socket.bufferedAmount : null,
    },
    browser: state.clientStats,
    browserAgeSec: state.clientStatsAt ? Math.round((Date.now() - state.clientStatsAt) / 1000) : null,
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
    selfDeaf: false,   // we listen too: Discord -> chatroom
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

  // Browser -> WebM bytes -> demux -> split every packet into 20 ms Opus
  // packets -> player. Chrome's MediaRecorder writes 60 ms Opus packets and the
  // player sends one packet per 20 ms tick, so without the split Discord gets
  // audio at 3x speed with broken timing and its receiver shreds it.
  const prism = require('prism-media');
  const { Transform } = require('stream');
  const { splitOpusPacket } = require('./opus-split');
  state.feed = new PassThrough({ highWaterMark: 1 << 20 });
  const demux = new prism.opus.WebmDemuxer();
  const split = new Transform({
    readableObjectMode: true, writableObjectMode: true,
    transform(pkt, enc, cb) { for (const f of splitOpusPacket(pkt)) { state.txPackets++; this.push(f); } cb(); },
  });
  demux.on('error', (e) => { state.lastError = 'demux: ' + (e && e.message || e); log(state.lastError); });
  state.feed.pipe(demux).pipe(split);
  const resource = createAudioResource(split, { inputType: StreamType.Opus });
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
  wireReceiver(state.connection, state.client.user && state.client.user.id);

  state.active = true;
  state.startedAt = Date.now();
  state.bytes = 0;
  state.lastError = '';
}


/* Discord -> browser. One Opus subscription per speaker, forwarded raw. */
function sendToBrowser(buf) {
  const ws = state.socket;
  if (ws && ws.readyState === 1) { try { ws.send(buf); } catch (e) {} }
}
function wireReceiver(connection, selfId) {
  const { EndBehaviorType } = require('@discordjs/voice');
  const receiver = connection.receiver;
  receiver.speaking.on('start', (userId) => {
    if (userId === selfId || state.rx[userId]) return;
    const slot = state.nextSlot++;
    let name = userId;
    try {
      const u = state.client.users.cache.get(userId);
      if (u) name = u.globalName || u.username || userId;
    } catch (e) {}
    const stream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    state.rx[userId] = { slot, stream, name };
    log('hearing', name, 'on slot', slot);
    sendToBrowser(JSON.stringify({ t: 'speaker', slot, id: userId, name }));
    const hdr = Buffer.alloc(3); hdr[0] = 0xD1; hdr.writeUInt16BE(slot, 1);
    stream.on('data', (pkt) => { state.rxPackets++; state.rxBytes += pkt.length; sendToBrowser(Buffer.concat([hdr, pkt])); });
    stream.on('error', (e) => log('rx error', name, e && e.message));
  });
  receiver.speaking.on('end', (userId) => {
    const r = state.rx[userId];
    if (r) sendToBrowser(JSON.stringify({ t: 'quiet', slot: r.slot }));
  });
}

function leaveDiscord(reason) {
  log('tearing down:', reason || 'requested');
  for (const id in state.rx) { try { state.rx[id].stream.destroy(); } catch (e) {} }
  state.rx = {}; state.rxPackets = 0; state.rxBytes = 0; state.txPackets = 0; state.clientStats = null; state.clientStatsAt = 0;
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

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        try {
          const m = JSON.parse(data.toString());
          if (m && m.t === 'stats') { state.clientStats = m; state.clientStatsAt = Date.now(); }
        } catch (e) {}
        return;
      }
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

module.exports = { attachBridgeRoutes, attachBridgeFeed, status, leaveDiscord, _test: { state, wireReceiver } };
