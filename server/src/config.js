// Relay configuration — everything comes from the environment so the same
// image runs anywhere. See .env.example.

import path from 'node:path';

export function loadConfig(env = process.env) {
  const dataDir = path.resolve(env.RELAY_DATA_DIR || './data');
  return {
    port: Number(env.RELAY_PORT || 8787),
    host: env.RELAY_BIND || '0.0.0.0',
    dataDir,
    dbPath: path.join(dataDir, 'relay.db'),
    // Where phones should connect — baked into pairing QR codes.
    publicUrl: (env.RELAY_PUBLIC_URL || '').replace(/\/+$/, ''),
    // Firebase service-account JSON for push (FCM delivers to APNs as well).
    fcmServiceAccount: env.RELAY_FCM_SERVICE_ACCOUNT || '',
    accessTtlMs: 15 * 60 * 1000,
    refreshTtlMs: 90 * 24 * 60 * 60 * 1000,
    pairTtlMs: 5 * 60 * 1000,
    enrollTtlMs: 24 * 60 * 60 * 1000,
    activityRetentionMs: 7 * 24 * 60 * 60 * 1000,
  };
}
