#!/usr/bin/env node
// Admin CLI — run inside the container:
//   docker compose exec relay termivin-relay host add "Office PC"
// Works directly on the SQLite file; the running relay picks changes up
// (revoked devices are disconnected within a minute).

import { loadConfig } from './config.js';
import { openDb } from './db.js';

const USAGE = `termivin-relay — admin

  host add <name>        register a PC; prints a one-time enrollment code (24 h)
  host reenroll <id>     new enrollment code for an existing PC (lost key / reinstall)
  host list              PCs, with last-seen time
  host remove <id>       delete a PC and every phone grant on it
  device list            paired phones
  device revoke <id>     revoke a phone everywhere
  audit [--host <id>] [--limit N]   recent actions`;

const fmt = (ts) => (ts ? new Date(ts).toISOString().replace('T', ' ').slice(0, 19) : '—');

function main(argv) {
  const [group, cmd, ...rest] = argv;
  if (!group || group === '-h' || group === '--help') {
    console.log(USAGE);
    return 0;
  }
  const cfg = loadConfig();
  const db = openDb(cfg);
  try {
    if (group === 'host' && cmd === 'add') {
      const name = rest.join(' ').trim();
      if (!name) throw new Error('usage: host add <name>');
      const h = db.addHost(name);
      console.log(`Host "${h.name}" created: ${h.id}`);
      console.log(`Enrollment code (valid 24 h, shown once):\n\n  ${h.code}\n`);
      console.log('In Termivin: ⚙ Settings → Remote → paste the relay URL and this code.');
      return 0;
    }
    if (group === 'host' && cmd === 'reenroll') {
      const r = db.reenrollHost(rest[0]);
      if (!r) throw new Error('no such host');
      console.log(`New enrollment code for ${r.id} (valid 24 h):\n\n  ${r.code}\n`);
      return 0;
    }
    if (group === 'host' && cmd === 'list') {
      for (const h of db.listHosts()) {
        const state = h.public_key ? 'enrolled' : 'awaiting enrollment';
        console.log(`${h.id}  ${h.name.padEnd(24)} ${state.padEnd(20)} last seen ${fmt(h.last_seen)}`);
      }
      return 0;
    }
    if (group === 'host' && cmd === 'remove') {
      if (!db.removeHost(rest[0])) throw new Error('no such host');
      console.log('removed');
      return 0;
    }
    if (group === 'device' && cmd === 'list') {
      for (const d of db.listDevices()) {
        const grants = db.grantsForDevice(d.id).map((g) => `${g.name}[${g.scopes.join(',')}]`).join(' ');
        console.log(`${d.id}  ${d.name.padEnd(20)} ${(d.platform || '').padEnd(8)} ${d.revoked_at ? 'REVOKED' : 'active '} last seen ${fmt(d.last_seen)}  ${grants}`);
      }
      return 0;
    }
    if (group === 'device' && cmd === 'revoke') {
      if (!db.revokeDevice(rest[0])) throw new Error('no such active device');
      console.log('revoked');
      return 0;
    }
    if (group === 'audit') {
      const args = [cmd, ...rest].filter(Boolean);
      const opt = (n) => {
        const i = args.indexOf('--' + n);
        return i === -1 ? undefined : args[i + 1];
      };
      const rows = db.listAudit({ hostId: opt('host'), limit: Number(opt('limit') || 50) });
      for (const r of rows.reverse()) {
        const res = r.ok == null ? '' : r.ok ? 'ok' : `FAIL ${r.error || ''}`;
        console.log(`${fmt(r.ts)}  ${(r.device_id || '-').padEnd(14)} ${(r.host_id || '-').padEnd(14)} ${r.op.padEnd(16)} ${res}  ${r.args || ''}`);
      }
      return 0;
    }
    console.error(USAGE);
    return 1;
  } catch (err) {
    console.error('error: ' + err.message);
    return 1;
  } finally {
    db.close();
  }
}

process.exitCode = main(process.argv.slice(2));
