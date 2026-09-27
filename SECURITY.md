# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Email
**pha.mr3998@gmail.com** with a description of the issue, steps to
reproduce, and the impact you believe it has. You will get a response within a
few days.

## Scope notes

Termivin executes shells and embeds OS windows by design, so keep these in mind
when assessing impact:

- Terminals run with the privileges of the user who launched the app — that is
  expected behavior, not a vulnerability.
- The Windows helper (`src/win-embed.ps1`) uses Win32 APIs (`SetParent`,
  `ReadProcessMemory` for cwd detection) on windows/processes of the same user
  session only.
- State (including terminal output snapshots) is stored unencrypted in the
  Electron user-data directory. Do not treat it as a secret store.

Reports about escaping the renderer sandbox, IPC abuse from untrusted content,
or the helper acting on windows it should not touch are very welcome.

### Remote control (relay `server/` + phone app `mobile/`)

The remote feature can type into your terminals from a phone, so a paired
phone with the `input` or `manage` scope is effectively a shell on the PC.
That is the design; the security boundary is the pairing, and these are the
things we treat as vulnerabilities:

- Getting a PC or a phone accepted by a relay without its enrollment code /
  pairing token, or reusing a spent, expired or revoked one.
- A phone doing more than its scopes allow (e.g. typing with only `view`).
- Answering an approval prompt other than the one the phone was shown
  (the PC must check the prompt hash before sending keys).
- An agent on the bus reading another agent's mail or sending as it, or
  getting a non-image file out through `termivin send owner --image`.
- The relay persisting terminal output or chat content (it must not).

Not vulnerabilities, but know them:

- The relay operator (you, self-hosted) can see everything that passes
  through it; there is no end-to-end encryption yet.
- A relay served over plain `http://` exposes tokens to anyone on the path —
  use HTTPS (Caddy profile) or a VPN for anything beyond your LAN.
- Paired phones are listed in Settings → Remote on the PC and can be revoked
  there or with `termivin-relay device revoke`.
