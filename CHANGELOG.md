# Changelog

All notable changes to Termivin are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

## [0.4.0] — 2026-09-01

The workspace dashboard learns to surface who is waiting on whom, the agent bus stops silently dropping mail after long sessions, and the app picks up nine new themes including its first two light modes.

### Added

- **"Awaiting reply" panel on the workspace dashboard.** Every ask (a message sent with `--ask`) is tracked server-side and appears in a new panel until any reply tagged with the matching `corr` comes through — with the sender, recipient, subject and how long it has been waiting. Agents that have unread bus mail sitting in their queue but no explicit ask show up in the same panel. Each row carries a 📬 **Push** button that types `termivin recv --wait 60` into the target agent's pane (unsubmitted, same idle-and-no-approval guard as the 🔗 connect button) so you can nudge a forgetful agent without leaving the dashboard. Outstanding asks survive an app restart — they are rebuilt from the message log on startup so the panel is never empty just because you closed the window.
- **Agent management inside the Terminals card.** A workspace grows to a dozen agents fast — the compact per-terminal list stops being enough. The Terminals card now carries a search box (matches both name and role), a row of status chips (All / Working / Idle / Approval / Off bus / Exited / Saved), and a per-row `⋯` menu with the same actions the pane's own `⋯` menu offers plus the dashboard-native ones — **Open in canvas, Rename, Push, Connect, Restart, Stop, Open folder, Remove**. Below the list a bulk-action strip surfaces the common one-clicks: **⚡ Restore all saved**, **📬 Push all with unread mail**, **🔗 Connect all off-bus**. Every bulk button is behind a confirm dialog, and the button only appears when its target set is non-empty. The count next to the card title shows "N of M" when a filter is active.
- **Nine new themes** — the ⚙ picker gains: **Bubblegum** (hot pink over deep magenta), **Sakura** (soft baby-pink pastel over warm plum), **Cotton Candy** (Termivin's first light theme — powder pink and baby-blue), **Latte** (the second light theme — warm cream with muted mauve accents, quieter than Cotton Candy), **Nord** (arctic frost, muted Scandi blue), **Dracula** (purple/pink/cyan cult classic), **Gruvbox** (warm retro brown and burnt orange), **Tokyo Night** (deep navy with neon violet accents), **Sunset** (coral over dusk violet), and **Rose Pine** (muted mauve and dusty rose). Each ships a full map palette and matching xterm colors; light themes flip halos and count text so labels stay readable against pale backgrounds.

### Fixed

- **The agent bus no longer loses messages after a long session.** The failure was tiny and easy to miss: `deliver()` wrote the "message read" record to the log *before* the HTTP response had actually flushed to the wire. Anything that could tear the connection down mid-write — Claude Code's 2-minute kill on a `bash` call, a socket the OS reclaimed while the poll was idle, an app quit during a hand-off — left the message marked delivered on disk while the agent never saw it, and every subsequent send behaved as if the earlier one had been read. `drain` splits into `peekQueue` + `confirmDelivered` + `returnUndelivered`, a `sendMessages()` helper only commits deliveries once `res.writableFinished` is true, and anything that fails to flush goes back on the queue for the next `recv`. The immediate `/recv` path and the long-poll path both use it.
- **The workspace dashboard's communication map stops reading as spaghetti.**
  - The map used to draw a dashed "listen" line from every agent to every topic — with 10 agents and one topic, 10 lines converged on the same hub before any real traffic was even drawn. Those lines are gone: topic membership is what the central hub itself signals. In their place there is one subtle solid line from the representative to its hub, so who speaks for a topic is visible without having to squint at the sub-text.
  - "On the bus" and "not on the bus" chips now really look different. The old 0.6-opacity dim was invisible next to a live chip on a dark background; an off-bus chip now has a dashed neutral-grey outline, a body filled in the panel color, muted pins and greyed text — plus an *off the bus* caption and a tooltip line telling you to press 🔗 to connect.
  - Chip name truncation reserves room for the mail badge, so "GlobalMonitor" is no longer rendered as "GlobalMonito…" underneath the "3" badge. Sub-line truncation follows the chip width too.
  - The ring layout forces enough radius to clear the central bus bar when a topic is present, and rotates the seed angle a half-slot, so horizontal-midline chips no longer collide with the hub at 3 and 9 o'clock.

- **The Settings modal fits on screen again.** `.modal` had no height limit, which was invisible while the theme picker held five cards. Fifteen cards make the list 893 px tall and the modal 1070 px — taller than the window — so it centred itself with the *Settings* title above the top edge and *Close* and *Rose Pine* below the bottom one, and nothing scrolled to reach either. The modal is now capped at `calc(100vh - 40px)` and the theme list scrolls inside it, so the title and the Close button stay pinned. This affected every platform; it only showed up where the window was shorter than the modal.
- **The two light themes no longer print white text on cream.** Five rules hardcoded `color: #fff` instead of a token, so when the background flipped light the label stayed white: the active workspace, the active tab and the active Canvas/Dashboard segment all landed at **1.05–1.21:1** contrast (WCAG asks 4.5:1; the dark themes measure 17–18:1), which is to say the thing you had selected was the one thing you could not read. Two new tokens — `--text-strong` for emphasis text on a themed surface and `--on-accent` for text on an accent-filled button — default to white and are overridden by Cotton Candy and Latte; those five rules now use them. Cotton Candy's and Latte's `--green`, `--red` and `--orange` were also too pale to carry a white button label (Approve sat at 2.23:1) and have been darkened. Every affected pair now measures 4.5:1 or better.
- **The theme E2E suite counts the registry instead of a literal.** `test/themes.mjs` asserted "picker lists 5 themes" and so failed the moment 0.4.0 added nine; it now compares the rendered cards against `THEMES` in the renderer's own module and checks every id is present, which cannot go stale the next time a theme is added.

## [0.3.3] — 2026-08-18

Two bugs where code written on Windows met a Mac: one silently ran shell commands, the other could not find an editor that was plainly installed.

### Fixed

- **The agent-bus connect prompt is no longer executed by the shell.** The 🔗 button typed its prompt into the pane and pressed Enter for you — but the pane under it may well be a shell: a `custom` terminal with no command is one, and so is any agent that has exited. zsh, the default shell on macOS, reads the prompt's markdown backticks as command substitution, so clicking 🔗 silently ran `termivin who`, `termivin topics` and — twice — `termivin recv`, which blocks for 60s and drains the agent's mailbox. bash and sh aborted on the prompt's parentheses instead, and PowerShell had its own variant of this in 0.3.0. The button now types without submitting, so nothing runs until you press Enter, and the prompt is written free of shell metacharacters so that pressing it in the wrong pane is a plain "command not found" rather than a hidden command.
- **macOS: "Open in VS Code" works without installing the `code` shim.** The menu item resolved the editor with `which code`, which asks the main process's own PATH — and a GUI app launched from the Dock inherits launchd's bare PATH, so even an installed shim in `/usr/local/bin` was invisible. Those directories are now searched explicitly, and when there is no shim at all Termivin asks macOS to open the folder in VS Code, which works even for a copy that never made it to `/Applications`.

## [0.3.2] — 2026-08-18

### Added

- **Permission mode for Claude Code terminals.** The new-terminal dialog gained a *Permission mode* dropdown — auto, accept-edits, plan, or the default ask-every-time — which writes `--permission-mode` into both the startup and the restore command. `Shift+Tab` already cycled these inside a session, but the choice was lost on every session restore, and reaching auto mode again cost three keystrokes and a confirmation each time.

### Fixed

- Two E2E suites assumed the app was already sitting on the first workspace's canvas, so they failed or hung depending on which suite ran before them. `rename` was the worst case: with a second workspace active, the first click of a double-click switched workspace and the sidebar re-rendered out from under the second.

## [0.3.1] — 2026-08-15

Termivin behaves like a native Mac app: it is named Termivin everywhere, its terminals find the tools your shell profile installs, and ⌘C copies.

### Fixed

- **macOS: the app is called Termivin again.** macOS takes the menu-bar title, Dock label and Force-Quit entry from the running bundle's `Info.plist`, which `app.setName()` cannot override — so unpackaged runs (`npm start`, the global `termivin` command) announced themselves as "Electron". Launching now renames the local Electron bundle first, and the About panel reports Termivin's own version instead of Electron's.
- **macOS: terminals start login shells**, matching Terminal.app and iTerm2. Homebrew, nvm and asdf write their setup to `~/.zprofile`, which only a login shell reads, so a Termivin opened from the Dock — inheriting launchd's bare `PATH` — could not find `claude` or `codex`.
- **macOS: ⌘C copies the terminal selection.** The native menu claims accelerators before the renderer sees them, the inverse of Windows, so the stock menu's ⌘C copied the always-empty DOM selection instead. Termivin now ships its own menu, which also drops Close Window: a stray ⌘W used to quit the app and kill every terminal.
- **Agent bus: the CLI and the app agree on the data directory.** The CLI looked for `bus.json` under `termivin`, the app wrote it to `Termivin`; only case-insensitive filesystems hid the mismatch.

### Changed

- **The E2E suites run on macOS.** They were authored on Windows and typed PowerShell into panes, pressed Ctrl+A for select-all and pointed at `D:\Work`, so most of them failed or hung on a Mac for reasons that had nothing to do with the app. Each now speaks the host platform's shell and key bindings; the two genuinely Windows-only suites skip with a message instead of crashing.

## [0.3.0] — 2026-08-15

### Added

- **Home overview** (⌂ in the sidebar) — one screen for the whole app: live counts per workspace, CPU/RAM of every terminal's process tree (the shell *and* everything it spawned), Claude/Codex token usage for today read from the CLIs' own transcripts, and a cross-workspace communication map. Click any terminal to **peek**: its live pane opens in an overlay you can type into, without switching workspaces or touching any layout.
- **Workspace dashboard, rebuilt as a communication map.** The old card grid duplicated what the canvas already shows, so the dashboard now answers the question the canvas can't: how are the agents talking? Terminals are chips (status LED, role, unread-mail badge), topics are bus bars, and bus traffic flows as glowing traces with live signal pulses — cross-workspace traffic appears as a chip for the other workspace. A side panel manages the bus: running/idle/approval counts with quick ✓/✗ approval actions, per-terminal CPU/RAM, topic management (create, delete, choose the representative), today's token usage for the workspace's folders, and a live activity feed.
- **Topics — workspaces can talk to each other.** A topic belongs to one workspace and has a *representative* agent. Inside its workspace, a message to `#topic` is a broadcast every agent hears; from any other workspace it reaches only the representative, so one terminal speaks for the workspace to the outside. Create topics from the dashboard or with `termivin topic <name> [--rep <agent>]`; list with `termivin topics`; send with `termivin send "#topic" "..."`. Topics persist across restarts; a dead representative falls back to a live registered agent.
- **Dock groups.** Fold minimized-terminal chips into named, collapsible groups: drag a chip onto a group, drop one chip onto another to create a group instantly (auto-named), or use the chip's right-click menu. Dragging a grouped chip shows a "⏏ Remove from group" strip. The header LED shows the most urgent member status; rename, restore-all and ungroup live on its right-click menu. Groups and collapsed state persist.
- **Bus connections survive restarts.** Registrations (roles) now persist to `bus/profiles.json`, and the traffic map + activity feed are rebuilt from the per-workspace message logs on startup — the communication maps no longer reset to a blank network after closing the app. (Messages and topics already persisted; profiles and counters were memory-only.)
- **Stop process** action in the pane ⋯ menu — stop what's running without removing the terminal.
- **Themes** — ⚙ in the sidebar footer opens Settings with five app-wide themes: Termivin (default), Matrix (full phosphor green), Amber CRT, Ice Terminal, and Synthwave. A theme restyles everything — panels, maps, and the terminals themselves (live xterm instances repaint on switch) — and persists.
- App version in the bottom-left corner of the sidebar.

### Fixed

- **Right-click paste inserted the text twice in Claude Code (Windows).** Claude Code turns on mouse tracking and pastes the clipboard itself when it receives the right-click report — and Termivin's right-click handler pasted on top of that. When the app in the terminal captures the mouse, Termivin now defers to it (same convention as Windows Terminal); plain shells keep Termivin's right-click paste.
- **Taskbar showed the generic Electron icon.** Windows resolves a taskbar button's icon through the window's AppUserModelID and an installed shortcut carrying the same ID — neither existed for dev/CLI runs. The window now declares its app details, and a Start Menu shortcut ("Termivin") with the matching AppUserModelID and icon is created on first run, which also makes pinning work properly.
- The agent-bus connect prompt ended with a backtick-escaped parenthesis, which left PowerShell terminals sitting in a `>>` continuation prompt.
- **Overlay bugs.** The dock stayed on screen over the Home overview; the "no agent on the bus" hint could cover a map chip (it moved into the side panel); map legends became footer strips instead of overlays; and modals/dialogs/menus were stacked *below* fullscreen panes and the dock — the z-order ladder is fixed.
- **Map readability.** On wide windows the ring layout stretched to the container edges and chips faded into dark backgrounds. The ring is now sized by node count and stays compact, chips got brighter fills and 2px outlines on every theme, and hub labels/trace counts carry a background halo. A terminal that clearly had bus traffic could still read "not on the bus" — a node now counts as connected when it is registered, has traffic, or has mail waiting.

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
