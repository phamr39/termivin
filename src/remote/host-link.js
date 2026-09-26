// The desktop's side of the relay connection: enrollment (an Ed25519 key pair
// whose public half the relay stores), then one outbound WebSocket that stays
// up with exponential-backoff reconnects. No inbound port is ever opened.
// Wire format: docs/REMOTE.md.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const PING_MS = 25000;
const BACKOFF_MAX_MS = 60000;
const REQUEST_TIMEOUT_MS = 10000;

function wsUrl(httpUrl, pathname) {
  const u = new URL(httpUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = u.pathname.replace(/\/+$/, '') + pathname;
  return u.toString();
}

function normalizeUrl(url) {
  const u = new URL(String(url).trim());
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('relay URL must start with http:// or https://');
  return u.toString().replace(/\/+$/, '');
}

class HostLink extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.file = path.join(dir, 'host.json');
    this.config = null;
    this.ws = null;
    this.state = 'disabled'; // disabled | connecting | online | offline | error
    this.error = null;
    this.backoff = 1000;
    this.retryTimer = null;
    this.pingTimer = null;
    this.pendingPair = [];
    this.pendingDevices = [];
    this.load();
  }

  load() {
    try {
      this.config = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.config = null;
    }
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  info() {
    const c = this.config;
    return {
      state: this.state,
      error: this.error,
      url: c ? c.url : '',
      hostId: c ? c.hostId : null,
      name: c ? c.name : '',
      enabled: !!(c && c.enabled),
    };
  }

  setState(state, error = null) {
    this.state = state;
    this.error = error;
    this.emit('state', this.info());
  }

  async enroll({ url, code, name }) {
    const base = normalizeUrl(url);
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const res = await fetch(base + '/api/hosts/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: String(code || '').trim(), publicKey: publicKeyB64, name }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(json.error === 'invalid_code' ? 'Enrollment code is invalid or expired' : `Relay refused enrollment (${json.error || res.status})`);
    }
    this.disconnect();
    this.config = {
      url: base,
      hostId: json.hostId,
      name: json.name,
      publicKey: publicKeyB64,
      privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }),
      enabled: true,
    };
    this.save();
    this.connect();
    return this.info();
  }

  setEnabled(enabled) {
    if (!this.config) return this.info();
    this.config.enabled = !!enabled;
    this.save();
    if (enabled) this.connect();
    else this.disconnect();
    return this.info();
  }

  forget() {
    this.disconnect();
    this.config = null;
    try { fs.unlinkSync(this.file); } catch {}
    this.setState('disabled');
    return this.info();
  }

  start() {
    if (this.config && this.config.enabled) this.connect();
    else this.setState('disabled');
  }

  connect() {
    if (!this.config || !this.config.enabled) return;
    clearTimeout(this.retryTimer);
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }
    this.setState('connecting');
    let ws;
    try {
      ws = new WebSocket(wsUrl(this.config.url, '/ws/host'));
    } catch (err) {
      this.setState('error', String(err.message || err));
      return this.scheduleRetry();
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this.onMessage(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      this.failPending('relay connection lost');
      if (!this.config || !this.config.enabled) return this.setState('disabled');
      const reason = ev.code === 4003 ? 'Relay rejected this PC (re-enroll it)' : null;
      this.setState(reason ? 'error' : 'offline', reason);
      this.emit('offline');
      if (ev.code !== 4003) this.scheduleRetry();
    };
    ws.onerror = () => {};
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    const delay = this.backoff + Math.floor(Math.random() * 500);
    this.backoff = Math.min(BACKOFF_MAX_MS, this.backoff * 2);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  disconnect() {
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try { ws.close(); } catch {}
    }
    this.failPending('disconnected');
    if (this.state !== 'disabled') this.setState('disabled');
  }

  failPending(reason) {
    for (const p of [...this.pendingPair, ...this.pendingDevices]) p.reject(new Error(reason));
    this.pendingPair = [];
    this.pendingDevices = [];
  }

  onMessage(msg) {
    switch (msg.t) {
      case 'challenge': {
        const key = crypto.createPrivateKey(this.config.privateKey);
        const sig = crypto.sign(null, Buffer.from(msg.nonce), key).toString('base64');
        this.sendJson({ t: 'auth', hostId: this.config.hostId, sig });
        break;
      }
      case 'ready':
        this.backoff = 1000;
        if (msg.name && msg.name !== this.config.name) {
          this.config.name = msg.name;
          this.save();
        }
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.sendJson({ t: 'ping' }), PING_MS);
        this.setState('online');
        this.emit('online');
        break;
      case 'pair.created': {
        const p = this.pendingPair.shift();
        if (p) p.resolve(msg);
        break;
      }
      case 'devices': {
        const p = this.pendingDevices.shift();
        if (p) p.resolve(msg.items || []);
        this.emit('devices', msg.items || []);
        break;
      }
      case 'cmd':
      case 'sub':
      case 'unsub':
        this.emit(msg.t, msg);
        break;
      default:
        break;
    }
  }

  get online() {
    return this.state === 'online' && this.ws && this.ws.readyState === 1;
  }

  sendJson(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  // u8 termIdLen | termId | u32be seq | utf8 data
  sendFrame(termId, seq, data) {
    if (!this.online) return;
    const tid = Buffer.from(termId, 'utf8');
    const head = Buffer.alloc(1 + tid.length + 4);
    head[0] = tid.length;
    tid.copy(head, 1);
    head.writeUInt32BE(seq >>> 0, 1 + tid.length);
    this.ws.send(Buffer.concat([head, Buffer.from(data, 'utf8')]));
  }

  request(list, msg) {
    return new Promise((resolve, reject) => {
      if (!this.online) return reject(new Error('Not connected to the relay'));
      const entry = { resolve, reject };
      list.push(entry);
      this.sendJson(msg);
      setTimeout(() => {
        const i = list.indexOf(entry);
        if (i !== -1) {
          list.splice(i, 1);
          reject(new Error('Relay did not answer'));
        }
      }, REQUEST_TIMEOUT_MS);
    });
  }

  createPairing(scopes) {
    return this.request(this.pendingPair, { t: 'pair.create', scopes });
  }

  listDevices() {
    return this.request(this.pendingDevices, { t: 'devices.list' });
  }

  revokeDevice(deviceId) {
    return this.request(this.pendingDevices, { t: 'devices.revoke', deviceId });
  }
}

module.exports = { HostLink, normalizeUrl };
