// Approval-prompt detection, shared by the renderer (desktop UI) and the main
// process (session hub → remote/phone). Pure functions over an array of
// terminal lines (oldest first, trailing whitespace trimmed); no DOM, no Node.
//
// src/shared is an ES module package (see package.json here): the renderer
// imports it directly, main loads it with import().

// Characters that draw prompt boxes and hint rows.
const BOX = /[│┃║|╭╮╰╯┌┐└┘┏┓┗┛╔╗╚╝─━═]/g;

// A line that is part of prompt chrome rather than content: a box border, or a
// keyboard hint row ("Esc to cancel · Tab to amend").
const CHROME = /^[\s╰╯─│╭╮└┘┌┐┃┏┓┗┛═║╔╗╚╝|+-]*$|(\besc\b|escape|to cancel|shift\+tab|↑|↓|enter to (confirm|select)|tab to amend|ctrl\+)/i;

// Option lines of a selection menu: "❯ 1. Yes", "  2. Yes, and don't ask…".
// The selection marker is what separates a live menu from a numbered list in
// ordinary output (a plan, a changelog) — a real menu always shows one.
const OPTION = /^\s*[│┃║|]?\s*([❯›>●▸▶→])?\s*([1-9])\.\s+(.+?)\s*[│┃║|]?\s*$/;
const YES_WORD = /^(yes|approve|allow|proceed|accept|run|always|continue|trust)\b/i;

function clean(line) {
  return String(line || '').replace(BOX, ' ').replace(/\s+/g, ' ').trim();
}

// FNV-1a — tiny, synchronous and identical in Node and the browser. Used to
// tell "the same prompt is still up" from "a different prompt replaced it".
export function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function trimTail(lines) {
  const out = [...lines];
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

// The menu block at the end of the buffer, if any: consecutive option lines
// (1., 2., …) followed only by chrome (borders, hints, blank lines).
function findMenu(lines) {
  let end = lines.length - 1;
  while (end >= 0 && (CHROME.test(lines[end]) || !lines[end].trim()) && !OPTION.test(lines[end])) end--;
  if (end < 0 || lines.length - 1 - end > 6) return null;
  const options = [];
  let marker = false;
  let i = end;
  // Walk up through option lines; an option label may wrap onto a second line.
  for (; i >= 0 && end - i < 16; i--) {
    const m = OPTION.exec(lines[i]);
    if (m) {
      options.unshift({ key: m[2], label: clean(m[3]) });
      if (m[1]) marker = true;
      if (m[2] === '1') break;
    } else if (!lines[i].trim() || CHROME.test(lines[i])) {
      break;
    }
  }
  if (!options.length || options[0].key !== '1' || options.length < 2 || !marker) return null;
  // Keys must run 1, 2, 3… without gaps.
  if (options.some((o, k) => o.key !== String(k + 1))) return null;
  return { start: i, end, options };
}

// Returns null, or { kind, hint, options, question, excerpt, hash }.
//   kind: 'menu' (numbered selection), 'yn', 'enter'
//   hash: identifies this particular prompt (see hashText)
export function detectApproval(rawLines) {
  const lines = trimTail(rawLines.map((l) => String(l || '').replace(/\s+$/, '')));
  if (!lines.length) return null;

  const menu = findMenu(lines);
  if (menu && YES_WORD.test(menu.options[0].label)) {
    // Context above the menu: the question and what is being asked about.
    const above = [];
    for (let k = menu.start - 1; k >= 0 && above.length < 8; k--) {
      const c = clean(lines[k]);
      if (!c && above.length) break;
      if (c) above.unshift(c);
    }
    const question = [...above].reverse().find((l) => /\?\s*$/.test(l)) || '';
    const excerpt = above.filter((l) => l !== question).slice(-4).join('\n');
    const region = [...above, ...menu.options.map((o) => o.key + '.' + o.label)].join('\n');
    return {
      kind: 'menu',
      hint: 'Enter = Yes · Esc = No',
      options: menu.options,
      question,
      excerpt,
      hash: hashText(region),
    };
  }

  const last = lines[lines.length - 1];
  const last3 = lines.slice(-3).join('\n');

  // Classic y/n prompt: the buffer must END with it (cursor waiting after it).
  if (/[\[(]\s*(y\/n|yes\/no|y\/n\/a)\s*[\])]\s*[:?]?\s*$/i.test(last) ||
      /\[(y\/N|Y\/n)\]\s*[:?]?\s*$/.test(last)) {
    return {
      kind: 'yn', hint: 'y = Yes · n = No',
      options: [{ key: 'y', label: 'Yes' }, { key: 'n', label: 'No' }],
      question: clean(last), excerpt: clean(lines[lines.length - 2] || ''),
      hash: hashText(lines.slice(-3).map(clean).join('\n')),
    };
  }

  // Generic confirmation phrasing at the very end of the buffer.
  if (/(do you want to|would you like to|allow this command|approve this|waiting for (your )?approval|needs? your approval|grant access|do you trust|press enter to (continue|confirm))/i.test(last3) &&
      /[:?]\s*$|press enter/i.test(last)) {
    return {
      kind: 'enter', hint: 'Enter = Confirm · Esc = Cancel',
      options: [{ key: 'enter', label: 'Confirm' }, { key: 'esc', label: 'Cancel' }],
      question: clean(last), excerpt: clean(lines[lines.length - 2] || ''),
      hash: hashText(lines.slice(-3).map(clean).join('\n')),
    };
  }

  return null;
}

// Keys for a plain approve/deny (desktop buttons, notification actions).
export function approvalKeys(kind, approve) {
  if (kind === 'yn') return approve ? 'y\r' : 'n\r';
  return approve ? '\r' : '\x1b'; // 'menu' (option 1 is preselected) / 'enter'
}

// Keys that pick one specific option of a detected prompt.
export function optionKeys(approval, key) {
  if (!approval) return null;
  if (approval.kind === 'menu') {
    if (key === 'esc') return '\x1b';
    return approval.options.some((o) => o.key === key) ? key : null;
  }
  if (approval.kind === 'yn') return key === 'y' ? 'y\r' : key === 'n' ? 'n\r' : null;
  return key === 'enter' ? '\r' : key === 'esc' ? '\x1b' : null;
}

// One line describing what a terminal is doing: the last line of real output,
// skipping prompt chrome, spinners and shell prompts.
export function summarize(rawLines) {
  const lines = trimTail(rawLines);
  for (let i = lines.length - 1; i >= 0 && lines.length - i < 40; i--) {
    const c = clean(lines[i]);
    if (!c || c.length < 3) continue;
    if (CHROME.test(lines[i])) continue;
    if (/^(PS [A-Z]:\\|[\w.-]+@[\w.-]+[:~]|[$#>❯]\s*$)/.test(c)) continue; // shell prompts
    if (/^[>❯›]\s/.test(c)) continue; // agent input box
    if (/^\?\s+for shortcuts/i.test(c)) continue;
    return c.replace(/^[✻✽✶✳·*◐◓◑◒⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*/, '').slice(0, 140);
  }
  return '';
}
