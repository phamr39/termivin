// Terminal type presets and approval-prompt detection patterns.

const isWin = window.termivin.platform === 'win32';

export function defaultShell() {
  if (isWin) return 'powershell.exe';
  return window.termivin.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
}

export const TYPES = {
  claude: {
    label: 'Claude Code',
    command: 'claude',
    restoreCommand: 'claude --continue',
    color: '#d97757',
    icon: '✳',
  },
  codex: {
    label: 'Codex',
    command: 'codex',
    restoreCommand: 'codex resume --last',
    color: '#19c37d',
    icon: '◆',
  },
  shell: {
    label: isWin ? 'PowerShell' : 'Shell',
    command: '',
    restoreCommand: '',
    color: '#5ea0ef',
    icon: '❯',
  },
  ...(isWin
    ? {
        cmd: {
          label: 'CMD',
          shell: 'cmd.exe',
          command: '',
          restoreCommand: '',
          color: '#c7cdd6',
          icon: '❯',
        },
      }
    : {}),
  custom: {
    label: 'Custom command',
    command: '',
    restoreCommand: '',
    color: '#b48ce8',
    icon: '▸',
  },
};

export function typeInfo(type) {
  if (type === 'external') {
    return { label: 'External window', command: '', restoreCommand: '', color: '#e8a13c', icon: '⧉' };
  }
  return TYPES[type] || TYPES.custom;
}

// --- Name generators ------------------------------------------------------

export const WORKSPACE_NAMES = [
  'Riverside', 'The Harmony', 'Symphony', 'Green Villas', 'Green Bay',
  'Skylake', 'Smart City', 'West Point', 'Metropolis', 'Gardenia',
  'Times City', 'Royal City', 'Ocean Park', 'Olympic', 'Global Gate',
  'HaLongXanh',
];

const TERMI_SUFFIXES = [
  'Mec', 'School', 'Uni', 'Space', 'Fast', 'Wonder', 'Safari',
  'Homes', 'Pearl', 'Film', 'City', 'Eco', 'Com',
];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// Random workspace name not already in use; falls back to a numbered variant.
export function randomWorkspaceName(existingNames) {
  const used = new Set(existingNames.map((n) => n.toLowerCase()));
  const free = WORKSPACE_NAMES.filter((n) => !used.has(n.toLowerCase()));
  if (free.length) return pick(free);
  const base = pick(WORKSPACE_NAMES);
  let i = 2;
  while (used.has(`${base} ${i}`.toLowerCase())) i++;
  return `${base} ${i}`;
}

// Random terminal name like "TermiFast"; avoids duplicates when possible.
export function randomTerminalName(existingNames = []) {
  const used = new Set(existingNames.map((n) => n.toLowerCase()));
  const free = TERMI_SUFFIXES.map((s) => 'Termi' + s).filter((n) => !used.has(n.toLowerCase()));
  if (free.length) return pick(free);
  const base = 'Termi' + pick(TERMI_SUFFIXES);
  let i = 2;
  while (used.has(`${base} ${i}`.toLowerCase())) i++;
  return `${base} ${i}`;
}

// --- Approval prompt detection -------------------------------------------
// Heuristics tuned for Claude Code / Codex permission prompts, plus generic
// y/n and "press enter" confirmations. Input: array of trimmed lines (the
// tail of the terminal buffer, oldest first).

// A prompt is only "waiting" if the very END of the buffer still looks like
// prompt UI. This is what stops answered prompts sitting in scrollback (with
// a fresh shell prompt after them) from re-triggering detection.
const PROMPT_TAIL =
  /(^\s*(❯|>)?\s*\d+\.\s)|(\besc\b|escape|cancel|interrupt|shift\+tab|↑|↓|enter to (confirm|select))|(^[\s╰╯─│╭╮└┘┌┐┃┏┓┗┛═║╔╗╚╝|+-]+$)/i;

export function detectApproval(lines) {
  const cleaned = [...lines];
  while (cleaned.length && !cleaned[cleaned.length - 1]) cleaned.pop();
  if (!cleaned.length) return null;

  const last = cleaned[cleaned.length - 1];
  const last3 = cleaned.slice(-3).join('\n');
  const recent = cleaned.slice(-14).join('\n');

  // Numbered option menu (Claude Code permission / trust prompts, Codex).
  // e.g. "❯ 1. Yes"  /  "1. Yes, allow"  followed by "2. ..." — and the last
  // line must still be an option, a hint, or a box border.
  if (/(❯|>)?\s*1\.\s*(yes|approve|allow|proceed|accept|run|always)/i.test(recent) &&
      /\b[2-9]\.\s+\S/.test(recent) &&
      PROMPT_TAIL.test(last)) {
    return { kind: 'menu', hint: 'Enter = Yes · Esc = No' };
  }

  // Classic y/n prompt: the buffer must END with it (cursor waiting after it).
  if (/[\[(]\s*(y\/n|yes\/no|y\/n\/a)\s*[\])]\s*[:?]?\s*$/i.test(last) ||
      /\[(y\/N|Y\/n)\]\s*[:?]?\s*$/.test(last)) {
    return { kind: 'yn', hint: 'y = Yes · n = No' };
  }

  // Generic confirmation phrasing at the very end of the buffer.
  if (/(do you want to|would you like to|allow this command|approve this|waiting for (your )?approval|needs? your approval|grant access|do you trust|press enter to (continue|confirm))/i.test(last3) &&
      /[:?]\s*$|press enter/i.test(last)) {
    return { kind: 'enter', hint: 'Enter = Confirm · Esc = Cancel' };
  }

  return null;
}

export function approvalKeys(kind, approve) {
  if (kind === 'yn') return approve ? 'y\r' : 'n\r';
  if (kind === 'menu') return approve ? '\r' : '\x1b';
  return approve ? '\r' : '\x1b'; // 'enter'
}
