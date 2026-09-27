// termivin-relay entry point: a small HTTP API (enrollment, pairing, token
// refresh) plus the two WebSocket endpoints the relay core serves.

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createRelay } from './relay.js';
import { createPush } from './push.js';
import { issueAccess, verifyAccess, isValidHostKey } from './tokens.js';

const MAX_BODY = 16 * 1024;
const API_RATE = 30; // requests per IP per minute on /api — pairing codes are guessable only by brute force

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(v && typeof v === 'object' ? v : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function clientIp(req) {
  // Behind Caddy the peer is the proxy; trust X-Forwarded-For only from loopback/private peers.
  const peer = req.socket.remoteAddress || '';
  const fwd = req.headers['x-forwarded-for'];
  if (fwd && /^(::ffff:)?(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)|^::1$/.test(peer)) {
    return String(fwd).split(',')[0].trim();
  }
  return peer;
}

export function startServer(cfg = loadConfig(), { log = console.log } = {}) {
  const db = openDb(cfg);
  const push = createPush(cfg, log);
  const relay = createRelay({ db, cfg, push, log });
  const hits = new Map(); // ip -> { count, resetAt }

  function limited(ip) {
    const now = Date.now();
    let h = hits.get(ip);
    if (!h || h.resetAt < now) hits.set(ip, (h = { count: 0, resetAt: now + 60000 }));
    h.count++;
    return h.count > API_RATE;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://relay');
    try {
      if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, ...relay.stats() });
      if (!url.pathname.startsWith('/api/') || req.method !== 'POST') return sendJson(res, 404, { error: 'not_found' });
      if (limited(clientIp(req))) return sendJson(res, 429, { error: 'rate_limited' });
      const body = await readBody(req);
      if (!body) return sendJson(res, 400, { error: 'bad_request' });

      if (url.pathname === '/api/hosts/enroll') {
        if (typeof body.code !== 'string' || !isValidHostKey(body.publicKey)) return sendJson(res, 400, { error: 'bad_request' });
        const name = typeof body.name === 'string' ? body.name.slice(0, 60) : null;
        const host = db.enrollHost(body.code.trim(), body.publicKey, name);
        if (!host) return sendJson(res, 403, { error: 'invalid_code' });
        db.audit({ hostId: host.id, op: 'host.enroll', ok: true });
        log(`host enrolled ${host.id} (${host.name})`);
        return sendJson(res, 200, { hostId: host.id, name: host.name });
      }

      if (url.pathname === '/api/devices/pair') {
        if (typeof body.token !== 'string') return sendJson(res, 400, { error: 'bad_request' });
        // An already-paired phone adds another PC to the same device identity.
        const auth = req.headers.authorization || '';
        const existing = auth.startsWith('Bearer ') ? verifyAccess(db.tokenKey, auth.slice(7)) : null;
        const result = existing
          ? relay.pairExisting(existing, body.token.trim())
          : relay.pair(body.token.trim(), body.name, body.platform);
        if (!result) return sendJson(res, 403, { error: 'invalid_token' });
        log(`device paired ${result.deviceId} → ${result.hostId}`);
        return sendJson(res, 200, result);
      }

      if (url.pathname === '/api/token/refresh') {
        if (typeof body.refreshToken !== 'string') return sendJson(res, 400, { error: 'bad_request' });
        const rotated = db.rotateRefresh(body.refreshToken);
        if (!rotated) return sendJson(res, 401, { error: 'invalid_refresh' });
        const access = issueAccess(db.tokenKey, rotated.deviceId, cfg.accessTtlMs);
        return sendJson(res, 200, { deviceId: rotated.deviceId, refreshToken: rotated.refreshToken, ...access });
      }

      return sendJson(res, 404, { error: 'not_found' });
    } catch (err) {
      log(`api error: ${err.stack || err}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://relay');
    const wss = pathname === '/ws/host' ? relay.hostWss : pathname === '/ws/device' ? relay.deviceWss : null;
    if (!wss) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const pruneHits = setInterval(() => {
    const now = Date.now();
    for (const [ip, h] of hits) if (h.resetAt < now) hits.delete(ip);
  }, 60000);

  return new Promise((resolve) => {
    server.listen(cfg.port, cfg.host, () => {
      const port = server.address().port;
      log(`termivin-relay listening on ${cfg.host}:${port}${cfg.publicUrl ? ` (public ${cfg.publicUrl})` : ''}`);
      resolve({
        port, db, relay, server,
        close: () => new Promise((done) => {
          clearInterval(pruneHits);
          relay.close();
          server.close(() => {
            db.close();
            done();
          });
        }),
      });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const running = await startServer();
  const stop = async () => {
    await running.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
