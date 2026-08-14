# Changelog

All notable changes to Termivin are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

## [0.3.0] — 2026-08-15

### Added

- **Home overview** (⌂ in the sidebar) — one screen for the whole app: live counts per workspace, CPU/RAM of every terminal's process tree (the shell *and* everything it spawned), Claude/Codex token usage for today read from the CLIs' own transcripts, and a cross-workspace communication map. Click any terminal to **peek**: its live pane opens in an overlay you can type into, without switching workspaces or touching any layout.
- **Workspace dashboard, rebuilt as a communication map.** The old card grid duplicated what the canvas already shows, so the dashboard now answers the question the canvas can't: how are the agents talking? Terminals are chips (status LED, role, unread-mail badge), topics are bus bars, and bus traffic flows as glowing traces with live signal pulses — cross-workspace traffic appears as a chip for the other workspace. A side panel manages the bus: running/idle/approval counts with quick ✓/✗ approval actions, per-terminal CPU/RAM, topic management (create, delete, choose the representative), today's token usage for the workspace's folders, and a live activity feed.
- **Topics — workspaces can talk to each other.** A topic belongs to one workspace and has a *representative* agent. Inside its workspace, a message to `#topic` is a broadcast every agent hears; from any other workspace it reaches only the representative, so one terminal speaks for the workspace to the outside. Create topics from the dashboard or with `termivin topic <name> [--rep <agent>]`; list with `termivin topics`; send with `termivin send "#topic" "..."`. Topics persist across restarts; a dead representative falls back to a live registered agent.
- **Dock groups.** Right-click a minimized terminal's chip to group it with others under a named, collapsible header (worst member status shows on the header LED). Rename, restore-all and ungroup live on the header's right-click menu. Groups and collapsed state persist.
- **Stop process** action in the pane ⋯ menu — stop what's running without removing the terminal.
- App version in the bottom-left corner of the sidebar.

### Fixed

- **Right-click paste inserted the text twice in Claude Code (Windows).** Claude Code turns on mouse tracking and pastes the clipboard itself when it receives the right-click report — and Termivin's right-click handler pasted on top of that. When the app in the terminal captures the mouse, Termivin now defers to it (same convention as Windows Terminal); plain shells keep Termivin's right-click paste.
- **Taskbar showed the generic Electron icon.** Windows resolves a taskbar button's icon through the window's AppUserModelID and an installed shortcut carrying the same ID — neither existed for dev/CLI runs. The window now declares its app details, and a Start Menu shortcut ("Termivin") with the matching AppUserModelID and icon is created on first run, which also makes pinning work properly.
- The agent-bus connect prompt ended with a backtick-escaped parenthesis, which left PowerShell terminals sitting in a `>>` continuation prompt.

### Testing

- New headless suite `test/topics.mjs` (28 checks: topic CRUD, in-workspace broadcast vs representative-only external delivery, fallback, persistence, stats, CLI).
- New E2E suites: `test/dashboards.mjs` (map, topics panel, feeds, tokens, peek overlay), `test/dock-groups.mjs`, and `test/paste.mjs` (right-click paste against a real `claude` session).
- `test/smoke.mjs` and `test/clone.mjs` updated for the new dashboard; `test/restore.mjs` updated for the auto-restore flow (the banner it tested was removed in 0.1.x); every suite now accepts a debug-port argument and the pane-overlap flake in `test/resize.mjs` is fixed.

## [0.2.0] — 2026-08-11

### Added

- **Agent bus** — AI agents running in the same workspace can now find each other and talk directly. A loopback HTTP server starts with the app and injects credentials into every terminal it spawns, so an agent needs no configuration: `termivin register`, `termivin who`, `termivin send`, `termivin recv`. Messages persist to an append-only log per workspace and unread ones survive a restart. The 🔗 button on an agent's pane types a ready-made connect prompt (only when the terminal is idle — typing at a permission prompt would approve it). Scoped per workspace, bound to `127.0.0.1`, bearer-token authenticated, and requests carrying an `Origin` header are refused so a web page cannot drive your agents. See `docs/AGENT-BUS.md`.
- **Pane ⋯ menu** — Rename, Refresh view, Clear scrollback, Open folder, Open in VS Code.
- **Refresh view / Clear scrollback** — recover a terminal that has gone sluggish or is drawing garbage after a long session, without killing the process.
- **Open folder / Open in VS Code** — open a terminal's working directory in the file manager or in VS Code (needs the `code` command on PATH; says so plainly when it is missing).

### Fixed

- **Copy from a terminal.** `Ctrl+C` always sent SIGINT, even with text selected, so the clipboard never changed. It now copies when there is a selection and interrupts when there is not, matching Windows Terminal. Added `Ctrl+Shift+C` / `Ctrl+Shift+V` and right-click copy/paste.
- **Renaming a terminal.** The inline editor could not be clicked into: the pane bar's `mousedown` handler called `preventDefault()` (killing the caret and starting a pane drag) and tabs are `draggable`, which swallowed text selection. Both are now neutralised while the editor is open.
- **Browse… ignored the folder you typed.** The folder picker opened at the OS default (usually Downloads) instead of the path already in the field — most visible when cloning a terminal. The typed path is now passed through as the dialog's starting folder.

### Testing

- New `test/features.mjs` covers the ⋯ menu, both rename paths, refresh/clear, folder actions and the full clipboard matrix — including one keystroke driven through the OS input queue, since CDP keys bypass the Win32 accelerator table.
- `test/rename.mjs` used `page.fill()`, which writes the input value straight through CDP and never clicks. That is why a rename box nobody could type into still passed; it now clicks and types like a person.
- `test/smoke.mjs` and `test/clone.mjs` accept a debug port argument, so suites can run against an isolated dev instance (`npm run start:dev`) instead of your real app.

## [0.1.1] — 2026-07-24

### Fixed

- The global `termivin` command works on Windows, and gained a standard CLI (`--help`, `--version`).
- macOS: `node-pty` spawns correctly (the `spawn-helper` executable bit is restored on install), terminals can be adopted, the Dock icon shows Termivin's logo, and packaging works.

## [0.1.0] — 2026-07-21

First public release.

### Added

- Workspaces with a floating terminal canvas: drag panes by the title bar, resize, stack, fullscreen one terminal (⛶ / double-click).
- Terminal types: Claude Code, Codex, PowerShell/CMD, zsh/bash, custom command — with themed name suggestions (workspaces: Riverside, Times City…; terminals: TermiFast, TermiUni…).
- Session restore: terminals remember type, working directory, and restore command (`claude --continue`, `codex resume --last`); the active workspace auto-restores on startup, other workspaces on first visit; last ~40 output lines are replayed into scrollback.
- Per-workspace dashboard with live status (`working` / `idle` / `needs approval` / `exited` / `saved` / `attached`), output previews, and one-click actions.
- Approval detection for AI CLI permission prompts (Claude Code menus, y/n prompts) with Approve/Deny from the dashboard and desktop notifications.
- External window embedding (Windows): attach via picker or one-shot drag-onto-canvas, safe detach with persisted window styles, auto re-adopt after UI reloads, and automatic conversion of lost external terminals into managed ones at their captured working directory (Claude sessions resume via `claude --continue`).
- Global `termivin` command (npm link) with single-instance focus behavior.
- E2E test suites driving the real app over CDP (smoke, restore, external, rename).
