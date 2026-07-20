# Contributing to Termivin

Thanks for your interest in improving Termivin! Contributions are welcome — bug reports, feature ideas, docs, and code.

## Before you start

- By contributing, you agree that your contributions are licensed under the project's [PolyForm Noncommercial 1.0.0](LICENSE.md) license.
- Search the [issue tracker](../../issues) first — your bug or idea may already be filed.

## Development setup

```bash
git clone <repo-url>
cd Termivin
npm install
npm start
```

Requirements: Node.js ≥ 18. On Windows, `node-pty` uses prebuilt binaries; on Linux you need `make`/`g++`/`python3`.

## Project layout

| Path | What it is |
| --- | --- |
| `src/main.js` | Electron main process: PTY lifecycle (node-pty), state persistence, external-window IPC |
| `src/preload.js` | `contextBridge` API exposed to the renderer as `window.termivin` |
| `src/win-embed.ps1` | Windows helper (persistent PowerShell process): SetParent embedding, EnumWindows, move hook, PEB cwd reader |
| `src/renderer/state.js` | Workspace/terminal metadata + persistence |
| `src/renderer/term-manager.js` | xterm instances, PTY wiring, status & approval detection |
| `src/renderer/ui.js` | All DOM: sidebar, tabs, floating canvas, dashboard, modals |
| `src/renderer/presets.js` | Terminal type presets, name pools, approval-prompt regexes |
| `test/*.mjs` | E2E tests (playwright-core over CDP) |

## Running the tests

```bash
npm run start:debug     # starts the app with CDP on :9222
npm run test:e2e        # core smoke suite
npm run test:restore    # session-restore flow
npm run test:external   # external window attach/detach (Windows only)
npm run test:rename     # rename flows
```

Tests drive the real app window over CDP, so run them on a machine where the app window can open. Please make sure the relevant suites pass before opening a PR, and add coverage for new behavior where practical.

## Pull requests

1. Fork and create a topic branch from `main`.
2. Keep changes focused — one feature/fix per PR.
3. Match the existing code style (plain JS, no build step in the renderer).
4. Describe **what** and **why** in the PR body; link related issues.

## Extending approval detection

Prompt-detection patterns for AI CLIs live in `src/renderer/presets.js` (`detectApproval`). If your favorite CLI's permission prompt isn't detected, PRs adding patterns (with a sample of the prompt text in the PR description) are very welcome.

## Reporting bugs

Use the bug-report issue template. Always include: OS + version, Node version, what you did, what you expected, what happened, and (if relevant) the terminal type involved (Claude Code / Codex / shell / external window).
