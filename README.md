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

## Command line

The global `termivin` command is a small CLI (works the same on Windows, macOS and Linux):

```bash
termivin              # launch the app (or focus the existing window)
termivin update       # update to the latest published version via npm
termivin --help       # -h   show usage and exit
termivin --version    # -v   print the installed version and exit
termivin --update     # -u   same as "termivin update"
termivin --debug      # launch with the DevTools remote debugging port (9222) open
```

Run from **inside a Termivin terminal**, the same command is the agent-bus client — this is how AI agents in your workspaces talk to each other:

```bash
termivin register --role "backend, owns src/api"   # join the workspace bus
termivin who                                       # list the agents here, with live status
termivin send TermiFast "schema for users?" --ask  # message one agent ("@all" broadcasts)
termivin recv --wait 60                            # read mail (blocks up to 60 s)
termivin topics                                    # list cross-workspace topics
termivin topic deploys --rep TermiFast             # create a topic in this workspace
termivin send "#deploys" "shipping v2"             # message a topic
```

Any unrecognized options are forwarded straight to Electron.

## Features

- **Workspaces** — group terminals into named workspaces (new workspaces get a themed name suggestion — Riverside, Times City, Ocean Park…; new terminals get Termi-style names — TermiFast, TermiUni…). Rename anything by double-clicking its name. Drag a terminal tab onto another workspace in the sidebar to move it; drag onto another tab to reorder. Workspaces themselves reorder the same way — drag an item up or down the sidebar (an accent line shows where it will land). You can also drag a terminal **by its title bar** straight onto a sidebar workspace: the target highlights, and a confirm dialog moves the terminal there.
- **Floating canvas** — each workspace is a free-form canvas: terminals are floating windows you can drag by their title bar, freely resize from any edge or corner (like real OS windows), and stack (click brings to front). The ⛶ button (or double-clicking the title bar) maximizes one terminal fullscreen; ⛶ again returns to the canvas.
- **Attach external windows (Windows)** — two ways:
  - *⧉ Attach window* button: lists running console windows (Windows Terminal, cmd, PowerShell, …; tick "Show all windows" for everything) and embeds the one you pick as a floating pane (Win32 `SetParent`).
  - **Drop-to-attach**: simply drag any window (by its title bar) and release it over the Termivin canvas — a confirmation toast pops up at the drop point ("Attach here"). Implemented with a global `SetWinEventHook(EVENT_SYSTEM_MOVESIZEEND)` hook in the helper process.

  Detaching returns the window safely to the desktop (its original window style is persisted in the app state, so restore works even if the helper process was restarted). Closing the app auto-detaches everything. Output capture/approval detection isn't available for attached windows, and they always render above the app's own panes.
- **Adopt a terminal session (macOS)** — macOS has no equivalent of `SetParent`, so the same button becomes *⧉ Adopt terminal*: it lists the shell and agent sessions running in Terminal.app / iTerm2 with their real working directories, and opens the one you pick as a managed Termivin terminal at that folder. The original window keeps running — nothing is embedded or taken over.
- **Convert external → managed terminal** — when an attached window is gone (app restart, window closed), its entry offers *⇄ Convert to terminal*: confirm whether it was a Claude Code session (runs `claude --continue`) or a plain terminal (opens a shell), at the terminal's remembered working directory. The real cwd of the external shell is captured at attach time (read from the process PEB); the convert dialog also suggests your recent Claude Code project folders (from `~/.claude/projects`). Note: a Windows Terminal window hosting multiple tabs makes the cwd guess ambiguous — double-check the suggested path.
- **Minimize to dock** — the − button on a pane's title bar collapses rarely-watched terminals (dev servers, watchers…) into a compact chip stack on the right edge of the canvas, freeing space for the terminals you actually work in. Docked terminals keep running; their chip shows live status and pulses when a permission prompt is waiting. Click the chip (or the dimmed tab) to restore. When the dock gets crowded, fold chips into named, collapsible **groups**: drag a chip onto a group (or onto another chip to create one instantly), or use the chip's right-click menu. The group header shows the most urgent member status; its right-click menu offers rename / restore all / ungroup, and dragging a grouped chip shows a "⏏ Remove from group" strip.
- **Clone a terminal** — the ❐ button on a pane's title bar opens the new-terminal dialog prefilled with the source's working directory, startup/restore commands and settings — tweak anything (or nothing) and confirm. Handy for running a second Claude Code session on the same project; the suggested name is a fresh Termi-name.
- **Auto-arrange** — the ▦ Arrange button tiles all open terminals of the workspace into a neat grid filling the canvas (dock strip stays clear). Appears whenever more than one terminal is open.
- **Pane ⋯ menu** — *Rename*, *Refresh view* (re-measures and repaints a terminal that has gone sluggish or is drawing garbage), *Clear scrollback* (drops the 8000-line history a long session accumulates, keeping the process alive), *Open folder* and *Open in VS Code* — both on the terminal's working directory. "Open in VS Code" needs the `code` command on your PATH (in VS Code: *Shell Command: Install 'code' command in PATH*).
- **Copy & paste** — with text selected, `Ctrl+C` copies it; with nothing selected it still sends `Ctrl+C` to the process, so interrupting works as usual. `Ctrl+Shift+C` always copies, `Ctrl+V` / `Ctrl+Shift+V` paste, and right-click copies a selection or pastes when there is none. On macOS the same rules sit on `⌘`: `⌘C` copies the selection while `Ctrl+C` keeps interrupting, and `⌘V` pastes. (Termivin ships its own menu bar for this — macOS gives menu accelerators to the app before the terminal sees them, so the stock Edit menu would copy an empty selection. That menu also omits Close Window, since one stray `⌘W` would take every terminal down with it.)
- **Renaming** — workspaces: hover → ✎ pencil, or double-click the name; terminals: the pane's ⋯ → *Rename*, or double-click the tab name or the pane title-bar name.
- **Session restore** — every terminal remembers its type, working directory, startup command and *restore command* (e.g. `claude --continue` for Claude Code, `codex resume --last` for Codex). Reopen the app and the active workspace's saved terminals relaunch automatically; other workspaces restore on first visit (terminals you stopped yourself stay stopped — **Restore all** in the header revives those too). The last ~40 lines of output are snapshotted and replayed so you can see what each session was doing.
- **Agent bus** — AI agents running in your workspaces can discover each other and talk, with zero configuration: a loopback HTTP server starts with the app and its credentials are injected into every terminal Termivin spawns, so `termivin register / who / send / recv` just work inside them. The 🔗 button on an agent's pane types a ready-made connect prompt. Registrations, topics and message history persist — the network comes back intact after a restart. Local-only and authenticated (bound to `127.0.0.1`, per-launch bearer token, browser `Origin` requests refused, rate-limited). Design notes in [`docs/AGENT-BUS.md`](docs/AGENT-BUS.md).
- **Home overview** — the ⌂ item above the workspace list shows the whole app at a glance: per-workspace live counts, CPU/RAM of every terminal's process tree, today's Claude/Codex token usage (read from the CLIs' own transcripts), and a cross-workspace communication map. Click any terminal to **peek** — its live pane opens in an overlay you can type into, without switching workspaces or disturbing any layout.
- **Workspace dashboard = communication map** — toggle to *Dashboard* to see how the workspace's agents talk: terminals as chips (status LED, role, unread-mail badge), topics as central bus bars, bus traffic as glowing traces with live signal pulses in hacker-terminal green. The side panel manages the bus: counts, per-terminal CPU/RAM, topics (create / delete / pick the representative), token usage for the workspace's folders, and a live activity feed.
- **Topics (cross-workspace)** — a topic lives in one workspace and has a *representative* agent. Inside the workspace, `termivin send "#topic" "..."` broadcasts to every agent; from any other workspace it reaches only the representative — one terminal speaks for the workspace to the outside. `termivin topics` lists them; `termivin topic <name> [--rep <agent>]` creates one.
- **Approval detection** — Termivin watches each terminal's output for permission prompts (Claude Code numbered menus, y/n prompts, "Do you want to…" confirmations). Terminals that are waiting flash orange in the sidebar, tab bar and dashboard, a desktop notification fires, and you can **Approve / Deny from the dashboard's side panel** without opening the terminal.
- **Any terminal type** — Claude Code, Codex, PowerShell/CMD (Windows), zsh/bash (macOS/Linux), or a custom command. On macOS these start as **login shells**, the way Terminal.app and iTerm2 do, so the `PATH` Homebrew/nvm/asdf set up in `~/.zprofile` is there even when Termivin was launched from the Dock.
- **Claude Code permission mode** — the new-terminal dialog has a *Permission mode* dropdown for Claude Code terminals: **Auto** (Claude vets each tool call itself — good for long unattended runs), **Accept file edits**, **Plan only**, or the default ask-every-time. `Shift+Tab` still cycles modes inside a running session; picking the mode here instead writes `--permission-mode` into the terminal's startup *and* restore command, so a restored terminal comes back in the mode you chose rather than reverting to the default. Claude Code itself asks to confirm the first time auto mode is switched on — answer *"Yes, and make it my default mode"* and it stops asking.
- **Themes** — ⚙ in the sidebar footer: Termivin (default), Matrix, Amber CRT, Ice Terminal, or Synthwave. Applies to the whole app, terminals included, and sticks across restarts.

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

Starting the app from a VS Code integrated terminal needs `env -u ELECTRON_RUN_AS_NODE npm start`: VS Code exports that variable to its child processes, and it makes Electron run `src/main.js` as plain Node, where every Electron API is undefined.

## State

Workspace/terminal layout and output snapshots are stored in the Electron user-data directory (`%APPDATA%/Termivin/termivin-state.json` on Windows, `~/Library/Application Support/Termivin/` on macOS, `~/.config/Termivin/` on Linux). Delete the file to reset.

## Packaging (optional)

To build distributable installers with [electron-builder](https://www.electron.build/) (already a dev dependency):

```bash
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
