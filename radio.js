/* ============================================================================
   RADIO — the server half

   The radio plays through somebody's VOICE stream: one person in the channel
   (the radio host) plays the audio in their browser and mixes it into what
   they send, so the whole channel hears it and the Discord bridge picks it up
   like any other voice. The catch is that YouTube and SoundCloud players are
   sealed cross-origin frames - a page cannot tap their sound - so the audio has
   to arrive as a plain audio stream the page is allowed to read. That is what
   this file does, the same way a Discord music bot does it:

     POST /radio/resolve  {url}   -> yt-dlp works out the real audio stream
                                     behind a YouTube / SoundCloud / Bandcamp /
                                     Vimeo / Twitch / direct link, and hands
                                     back a short-lived token plus the title
     GET  /radio/stream/:token    -> the audio itself, piped through here with
                                     CORS and Range support

   Why proxy rather than hand the browser the URL: YouTube's audio URLs are
   locked to the address that asked for them (this server) and carry no CORS
   headers, so the browser could not play them into Web Audio even if it
   could reach them. Only the one radio host pulls the stream - everybody
   else hears it over voice - so this costs one audio stream, not one per
   listener. Nothing is transcoded or stored; bytes are passed straight
   through.

   yt-dlp is a standalone binary fetched at install time (scripts/get-ytdlp.js).
   Without it, direct audio links still work and everything else says why not.

   Render -> Environment (both optional):
     YTDLP_PATH      use a yt-dlp somewhere else
     YTDLP_COOKIES   the contents of a Netscape cookies.txt, for when YouTube
                     starts asking this server's address to "sign in to
                     confirm you're not a bot" - which datacentre addresses
                     do get asked. Use a throwaway account.
   ============================================================================ */
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');

const BIN = process.env.YTDLP_PATH ||
  path.join(__dirname, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

let cookiesFile = null;
if (process.env.YTDLP_COOKIES) {
  try {
    cookiesFile = path.join(os.tmpdir(), 'mingus-ytdlp-cookies.txt');
    fs.writeFileSync(cookiesFile, process.env.YTDLP_COOKIES);
  } catch (e) { cookiesFile = null; }
}

function haveYtdlp() { try { return fs.existsSync(BIN); } catch (e) { return false; } }

// token -> { url, headers, exp, meta }
const streams = new Map();
// input url -> { at, result } so the host re-resolving a queued item is instant
const cache = new Map();
const CACHE_MS = 25 * 60 * 1000;      // YouTube stream URLs last hours; stay well inside
const TOKEN_MS = 4 * 60 * 60 * 1000;

// ---- abuse brakes ----------------------------------------------------------
// Anybody in the room can queue, so resolving needs its own budget: yt-dlp is
// the most expensive thing this server ever does on its 0.1 CPU.
const hits = new Map();
function allowed(ip) {
  const now = Date.now();
  let r = hits.get(ip);
  if (!r || now > r.resetAt) { r = { n: 0, resetAt: now + 60000 }; hits.set(ip, r); }
  if (hits.size > 500) for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
  return ++r.n <= 20;
}
let running = 0;
const waiting = [];
function slot() {
  if (running < 2) { running++; return Promise.resolve(); }
  return new Promise((res) => waiting.push(res));
}
function release() {
  const next = waiting.shift();
  if (next) next(); else running--;
}

// ---- no fetching the server's own network ----------------------------------
// yt-dlp's generic extractor will fetch any URL, and the stream proxy follows
// whatever it returns - so both refuse private and loopback addresses, or this
// would be a way to reach things on Render's internal network.
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') ||
    l.startsWith('fe80') || l.startsWith('::ffff:127.') || l.startsWith('::ffff:10.') ||
    l.startsWith('::ffff:192.168.');
}
async function publicUrl(u) {
  let x;
  try { x = new URL(u); } catch (e) { return false; }
  if (x.protocol !== 'http:' && x.protocol !== 'https:') return false;
  if (process.env.RADIO_ALLOW_PRIVATE === '1') return true;   // local testing only
  const host = x.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (net.isIP(host)) return !privateIp(host);
  try {
    const addrs = await dns.lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !privateIp(a.address));
  } catch (e) { return false; }
}

// ---- resolving ---------------------------------------------------------------
const DIRECT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm|mp4)(\?|#|$)/i;

function ytdlp(url, extra) {
  return new Promise((resolve, reject) => {
    const args = [
      '-J', '--no-playlist', '--no-warnings', '--no-progress',
      // an audio-only stream over plain HTTP(S): an <audio> element can play
      // that directly. HLS playlists need a demuxer the browser does not have.
      // and never a 30-second preview: SoundCloud gives non-subscribers a
      // snippet of Go+ tracks, labelled 'preview', which would play and stop
      '-f', 'bestaudio[format_id!*=preview][protocol^=http][protocol!*=m3u8]/best[format_id!*=preview][protocol^=http][protocol!*=m3u8][vcodec=none]/bestaudio[format_id!*=preview][protocol^=http]/best[format_id!*=preview][protocol^=http][protocol!*=m3u8]',
      '--socket-timeout', '15',
    ].concat(extra || []);
    if (cookiesFile) args.push('--cookies', cookiesFile);
    args.push('--', url);
    execFile(BIN, args, { timeout: 60000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        // With -i a search still exits non-zero when some results failed
        // (DRM, region locks) but prints the ones that worked - use those.
        if (err && stdout && String(stdout).trim().startsWith('{')) {
          try { return resolve(JSON.parse(stdout)); } catch (e) { /* fall through */ }
        }
        if (err) {
          const msg = String(stderr || err.message || err).split('\n')
            .filter((l) => /ERROR/.test(l)).join(' ').replace(/^.*?ERROR:\s*/, '') ||
            String(err.message || err);
          return reject(new Error(msg.slice(0, 300)));
        }
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error('yt-dlp returned nothing usable')); }
      });
  });
}

const BOT = /sign in to confirm|not a bot|confirm you.?re not/i;
const YOUTUBE = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;

function fromYtdlp(j, url) {
  // with a merged/single format the URL is at the top level
  const f = (j.requested_formats && j.requested_formats[0]) || j;
  if (!f.url) throw new Error('no playable audio stream found for that link');
  if (f.url.indexOf('/preview/') >= 0 || /preview/.test(String(f.format_id || ''))) {
    throw new Error('only a 30-second preview of that track is available (Requested format is not available)');
  }
  return {
    url: f.url,
    headers: Object.assign({}, j.http_headers || {}, f.http_headers || {}),
    meta: {
      title: String(j.title || j.fulltitle || 'untitled').slice(0, 120),
      duration: Number(j.duration) || 0,
      thumb: j.thumbnail || '',
      source: j.extractor_key || j.extractor || 'link',
      page: j.webpage_url || url,
    },
  };
}

// YouTube's public oEmbed endpoint answers with the title even when the video
// pages themselves are bot-checking this server's address.
async function youtubeTitle(url) {
  try {
    const r = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(url),
      { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return '';
    const j = await r.json();
    return String((j && j.title) || '');
  } catch (e) { return ''; }
}

// Search SoundCloud and return the first result that actually PLAYS IN FULL.
// The top hit for a popular song is usually the official label upload, which
// is either DRM-locked or only a 30-second preview. So: one quick "flat"
// search for the candidates (a single request), then open them one at a time
// and stop at the first that yields a full, unlocked stream. That is a lot
// cheaper on Render's CPU than fully processing eight results up front, which
// is what made queueing take the better part of a minute.
async function searchSoundCloud(q, excludeId) {
  let list;
  try { list = await ytdlp('scsearch8:' + q, ['--flat-playlist']); } catch (e) { return null; }
  // Rank by how well the title matches, and skip covers / remixes / nightcore
  // / sped-up versions unless that is what was asked for - the first live test
  // of this played a Rick Astley COVER because it happened to be listed first.
  const words = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1);
  const want = words(q);
  const VARIANT = /\b(cover|remix|nightcore|sped up|speed up|slowed|reverb|8d|karaoke|instrumental|mashup|bootleg|edit|flip|rework|type beat)\b/i;
  const askedVariant = VARIANT.test(q);
  const score = (e) => {
    const t = words(e.title);
    let hit = 0; for (const w of want) if (t.indexOf(w) >= 0) hit++;
    let s = want.length ? hit / want.length : 0;
    if (!askedVariant && VARIANT.test(String(e.title || ''))) s -= 1;
    return s;
  };
  const cands = (list.entries || []).filter((e) => e && e.url &&
    String(e.id) !== String(excludeId || '') &&
    !(Number(e.duration) > 0 && Number(e.duration) <= 35))
    .map((e) => ({ e, s: score(e) }))
    .filter((x) => x.s > 0.34)          // at least a third of the words in common
    .sort((a, b) => b.s - a.s)
    .map((x) => x.e);
  for (const c of cands.slice(0, 4)) {
    try {
      const r = fromYtdlp(await ytdlp(c.url), c.url);
      if (r.meta.duration && r.meta.duration <= 35) continue;   // a clip, not the song
      return r;
    } catch (e) { /* locked, preview-only, region-blocked: next */ }
  }
  return null;
}
function cleanTitle(t) {
  return String(t || '')
    .replace(/\((official|lyric|lyrics|audio|video|music video|visualizer|hd|4k)[^)]*\)/ig, '')
    .replace(/\[(official|lyric|lyrics|audio|video|music video|visualizer|hd|4k)[^\]]*\]/ig, '')
    .replace(/\s+/g, ' ').trim();
}

// DRM-protected tracks (major-label uploads, SoundCloud Go+) are encrypted and
// cannot be played by this or any other bot - and breaking that encryption is
// not something this does. What it does instead is read the track's title,
// which SoundCloud still gives out, and look for another upload of the same
// song that is not locked. Popular songs nearly always have one.
async function resolveDrm(url, original) {
  let meta = null;
  try { meta = await ytdlp(url, ['--ignore-no-formats-error', '-f', 'bestaudio/best/all']); } catch (e) { throw original; }
  const title = cleanTitle(meta && (meta.title || meta.fulltitle));
  if (!title) throw original;
  const who = String((meta && (meta.artist || meta.uploader)) || '').trim();
  const q = (who && title.toLowerCase().indexOf(who.toLowerCase()) < 0) ? (who + ' ' + title) : title;
  let hit = await searchSoundCloud(q, meta.id);
  if (!hit && q !== title) hit = await searchSoundCloud(title, meta.id);
  if (!hit) {
    throw new Error('"' + title.slice(0, 80) + '" is locked on SoundCloud (a label or Go+ upload - DRM or a ' +
      '30-second preview), and no full, unlocked upload of it turned up. Try a different link for the same song.');
  }
  const r = hit;
  r.meta.fallback = 'drm';
  r.meta.ytTitle = title.slice(0, 120);
  return r;
}

// When YouTube will not talk to a datacentre address, two things are tried
// before giving up, both costing nothing and needing nobody's account:
//   1. ask as YouTube's TV and mobile-web clients, which it sometimes lets
//      through when it is bot-checking the ordinary web one;
//   2. look the song up by its title on SoundCloud and play that instead,
//      saying so - the same trick music bots use to play Spotify links.
// Cookies (YTDLP_COOKIES) remain the real fix and are tried first when set.
// Once YouTube has bot-checked this server, asking again for every link just
// adds half a minute of waiting to each one. Remember it for a while and go
// straight to the SoundCloud match; try YouTube itself again after that.
let ytBlockedUntil = 0;
async function resolveYouTube(url) {
  try {
    if (Date.now() < ytBlockedUntil) throw new Error('Sign in to confirm you are not a bot (remembered)');
    return fromYtdlp(await ytdlp(url), url);
  } catch (e1) {
    if (!BOT.test(String(e1.message))) throw e1;
    try {
      if (Date.now() < ytBlockedUntil) throw e1;
      return fromYtdlp(await ytdlp(url, ['--extractor-args', 'youtube:player_client=tv,mweb']), url);
    } catch (e2) {
      if (!cookiesFile) ytBlockedUntil = Date.now() + 30 * 60 * 1000;
      const title = await youtubeTitle(url);
      if (!title) throw e1;
      let hit = null;
      try { hit = await searchSoundCloud(cleanTitle(title)); } catch (e3) { throw e1; }
      if (!hit) throw e1;
      const r = hit;
      r.meta.fallback = 'soundcloud';
      r.meta.ytTitle = title.slice(0, 120);
      return r;
    }
  }
}

async function resolve(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;

  let result;
  let host = '';
  try { host = new URL(url).hostname; } catch (e) {}
  if (haveYtdlp() && YOUTUBE.test(host)) {
    result = await resolveYouTube(url);
  } else if (haveYtdlp()) {
    try {
      result = fromYtdlp(await ytdlp(url), url);
    } catch (e) {
      if (!/DRM|preview|Requested format is not available/i.test(String(e.message))) throw e;
      result = await resolveDrm(url, e);
    }
  } else if (DIRECT.test(url)) {
    result = {
      url, headers: {},
      meta: { title: decodeURIComponent(url.split('/').pop().split('?')[0]).slice(0, 120),
              duration: 0, thumb: '', source: 'direct', page: url },
    };
  } else {
    throw new Error('this server has no yt-dlp, so only direct audio links (.mp3, .m4a, .ogg...) work');
  }
  if (!(await publicUrl(result.url))) throw new Error('that link points somewhere this server will not fetch');
  cache.set(url, { at: Date.now(), result });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return result;
}

function attach(app, clientIp) {
  app.get('/radio/status', (req, res) => {
    res.json({ ok: true, ytdlp: haveYtdlp(), cookies: !!cookiesFile });
  });

  app.post('/radio/resolve', async (req, res) => {
    const url = String((req.body && req.body.url) || '').trim().slice(0, 600);
    if (!/^https?:\/\//i.test(url)) return res.json({ ok: false, error: 'that needs to be an http(s) link' });
    if (!allowed(clientIp(req))) return res.status(429).json({ ok: false, error: 'slow down — too many links in a minute' });
    if (!(await publicUrl(url))) return res.json({ ok: false, error: 'that link points somewhere this server will not fetch' });
    await slot();
    try {
      const r = await resolve(url);
      const token = crypto.randomBytes(12).toString('hex');
      streams.set(token, { url: r.url, headers: r.headers, exp: Date.now() + TOKEN_MS });
      if (streams.size > 400) {
        const now = Date.now();
        for (const [k, v] of streams) if (v.exp < now) streams.delete(k);
      }
      res.json(Object.assign({ ok: true, token }, r.meta));
    } catch (e) {
      let why = String((e && e.message) || e);
      if (/sign in to confirm|not a bot/i.test(why)) {
        why = 'YouTube is asking this server to prove it is not a bot. An admin can fix that by ' +
              'setting YTDLP_COOKIES on the server (see radio.js). SoundCloud and direct links still work.';
      }
      res.json({ ok: false, error: why });
    } finally {
      release();
    }
  });

  // The audio itself. Range requests pass straight through so the host can
  // seek and so Chrome's media pipeline gets the partial responses it expects.
  app.get('/radio/stream/:token', async (req, res) => {
    const s = streams.get(String(req.params.token || ''));
    if (!s || s.exp < Date.now()) return res.status(404).end();
    const headers = Object.assign({}, s.headers);
    delete headers['Accept-Encoding'];
    if (req.headers.range) headers.Range = req.headers.range;
    let up;
    try {
      up = await fetch(s.url, { headers, redirect: 'follow' });
    } catch (e) {
      return res.status(502).end();
    }
    if (!up.ok && up.status !== 206) return res.status(up.status === 403 ? 410 : 502).end();
    res.status(up.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = up.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!up.headers.get('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');
    const { Readable } = require('stream');
    const body = Readable.fromWeb(up.body);
    req.on('close', () => { try { body.destroy(); } catch (e) {} });
    body.on('error', () => { try { res.end(); } catch (e) {} });
    body.pipe(res);
  });
}

module.exports = { attach, haveYtdlp };
