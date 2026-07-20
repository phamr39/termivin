<p align="center">
  <img src="assets/termivin-logo.png" width="128" alt="Termivin logo" />
</p>

<h1 align="center">Termivin</h1>

<p align="center">
  Workspace manager for terminals, optimized for AI CLI clients such as <b>Claude Code</b> and <b>Codex</b>.<br/>
  Windows / macOS / Linux · Electron + node-pty + xterm.js (the same terminal stack VS Code uses)
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/termivin"><img src="https://img.shields.io/npm/v/termivin?color=cb3837&logo=npm" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/termivin"><img src="https://img.shields.io/npm/dt/termivin?color=cb3837" alt="npm downloads" /></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue" alt="License: PolyForm Noncommercial 1.0.0" /></a>
  <img src="https://img.shields.io/badge/platform-win%20%7C%20mac%20%7C%20linux-lightgrey" alt="Platforms" />
  <img src="https://img.shields.io/badge/electron-43-9feaf9" alt="Electron 43" />
</p>

## Install

```bash
npm install -g termivin
termivin
```

Requires Node.js ≥ 18. Running `termivin` again focuses the existing window (single-instance). Package page: [npmjs.com/package/termivin](https://www.npmjs.com/package/termivin).

## Features

- **Workspaces** — group terminals into named workspaces (new workspaces get a themed name suggestion — Riverside, Times City, Ocean Park…; new terminals get Termi-style names — TermiFast, TermiUni…). Rename anything by double-clicking its name. Drag a terminal tab onto another workspace in the sidebar to move it; drag onto another tab to reorder.
- **Floating canvas** — each workspace is a free-form canvas: terminals are floating windows you can drag by their title bar, resize from the corner, and stack (click brings to front). The ⛶ button (or double-clicking the title bar) maximizes one terminal fullscreen; ⛶ again returns to the canvas.
- **Attach external windows (Windows)** — two ways:
  - *⧉ Attach window* button: lists running console windows (Windows Terminal, cmd, PowerShell, …; tick "Show all windows" for everything) and embeds the one you pick as a floating pane (Win32 `SetParent`).
  - **Drop-to-attach**: simply drag any window (by its title bar) and release it over the Termivin canvas — a confirmation toast pops up at the drop point ("Attach here"). Implemented with a global `SetWinEventHook(EVENT_SYSTEM_MOVESIZEEND)` hook in the helper process.

  Detaching returns the window safely to the desktop (its original window style is persisted in the app state, so restore works even if the helper process was restarted). Closing the app auto-detaches everything. Output capture/approval detection isn't available for attached windows, and they always render above the app's own panes.
- **Convert external → managed terminal** — when an attached window is gone (app restart, window closed), its entry offers *⇄ Convert to terminal*: confirm whether it was a Claude Code session (runs `claude --continue`) or a plain terminal (opens a shell), at the terminal's remembered working directory. The real cwd of the external shell is captured at attach time (read from the process PEB); the convert dialog also suggests your recent Claude Code project folders (from `~/.claude/projects`). Note: a Windows Terminal window hosting multiple tabs makes the cwd guess ambiguous — double-check the suggested path.
- **Renaming** — workspaces: hover → ✎ pencil, or double-click the name; terminals: double-click the tab name or the pane title-bar name.
- **Session restore** — every terminal remembers its type, working directory, startup command and *restore command* (e.g. `claude --continue` for Claude Code, `codex resume --last` for Codex). After quitting or rebooting, reopen the app and hit **Restore all** — each terminal relaunches with its restore command in its original directory. The last ~40 lines of output are also snapshotted so you can see what each session was doing.
- **Per-workspace dashboard** — toggle to the *Dashboard* view to see every terminal in the workspace as a live card: status (`working` / `idle` / `needs approval` / `exited` / `saved`), a live output preview, and one-click actions.
- **Approval detection** — Termivin watches each terminal's output for permission prompts (Claude Code numbered menus, y/n prompts, "Do you want to…" confirmations). Terminals that are waiting flash orange in the sidebar, tab bar and dashboard, a desktop notification fires, and you can **Approve / Deny directly from the dashboard** without opening the terminal.
- **Any terminal type** — Claude Code, Codex, PowerShell/CMD (Windows), zsh/bash (macOS/Linux), or a custom command.

## Terminal status legend

| Status | Meaning |
| --- | --- |
| `working` (blue, pulsing) | Output produced within the last 3 seconds |
| `idle` (green) | Running, quiet |
| `needs approval` (orange, pulsing) | A permission/confirmation prompt is waiting for input |
| `exited` (red) | Process ended |
| `saved` (gray) | Not running — stored from a previous session, ready to restore |
| `attached` (purple) | An embedded external OS window |

## Run from source

```bash
git clone https://github.com/phamr39/termivin.git
cd termivin
npm install
npm start
```

To get the global `termivin` command from a source checkout, run `npm link` once.

`node-pty` ships prebuilt binaries (Windows x64/arm64, macOS x64/arm64); on Linux it compiles during `npm install` (needs `make`/`g++`/`python3`).

## State

Workspace/terminal layout and output snapshots are stored in the Electron user-data directory (`%APPDATA%/termivin/termivin-state.json` on Windows, `~/Library/Application Support/termivin/` on macOS, `~/.config/termivin/` on Linux). Delete the file to reset.

## Packaging (optional)

To build distributable installers, add [electron-builder](https://www.electron.build/):

```bash
npm i -D electron-builder
npx electron-builder --win   # or --mac / --linux
```

## Notes on approval detection

Detection is heuristic (regex over the terminal tail after ~0.7 s of quiet):

- Numbered menus (`❯ 1. Yes … 2. …`) → Approve sends **Enter**, Deny sends **Esc**
- `(y/n)` / `[Y/n]` prompts → sends `y` / `n`
- Generic "Do you want to…" / "Press enter to continue" → **Enter** / **Esc**

Patterns live in `src/renderer/presets.js` (`detectApproval`) — extend them there if your CLI uses a different prompt style.

## Contributing

Bug reports, feature ideas, and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup, project layout, and how to run the E2E suites. Please also read the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues go to [SECURITY.md](SECURITY.md) — not the public tracker.

## License

Termivin is source-available under the **[PolyForm Noncommercial License 1.0.0](LICENSE.md)**:

- ✅ Free to use, modify, and share for **any noncommercial purpose** — personal use, research, education, charities, public institutions.
- ❌ **Commercial use is not permitted** (using Termivin in/for a for-profit business, or selling products built on it). Contact the author for a commercial license.

Copyright © 2026 phamr39 ([pha.mr3998@gmail.com](mailto:pha.mr3998@gmail.com)).
