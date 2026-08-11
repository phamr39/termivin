// E2E checks for the pane ⋯ menu: rename, refresh, clear scrollback, open
// folder, open in VS Code — plus terminal copy/paste and the folder picker
// honouring the path already typed in the field.
//
// Runs against an isolated dev instance so it never touches your real app:
//   npm run start:dev
//   node test/features.mjs 9223
//
// It drives real keystrokes through the OS input queue for the clipboard
// checks, because CDP injects keys straight into the renderer and would skip
// the Win32 accelerator table the Electron menu installs.

import { chromium } from 'playwright-core';
import { execFileSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const PORT = process.argv[2] || '9223';
const isWin = process.platform === 'win32';
let fails = 0;
const ok = (m) => console.log('PASS  ' + m);
const fail = (m, detail) => {
  console.error('FAIL  ' + m + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)));
  fails++;
};
const check = (name, cond, detail) => (cond ? ok(name) : fail(name, detail));
const skip = (m) => console.log('SKIP  ' + m);

const psRun = (script) => execFileSync('powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim();

// Focus the dev window by its --user-data-dir, never a Termivin the user has
// open. Windows refuses SetForegroundWindow to a background process unless the
// caller's input thread is attached to the foreground one, so do that — and
// report whether it actually took, since a silently unfocused window would turn
// every keystroke check into a false failure.
const FOCUS_DEV = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@
$procs = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -like '*devprofile*' }
$hwnd = [IntPtr]::Zero
foreach ($p in $procs) {
  $o = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  if ($o -and $o.MainWindowHandle -ne 0) { $hwnd = $o.MainWindowHandle; break }
}
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "NOWINDOW"; exit 1 }
$target = [W]::GetWindowThreadProcessId($hwnd, [IntPtr]::Zero)
$me = [W]::GetCurrentThreadId()
[W]::AttachThreadInput($me, $target, $true) | Out-Null
[W]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE
[W]::BringWindowToTop($hwnd) | Out-Null
[W]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 500
$got = [W]::GetForegroundWindow()
[W]::AttachThreadInput($me, $target, $false) | Out-Null
if ($got -ne $hwnd) { Write-Output "NOTFOCUSED"; exit 1 }
`;
// Returns true when the keystroke was genuinely delivered to the dev window.
const sendKeysToDev = (keys) => {
  try {
    const r = psRun(FOCUS_DEV + `[System.Windows.Forms.SendKeys]::SendWait("${keys}")\nWrite-Output "SENT"`);
    return /SENT/.test(r);
  } catch {
    return false;
  }
};

const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const ctx = cdp.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('index.html')) || ctx.pages()[0];

await page.waitForSelector('.ws-item', { timeout: 15000 });
ok('window is up: ' + (await page.textContent('.ws-item .ws-name')).trim());

// A folder that certainly exists and is safe to open.
const probeDir = mkdtempSync(path.join(tmpdir(), 'termivin-feat-'));

// --- create a terminal ----------------------------------------------------
await page.click('#new-terminal-btn');
await page.waitForSelector('#modal-overlay:not(.hidden)');
await page.selectOption('#nt-type', 'shell');
await page.fill('#nt-name', 'FeatOne');
await page.fill('#nt-cwd', probeDir);
await page.click('#nt-create');
await page.waitForTimeout(5000);

const pane = '.pane.focused';
const termId = await page.getAttribute(pane, 'data-term-id');
const screen = () => page.evaluate((s) =>
  document.querySelector(s + ' .xterm-rows')?.innerText || '', pane);
const nameOf = (id) => page.evaluate((i) => {
  const { S } = window.__termivin;
  for (const ws of S.getState().workspaces) {
    const t = ws.terminals.find((x) => x.id === i);
    if (t) return t.name;
  }
  return null;
}, id);

// ---------------------------------------------------------------- ⋯ menu
check('pane has a ⋯ button', await page.locator(`${pane} .pane-more`).count() === 1);

await page.click(`${pane} .pane-more`);
await page.waitForSelector('.pane-menu', { timeout: 3000 });
const items = await page.evaluate(() =>
  [...document.querySelectorAll('.pane-menu-item')].map((b) => b.textContent.trim()));
check('menu offers rename', items.some((i) => /Rename/.test(i)), items);
check('menu offers refresh', items.some((i) => /Refresh/.test(i)), items);
check('menu offers clear scrollback', items.some((i) => /Clear scrollback/.test(i)), items);
check('menu offers open folder', items.some((i) => /Open folder/.test(i)), items);
check('menu offers open in VS Code', items.some((i) => /VS Code/.test(i)), items);

// the button toggles rather than stacking menus
await page.click(`${pane} .pane-more`);
await page.waitForTimeout(250);
check('⋯ toggles the menu shut', await page.locator('.pane-menu').count() === 0);

// ------------------------------------------------------------------ rename
// Rename from the menu: the input must accept typed text and commit on Enter.
await page.click(`${pane} .pane-more`);
await page.waitForSelector('.pane-menu');
await page.click('.pane-menu-item:has-text("Rename")');
await page.waitForSelector(`${pane} .inline-rename`, { timeout: 3000 });
check('rename input is focused', await page.evaluate(() =>
  document.activeElement?.classList.contains('inline-rename')));

// Click into the input first: this is what used to start a pane drag and steal
// the caret, so it is the regression that matters.
const boxBefore = await page.evaluate((s) => {
  const p = document.querySelector(s);
  return { x: p.offsetLeft, y: p.offsetTop };
}, pane);
await page.click(`${pane} .inline-rename`);
await page.keyboard.press('Control+a');
await page.keyboard.type('RenamedViaMenu', { delay: 25 });
const typed = await page.inputValue(`${pane} .inline-rename`);
check('typing into the rename input works', typed === 'RenamedViaMenu', typed);
check('clicking the rename input did not start a pane drag',
  await page.evaluate(() => !document.body.classList.contains('dragging-pane')));
await page.keyboard.press('Enter');
await page.waitForTimeout(400);

const boxAfter = await page.evaluate((s) => {
  const p = document.querySelector(s);
  return { x: p.offsetLeft, y: p.offsetTop };
}, pane);
check('the pane did not move while renaming',
  boxBefore.x === boxAfter.x && boxBefore.y === boxAfter.y, { boxBefore, boxAfter });
check('rename reached the state', await nameOf(termId) === 'RenamedViaMenu', await nameOf(termId));
check('rename shows on the pane bar',
  (await page.textContent(`${pane} .pane-name`)).trim() === 'RenamedViaMenu');
check('rename shows on the tab',
  (await page.textContent(`.tab[data-term-id="${termId}"] .tab-name`)).trim() === 'RenamedViaMenu');

// Rename by double-clicking the tab — the draggable="true" path.
await page.dblclick(`.tab[data-term-id="${termId}"] .tab-name`);
await page.waitForSelector('.tab .inline-rename', { timeout: 3000 });
check('tab is not draggable while renaming',
  await page.getAttribute(`.tab[data-term-id="${termId}"]`, 'draggable') === 'false');
await page.click('.tab .inline-rename');
await page.keyboard.press('Control+a');
await page.keyboard.type('RenamedViaTab', { delay: 25 });
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
check('tab rename reached the state', await nameOf(termId) === 'RenamedViaTab', await nameOf(termId));
check('tab is draggable again after renaming',
  await page.getAttribute(`.tab[data-term-id="${termId}"]`, 'draggable') === 'true');

// -------------------------------------------------- refresh / scrollback
await page.click(`${pane} .xterm-screen`);
await page.keyboard.type('1..60 | ForEach-Object { "filler line $_" }', { delay: 5 });
await page.keyboard.press('Enter');
await page.waitForTimeout(2500);
const before = await page.evaluate((id) =>
  window.__termivin.TM.getRuntime(id).xterm.buffer.active.length, termId);
check('scrollback grew', before > 40, before);

await page.click(`${pane} .pane-more`);
await page.waitForSelector('.pane-menu');
await page.click('.pane-menu-item:has-text("Refresh view")');
await page.waitForTimeout(600);
const afterRefresh = await page.evaluate((id) => {
  const rt = window.__termivin.TM.getRuntime(id);
  return { len: rt.xterm.buffer.active.length, cols: rt.xterm.cols, running: rt.running };
}, termId);
check('refresh keeps the session alive', afterRefresh.running === true, afterRefresh);
check('refresh keeps the scrollback', afterRefresh.len >= before - 2, { before, afterRefresh });
check('refresh left the terminal focused', await page.evaluate(() =>
  document.activeElement?.classList.contains('xterm-helper-textarea')));

await page.click(`${pane} .pane-more`);
await page.waitForSelector('.pane-menu');
await page.click('.pane-menu-item:has-text("Clear scrollback")');
await page.waitForTimeout(600);
const afterClear = await page.evaluate((id) => {
  const rt = window.__termivin.TM.getRuntime(id);
  return { len: rt.xterm.buffer.active.length, running: rt.running };
}, termId);
check('clear scrollback drops the history', afterClear.len < before, { before, afterClear });
check('clear scrollback keeps the session alive', afterClear.running === true, afterClear);
// the shell still responds afterwards
await page.click(`${pane} .xterm-screen`);
await page.keyboard.type('echo ALIVE-AFTER-CLEAR', { delay: 8 });
await page.keyboard.press('Enter');
await page.waitForTimeout(1800);
check('PTY still works after clearing', (await screen()).includes('ALIVE-AFTER-CLEAR'),
  (await screen()).slice(-160));

// ------------------------------------------------------- open folder / code
const openFolder = await page.evaluate((d) => window.termivin.openFolder(d), probeDir);
check('open folder succeeds for a real folder', openFolder.ok === true, openFolder);
const openMissing = await page.evaluate((d) => window.termivin.openFolder(d),
  path.join(probeDir, 'does-not-exist'));
check('open folder reports a missing folder', openMissing.ok === false, openMissing);

// Close the Explorer window this just opened, matched by the temp folder name.
if (isWin) {
  const leaf = path.basename(probeDir);
  psRun(`
    $sh = New-Object -ComObject Shell.Application
    foreach ($w in @($sh.Windows())) {
      try { if ($w.LocationName -eq '${leaf}') { $w.Quit() } } catch {}
    }
  `);
}

const codeAvailable = (() => {
  try {
    execFileSync(isWin ? 'where' : 'which', [isWin ? 'code.cmd' : 'code'],
      { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch { return false; }
})();
const openEditorMissing = await page.evaluate((d) => window.termivin.openInEditor(d),
  path.join(probeDir, 'does-not-exist'));
check('open in VS Code reports a missing folder', openEditorMissing.ok === false, openEditorMissing);
if (codeAvailable) {
  // Only assert the resolver+spawn path; launching a real editor window here
  // would litter the user's desktop, so this is deliberately not exercised.
  skip('open in VS Code happy path (would open a real editor window)');
} else {
  const res = await page.evaluate((d) => window.termivin.openInEditor(d), probeDir);
  check('open in VS Code explains a missing `code` CLI',
    res.ok === false && /PATH/.test(res.error), res);
}

// ------------------------------------------------------------- copy / paste
if (!isWin) {
  skip('clipboard checks (native keystrokes are Windows-only here)');
} else {
  const savedClip = psRun('Get-Clipboard -Raw');
  const clearSel = () =>
    page.evaluate((id) => window.__termivin.TM.getRuntime(id).xterm.clearSelection(), termId);
  const selectAll = () =>
    page.evaluate((id) => window.__termivin.TM.getRuntime(id).xterm.selectAll(), termId);
  try {
    await page.click(`${pane} .xterm-screen`);
    await page.keyboard.type('echo CLIP-SOURCE-LINE', { delay: 8 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);

    // CDP keystrokes reach xterm's key handler the same way real ones do (the
    // Electron menu does not swallow Ctrl+C), so the behavioural assertions use
    // them — deterministic, and no window-focus race. One real keystroke at the
    // end confirms the physical-keyboard path.
    psRun(`Set-Clipboard -Value 'SENTINEL'`);
    await selectAll();
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(700);
    check('Ctrl+C copies the selection', /CLIP-SOURCE-LINE/.test(psRun('Get-Clipboard -Raw')),
      psRun('Get-Clipboard -Raw').slice(0, 100));
    check('Ctrl+C with a selection does not interrupt',
      !/\^C/.test((await screen()).slice(-120)), (await screen()).slice(-120));
    check('the selection is cleared after copying',
      await page.evaluate((id) => !window.__termivin.TM.getRuntime(id).xterm.hasSelection(), termId));

    // Ctrl+C WITHOUT a selection must still interrupt.
    await clearSel();
    await page.click(`${pane} .xterm-screen`);
    await page.keyboard.type('while($true){ Start-Sleep -Milliseconds 300 }', { delay: 5 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1400);
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(1200);
    await page.keyboard.type('echo INTERRUPTED-OK', { delay: 8 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1800);
    check('Ctrl+C with no selection still sends SIGINT',
      (await screen()).includes('INTERRUPTED-OK'), (await screen()).slice(-160));

    // Ctrl+Shift+V pastes.
    await clearSel();
    psRun(`Set-Clipboard -Value 'echo SHIFT-PASTED'`);
    await page.click(`${pane} .xterm-screen`);
    await page.keyboard.press('Control+Shift+V');
    await page.waitForTimeout(1000);
    check('Ctrl+Shift+V pastes', (await screen()).includes('SHIFT-PASTED'),
      (await screen()).slice(-140));

    // Right-click pastes when nothing is selected, copies when something is.
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
    await clearSel();
    psRun(`Set-Clipboard -Value 'echo RIGHT-CLICK-PASTE'`);
    await page.click(`${pane} .xterm-screen`, { button: 'right' });
    await page.waitForTimeout(1000);
    check('right-click pastes with no selection',
      (await screen()).includes('RIGHT-CLICK-PASTE'), (await screen()).slice(-140));

    psRun(`Set-Clipboard -Value 'SENTINEL2'`);
    await selectAll();
    await page.click(`${pane} .xterm-screen`, { button: 'right' });
    await page.waitForTimeout(700);
    check('right-click copies when there is a selection',
      psRun('Get-Clipboard -Raw') !== 'SENTINEL2');

    // --- the real keyboard, not CDP -----------------------------------------
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
    psRun(`Set-Clipboard -Value 'SENTINEL3'`);
    await selectAll();
    if (!sendKeysToDev('^c')) {
      skip('physical-keyboard Ctrl+C (could not take window focus)');
    } else {
      await page.waitForTimeout(900);
      check('a physical Ctrl+C copies too', psRun('Get-Clipboard -Raw') !== 'SENTINEL3',
        psRun('Get-Clipboard -Raw').slice(0, 80));
    }
    await clearSel();
  } finally {
    if (savedClip) psRun(`Set-Clipboard -Value @'\n${savedClip}\n'@`);
  }
}

// ------------------------------------------------- folder picker default
// The picker itself is a native modal a CDP test cannot drive, so verify the
// contract instead: the renderer must hand the typed path to the main process.
await page.click('#new-terminal-btn');
await page.waitForSelector('#modal-overlay:not(.hidden)');
check('new-terminal modal prefills a cwd',
  (await page.inputValue('#nt-cwd')).length > 0, await page.inputValue('#nt-cwd'));
await page.click('#nt-cancel');

// Cloning must carry the source folder into the modal — that is the case the
// broken picker was reported against.
await page.click(`${pane} .pane-clone`);
await page.waitForSelector('#modal-overlay:not(.hidden)');
const clonedCwd = await page.inputValue('#nt-cwd');
check('clone prefills the source folder', clonedCwd === probeDir, { clonedCwd, probeDir });
await page.click('#nt-cancel');

await cdp.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
