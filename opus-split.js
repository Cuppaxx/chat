/* Split an Opus packet into one packet per frame (RFC 6716 §3.2), without
   decoding. Chrome's MediaRecorder emits 60 ms packets (code 3, three 20 ms
   frames); @discordjs/voice assumes every packet it sends is 20 ms. Splitting
   here makes the two agree. Returns an array of Buffers (possibly just [pkt]). */
function splitOpusPacket(pkt) {
  if (!pkt || pkt.length < 1) return [];
  const toc = pkt[0];
  const code = toc & 3;
  const toc0 = toc & 0xfc;                // same config + stereo bit, code 0
  if (code === 0) return [pkt];
  if (code === 1) {                        // two frames, equal size
    const n = pkt.length - 1;
    if (n % 2) return [pkt];
    const h = n / 2;
    return [Buffer.concat([Buffer.from([toc0]), pkt.subarray(1, 1 + h)]),
            Buffer.concat([Buffer.from([toc0]), pkt.subarray(1 + h)])];
  }
  if (code === 2) {                        // two frames, first length given
    const r = readLen(pkt, 1); if (!r) return [pkt];
    const a = pkt.subarray(r.pos, r.pos + r.len), b = pkt.subarray(r.pos + r.len);
    return [Buffer.concat([Buffer.from([toc0]), a]), Buffer.concat([Buffer.from([toc0]), b])];
  }
  // code 3: arbitrary number of frames
  if (pkt.length < 2) return [pkt];
  const fc = pkt[1];
  const M = fc & 0x3f, vbr = !!(fc & 0x80), pad = !!(fc & 0x40);
  if (M === 0) return [pkt];
  let pos = 2, padLen = 0;
  if (pad) {                                // padding length: 255-chains
    let p;
    do { if (pos >= pkt.length) return [pkt]; p = pkt[pos++]; padLen += p === 255 ? 254 : p; } while (p === 255);
  }
  const end = pkt.length - padLen;
  const out = [];
  if (!vbr) {
    const total = end - pos;
    if (total < 0 || total % M) return [pkt];
    const sz = total / M;
    for (let i = 0; i < M; i++) out.push(Buffer.concat([Buffer.from([toc0]), pkt.subarray(pos + i * sz, pos + (i + 1) * sz)]));
    return out;
  }
  const lens = [];
  for (let i = 0; i < M - 1; i++) { const r = readLen(pkt, pos); if (!r) return [pkt]; lens.push(r.len); pos = r.pos; }
  let used = lens.reduce((a, b) => a + b, 0);
  const last = end - pos - used;
  if (last < 0) return [pkt];
  lens.push(last);
  for (const L of lens) { out.push(Buffer.concat([Buffer.from([toc0]), pkt.subarray(pos, pos + L)])); pos += L; }
  return out;
}
function readLen(pkt, pos) {
  if (pos >= pkt.length) return null;
  const b = pkt[pos];
  if (b < 252) return { len: b, pos: pos + 1 };
  if (pos + 1 >= pkt.length) return null;
  return { len: b + 4 * pkt[pos + 1], pos: pos + 2 };
}
module.exports = { splitOpusPacket };
