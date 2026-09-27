// Images in the phone chat — a screenshot an agent sends with
// `termivin send owner --image shot.png`, or a capture of the PC screen.
// Files are checked by content (only real images: an agent must not be able
// to ship arbitrary files off the PC this way), downsized for a phone, and
// kept under <userData>/remote/media. The phone fetches them in chunks over
// the relay, which never stores them.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const KEEP_FILES = 300;
const CHUNK_MAX = 384 * 1024; // raw bytes per fetch (base64 ≈ 512 KB on the wire)

// Image type from the first bytes, or null.
function sniff(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 2 && buf.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
  return null;
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' };

class MediaStore {
  // encode(buf, mime) → { buffer, mime, width, height } — resizes for phones
  // (Electron's nativeImage in the app; identity in tests).
  constructor(dir, { encode } = {}) {
    this.dir = dir;
    this.encode = encode || ((buffer, mime) => ({ buffer, mime, width: null, height: null }));
    fs.mkdirSync(dir, { recursive: true });
  }

  // From raw bytes (screen capture) or a file an agent pointed at.
  ingestBuffer(buf, { name = 'image' } = {}) {
    const mime = sniff(buf);
    if (!mime) throw new Error('not an image');
    const out = this.encode(buf, mime) || { buffer: buf, mime };
    const id = Date.now().toString(36) + crypto.randomBytes(6).toString('hex');
    const file = path.join(this.dir, `${id}.${EXT[out.mime] || 'bin'}`);
    fs.writeFileSync(file, out.buffer);
    this.prune();
    return { id, mime: out.mime, size: out.buffer.length, width: out.width || null, height: out.height || null, name };
  }

  ingestFile(file) {
    const st = fs.statSync(file);
    if (!st.isFile()) throw new Error('not a file');
    if (st.size > MAX_INPUT_BYTES) throw new Error('image too large');
    return this.ingestBuffer(fs.readFileSync(file), { name: path.basename(file) });
  }

  locate(id) {
    if (!/^[a-z0-9]{8,40}$/.test(String(id))) return null;
    const hit = fs.readdirSync(this.dir).find((f) => f.startsWith(id + '.'));
    return hit ? path.join(this.dir, hit) : null;
  }

  // A slice of a stored image, base64, for the phone to reassemble.
  read(id, offset = 0, length = CHUNK_MAX) {
    const file = this.locate(id);
    if (!file) throw new Error('no such image');
    const size = fs.statSync(file).size;
    const start = Math.max(0, Number(offset) || 0);
    const len = Math.max(0, Math.min(CHUNK_MAX, Number(length) || CHUNK_MAX, size - start));
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, len, start);
    } finally {
      fs.closeSync(fd);
    }
    return { id, size, offset: start, data: buf.toString('base64'), done: start + len >= size };
  }

  prune() {
    try {
      const files = fs.readdirSync(this.dir)
        .map((f) => ({ f, t: fs.statSync(path.join(this.dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const { f } of files.slice(KEEP_FILES)) fs.unlinkSync(path.join(this.dir, f));
    } catch {}
  }
}

module.exports = { MediaStore, sniff, CHUNK_MAX };
