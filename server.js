// Mingus Chatroom signaling server.
// This does ONE job: help two browsers find each other. No audio, no video,
// no chat ever touches it — that all stays peer-to-peer. It is tiny and free
// to run, and it replaces the flaky public PeerJS cloud.
//
// It ALSO serves the chatroom page itself at /chat. That is not decoration:
// Neocities sends "Content-Security-Policy: connect-src 'self'" on every page
// it hosts, which forbids the browser from opening the signaling WebSocket to
// this server. A page served from Neocities therefore can never connect, no
// matter how healthy this server, the network or the TURN relay is — it just
// sits on "connecting…" forever with no error. Serving the page from here
// makes the page and the signaling server the SAME origin, so 'self' is
// satisfied and that entire class of failure disappears for good.
//
// And it enforces IP bans. The browser cannot do that — there is no API that
// tells a web page anyone's IP address. This server, on the other hand, sees
// the real address of every WebSocket that connects, so bans are applied here
// where they actually bite: a banned address cannot complete the handshake at
// all, so clearing storage, changing gamertag or rejoining does not help.

const express = require('express');
const { ExpressPeerServer } = require('peer');

const app = express();
const PORT = process.env.PORT || 9000;

// Set ADMIN_PASS in the Render dashboard to change it without editing code.
// It must match the password in the chatroom page's admin panel.
const ADMIN_PASS = process.env.ADMIN_PASS || 'MingMing67';

const bannedIps = new Set();   // addresses refused at the handshake
const peerIps = new Map();     // peerId -> ip, so the admin can ban by person

app.use(express.json({ limit: '16kb' }));

// Neocities pages are a different origin, so they need CORS to reach us.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function clientIp(req) {
  // Render sits behind a proxy, so the socket address is the proxy's. The real
  // client is the first entry of X-Forwarded-For.
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || '';
}

function requireAdmin(req, res, next) {
  const pass = (req.body && req.body.pass) || req.query.pass;
  if (pass !== ADMIN_PASS) return res.status(403).json({ ok: false, error: 'bad password' });
  next();
}

app.get('/', (req, res) => res.send('mingus signaling server: up'));
app.get('/health', (req, res) => res.json({ ok: true, up: process.uptime(), bans: bannedIps.size }));

// The chatroom page. MUST be declared above app.use('/', peerServer) at the
// bottom — that mount matches every path, so anything registered after it
// never gets reached.
app.get('/chat', (req, res) => {
  // no-cache = "always ask me if this changed" (not "never cache"): the browser
  // still revalidates cheaply with ETag and gets a 304 when nothing moved.
  //
  // This matters more than it looks. Moderation, pranks and the theater are all
  // message types that an older client silently ignores, so one person running
  // a stale copy produces bugs that look real but are not — kicks that do
  // nothing, unmutes that never unmute. Without this header browsers hold onto
  // the page for days and everyone drifts onto different builds. With it, a
  // deploy reaches everybody on their next page load.
  res.set('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(__dirname + '/mingus-chatroom.html', (err) => {
    if (err) res.status(404).send('mingus-chatroom.html is missing from the repo');
  });
});

// ---- admin API (used by the chatroom's Admin Panel) ----
app.get('/admin/bans', requireAdmin, (req, res) => {
  res.json({
    ok: true,
    ips: Array.from(bannedIps),
    online: Array.from(peerIps.entries()).map(([id, ip]) => ({ id, ip })),
  });
});

app.post('/admin/ban', requireAdmin, (req, res) => {
  const { peerId, ip } = req.body || {};
  const target = ip || peerIps.get(peerId);
  if (!target) {
    return res.json({ ok: false, error: 'no address on record for that peer — they may have already disconnected' });
  }
  bannedIps.add(target);
  console.log('BAN ' + target + (peerId ? ' (' + peerId + ')' : ''));
  res.json({ ok: true, ip: target, count: bannedIps.size });
});

app.post('/admin/unban', requireAdmin, (req, res) => {
  const { ip } = req.body || {};
  const had = bannedIps.delete(ip);
  console.log('UNBAN ' + ip + (had ? '' : ' (was not banned)'));
  res.json({ ok: had, ip, count: bannedIps.size });
});

const server = app.listen(PORT, '0.0.0.0', () =>
  console.log('signaling server listening on ' + PORT)
);

// Refuse banned addresses before PeerJS ever sees them.
// prependListener puts this ahead of PeerServer's own upgrade handler no matter
// what order things were wired up in, so a banned client's socket is closed
// before any signalling happens.
server.prependListener('upgrade', (req, socket) => {
  const ip = clientIp(req);
  if (bannedIps.has(ip)) {
    console.log('refused banned ' + ip);
    try { socket.destroy(); } catch (e) {}
    return;
  }
  try {
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    if (id) peerIps.set(id, ip);
  } catch (e) {}
});

const peerServer = ExpressPeerServer(server, {
  path: '/',
  allow_discovery: true,       // lets the chatroom list who is in a room
  alive_timeout: 30000,        // drop dead sockets fast so slots free up
  expire_timeout: 10000,
  concurrent_limit: 500,
});

peerServer.on('connection', (c) => console.log('+ ' + c.getId()));
peerServer.on('disconnect', (c) => {
  console.log('- ' + c.getId());
  peerIps.delete(c.getId());   // don't leak the id->ip map forever
});

app.use('/', peerServer);
