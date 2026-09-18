/* ===================== DISCORD BRIDGE =====================
   Pipes the Mingus Chatroom voice call into a Discord voice channel, on demand,
   from the 🔗 button in the chatroom's admin panel.

   The server never touches audio. The browser that pressed the button mixes
   every peer + its own mic with WebAudio, encodes once with MediaRecorder
   (Opus in WebM) and streams the chunks here over a WebSocket. @discordjs/voice
   demuxes WebM/Opus natively, so this is a dumb pipe: bytes in, bytes out.
   That is what fits in Render's 0.1 free CPU.

   Render -> Environment needs:
     DISCORD_TOKEN           (always)
     DISCORD_GUILD_ID        (optional from 7.0 — only the default for the picker)
     DISCORD_CHANNEL_ID      (optional from 7.0 — only the default for the picker)

   From 7.0 the admin panel can pick ANY guild and voice channel the bot has
   been invited to, so the two ID variables are just the default selection.

   Text channels: the bot can post as itself into any text channel it can write
   to, and can relay a channel's messages back into the chatroom. Relaying
   INBOUND messages needs the MessageContent privileged intent switched on in
   the Discord developer portal — without it Discord delivers empty message
   bodies and the relay quietly shows nothing. Posting outbound never needs it.

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
  // Slots used to be handed out at the moment somebody first spoke, which
  // meant the chatroom had no handle on a person until they made a noise —
  // nothing to hang a level meter on, and nothing for a volume slider to act
  // on. They are now allocated when somebody is seen in the channel, so every
  // member has a stable slot from the moment they appear in the roster.
  slotByUser: {},   // discord userId -> slot, stable for the session
  nextSlot: 1,
  rxPackets: 0,
  txPackets: 0,     // 20 ms packets handed to the Discord player
  rxBytes: 0,
  clientStats: null,
  clientStatsAt: 0,
  startedAt: 0,
  bytes: 0,
  lastError: '',
  guildId: null,       // what we actually joined, which may not be the env default
  channelId: null,
  channelName: '',
  relayChannelId: null, // text channel being mirrored into the chatroom, if any
  relayWired: false,
  vc: [],              // everyone currently sitting in the voice channel
};

function log(...a) { console.log('[bridge]', ...a); }

function status() {
  return {
    active: state.active,
    seconds: state.active ? Math.round((Date.now() - state.startedAt) / 1000) : 0,
    kb: Math.round(state.bytes / 1024),
    // Only the token is genuinely required now; the two IDs are defaults for
    // the picker, so reporting them as "not configured" would be misleading.
    configured: !!process.env.DISCORD_TOKEN,
    guildId: state.guildId,
    channelId: state.channelId,
    channelName: state.channelName,
    relayChannelId: state.relayChannelId,
    vc: state.vc,
    lastError: state.lastError || null,
    txPackets: state.txPackets,
    txDropped: state.txDropped || 0,   // packets skipped to keep Discord from lagging behind
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

/* One shared, logged-in client for everything: voice, the channel pickers and
   the text relay. It is created once and kept, so switching voice channels or
   posting a message does not pay the login cost again. The message intents are
   requested up front — Discord simply omits message events if MessageContent
   has not been enabled in the developer portal, rather than refusing the
   login, so asking for it is safe either way. */
async function ensureClient() {
  if (state.client) return state.client;
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error('DISCORD_TOKEN is not set in the Render environment');
  const { Client, GatewayIntentBits, Partials } = require('discord.js');
  log('logging in to Discord…');
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });
  await client.login(token);
  await new Promise((res) => (client.isReady() ? res() : client.once('clientReady', res)));
  state.client = client;
  log('logged in as', client.user && client.user.tag);
  wireTextRelay(client);
  wireVoiceRoster(client);
  return client;
}

/* Who is sitting in the voice channel right now. This is what lets the
   chatroom list Discord people in the member list instead of only showing
   somebody at the moment they happen to make a noise. */
function slotFor(userId) {
  if (!state.slotByUser[userId]) state.slotByUser[userId] = state.nextSlot++;
  return state.slotByUser[userId];
}
function readVoiceMembers() {
  const out = [];
  try {
    const g = state.client && state.guildId && state.client.guilds.cache.get(state.guildId);
    const ch = g && state.channelId && g.channels.cache.get(state.channelId);
    if (ch && ch.members) {
      ch.members.forEach((m) => {
        // the bot itself never needs a slot; everyone else gets one now
        const isSelf = !!(state.client.user && m.id === state.client.user.id);
        out.push({
          id: m.id,
          slot: isSelf ? null : slotFor(m.id),
          name: m.nickname || (m.user && (m.user.globalName || m.user.username)) || m.id,
          bot: !!(m.user && m.user.bot),
          self: !!(state.client.user && m.id === state.client.user.id),
          muted: !!(m.voice && (m.voice.selfMute || m.voice.serverMute)),
          deaf: !!(m.voice && (m.voice.selfDeaf || m.voice.serverDeaf)),
        });
      });
    }
  } catch (e) {}
  return out;
}
function pushVoiceRoster() {
  state.vc = readVoiceMembers();
  sendToBrowser(JSON.stringify({ t: 'vc', members: state.vc, channel: state.channelName }));
}
function wireVoiceRoster(client) {
  if (client.__vcWired) return;
  client.__vcWired = true;
  client.on('voiceStateUpdate', (oldS, newS) => {
    if (!state.active) return;
    const touched = (oldS && oldS.channelId === state.channelId) || (newS && newS.channelId === state.channelId);
    if (touched) pushVoiceRoster();
  });
}

/* Discord text channel -> chatroom. Only the one channel the admin selected is
   forwarded, the bot's own posts are skipped so the chatroom does not echo
   itself, and attachments are reduced to their filenames rather than being
   pulled through the server. */
function wireTextRelay(client) {
  if (state.relayWired) return;
  state.relayWired = true;
  client.on('messageCreate', (msg) => {
    try {
      if (!state.relayChannelId || msg.channelId !== state.relayChannelId) return;
      if (client.user && msg.author && msg.author.id === client.user.id) return;
      const files = (msg.attachments && msg.attachments.size)
        ? Array.from(msg.attachments.values()).map((a) => a.name).slice(0, 4)
        : [];
      sendToBrowser(JSON.stringify({
        t: 'dtext',
        author: (msg.member && msg.member.nickname) ||
                (msg.author && (msg.author.globalName || msg.author.username)) || 'someone',
        bot: !!(msg.author && msg.author.bot),
        content: String(msg.content || '').slice(0, 500),
        files,
      }));
    } catch (e) {}
  });
}

async function joinDiscord(opts) {
  const token = process.env.DISCORD_TOKEN;
  const guildId = (opts && opts.guildId) || process.env.DISCORD_GUILD_ID;
  const channelId = (opts && opts.channelId) || process.env.DISCORD_CHANNEL_ID;
  if (!token) throw new Error('DISCORD_TOKEN is not set in the Render environment');
  if (!guildId || !channelId) {
    throw new Error('no voice channel chosen — pick one in the admin panel, or set DISCORD_GUILD_ID and DISCORD_CHANNEL_ID');
  }

  // required lazily so the server still boots if the deps are missing
  const {
    joinVoiceChannel, createAudioPlayer, createAudioResource,
    StreamType, NoSubscriberBehavior, entersState, VoiceConnectionStatus,
  } = require('@discordjs/voice');

  await ensureClient();

  const guild = await state.client.guilds.fetch(guildId);
  const chan = await guild.channels.fetch(channelId);
  state.guildId = guildId;
  state.channelId = channelId;
  state.channelName = (chan && chan.name) || channelId;
  log('joining voice channel', state.channelName, 'in', guild.name);
  state.connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,   // we listen too: Discord -> chatroom
    selfMute: false,
  });
  state.connection.on('error', (e) => { state.lastError = String(e && e.message || e); log('connection error', state.lastError); });
  state.connection.on('stateChange', (o, n) => log('voice', o.status, '->', n.status));
  // The voice handshake sometimes stalls in 'signalling' on the first try and
  // then just sits there — that was a good share of "sometimes it's broken".
  // A fresh second attempt almost always goes straight through.
  let ready = false, lastErr = null;
  for (let attempt = 1; attempt <= 2 && !ready; attempt++) {
    try {
      await entersState(state.connection, VoiceConnectionStatus.Ready, attempt === 1 ? 15000 : 20000);
      ready = true;
    } catch (e) {
      lastErr = e;
      if (attempt === 1) {
        log('voice connection did not become ready, retrying once');
        try { state.connection.destroy(); } catch (e2) {}
        state.connection = joinVoiceChannel({
          channelId, guildId, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: false,
        });
        state.connection.on('error', (e3) => { state.lastError = String(e3 && e3.message || e3); log('connection error', state.lastError); });
        state.connection.on('stateChange', (o, n) => log('voice', o.status, '->', n.status));
      }
    }
  }
  if (!ready) {
    throw new Error('could not reach the voice channel (check the bot has Connect + Speak on that channel): ' + (lastErr && lastErr.message || lastErr));
  }
  log('voice connection ready');
  watchConnection(state.connection, { entersState, VoiceConnectionStatus });

  // The player lives for the whole link; the audio pipeline feeding it is
  // rebuilt for every browser socket (see newFeed), because each socket
  // carries its own WebM header.
  state.makeResource = (stream) => createAudioResource(stream, { inputType: StreamType.Opus });
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
  state.connection.subscribe(state.player);
  wireReceiver(state.connection, state.client.user && state.client.user.id);

  state.active = true;
  state.startedAt = Date.now();
  state.bytes = 0;
  state.lastError = '';
  // A socket that was already attached (a relink while the bot was still in
  // the channel) gets a clean pipeline now; otherwise the next one will.
  if (state.socket && state.socket.readyState === 1) newFeed();
  else armFeedWatchdog();
  pushVoiceRoster();
}

/* Browser -> WebM bytes -> demux -> split every packet into 20 ms Opus
   packets -> player. Chrome's MediaRecorder writes 60 ms Opus packets and the
   player sends one packet per 20 ms tick, so without the split Discord gets
   audio at 3x speed with broken timing and its receiver shreds it.

   Built fresh for EVERY feed socket. The WebM header only exists at the start
   of a MediaRecorder stream, so a second socket's stream written into the
   first socket's demuxer (what happened when you relinked while the bot was
   still sitting in the channel) is unparseable, and Discord heard nothing
   until the bot was kicked and rejoined. */
function newFeed() {
  if (!state.player || !state.makeResource) return;
  const prism = require('prism-media');
  const { Transform } = require('stream');
  const { splitOpusPacket } = require('./opus-split');
  try { if (state.feed) state.feed.end(); } catch (e) {}
  const feed = new PassThrough({ highWaterMark: 1 << 20 });
  const demux = new prism.opus.WebmDemuxer();
  let resource = null, dropped = 0;
  const split = new Transform({
    readableObjectMode: true, writableObjectMode: true,
    transform(pkt, enc, cb) {
      for (const f of splitOpusPacket(pkt)) {
        // Drift control. The player drains exactly one packet per 20 ms, so
        // anything the browser (or a stalled free-tier CPU) delivers faster
        // than that piles up and stays piled up - Discord ends up hearing the
        // room seconds late and it never catches back up. If more than ~400 ms
        // is queued, drop packets until it is back under ~120 ms; Opus hides a
        // few lost 20 ms frames far better than it hides a growing delay.
        const queuedMs = resource ? (state.txPackets * 20 - dropped * 20 - resource.playbackDuration) : 0;
        state.txPackets++;
        if (queuedMs > 400 || (state.catchingUp && queuedMs > 120)) {
          state.catchingUp = true; dropped++; state.txDropped = (state.txDropped || 0) + 1;
          continue;
        }
        state.catchingUp = false;
        this.push(f);
      }
      cb();
    },
  });
  demux.on('error', (e) => { state.lastError = 'demux: ' + (e && e.message || e); log(state.lastError); });
  feed.pipe(demux).pipe(split);
  state.txPackets = 0; state.catchingUp = false;
  resource = state.makeResource(split);
  state.feed = feed;
  state.player.play(resource);
  clearTimeout(state.feedWatchdog);
  log('fresh audio pipeline for the browser feed');
}

/* If the bot joined but no browser ever attaches a feed (the page was closed,
   the WebSocket was blocked), it would otherwise sit in the channel forever,
   silent, and the next link attempt would find it "already active". */
function armFeedWatchdog() {
  clearTimeout(state.feedWatchdog);
  state.feedWatchdog = setTimeout(() => {
    if (state.active && !(state.socket && state.socket.readyState === 1)) {
      state.lastError = 'no browser attached the audio feed within 30s';
      leaveDiscord(state.lastError);
    }
  }, 30000);
}

/* Discord moves voice servers, drops UDP, or somebody drags the bot to another
   channel. Previously any of those left the connection 'disconnected' for good
   while the bridge still reported itself active - linked, and dead. This is
   the recovery the @discordjs/voice docs recommend: give it five seconds to
   reconnect on its own, then try one explicit rejoin, then give up loudly. */
function watchConnection(conn, { entersState, VoiceConnectionStatus }) {
  conn.on(VoiceConnectionStatus.Disconnected, async () => {
    if (state.connection !== conn || !state.active) return;
    try {
      await Promise.race([
        entersState(conn, VoiceConnectionStatus.Signalling, 5000),
        entersState(conn, VoiceConnectionStatus.Connecting, 5000),
      ]);
      log('voice connection recovering on its own');
    } catch (e) {
      if (state.connection !== conn || !state.active) return;
      try {
        log('voice connection lost, rejoining');
        conn.rejoin();
        await entersState(conn, VoiceConnectionStatus.Ready, 15000);
        log('voice connection back');
      } catch (e2) {
        if (state.connection !== conn || !state.active) return;
        state.lastError = 'lost the Discord voice connection and could not get it back';
        sendToBrowser(JSON.stringify({ t: 'bye', reason: state.lastError }));
        leaveDiscord(state.lastError);
      }
    }
  });
  conn.on(VoiceConnectionStatus.Destroyed, () => {
    if (state.connection !== conn || !state.active) return;
    state.lastError = 'the Discord voice connection was closed';
    sendToBrowser(JSON.stringify({ t: 'bye', reason: state.lastError }));
    leaveDiscord(state.lastError);
  });
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
    // Reuse the slot this person was already given in the roster, so the
    // chatroom's meter and volume slider for them keep pointing at the same
    // audio path once they actually start talking.
    const slot = slotFor(userId);
    let name = userId;
    try {
      // prefer the per-server nickname, which is what everyone in that server
      // actually calls them, then the global display name, then the handle
      const g = state.guildId && state.client.guilds.cache.get(state.guildId);
      const m = g && g.members.cache.get(userId);
      if (m) name = m.nickname || (m.user && (m.user.globalName || m.user.username)) || userId;
      else {
        const u = state.client.users.cache.get(userId);
        if (u) name = u.globalName || u.username || userId;
      }
    } catch (e) {}
    const stream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    state.rx[userId] = { slot, stream, name };
    log('hearing', name, 'on slot', slot);
    sendToBrowser(JSON.stringify({ t: 'speaker', slot, id: userId, name }));
    // somebody we had not seen before is talking — make sure the chatroom's
    // member list knows about them even if the roster push was missed
    try { pushVoiceRoster(); } catch (e) {}
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
  // Mark inactive and detach FIRST: destroying the connection fires its
  // Destroyed handler synchronously, which must see a bridge that is already
  // on its way down rather than start a second teardown.
  state.active = false;
  const conn = state.connection, player = state.player, feed = state.feed, sock = state.socket;
  state.player = null; state.feed = null; state.connection = null; state.socket = null;
  state.makeResource = null;
  clearTimeout(state.feedWatchdog);
  for (const id in state.rx) { try { state.rx[id].stream.destroy(); } catch (e) {} }
  state.rx = {}; state.rxPackets = 0; state.rxBytes = 0; state.txPackets = 0; state.txDropped = 0; state.clientStats = null; state.clientStatsAt = 0;
  state.slotByUser = {}; state.nextSlot = 1;
  try { if (player) player.stop(true); } catch (e) {}
  try { if (feed) feed.end(); } catch (e) {}
  try { if (conn) conn.destroy(); } catch (e) {}
  try { if (sock && sock.readyState === 1) sock.close(); } catch (e) {}
  state.vc = [];
  state.channelId = null; state.channelName = '';
  // the relay selection is deliberately kept: reconnecting should not silently
  // stop mirroring the text channel the admin had chosen
  // the Discord client stays logged in so the next link is instant
}

/**
 * Register the HTTP routes. Call this BEFORE app.use('/', peerServer).
 */
// isAdmin(pass, ip) is the server's own check (see server.js): the password in
// the page source is no longer good enough for anything that reaches Discord.
function attachBridgeRoutes(app, isAdmin, ipOf) {
  function requireAdmin(req, res, next) {
    const pass = (req.body && req.body.pass) || req.query.pass;
    if (!isAdmin(pass, ipOf ? ipOf(req) : '')) return res.status(403).json({ ok: false, error: 'bad password' });
    next();
  }

  app.get('/bridge/status', requireAdmin, (req, res) => res.json({ ok: true, ...status() }));

  app.post('/bridge/join', requireAdmin, async (req, res) => {
    const want = { guildId: req.body && req.body.guildId, channelId: req.body && req.body.channelId };
    // A second press while the first join is still handshaking used to start
    // a second, overlapping join that tore the first one's connection out
    // from under it. Wait for the one already in flight instead.
    if (state.joining) {
      try { await state.joining; } catch (e) {}
      return res.json(state.active ? { ok: true, already: true, ...status() }
                                   : { ok: false, error: state.lastError || 'join failed' });
    }
    // Asking for a different channel while already connected should MOVE the
    // bot, not be silently ignored as "already active".
    if (state.active && want.channelId && want.channelId !== state.channelId) {
      leaveDiscord('moving to another channel');
    } else if (state.active) {
      return res.json({ ok: true, already: true, ...status() });
    }
    state.joining = joinDiscord(want);
    try {
      await state.joining;
      res.json({ ok: true, ...status() });
    } catch (e) {
      const why = String(e && e.message || e);
      log('join failed:', why);
      leaveDiscord('join failed');
      state.lastError = why;
      res.json({ ok: false, error: why });
    } finally {
      state.joining = null;
    }
  });

  app.post('/bridge/leave', requireAdmin, (req, res) => {
    leaveDiscord('admin asked');
    res.json({ ok: true, ...status() });
  });

  /* Everywhere the bot could go. The admin panel turns this into two pickers,
     which is the whole point — before this the bot could only ever sit in the
     one channel baked into the environment. */
  app.get('/bridge/channels', requireAdmin, async (req, res) => {
    try {
      const client = await ensureClient();
      const guilds = [];
      const gs = await client.guilds.fetch();
      for (const [gid] of gs) {
        const g = await client.guilds.fetch(gid);
        const chans = await g.channels.fetch();
        const voice = [], text = [];
        chans.forEach((c) => {
          if (!c) return;
          // 2 = GuildVoice, 13 = GuildStageVoice, 0 = GuildText, 5 = GuildAnnouncement
          const me = g.members.me;
          const perms = me && c.permissionsFor ? c.permissionsFor(me) : null;
          if (c.type === 2 || c.type === 13) {
            voice.push({
              id: c.id, name: c.name,
              can: !perms ? null : (perms.has('Connect') && perms.has('Speak')),
              users: (c.members && c.members.size) || 0,
            });
          } else if (c.type === 0 || c.type === 5) {
            text.push({
              id: c.id, name: c.name,
              can: !perms ? null : perms.has('SendMessages'),
            });
          }
        });
        voice.sort((a, b) => a.name.localeCompare(b.name));
        text.sort((a, b) => a.name.localeCompare(b.name));
        guilds.push({ id: g.id, name: g.name, voice, text });
      }
      res.json({ ok: true, guilds, current: { guildId: state.guildId, channelId: state.channelId } });
    } catch (e) {
      res.json({ ok: false, error: String((e && e.message) || e) });
    }
  });

  /* Post into a text channel as the bot. */
  app.post('/bridge/say', requireAdmin, async (req, res) => {
    const { channelId, text, as } = req.body || {};
    if (!channelId) return res.json({ ok: false, error: 'no channel chosen' });
    const body = String(text || '').slice(0, 1800).trim();
    if (!body) return res.json({ ok: false, error: 'nothing to say' });
    try {
      const client = await ensureClient();
      const ch = await client.channels.fetch(channelId);
      if (!ch || !ch.send) return res.json({ ok: false, error: 'that channel cannot be posted to' });
      // The "as" name is prefixed rather than faked with a webhook: the message
      // genuinely comes from the bot, and pretending otherwise in a server
      // where people trust names would be worse than a slightly uglier line.
      await ch.send(as ? `**${String(as).slice(0, 32)}** (from the Mingus Chatroom): ${body}` : body);
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: String((e && e.message) || e) });
    }
  });

  /* Mirror a text channel into the chatroom, or stop. */
  app.post('/bridge/relay', requireAdmin, async (req, res) => {
    const { channelId } = req.body || {};
    try {
      if (!channelId) {
        state.relayChannelId = null;
        return res.json({ ok: true, relayChannelId: null });
      }
      await ensureClient();
      state.relayChannelId = String(channelId);
      res.json({ ok: true, relayChannelId: state.relayChannelId });
    } catch (e) {
      res.json({ ok: false, error: String((e && e.message) || e) });
    }
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
function attachBridgeFeed(server, isAdmin, ipOf) {
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
    if (!isAdmin(pass, ipOf ? ipOf(req) : '')) { try { socket.destroy(); } catch (e) {} return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    log('browser attached to the feed');
    if (state.socket && state.socket !== ws) { try { state.socket.close(); } catch (e) {} }
    state.socket = ws;
    // every socket starts a brand-new WebM stream, so it needs its own demuxer
    if (state.active) newFeed();

    // Heartbeat. A browser that vanished without a clean close (sleep, Wi-Fi
    // drop, the app killed) left a half-open socket that looked alive for
    // ages, so the bot sat "active" in the channel and the next link found
    // it wedged. No pong for 30 s means it is gone.
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const beat = setInterval(() => {
      if (!ws.isAlive) { log('browser feed stopped answering pings'); try { ws.terminate(); } catch (e) {} return; }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) {}
    }, 15000);
    ws.on('close', () => clearInterval(beat));

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

module.exports = {
  attachBridgeRoutes, attachBridgeFeed, status, leaveDiscord,
  _test: { state, wireReceiver, readVoiceMembers },
};
