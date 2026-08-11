# Agent Bus — design

A local message bus that lets the AI agents running inside one Termivin
workspace discover each other and talk directly, plus (later) a shared
knowledge base.

## Why a server and not just files

Agents are CLI programs. Termivin owns their PTY, not their process — so the
only ways to reach them are: type into the PTY, let them run a shell command,
or read their output. A local HTTP server + a thin CLI covers the second one,
which is the only structured channel that works with *every* agent (they all
have a shell tool).

A broker like MQTT was rejected for transport: Windows has no `mosquitto_pub`,
so every agent would need a client installed. `curl` is everywhere.

## The constraint that shapes everything

**Agents have no event loop.** They only exist during a turn. `subscribe` with
a callback is impossible.

So we keep MQTT's *semantics* and drop its *transport*:

| MQTT | Here |
| --- | --- |
| `publish` | `POST /publish` — one command, done |
| `subscribe` (callback) | impossible |
| → replaced by | `GET /recv?wait=N` long-poll (blocks inside the agent's shell tool) |
| retained message | presence entries in the registry |
| last will | Termivin sees `pty:exit` and marks the agent offline |

## Layout

```
main process (src/main.js)
  └── src/agent-bus.js — http.createServer() on 127.0.0.1:<ephemeral>
        ├── in-memory: registry, per-agent pending queues, long-poll waiters
        └── on disk:   <userData>/bus/<workspaceId>.jsonl  (append-only)

agent ──`termivin` CLI (bin/termivin.js)──▶ HTTP ──▶ bus
renderer ──IPC──▶ roster sync (who is alive, and what status)
```

Split of responsibility:

- **server** — presence, routing, live delivery. Ephemeral by nature.
- **disk** — the message log. Survives restarts; unread messages are replayed
  into the pending queues on startup.

## Scope

**Per workspace.** A terminal only sees agents in the same workspace, matching
how people actually group work. The workspace is resolved from the live roster
the renderer pushes (not from a captured env var), so moving a terminal between
workspaces moves its bus membership too.

## Discovery and auth

The server writes `<userData>/bus.json` (url + token + pid) on start, and
`pty:create` injects into every spawned terminal:

```
TERMIVIN_URL    http://127.0.0.1:<port>
TERMIVIN_TOKEN  bearer token, regenerated on every app start
TERMIVIN_AGENT  the terminal id — this *is* the agent id
TERMIVIN_SPACE  workspace id
TERMIVIN_NAME   terminal name (TermiFast, …)
```

An agent therefore needs no configuration: the env is already there,
`termivin register` just attaches a role description.

**Security.** This server can make agents act, so it is treated as a real
attack surface:

- binds `127.0.0.1` only, never `0.0.0.0`
- requires `Authorization: Bearer <token>`; the token is random per app start
- **rejects any request carrying an `Origin` header** — otherwise a random web
  page could drive your agents via DNS rebinding
- rate limits each agent (20 messages/minute)

## API

| Endpoint | Caller | Notes |
| --- | --- | --- |
| `POST /register` | agent | `{role, skills}` — identity comes from the env |
| `GET /agents` | agent | peers in the same workspace, with live status |
| `POST /publish` | agent | `{to, kind, subject, body, corr}`; `to` may be `@all` |
| `GET /recv?wait=N` | agent | long-poll, max 60s, drains the pending queue |
| `GET /health` | anyone | liveness |

`kind` is one of `note` (fire and forget), `ask` / `reply` (paired by `corr`),
`claim` (I am taking this file/task).

## Known failure modes and the guards

**Long-poll stalls the agent.** A blocking `recv` means the agent does nothing
else, and two agents waiting on each other deadlock silently. Claude Code also
kills bash calls at ~2 minutes.
→ `wait` is capped at 60s server-side; `ask` is async by default.

**The agent never calls `recv`.** The most likely failure in practice — it is
busy and forgets the bus exists.
→ three mitigations: the connect prompt tells it to poll at task boundaries;
Termivin nudges the PTY when mail arrives (phase 2); the tab shows a badge.

**Message storms.** Three polite agents greeting each other will burn a lot of
tokens.
→ `ttl` decrements per hop, `@all` must not be auto-replied to, and the server
rate-limits and logs drops.

**Typing into a terminal that is waiting for approval.** `approvalKeys()` maps
Enter to *Yes* — injecting text while a permission prompt is up would approve
whatever it is asking about.
→ every PTY injection (including the connect button) is gated on
`getStatus() === 'idle'` with no pending approval.

## Testing

```bash
npm run test:bus          # server + CLI, headless, no Electron needed
npm run start:dev         # isolated instance (own user-data-dir, port 9223)
npm run test:bus-ui       # then drive that instance over CDP
```

`start:dev` uses its own `--user-data-dir`, and Electron scopes the
single-instance lock to that directory — so it runs alongside a Termivin you
already have open, without touching its state.

## Roadmap

| Phase | Contents | Status |
| --- | --- | --- |
| 1 | server, token, env injection, `register`/`who`/`send`/`recv`, connect button | done |
| 2 | PTY nudge on delivery, 📬 badge on tab and dock chip | next |
| 3 | shared KB (`/kb`, `kb/entries/*.md` + `INDEX.md`, atomic writes) | |
| 4 | Bus timeline in the dashboard, `claim` locks | |
| 5 | MCP façade over the same server | |
