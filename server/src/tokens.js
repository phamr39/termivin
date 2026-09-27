// Short-lived access tokens for devices: base64url(payload).base64url(hmac).
// Deliberately tiny — no JWT library, one algorithm, nothing to negotiate.

import crypto from 'node:crypto';

function sign(key, body) {
  return crypto.createHmac('sha256', key).update(body).digest('base64url');
}

export function issueAccess(key, deviceId, ttlMs) {
  const exp = Date.now() + ttlMs;
  const body = Buffer.from(JSON.stringify({ sub: deviceId, exp })).toString('base64url');
  return { accessToken: `${body}.${sign(key, body)}`, expiresAt: exp };
}

export function verifyAccess(key, token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const expected = Buffer.from(sign(key, body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.sub || !(payload.exp > Date.now())) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

// Hosts authenticate by signing the connection nonce with their Ed25519 key.
// The public key is stored as base64 SPKI DER.
export function verifyHostSig(publicKeyB64, nonce, sigB64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') return false;
    return crypto.verify(null, Buffer.from(nonce), key, Buffer.from(String(sigB64), 'base64'));
  } catch {
    return false;
  }
}

export function isValidHostKey(publicKeyB64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(String(publicKeyB64), 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}
