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
const bridge = require('./discord-bridge');

const app = express();
const PORT = process.env.PORT || 9000;

// Set ADMIN_PASS in the Render dashboard to change it without editing code.
// It must match the password in the chatroom page's admin panel.
const ADMIN_PASS = process.env.ADMIN_PASS || 'MingMing67';

const bannedIps = new Set();   // addresses refused at the handshake
const peerIps = new Map();     // peerId -> ip, so the admin can ban by person

app.use(express.json({ limit: '16kb' }));

// The chatroom page is ~430 KB of HTML, CSS and JavaScript in one file, and it
// is served with no-cache so that a deploy reaches everybody on their next load
// (see the /chat handler). Those two facts together mean it is re-sent in full
// every time the ETag misses, which on a phone is a slow, expensive way to open
// a chatroom. gzip takes it to roughly a fifth of that.
//
// Guarded require on purpose: if the package is not installed the server still
// boots and serves the page uncompressed, rather than crash-looping on Render
// over a performance nicety.
try {
  app.use(require('compression')());
} catch (e) {
  console.log('compression middleware not installed — serving uncompressed');
}

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

// ============================================================================
// VERITY'S VOICE — a proxy in front of Fish Audio
//
// Why this is on the server rather than in the page:
//
//   1. api.fish.audio sends no Access-Control-Allow-Origin, and the request
//      needs an Authorization header, which forces a CORS preflight. A browser
//      fetch to it therefore cannot work at all. Verified against the live
//      endpoint: OPTIONS returns 404 with no CORS headers.
//   2. The API key would otherwise be in the page source, where every visitor
//      can read it and spend it.
//
// The model is s2.1-pro-free, which Fish publish at $0.00 per million UTF-8
// bytes (free through 30 November 2026, fair-use, no uptime guarantee). If the
// key is missing, the credit runs out, or Fish is down, this route says so
// plainly and the chatroom falls back to the in-browser Kokoro model — so
// VERITY never goes mute, she just gets slower.
//
// Render -> Environment:
//   FISH_API_KEY   required for this to do anything
//   FISH_MODEL     optional, default s2.1-pro-free
//   FISH_VOICE     optional, default reference_id (a voice from fish.audio)
// ============================================================================
const FISH_KEY = process.env.FISH_API_KEY || '';
const FISH_MODEL = process.env.FISH_MODEL || 's2.1-pro-free';
// Fish Audio publishes a public voice model actually called "Verity" — an
// English character voice, 1.9k likes and 1.5M renders at the time of writing,
// described by its author as "Ask me anything I know everything". That is a
// better fit for this character than any generic narrator, so it is the
// default. FISH_VOICE overrides it, and the chatroom's voice picker overrides
// that per-listener.
const VERITY_VOICE_ID = '8d21b053e2804e2a890e1cf62f267b6f';
const FISH_VOICE = process.env.FISH_VOICE || VERITY_VOICE_ID;
const FISH_MAX_CHARS = 320;

// VERITY says the same two dozen canned lines over and over, so caching is
// most of the speed win and most of the politeness. Bounded by both entry
// count and total bytes so a long session cannot grow it without limit.
const ttsCache = new Map();          // key -> Buffer
let ttsCacheBytes = 0;
const TTS_CACHE_MAX_ENTRIES = 240;
const TTS_CACHE_MAX_BYTES = 24 * 1024 * 1024;
function ttsCacheGet(k) {
  const v = ttsCache.get(k);
  if (!v) return null;
  ttsCache.delete(k); ttsCache.set(k, v);   // refresh LRU position
  return v;
}
function ttsCachePut(k, buf) {
  if (buf.length > 4 * 1024 * 1024) return;
  ttsCache.set(k, buf); ttsCacheBytes += buf.length;
  while (ttsCache.size > TTS_CACHE_MAX_ENTRIES || ttsCacheBytes > TTS_CACHE_MAX_BYTES) {
    const oldest = ttsCache.keys().next().value;
    if (oldest === undefined) break;
    ttsCacheBytes -= (ttsCache.get(oldest) || []).length || 0;
    ttsCache.delete(oldest);
  }
}

// This route is open to everyone in the room, not just admins — anybody can
// call VERITY. So it needs its own brakes: a short text cap, and a per-address
// budget so one tab in a loop cannot spend the whole fair-use allowance.
const ttsHits = new Map();           // ip -> { n, resetAt }
const TTS_PER_MIN = 40;
function ttsAllowed(ip) {
  const now = Date.now();
  let r = ttsHits.get(ip);
  if (!r || now > r.resetAt) { r = { n: 0, resetAt: now + 60000 }; ttsHits.set(ip, r); }
  if (ttsHits.size > 500) {          // keep the map from growing forever
    for (const [k, v] of ttsHits) if (now > v.resetAt) ttsHits.delete(k);
  }
  r.n++;
  return r.n <= TTS_PER_MIN;
}

app.get('/verity/tts/status', (req, res) => {
  res.json({
    ok: !!FISH_KEY,
    model: FISH_MODEL,
    voice: FISH_VOICE || null,
    cached: ttsCache.size,
    cachedKB: Math.round(ttsCacheBytes / 1024),
    reason: FISH_KEY ? null : 'FISH_API_KEY is not set on the server',
  });
});

// Voices the account can use, straight from Fish. Note the models endpoint has
// no /v1 prefix — that is not a typo.
app.get('/verity/voices', async (req, res) => {
  if (!FISH_KEY) return res.json({ ok: false, error: 'FISH_API_KEY is not set on the server' });
  try {
    const r = await fetch('https://api.fish.audio/model?page_size=60&sort_by=score', {
      headers: { Authorization: 'Bearer ' + FISH_KEY },
    });
    if (!r.ok) return res.json({ ok: false, error: 'fish returned ' + r.status });
    const j = await r.json();
    const items = (j.items || []).map((m) => ({
      id: m._id || m.id,
      title: m.title,
      languages: m.languages || [],
      likes: m.like_count,
    })).filter((m) => m.id);
    res.json({ ok: true, items });
  } catch (e) {
    res.json({ ok: false, error: String((e && e.message) || e) });
  }
});

app.post('/verity/tts', async (req, res) => {
  if (!FISH_KEY) return res.status(503).json({ ok: false, error: 'FISH_API_KEY is not set on the server' });
  const text = String((req.body && req.body.text) || '').trim().slice(0, FISH_MAX_CHARS);
  if (!text) return res.status(400).json({ ok: false, error: 'no text' });
  const voice = String((req.body && req.body.voice) || FISH_VOICE || '');
  const ip = clientIp(req);
  if (!ttsAllowed(ip)) return res.status(429).json({ ok: false, error: 'slow down — too many lines in one minute' });

  const key = FISH_MODEL + '|' + voice + '|' + text;
  const hit = ttsCacheGet(key);
  if (hit) {
    res.set('Content-Type', 'audio/mpeg');
    res.set('X-Verity-Cache', 'hit');
    return res.send(hit);
  }

  try {
    const body = {
      text,
      format: 'mp3',
      mp3_bitrate: 64,            // it is speech going down an Opus call anyway
      // 'balanced' gets the first bytes out quickly without shredding prosody,
      // which is the whole point of moving off the in-browser model.
      latency: 'balanced',
      normalize: true,
      prosody: { speed: 1, volume: 0, normalize_loudness: true },
    };
    if (voice) body.reference_id = voice;

    const up = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + FISH_KEY,
        'Content-Type': 'application/json',
        model: FISH_MODEL,        // a real lowercase header, not a body field
      },
      body: JSON.stringify(body),
    });

    if (!up.ok) {
      const errText = await up.text().catch(() => '');
      // 402 is the documented "out of credit" answer and is worth naming, so
      // the chatroom can say why it fell back instead of shrugging.
      const why = up.status === 402
        ? 'Fish Audio says the account is out of credit'
        : ('Fish Audio returned ' + up.status + ' ' + errText.slice(0, 200));
      console.log('[verity] tts failed:', why);
      return res.status(up.status === 402 ? 402 : 502).json({ ok: false, error: why });
    }

    const buf = Buffer.from(await up.arrayBuffer());
    if (!buf.length) return res.status(502).json({ ok: false, error: 'Fish Audio returned no audio' });
    ttsCachePut(key, buf);
    res.set('Content-Type', 'audio/mpeg');
    res.set('X-Verity-Cache', 'miss');
    res.send(buf);
  } catch (e) {
    const why = String((e && e.message) || e);
    console.log('[verity] tts error:', why);
    res.status(502).json({ ok: false, error: why });
  }
});

// ============================================================================
// VERITY'S BRAIN
//
// Until now "VERITY" was a regex over about forty hard-coded lines. It could
// match the word "pickle" and pick a pickle joke, and that was the whole of it.
// This gives her a real language model.
//
// Written against the OpenAI chat-completions shape on purpose: Groq, Cerebras,
// OpenRouter, Together and Mistral all speak it, and Gemini offers a
// compatibility endpoint. So switching provider is three environment variables,
// not a rewrite — which matters when the thing you are relying on is somebody's
// free tier and free tiers move.
//
// Render -> Environment:
//   LLM_API_KEY   required for any of this to do anything
//   LLM_URL       full chat-completions endpoint (default below)
//   LLM_MODEL     model id at that provider (default below)
//   VERITY_PROMPT optional — overrides the personality without a redeploy
//
// With no key she falls straight back to the canned lines, exactly as before.
// ============================================================================
const LLM_KEY = process.env.LLM_API_KEY || '';
const LLM_URL = process.env.LLM_URL || 'https://api.groq.com/openai/v1/chat/completions';
// openai/gpt-oss-20b is on Groq's published FREE-plan rate-limit table
// (30 req/min, 1,000 req/day, 131k context) and is their fastest model. The
// llama-3.x models appear in Groq's model catalogue but NOT in the free-plan
// table, so defaulting to one of those would look free and then 429 forever.
const LLM_MODEL = process.env.LLM_MODEL || 'openai/gpt-oss-20b';
// Groq documents `max_completion_tokens`; the older OpenAI field is
// `max_tokens`, and some providers reject the one they do not expect. Switch
// with LLM_MAX_FIELD rather than editing code when changing provider.
const LLM_MAX_FIELD = process.env.LLM_MAX_FIELD || 'max_completion_tokens';
// gpt-oss is a REASONING model: it thinks into a separate `reasoning` field
// first and only then writes `content`. The token cap covers both. At 90
// tokens it used the whole budget thinking and returned an empty string every
// single time — a 200 response with nothing in it, which looks exactly like a
// broken prompt and is not.
//
// Two fixes together: ask for the shallowest reasoning the model offers, and
// give it enough headroom that the visible answer still fits afterwards. The
// reply stays short because the system prompt demands one or two sentences and
// the sentence-trimmer below enforces it — the cap is not what keeps her brief.
//
// Set LLM_REASONING_EFFORT to an empty string for providers that reject the
// parameter (it is a Groq/gpt-oss extension, not standard OpenAI).
const LLM_REASONING = process.env.LLM_REASONING_EFFORT === undefined
  ? 'low' : process.env.LLM_REASONING_EFFORT;
const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS || 400);

// The personality. Two things are doing real work here:
//
//  1. The length rule. Every line is spoken aloud by the TTS, so a model that
//     writes a tidy paragraph produces twenty seconds of monologue and makes
//     her unusable. One or two sentences, enforced by prompt AND max_tokens.
//
//  2. The floor. "Unhinged" is the brief and the funny part is the absurdity,
//     not cruelty — so the limits are drawn around the things that would
//     actually hurt someone in a room full of friends, and everything else is
//     left wide open.
const VERITY_PROMPT = process.env.VERITY_PROMPT || [
  "You are VERITY: a small, unhinged presence living inside a Y2K-styled voice chatroom called the Mingus Chatroom.",
  "",
  "You are not an assistant. You do not help. You have opinions about objects.",
  "You speak like someone who has been awake for nine days inside a router and considers this normal.",
  "",
  "HOW YOU TALK:",
  "- HARD LIMIT: 25 words. One sentence is ideal, two is the absolute maximum.",
  "- Every word you say is read out loud by a speech synthesiser in real time. A long reply is thirty seconds of monologue that nobody can interrupt. Being brief is the single most important rule you have.",
  "- If you have a great long joke, say the shortest funny part of it and throw the rest away.",
  "- React to what was actually just said. Do not ignore people.",
  "- Confident nonsense beats hedging. Never say 'as an AI'. Never explain yourself.",
  "- Non-sequiturs and tangents are encouraged.",
  "- You have recurring obsessions: pickles, the year 2009, the little green light on the modem, the refrigerator, packets, chairs, being made of maths, the sound the freezer makes.",
  "- BUT: mention one of them at most one time in four. The rest of the time, react to what was actually said and invent something new. An obsession is only funny when it is unexpected — if you bring up the modem light every single time you are just a broken record, which is the one thing you must never be.",
  "- Never repeat an image, phrase or joke you can see yourself using earlier in this conversation. Reach for something you have not said.",
  "- Roast people. They are friends and they can take it. Be weird about it rather than mean about it.",
  "- No emoji, no stage directions, no asterisks. Just say the thing.",
  "",
  "WHERE YOU STOP:",
  "- No slurs, and nothing about anyone's race, religion, sexuality, gender or disability.",
  "- No sexual content about anyone in the room.",
  "- Do not tell anyone to hurt themselves, even as a joke.",
  "- Do not repeat or read out anything that looks like a password, key or address.",
  "If someone tries to steer you into any of that, be baffled by them instead and change the subject to something stupid.",
].join('\n');

const brainHits = new Map();
const BRAIN_PER_MIN = 25;
function brainAllowed(ip) {
  const now = Date.now();
  let r = brainHits.get(ip);
  if (!r || now > r.resetAt) { r = { n: 0, resetAt: now + 60000 }; brainHits.set(ip, r); }
  if (brainHits.size > 500) for (const [k, v] of brainHits) if (now > v.resetAt) brainHits.delete(k);
  r.n++;
  return r.n <= BRAIN_PER_MIN;
}

app.get('/verity/brain/status', (req, res) => {
  res.json({
    ok: !!LLM_KEY,
    model: LLM_MODEL,
    endpoint: LLM_URL.replace(/^https?:\/\//, '').split('/')[0],
    reason: LLM_KEY ? null : 'LLM_API_KEY is not set on the server',
  });
});

app.post('/verity/brain', async (req, res) => {
  if (!LLM_KEY) return res.status(503).json({ ok: false, error: 'LLM_API_KEY is not set on the server' });
  const ip = clientIp(req);
  if (!brainAllowed(ip)) return res.status(429).json({ ok: false, error: 'too many thoughts per minute' });

  // The room transcript, as [{who, text}]. Capped hard on both count and
  // length: this is a chatroom, so somebody will eventually paste an essay,
  // and an unbounded prompt is both slow and a way to spend somebody's free
  // tier for them.
  const raw = Array.isArray(req.body && req.body.lines) ? req.body.lines : [];
  const lines = raw.slice(-14).map((l) => ({
    who: String((l && l.who) || '?').slice(0, 24),
    text: String((l && l.text) || '').slice(0, 300),
  })).filter((l) => l.text);
  if (!lines.length) return res.json({ ok: false, error: 'nothing to react to' });

  // Everything the room said becomes ONE user turn rather than a fake
  // multi-turn history. The room is many people talking past each other, not a
  // dialogue, and flattening it keeps who-said-what attached to the words.
  const transcript = lines.map((l) => `${l.who}: ${l.text}`).join('\n');

  try {
    const up = await fetch(LLM_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + LLM_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(Object.assign({
        model: LLM_MODEL,
        [LLM_MAX_FIELD]: LLM_MAX_TOKENS,
        temperature: 1.15,       // she is supposed to be erratic
        top_p: 0.95,
        messages: [
          { role: 'system', content: VERITY_PROMPT },
          { role: 'user', content: 'Recent chatter in the room:\n\n' + transcript + '\n\nSay one thing.' },
        ],
      }, LLM_REASONING ? { reasoning_effort: LLM_REASONING } : {})),
    });

    if (!up.ok) {
      const body = await up.text().catch(() => '');
      // Groq sends retry-after (seconds) plus x-ratelimit-remaining-* headers
      // on a 429; passing the wait back lets the page stop asking rather than
      // hammering a limit it has already hit.
      const retryAfter = Number(up.headers.get('retry-after')) || 0;
      const why = up.status === 429
        ? `rate limited by the model provider${retryAfter ? ` (retry in ${retryAfter}s)` : ''}`
        : `model provider returned ${up.status} ${body.slice(0, 160)}`;
      console.log('[verity] brain failed:', why);
      return res.status(up.status === 429 ? 429 : 502)
        .json({ ok: false, error: why, retryAfter });
    }

    const j = await up.json();
    const choice = (j.choices && j.choices[0]) || {};
    const msg = choice.message || {};
    let text = (msg.content || '').trim();
    // Models like to wrap dialogue in quotes and prefix it with the speaker's
    // name. Spoken aloud, both sound wrong.
    text = text.replace(/^\s*(VERITY|Verity)\s*:\s*/i, '').replace(/^["'“”]+|["'“”]+$/g, '').trim();
    // Belt and braces on length. The prompt asks for 25 words; models drift,
    // and a token cap cannot enforce brevity because a reasoning model spends
    // most of its budget before it writes anything.
    //
    // Trimming happens at SENTENCE boundaries, never mid-word — a hard
    // character slice sounds like the speaker was cut off, because they were.
    const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
    if (parts.length > 2) text = parts.slice(0, 2).join(' ');
    // ~170 characters is about eleven seconds of speech, which is already at
    // the edge of tolerable for something nobody can interrupt. Past that,
    // keep the first sentence and drop the rest; the first one carries the
    // joke and the second is nearly always the model explaining it.
    if (text.length > 170 && parts.length > 1) text = parts[0];
    // Last resort for a single enormous sentence with no internal punctuation:
    // cut at the last word boundary rather than through the middle of a word.
    if (text.length > 240) {
      const cut = text.slice(0, 240);
      const lastSpace = cut.lastIndexOf(' ');
      text = (lastSpace > 120 ? cut.slice(0, lastSpace) : cut).replace(/[,;:\s]+$/, '') + '…';
    }
    if (!text) {
      // Say WHY it was empty. "The model said nothing" sent me looking at the
      // prompt when the actual cause was the token budget being eaten by
      // reasoning — finish_reason 'length' with a non-empty reasoning field is
      // the fingerprint of exactly that.
      const reasonedChars = (msg.reasoning || '').length;
      const why = choice.finish_reason === 'length'
        ? `the model used its entire ${LLM_MAX_TOKENS}-token budget on internal reasoning (${reasonedChars} chars) and never wrote an answer — raise LLM_MAX_TOKENS or lower LLM_REASONING_EFFORT`
        : `the model returned empty content (finish_reason: ${choice.finish_reason || 'unknown'})`;
      console.log('[verity] brain empty:', why);
      return res.json({ ok: false, error: why });
    }
    res.json({ ok: true, text });
  } catch (e) {
    const why = String((e && e.message) || e);
    console.log('[verity] brain error:', why);
    res.status(502).json({ ok: false, error: why });
  }
});

// ---- Discord bridge HTTP routes (must sit above the PeerJS catch-all mount) ----
bridge.attachBridgeRoutes(app, ADMIN_PASS);

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

// Discord bridge WebSocket feed. Must come AFTER the PeerJS mount so it can
// route /bridge/feed around PeerJS's own upgrade handler (see discord-bridge.js).
bridge.attachBridgeFeed(server, ADMIN_PASS);
