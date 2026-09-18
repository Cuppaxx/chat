/* Fetches the standalone yt-dlp binary into ./bin at install time, for the
   radio (see radio.js). The standalone build needs no Python, which matters
   because Render's Node environment is not guaranteed to have one.

   Never fails the install: if the download does not work the server still
   boots, and the radio simply accepts direct audio links only until the next
   deploy fetches it. Set SKIP_YTDLP=1 to skip it entirely. */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

if (process.env.SKIP_YTDLP === '1') { console.log('[yt-dlp] skipped (SKIP_YTDLP=1)'); process.exit(0); }

const asset = process.platform === 'win32' ? 'yt-dlp.exe'
  : process.platform === 'darwin' ? 'yt-dlp_macos'
  : (process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux');
const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/' + asset;
const dir = path.join(__dirname, '..', 'bin');
const out = path.join(dir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

function get(u, hops) {
  return new Promise((resolve, reject) => {
    https.get(u, { headers: { 'User-Agent': 'mingus-chatroom' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 6) {
        res.resume();
        return resolve(get(new URL(res.headers.location, u).toString(), hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      resolve(res);
    }).on('error', reject);
  });
}

(async () => {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const res = await get(url, 0);
    const tmp = out + '.part';
    await new Promise((resolve, reject) => {
      const f = fs.createWriteStream(tmp);
      res.pipe(f);
      f.on('finish', resolve);
      f.on('error', reject);
    });
    fs.renameSync(tmp, out);
    if (process.platform !== 'win32') fs.chmodSync(out, 0o755);
    console.log('[yt-dlp] installed ' + asset + ' (' + Math.round(fs.statSync(out).size / 1048576) + ' MB)');
  } catch (e) {
    console.log('[yt-dlp] could not be fetched (' + (e && e.message) + ') — the radio will accept direct audio links only');
  }
})();
