# termivin-relay

The self-hosted relay between Termivin desktops and the Termivin phone app.
Your PC keeps doing all the work; the relay authenticates, routes and keeps
just enough state for the phone to show something while the PC is offline.
It never runs anything and never writes terminal output to disk.
Design and wire protocol: [`docs/REMOTE.md`](../docs/REMOTE.md).

```
PC (Termivin) ──WSS out──▶  relay (this)  ◀──WSS──  phone (Termivin app)
```

## 1. Run it

Needs Docker (Compose v2). From this folder:

```bash
cp .env.example .env        # optional — see "Configuration"
docker compose up -d        # builds the image, starts on :8787
curl http://localhost:8787/healthz
# {"ok":true,"hostsOnline":0,"devicesOnline":0}
```

Data (SQLite: PCs, phones, grants, audit) lives in the `termivin_relay-data`
Docker volume — the only state. See *Backup and upgrades*.

### Where phones reach it

| Setup | `.env` | PC uses | Phone uses |
| --- | --- | --- | --- |
| Same PC (testing) | — | `http://localhost:8787` | Android emulator: `http://10.0.2.2:8787` |
| LAN / home server | `RELAY_PUBLIC_URL=http://192.168.1.20:8787` | `http://192.168.1.20:8787` | same |
| VPN (Tailscale/WireGuard) — **recommended for personal use** | `RELAY_PUBLIC_URL=http://relay.tailnet-name.ts.net:8787` | VPN address | VPN address |
| Public domain | `RELAY_DOMAIN=relay.example.com`, `RELAY_PUBLIC_URL=https://relay.example.com` then `docker compose --profile tls up -d` | `https://relay.example.com` | same |

With `--profile tls`, Caddy gets a Let's Encrypt certificate automatically
(ports 80 and 443 must reach the server; point the domain's DNS at it). Also
set `RELAY_HTTP_PORT=127.0.0.1:8787` so the plain-HTTP port is only reachable
from the server itself and everything outside goes through HTTPS.
Anything reachable from the internet should use HTTPS — the phone app allows
plain `http://` only because LAN/VPN relays commonly are.

`RELAY_PUBLIC_URL` is what pairing codes carry. If it is empty, the desktop
puts in the URL it uses itself; the phone's pairing screen lets you correct
the address either way.

## 2. Connect a PC

```bash
docker compose exec relay termivin-relay host add "Office PC"
# Host "Office PC" created: h_…
# Enrollment code (valid 24 h, shown once):
#   Zq8…
```

In Termivin on that PC: **⚙ Settings → Remote** → relay URL + the code →
**Connect this PC**. The PC generates a key pair; from then on it proves who
it is by signing a challenge — no password is stored anywhere. The status
turns green: *Online — phones can reach this PC*.

The PC only ever connects **out**; no port is opened on it.

## 3. Pair a phone

Same Settings pane → **Show pairing code** → scan the QR with the app (or
copy the `termivin://pair?...` text into it). Codes are single use and expire
after 5 minutes. A phone can be paired with several PCs (System → Add another PC).

## Admin CLI

```bash
docker compose exec relay termivin-relay host add <name>       # new PC → enrollment code
docker compose exec relay termivin-relay host reenroll <id>     # lost/stolen key or reinstalled PC — the old key stops working
docker compose exec relay termivin-relay host list
docker compose exec relay termivin-relay host remove <id>
docker compose exec relay termivin-relay device list
docker compose exec relay termivin-relay device revoke <id>     # disconnected within a minute
docker compose exec relay termivin-relay audit --limit 50
docker compose exec relay termivin-relay backup
```

Phones can also be revoked from the desktop (Settings → Remote) or from
another phone with the `manage` scope (System tab).

## Backup and upgrades

```bash
docker compose exec relay termivin-relay backup          # consistent copy inside the volume
docker compose cp relay:/data/backup-<date>.db .         # take it off the server

git pull && docker compose up -d --build                  # upgrade; the volume is kept
```

Restore: stop the relay, put the backup in the volume as `/data/relay.db`
(remove any `relay.db-wal` / `relay.db-shm` first), start it again.

**Coming from an older checkout that used `./data`:** before the first
`docker compose up` with this version, copy the database into the volume:

```bash
docker compose create relay
docker compose cp data/relay.db relay:/data/relay.db
docker run --rm -v termivin_relay-data:/data alpine chown -R 1000:1000 /data
docker compose up -d
```

## Configuration (`.env`)

| Variable | Default | |
| --- | --- | --- |
| `RELAY_PUBLIC_URL` | — | Address phones use; baked into pairing codes |
| `RELAY_HTTP_PORT` | `8787` | Host port for plain HTTP |
| `RELAY_DOMAIN` | — | Domain for the Caddy/TLS profile |
| `RELAY_FCM_SERVICE_ACCOUNT` | — | Path (inside the container, e.g. `/data/firebase.json`) to a Firebase service-account JSON — enables push notifications for approvals, crashes and agent messages. FCM reaches iOS through the APNs key you upload in the Firebase console. Without it, the app still gets everything while it is open. |

## Security model

- **PCs**: Ed25519 key per PC, challenge-signed on every connection.
- **Phones**: refresh token (90 days, rotated on every use with a 60 s grace
  for a response lost on a flaky network, stored in the phone's
  keychain/keystore) → access token (15 min). Only hashes are stored.
- **Scopes per phone and PC**: `view`, `approve` (answer prompts, quick keys,
  nudge), `input` (free typing, chat prompts), `manage` (start/stop/restart,
  create, rename, permission mode, revoke phones). Pairing grants all four by
  default.
- **Approvals are verified on the PC**: the phone sends the hash of the
  prompt it showed; the PC types the answer only if that exact prompt is still
  on screen.
- **Nothing is queued**: commands for an offline PC fail immediately.
- Every command is in the audit log (free text input is logged as a length only).
- Rate limits: 30 API calls/min per IP, ~20 commands/s per phone socket.

## Development

```bash
npm install
npm test          # relay tests (node:test)
npm start         # RELAY_DATA_DIR=./data, port 8787
```

The desktop ⇄ relay ⇄ phone integration test lives in the main repo:
`npm run test:remote` (from the repository root).
