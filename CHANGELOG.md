# Changelog

All notable changes to Termivin are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

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
