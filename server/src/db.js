// Persistence: hosts, devices, grants, tokens, audit and activity in one SQLite
// file (node:sqlite — no native dependency to build in the image).
// Secrets (enrollment codes, pairing and refresh tokens) are stored as SHA-256
// hashes only; the plaintext is shown once and never kept.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const SCOPES = ['view', 'approve', 'input', 'manage'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, public_key TEXT,
  enroll_hash TEXT, enroll_expires INTEGER,
  created_at INTEGER NOT NULL, last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT,
  push_token TEXT, push_platform TEXT,
  created_at INTEGER NOT NULL, last_seen INTEGER, revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS grants (
  device_id TEXT NOT NULL, host_id TEXT NOT NULL, scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (device_id, host_id)
);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  hash TEXT PRIMARY KEY, device_id TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pair_tokens (
  hash TEXT PRIMARY KEY, host_id TEXT NOT NULL, scopes TEXT NOT NULL,
  expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
  device_id TEXT, host_id TEXT, op TEXT NOT NULL, args TEXT,
  ok INTEGER, error TEXT
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
  host_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT
);
CREATE INDEX IF NOT EXISTS activity_host_ts ON activity (host_id, ts);
`;

export function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

export function newSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}

export function normalizeScopes(scopes) {
  const list = Array.isArray(scopes) ? scopes : String(scopes || '').split(',');
  const out = SCOPES.filter((s) => list.includes(s));
  // Every grant can at least see; the other scopes build on that.
  if (!out.includes('view')) out.unshift('view');
  return out;
}

export function openDb(cfg) {
  if (cfg.dbPath !== ':memory:') fs.mkdirSync(cfg.dataDir, { recursive: true });
  const db = new DatabaseSync(cfg.dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const q = (sql) => db.prepare(sql);
  const now = () => Date.now();

  // Signing key for access tokens — generated on first start, lives with the db.
  let tokenKey = q('SELECT value FROM meta WHERE key = ?').get('token_key')?.value;
  if (!tokenKey) {
    tokenKey = newSecret(48);
    q('INSERT INTO meta (key, value) VALUES (?, ?)').run('token_key', tokenKey);
  }

  return {
    raw: db,
    tokenKey,
    close: () => db.close(),

    // --- hosts ------------------------------------------------------------
    addHost(name) {
      const id = newId('h');
      const code = newSecret(12);
      q(`INSERT INTO hosts (id, name, enroll_hash, enroll_expires, created_at)
         VALUES (?, ?, ?, ?, ?)`).run(id, name, hashSecret(code), now() + cfg.enrollTtlMs, now());
      return { id, name, code };
    },
    // A fresh code for an existing host (lost key, reinstalled desktop).
    reenrollHost(id) {
      const code = newSecret(12);
      const r = q(`UPDATE hosts SET enroll_hash = ?, enroll_expires = ? WHERE id = ?`)
        .run(hashSecret(code), now() + cfg.enrollTtlMs, id);
      return r.changes ? { id, code } : null;
    },
    enrollHost(code, publicKey, name) {
      const row = q('SELECT * FROM hosts WHERE enroll_hash = ?').get(hashSecret(code));
      if (!row || !row.enroll_expires || row.enroll_expires < now()) return null;
      q(`UPDATE hosts SET public_key = ?, name = COALESCE(?, name),
         enroll_hash = NULL, enroll_expires = NULL WHERE id = ?`)
        .run(publicKey, name || null, row.id);
      return this.getHost(row.id);
    },
    getHost(id) {
      return q('SELECT * FROM hosts WHERE id = ?').get(id) || null;
    },
    listHosts() {
      return q('SELECT * FROM hosts ORDER BY created_at').all();
    },
    removeHost(id) {
      q('DELETE FROM grants WHERE host_id = ?').run(id);
      q('DELETE FROM pair_tokens WHERE host_id = ?').run(id);
      return q('DELETE FROM hosts WHERE id = ?').run(id).changes > 0;
    },
    touchHost(id) {
      q('UPDATE hosts SET last_seen = ? WHERE id = ?').run(now(), id);
    },

    // --- pairing ----------------------------------------------------------
    createPairToken(hostId, scopes) {
      const token = newSecret(24);
      const expiresAt = now() + cfg.pairTtlMs;
      q(`INSERT INTO pair_tokens (hash, host_id, scopes, expires_at) VALUES (?, ?, ?, ?)`)
        .run(hashSecret(token), hostId, normalizeScopes(scopes).join(','), expiresAt);
      return { token, expiresAt };
    },
    // Single use: the row is marked used in the same statement that checks it.
    consumePairToken(token) {
      const hash = hashSecret(token);
      const r = q(`UPDATE pair_tokens SET used_at = ?
                   WHERE hash = ? AND used_at IS NULL AND expires_at > ?`).run(now(), hash, now());
      if (!r.changes) return null;
      return q('SELECT host_id, scopes FROM pair_tokens WHERE hash = ?').get(hash);
    },

    // --- devices & grants -------------------------------------------------
    addDevice(name, platform) {
      const id = newId('d');
      q(`INSERT INTO devices (id, name, platform, created_at) VALUES (?, ?, ?, ?)`)
        .run(id, String(name || 'Phone').slice(0, 60), String(platform || '').slice(0, 20), now());
      return id;
    },
    getDevice(id) {
      return q('SELECT * FROM devices WHERE id = ?').get(id) || null;
    },
    listDevices(hostId) {
      const rows = hostId
        ? q(`SELECT d.*, g.scopes FROM devices d JOIN grants g ON g.device_id = d.id
             WHERE g.host_id = ? AND d.revoked_at IS NULL ORDER BY d.created_at`).all(hostId)
        : q('SELECT * FROM devices ORDER BY created_at').all();
      return rows;
    },
    revokeDevice(id) {
      q('DELETE FROM refresh_tokens WHERE device_id = ?').run(id);
      q('DELETE FROM grants WHERE device_id = ?').run(id);
      return q('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
        .run(now(), id).changes > 0;
    },
    // Drop one host's grant; the device itself stays if it has other hosts.
    revokeGrant(deviceId, hostId) {
      return q('DELETE FROM grants WHERE device_id = ? AND host_id = ?').run(deviceId, hostId).changes > 0;
    },
    touchDevice(id) {
      q('UPDATE devices SET last_seen = ? WHERE id = ?').run(now(), id);
    },
    setPushToken(id, token, platform) {
      q('UPDATE devices SET push_token = ?, push_platform = ? WHERE id = ?')
        .run(String(token || '').slice(0, 4096) || null, platform || null, id);
    },
    upsertGrant(deviceId, hostId, scopes) {
      q(`INSERT INTO grants (device_id, host_id, scopes, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (device_id, host_id) DO UPDATE SET scopes = excluded.scopes`)
        .run(deviceId, hostId, normalizeScopes(scopes).join(','), now());
    },
    grantsForDevice(deviceId) {
      return q(`SELECT g.host_id, g.scopes, h.name, h.last_seen FROM grants g
                JOIN hosts h ON h.id = g.host_id WHERE g.device_id = ?`).all(deviceId)
        .map((r) => ({ hostId: r.host_id, name: r.name, lastSeen: r.last_seen, scopes: r.scopes.split(',') }));
    },
    devicesForHost(hostId) {
      return q(`SELECT d.id, d.push_token, d.push_platform FROM devices d
                JOIN grants g ON g.device_id = d.id
                WHERE g.host_id = ? AND d.revoked_at IS NULL`).all(hostId);
    },

    // --- refresh tokens (rotated on every use) ----------------------------
    issueRefresh(deviceId) {
      const token = newSecret(32);
      q('INSERT INTO refresh_tokens (hash, device_id, expires_at) VALUES (?, ?, ?)')
        .run(hashSecret(token), deviceId, now() + cfg.refreshTtlMs);
      return token;
    },
    rotateRefresh(token) {
      const hash = hashSecret(token);
      const row = q('SELECT * FROM refresh_tokens WHERE hash = ?').get(hash);
      q('DELETE FROM refresh_tokens WHERE hash = ?').run(hash);
      if (!row || row.expires_at < now()) return null;
      const dev = this.getDevice(row.device_id);
      if (!dev || dev.revoked_at) return null;
      return { deviceId: row.device_id, refreshToken: this.issueRefresh(row.device_id) };
    },

    // --- audit & activity -------------------------------------------------
    audit(entry) {
      q(`INSERT INTO audit (ts, device_id, host_id, op, args, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(now(), entry.deviceId || null, entry.hostId || null, entry.op,
          entry.args === undefined ? null : JSON.stringify(entry.args).slice(0, 2000),
          entry.ok === undefined ? null : entry.ok ? 1 : 0, entry.error || null);
    },
    listAudit({ hostId, limit = 100 } = {}) {
      const rows = hostId
        ? q('SELECT * FROM audit WHERE host_id = ? ORDER BY id DESC LIMIT ?').all(hostId, limit)
        : q('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit);
      return rows;
    },
    addActivity(hostId, kind, data) {
      q('INSERT INTO activity (ts, host_id, kind, data) VALUES (?, ?, ?, ?)')
        .run(now(), hostId, kind, JSON.stringify(data ?? null).slice(0, 4000));
    },
    listActivity(hostIds, { before = Infinity, limit = 100 } = {}) {
      if (!hostIds.length) return [];
      const marks = hostIds.map(() => '?').join(',');
      return q(`SELECT * FROM activity WHERE host_id IN (${marks}) AND ts < ?
                ORDER BY ts DESC LIMIT ?`)
        .all(...hostIds, Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER, limit)
        .map((r) => ({ ts: r.ts, hostId: r.host_id, kind: r.kind, data: JSON.parse(r.data) }));
    },
    prune() {
      q('DELETE FROM activity WHERE ts < ?').run(now() - cfg.activityRetentionMs);
      q('DELETE FROM pair_tokens WHERE expires_at < ?').run(now() - 60 * 60 * 1000);
      q('DELETE FROM refresh_tokens WHERE expires_at < ?').run(now());
    },
  };
}
