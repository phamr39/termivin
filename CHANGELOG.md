# Changelog

All notable changes to Termivin are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

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
