// Shared data plumbing for the two dashboards: throttled polling of bus
// stats, process stats and token usage, plus a fan-out for live bus events.
// Both dashboards render from the same cached snapshots, so opening either
// never doubles the sampling cost.

import * as S from './state.js';

let busStats = { agents: [], topics: [], links: [], spaceLinks: [], recent: [] };
let procStats = { byKey: {}, app: null, sys: null };
let tokens = null;
let busAt = 0;
let procAt = 0;
let tokAt = 0;
let procInFlight = false;

const busListeners = new Set();

export function onBusEvent(cb) {
  busListeners.add(cb);
}

export function initDashData() {
  window.termivin.onBusEvent((evt) => {
    // a live message invalidates the stats cache so counts catch up quickly
    if (evt.type === 'msg' || evt.type === 'topic' || evt.type === 'register') busAt = 0;
    for (const cb of busListeners) {
      try { cb(evt); } catch {}
    }
  });
}

export async function getBusStats(maxAgeMs = 2000) {
  if (Date.now() - busAt > maxAgeMs) {
    try {
      busStats = await window.termivin.busStats();
      busAt = Date.now();
    } catch {}
  }
  return busStats;
}

export async function getProcStats(maxAgeMs = 4000) {
  if (Date.now() - procAt > maxAgeMs && !procInFlight) {
    procInFlight = true;
    try {
      const terms = [];
      for (const ws of S.getState().workspaces) {
        for (const t of ws.terminals) {
          terms.push({ termId: t.id, pid: t.external ? t.external.pid : undefined });
        }
      }
      procStats = await window.termivin.statsSample(terms);
      procAt = Date.now();
    } catch {} finally {
      procInFlight = false;
    }
  }
  return procStats;
}

export async function getTokens(maxAgeMs = 30000) {
  if (!tokens || Date.now() - tokAt > maxAgeMs) {
    try {
      tokens = await window.termivin.tokenUsage();
      tokAt = Date.now();
    } catch {}
  }
  return tokens;
}

// --- formatting helpers -----------------------------------------------------

export function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

export function fmtMem(bytes) {
  if (!bytes) return '0';
  if (bytes >= 1 << 30) return (bytes / (1 << 30)).toFixed(1) + ' GB';
  return Math.round(bytes / (1 << 20)) + ' MB';
}

export function fmtPct(p) {
  if (p == null) return '–';
  return (p < 9.95 ? p.toFixed(1) : Math.round(p)) + '%';
}

export function fmtAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return Math.floor(s) + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  return Math.floor(s / 3600) + 'h';
}

export function normCwd(p) {
  return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

// Token usage for a set of working directories (a workspace, or one terminal).
export function tokensForCwds(tok, cwds) {
  const out = { claude: 0, codex: 0 };
  if (!tok) return out;
  const set = new Set([...cwds].map(normCwd).filter(Boolean));
  for (const [cwd, u] of Object.entries(tok.claude?.byCwd || {})) {
    if (set.has(cwd)) out.claude += u.total;
  }
  for (const [cwd, u] of Object.entries(tok.codex?.byCwd || {})) {
    if (set.has(cwd)) out.codex += u.total;
  }
  return out;
}
