# Remote — self-hosted relay + mobile app

Manage the terminals of one or more PCs from a phone, through a relay you host
yourself. The PC still does all the work: PTYs, Claude Code, Codex all run
there. The relay only authenticates and forwards; the phone is a **control
tower** (triage approvals, nudge agents, manage terminal lifecycles), not a
terminal emulator first.

## Quick start

1. **Relay** (any machine with Docker — see [`server/README.md`](../server/README.md)):
   `cd server && docker compose up -d`, then
   `docker compose exec relay termivin-relay host add "My PC"` → enrollment code.
2. **PC**: Termivin → ⚙ Settings → **Remote** → relay URL + code → *Connect
   this PC* → *Show pairing code*.
3. **Phone**: install the app ([`mobile/README.md`](../mobile/README.md)) →
   scan the QR (or paste the code).

Keep the PC awake with Termivin open: the phone manages it, the PC runs it.

> [!WARNING]
> **Plain HTTP by default.** `docker compose up -d` serves the relay as
> `http://` on port 8787 on **all** interfaces. Tokens and terminal output then
> cross the network unencrypted — fine on a home LAN or inside a VPN
> (Tailscale/WireGuard), **not** on the internet. For anything reachable from
> outside use the `tls` profile (HTTPS via Caddy) and set
> `RELAY_HTTP_PORT=127.0.0.1:8787`, or firewall port 8787.

> [!WARNING]
> **A paired phone gets full control by default.** Pairing grants all four
> scopes — `view`, `approve`, `input` (type anything into a terminal) and
> `manage` (start/stop terminals, capture the screen). A phone with `input`
> is effectively a shell on your PC: lock the phone, pair only devices you own,
> and revoke a lost one right away (Termivin → Settings → Remote → *Revoke*, or
> `docker compose exec relay termivin-relay device revoke <id>`).

## Topology

```
PC (Termivin desktop)                 Private server (docker compose)          Phone (Flutter, iOS + Android)
 session hub (PTY, approvals)          caddy (TLS)                              Inbox / Workspaces / Activity / System
 src/remote/host-link.js ──WSS──▶      termivin-relay (Node) ◀──WSS──           
   outbound only, no open port          ├ auth: host keys, device tokens
                                        ├ routing host ↔ devices, fan-out
                                        ├ cache: last snapshot + attention
                                        ├ activity + audit (SQLite)
                                        └ push (FCM → APNs/Android)
```

Both the PC and the phone dial **out** to the relay — the same model as Claude
Code Remote Control (outbound HTTPS only, relay routes a streaming connection,
QR pairing, short-lived scoped credentials) — except the relay is yours and it
never writes terminal output to disk.

| Piece | Does | Never does |
| --- | --- | --- |
| PC (host) | runs terminals, detects approvals, serializes screens, executes commands | opens an inbound port |
| Relay | auth, pairing, routing, caches last-known state for offline PCs, audit, push | executes anything, stores PTY output |
| Phone | UI, QR scan, push, live view, quick replies | detects approvals itself |

## Credentials

- **Host enrollment.** `termivin-relay host add <name>` prints a one-time
  enrollment code (24 h). The desktop generates an Ed25519 key pair and posts
  `{code, name, publicKey}` to `POST /api/hosts/enroll`. From then on the host
  proves itself by signing a per-connection nonce — no shared secret stored on
  the relay.
- **Device pairing.** The authenticated host asks the relay for a pairing token
  (`pair.create`, 5 min, single use, carries the scopes). The desktop shows it
  as a QR: `{"v":1,"url":"https://relay.example.com","token":"…"}`. The phone
  posts it to `POST /api/devices/pair` and receives a **refresh token**
  (stored in the keychain, 90 days, rotated on every use) plus an
  **access token** (15 min). A device paired to several hosts holds one
  refresh token and a grant per host.
- **Scopes per (device, host)**: `view` · `approve` · `input` · `manage`.
  `input` = free typing; `manage` = create / stop / restart / move terminals.
- **Revocation** from the desktop or the relay CLI closes the device's socket
  immediately.

## Wire protocol (v1)

One WebSocket per party: `/ws/host` and `/ws/device`. The first text frame
must be the auth frame; nothing else is accepted before it. Control messages
are JSON text frames with a `t` field. PTY output is binary frames.

### Host ⇄ relay

```
relay→host  {t:"challenge", nonce}
host→relay  {t:"auth", hostId, sig}                 sig = Ed25519(nonce), base64
relay→host  {t:"ready", hostId, name}

host→relay  {t:"snapshot", data}                    full state, replaces the cache
host→relay  {t:"event", kind, data}                 status|approval|summary|bus|stats|activity
host→relay  {t:"attention", items:[Attention]}      full list, replaces the cache
host→relay  {t:"cmd.result", id, ok, data?, error?}
host→relay  {t:"pair.create", scopes, deviceHint?}  → relay→host {t:"pair.created", token, expiresAt}
host→relay  {t:"devices.list"} / {t:"devices.revoke", deviceId}

relay→host  {t:"cmd", id, deviceId, op, args}
relay→host  {t:"sub", termId, lastSeq} / {t:"unsub", termId}
```

### Device ⇄ relay

```
device→relay {t:"auth", token}                      access token
relay→device {t:"ready", deviceId, hosts:[{hostId, name, online, lastSeen, scopes}]}
relay→device {t:"snapshot", hostId, data, stale}    cached; stale=true when the host is offline
relay→device {t:"attention", hostId, items}
relay→device {t:"event", hostId, kind, data}
relay→device {t:"host", hostId, online, lastSeen}

device→relay {t:"cmd", id, hostId, op, args}        id = idempotency key (uuid)
relay→device {t:"cmd.result", id, ok, data?, error?}
device→relay {t:"sub", hostId, termId, lastSeq?} / {t:"unsub", hostId, termId}
device→relay {t:"push.register", token, platform}
```

Commands are **rejected, never queued**, when the host is offline
(`error:"host_offline"`): a stop or an approval executed hours later is worse
than a failure. A repeated `id` returns the first result (dedupe window 10 min).

### Binary frames (PTY output)

```
host→relay:   u8 termIdLen | termId utf8 | u32be seq | bytes
relay→device: u8 hostIdLen | hostId utf8 | u8 termIdLen | termId utf8 | u32be seq | bytes
```

The relay forwards a host's `sub` only on the first subscriber of a terminal
and `unsub` when the last one leaves; the host streams only subscribed
terminals. On `sub` the host first sends the serialized screen (an event
`{kind:"screen", termId, seq, data}`) — or, if `lastSeq` is still inside its
ring buffer, only the missing bytes. The phone never resizes the PTY.

### Operations (`cmd.op`)

| op | scope | args |
| --- | --- | --- |
| `approval.answer` | approve | `{approvalId, screenHash, option}` |
| `bus.push` | approve | `{termId}` — types `termivin recv --wait 60` |
| `bus.send` | approve | `{to, body, kind}` — sender shows as *Owner (📱)* |
| `term.keys` | approve | `{termId, keys}` — quick replies only: `1`–`9`, `enter`, `esc`, `shift+tab`, `ctrl+c` |
| `term.input` | input | `{termId, data}` |
| `term.restore` / `term.stop` / `term.restart` | manage | `{termId}` |
| `term.create` / `term.clone` | manage | preset, cwd, permission mode… |
| `term.rename` / `term.move` / `term.mode` | manage | … |

**`approval.answer` must match the prompt that is on screen.** Every approval
carries `screenHash` (hash of the prompt region when it was detected). Before
sending keys the host recomputes it; if the prompt changed it answers
`error:"prompt_changed"` and sends nothing. Otherwise a late tap could approve
a different command.

### Prompt kinds

Detection lives in `src/shared/approval.js` (used by both the desktop UI and
the main-process hub):

| kind | looks like | answering option N |
| --- | --- | --- |
| `menu` | `❯ 1. Yes` / `2. …` — numbered, with a selection marker, at the end of the buffer | types `N` |
| `select` | `❯ No, exit` / `Yes, I trust this folder` + "Enter to confirm" — unnumbered arrow list (Claude's folder-trust dialog) | ↑/↓ from the marked row, then Enter |
| `yn` | ends in `[y/N]`, `(yes/no)` | `y⏎` / `n⏎` |
| `enter` | "Do you want to…?", "Press enter to continue" | Enter / Esc |

A numbered list without a marker (a plan in an agent's answer) is not a prompt.

### Attention (the phone's inbox)

```
{ id, hostId, kind: "approval"|"ask"|"exited"|"host_offline",
  termId?, spaceId?, title, excerpt, options?, screenHash?, since }
```

## Mobile UX

Five tabs: **Inbox** (approvals, unanswered asks, abnormal exits, offline
PCs) · **Chat** (below) · **Workspaces** (PC → workspace → terminal cards sorted by urgency) ·
**Activity** (bus traffic + actions timeline) · **System** (PCs, paired
devices, audit, notifications).

Terminal detail is a bottom sheet with *Live* (read-only screen, pinch-zoom,
quick-reply row, ⌨ only with `input` + biometrics), *Info* and *Bus*.

Error guards: stale-prompt check above; idempotent commands; hold-to-confirm
or biometrics for stop / free input; every action is disabled with a
"data from 14:32" banner while the host is offline; everything lands in the
audit log.

## Chat view — terminals as characters

A fifth tab, **Chat**, presents the same workspaces as a messenger:

| Chat concept | Termivin concept |
| --- | --- |
| Group chat | a workspace — the owner plus every terminal in it |
| Channel | a bus topic (`#deploys`) |
| Character (avatar, name, status dot) | a terminal — its Termi-name, type colour/icon, live status |
| Direct message | owner ⇄ one terminal |

**Owner is a bus participant.** The human gets a reserved bus identity,
`owner`. Agents reply with `termivin send owner "…"`; the owner's messages
arrive in agents' `recv` like any other peer's, marked `from: Owner`.

**What a message to a terminal does** — the composer offers two delivery
modes, defaulting per terminal type:

- *Prompt* (default for Claude Code / Codex): the text is typed into the
  agent's prompt and submitted — only when the terminal is `idle` with no
  approval pending (the same gate the agent-bus connect button uses); if it is
  busy the message is queued on the host and delivered at the next idle, shown
  as "chờ gửi" in the bubble.
- *Bus* : delivered to the agent's bus inbox (`recv`), no typing — for agents
  already registered on the bus that should pick it up at a task boundary.

Shell terminals get no prompt mode: their DM shows command output snippets
and quick commands instead.

**What an agent "says"** — bubbles come from three sources, merged by time:

1. **One summary per turn of work** (src/remote/turns.js). While an agent
   works the phone sees a single live progress line ("TermiPearl is working
   · 4 steps · ▶ npm test", not stored); when the turn ends one message lands
   in the DM: the agent's final reply as a headline (full reply on tap), what
   it did (edits / commands / reads, duration) and the step list, collapsed.
   Claude Code: turns come from its transcript — a typed prompt opens one,
   system/turn_duration closes it (end_turn + quiet as a fallback); the
   terminal is bound to the newest session file in its folder written after
   it started. Other terminals (Codex, custom agents, shells): a prompt sent
   from the phone opens a turn, the terminal going idle closes it, and the
   summary is what it printed after the prompt, read from the rendered screen.
2. Images: `termivin send owner --image FILE "caption"` (checked by content, downsized, kept under <userData>/remote/media, fetched by the phone with `media.get` in 384 KB chunks) and 📎 → *Screenshot of the PC screen* (`screen.capture`, manage scope).
3. Bus messages addressed to `owner`, `@all` or the group's topics.
3. System cards: approval requests (inline Approve / Deny with the options
   read from screen), exits, restores — the same objects as the Inbox.

The group chat interleaves agent ↔ agent bus traffic (dimmed, collapsible) so
the owner can follow the conversation between characters and step in.

Protocol additions: `event kind:"chat"` `{chatId, msg}` pushed live;
`cmd op:"chat.send"` `{chatId, text, mode}` (scope `input` for prompt mode,
`approve` for bus mode); `cmd op:"chat.history"` `{chatId, before, limit}` —
answered by the host from transcripts + bus logs, so the relay never stores
conversation content.

## Deploying the relay

See [`server/README.md`](../server/README.md).
