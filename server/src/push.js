// Push notifications through Firebase Cloud Messaging (HTTP v1). FCM also
// delivers to iOS (via the APNs key uploaded in the Firebase console), so one
// integration covers both platforms. Optional: without a service account the
// relay simply doesn't push — the app still gets everything over its socket.

import fs from 'node:fs';
import crypto from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

export function createPush(cfg, log = () => {}) {
  if (!cfg.fcmServiceAccount) return null;
  let account;
  try {
    account = JSON.parse(fs.readFileSync(cfg.fcmServiceAccount, 'utf8'));
  } catch (err) {
    log(`push disabled: cannot read ${cfg.fcmServiceAccount}: ${err.message}`);
    return null;
  }
  let accessToken = null;
  let accessExp = 0;

  async function token() {
    if (accessToken && Date.now() < accessExp - 60000) return accessToken;
    const now = Math.floor(Date.now() / 1000);
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
      iss: account.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600,
    })}`;
    const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), account.private_key).toString('base64url');
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${sig}`,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error_description || json.error || res.status);
    accessToken = json.access_token;
    accessExp = Date.now() + json.expires_in * 1000;
    return accessToken;
  }

  async function sendOne(deviceToken, note) {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: deviceToken,
          notification: { title: note.title, body: note.body },
          data: Object.fromEntries(Object.entries(note.data || {}).map(([k, v]) => [k, String(v)])),
          android: { priority: 'high', notification: { channel_id: 'attention' } },
          apns: { payload: { aps: { category: note.category || 'DEFAULT', sound: 'default' } } },
        },
      }),
    });
    if (!res.ok) log(`push failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  return {
    // devices: rows with push_token — fire and forget, never blocks routing.
    send(devices, note) {
      for (const d of devices) {
        if (d.push_token) sendOne(d.push_token, note).catch((err) => log(`push error: ${err.message}`));
      }
    },
  };
}
