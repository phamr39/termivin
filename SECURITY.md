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
