// Unit tests for src/remote/media.js — images for the phone chat.
//   node test/media.mjs

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { MediaStore, sniff } = require('../src/remote/media.js');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('PASS  ' + name);
  else {
    console.error('FAIL  ' + name + (detail === undefined ? '' : '  → ' + JSON.stringify(detail).slice(0, 300)));
    failures++;
  }
};

// a real 1x1 PNG
export const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termivin-media-'));
const store = new MediaStore(path.join(dir, 'media'));

check('sniff knows PNG', sniff(PNG_1PX) === 'image/png');
check('sniff knows JPEG', sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])) === 'image/jpeg');
check('sniff rejects text', sniff(Buffer.from('API_KEY=secret\n')) === null);

const pngFile = path.join(dir, 'shot.png');
fs.writeFileSync(pngFile, PNG_1PX);
const meta = store.ingestFile(pngFile);
check('an image file is stored', meta.id && meta.mime === 'image/png' && meta.size === PNG_1PX.length && meta.name === 'shot.png', meta);

const envFile = path.join(dir, '.env');
fs.writeFileSync(envFile, 'API_KEY=secret\n');
let refused = null;
try { store.ingestFile(envFile); } catch (err) { refused = err.message; }
check('a non-image file is refused (no exfiltration through --image)', refused === 'not an image', refused);

const r = store.read(meta.id, 0);
check('read returns the bytes as base64', Buffer.from(r.data, 'base64').equals(PNG_1PX) && r.done && r.size === PNG_1PX.length, r);

// chunking
const big = Buffer.concat([PNG_1PX, Buffer.alloc(900 * 1024, 7)]);
const bigMeta = store.ingestBuffer(big, { name: 'big.png' });
const parts = [];
let off = 0;
for (let i = 0; i < 10; i++) {
  const c = store.read(bigMeta.id, off);
  parts.push(Buffer.from(c.data, 'base64'));
  off += Buffer.from(c.data, 'base64').length;
  if (c.done) break;
}
check('large images come back in several chunks', parts.length === 3 && Buffer.concat(parts).equals(big), parts.map((p) => p.length));

let bad = null;
try { store.read('../../etc/passwd'); } catch (err) { bad = err.message; }
check('ids cannot walk out of the media folder', bad === 'no such image', bad);

const encoded = new MediaStore(path.join(dir, 'm2'), { encode: (buf) => ({ buffer: Buffer.from([0xff, 0xd8, 0xff, 1]), mime: 'image/jpeg', width: 800, height: 600 }) });
const em = encoded.ingestBuffer(PNG_1PX);
check('the encoder decides the stored format and size', em.mime === 'image/jpeg' && em.width === 800, em);

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\nMEDIA: ${failures} FAILURE(S)` : '\nMEDIA: ALL PASSED');
process.exit(failures ? 1 : 0);
