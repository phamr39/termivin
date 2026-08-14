// Home overview: every workspace on one screen — live counts, resource cost,
// token spend, the cross-workspace communication map (workspaces as chips,
// topics as bus bars), and a peek overlay that opens any terminal from any
// workspace in place, without switching workspaces or touching layouts.

import * as S from './state.js';
import * as TM from './term-manager.js';
import { typeInfo } from './presets.js';
import { BusMap } from './busmap.js';
import {
  getBusStats, getProcStats, getTokens,
  fmtTokens, fmtMem, fmtPct, normCwd, tokensForCwds,
} from './dash-data.js';

let map = null;
let hooks = null; // { switchWorkspace(wsId), renderAll }
let refreshing = false;
let peekTermId = null;

export function initHome(uiHooks) {
  hooks = uiHooks;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function isHome() {
  const st = S.getState();
  return !!(st && st.appView === 'home');
}

export function renderHome() {
  const home = document.getElementById('home');
  if (!isHome()) {
    home.classList.add('hidden');
    return;
  }
  home.classList.remove('hidden');

  if (!home.dataset.built) {
    home.dataset.built = '1';
    home.innerHTML = `
      <div class="home-hero" id="home-hero"></div>
      <div class="home-map">
        <div class="home-map-canvas" id="home-map-canvas"></div>
        <div class="home-map-hint">Workspaces talk through topic representatives — traffic appears as glowing traces.</div>
      </div>
      <div class="home-grid" id="home-grid"></div>`;
    map = new BusMap(document.getElementById('home-map-canvas'), {
      mode: 'global',
      onNodeClick: (id) => hooks.switchWorkspace(id),
    });
  }
  refreshHome(true);
}

export async function refreshHome(force = false) {
  if (!isHome()) return;
  if (refreshing && !force) return;
  refreshing = true;
  try {
    const [stats, proc, tok] = await Promise.all([getBusStats(), getProcStats(), getTokens()]);
    drawHero(proc, tok);
    drawGlobalMap(stats, proc, tok);
    drawGrid(proc, tok, stats);
  } finally {
    refreshing = false;
  }
}

function countStatuses(ws) {
  const c = { total: ws.terminals.length, working: 0, idle: 0, approval: 0, off: 0, running: 0 };
  for (const t of ws.terminals) {
    const st = TM.getStatus(t.id);
    if (st === 'working') c.working++;
    else if (st === 'idle' || st === 'attached') c.idle++;
    else if (st === 'approval') c.approval++;
    else c.off++;
  }
  c.running = c.working + c.idle + c.approval;
  return c;
}

function drawHero(proc, tok) {
  const hero = document.getElementById('home-hero');
  const state = S.getState();
  let terms = 0, running = 0, approvals = 0;
  for (const ws of state.workspaces) {
    const c = countStatuses(ws);
    terms += c.total;
    running += c.running;
    approvals += c.approval;
  }
  let cpu = 0, mem = 0;
  for (const ws of state.workspaces) {
    for (const t of ws.terminals) {
      const s = proc.byKey[t.id];
      if (s) { cpu += s.cpu; mem += s.mem; }
    }
  }
  if (proc.app) { cpu += proc.app.cpu; mem += proc.app.mem; }

  hero.innerHTML = '';
  const tile = (value, label, cls = '', title = '') => {
    const d = el('div', 'hero-tile ' + cls);
    d.append(el('div', 'hero-tile-v', String(value)), el('div', 'hero-tile-l', label));
    if (title) d.title = title;
    hero.appendChild(d);
  };
  tile(state.workspaces.length, 'workspaces');
  tile(terms, 'terminals');
  tile(running, 'running', running ? 'tile-idle' : '');
  if (approvals) tile(approvals, 'need approval', 'tile-approval');
  tile(fmtPct(cpu), 'CPU', '', 'App + all terminal process trees');
  tile(fmtMem(mem), 'RAM', '', 'App + all terminal process trees');
  const cl = tok?.claude?.today;
  const cx = tok?.codex?.today;
  tile(fmtTokens(cl ? cl.total : 0), '✳ Claude today', 'tile-claude',
    cl ? `${fmtTokens(cl.output)} output · ${fmtTokens(cl.cacheRead)} cache read · ${cl.messages} calls` : '');
  tile(fmtTokens(cx ? cx.total : 0), '◆ Codex today', 'tile-codex',
    cx && cx.total ? `${fmtTokens(cx.output)} output · ${fmtTokens(cx.cacheRead)} cached` : 'no usage today');
}

function drawGlobalMap(stats, proc, tok) {
  const state = S.getState();
  const nodes = state.workspaces.map((ws) => {
    const c = countStatuses(ws);
    let cpu = 0, mem = 0;
    const cwds = new Set();
    for (const t of ws.terminals) {
      const s = proc.byKey[t.id];
      if (s) { cpu += s.cpu; mem += s.mem; }
      cwds.add(normCwd(t.cwd));
    }
    const tks = tokensForCwds(tok, cwds);
    const status = c.approval ? 'approval' : c.working ? 'working' : c.idle ? 'idle' : 'saved';
    return {
      id: ws.id,
      label: ws.name,
      icon: '▣',
      color: '#5ea0ef',
      status,
      sub: `${c.total} terminal${c.total === 1 ? '' : 's'} · ${c.running} running`,
      sub2: `${fmtPct(cpu)} · ${fmtMem(mem)}` + (tks.claude ? ` · ✳ ${fmtTokens(tks.claude)}` : ''),
      badge: c.approval ? String(c.approval) : null,
      title: `${ws.name}\n${c.working} working · ${c.idle} idle · ${c.approval} waiting approval\nclick to open`,
    };
  });

  const hubs = stats.topics.map((t) => ({
    id: 'topic:' + t.id,
    label: t.name,
    sub: (t.spaceName || '') + (t.effectiveRepName ? ' · rep ' + t.effectiveRepName : ''),
    title: `#${t.name} — lives in "${t.spaceName}"\nOther workspaces reach it through ${t.effectiveRepName || '(nobody)'}.`,
  }));

  const links = [];
  const pair = new Map();
  for (const l of stats.spaceLinks) {
    const k = l.from < l.to ? l.from + '|' + l.to : l.to + '|' + l.from;
    pair.set(k, (pair.get(k) || 0) + l.count);
  }
  for (const [k, count] of pair) {
    const [a, b] = k.split('|');
    links.push({ a, b, count, kind: 'traffic' });
  }
  for (const t of stats.topics) {
    links.push({ a: t.spaceId, b: 'topic:' + t.id, count: 0, kind: 'listen' });
  }

  map.render(nodes, hubs, links);
  map.topicByName = Object.fromEntries(stats.topics.map((t) => [t.name, 'topic:' + t.id]));
}

function drawGrid(proc, tok, stats) {
  const grid = document.getElementById('home-grid');
  const state = S.getState();
  grid.innerHTML = '';
  for (const ws of state.workspaces) {
    const c = countStatuses(ws);
    const card = el('div', 'home-card');

    const head = el('div', 'home-card-head');
    const name = el('span', 'home-card-name', ws.name);
    const badges = el('span', 'home-card-badges');
    if (c.approval) badges.appendChild(el('span', 'badge badge-approval', String(c.approval)));
    if (c.running) badges.appendChild(el('span', 'badge badge-run', String(c.running)));
    badges.appendChild(el('span', 'badge badge-total', String(c.total)));
    const open = el('button', 'btn btn-ghost btn-sm', 'Open ⤢');
    open.addEventListener('click', () => hooks.switchWorkspace(ws.id));
    head.append(name, badges, open);
    card.appendChild(head);

    const cwds = new Set(ws.terminals.map((t) => normCwd(t.cwd)));
    const tks = tokensForCwds(tok, cwds);
    let cpu = 0, mem = 0;
    for (const t of ws.terminals) {
      const s = proc.byKey[t.id];
      if (s) { cpu += s.cpu; mem += s.mem; }
    }
    const metaBits = [`${fmtPct(cpu)} CPU`, fmtMem(mem)];
    if (tks.claude) metaBits.push(`✳ ${fmtTokens(tks.claude)}`);
    if (tks.codex) metaBits.push(`◆ ${fmtTokens(tks.codex)}`);
    card.appendChild(el('div', 'home-card-meta', metaBits.join(' · ')));

    const rows = el('div', 'home-card-rows');
    for (const t of ws.terminals) {
      const info = typeInfo(t.external ? 'external' : t.type);
      const st = TM.getStatus(t.id);
      const row = el('div', 'home-term-row');
      const dot = el('span', 'dot st-' + st);
      const icon = el('span', 'home-term-icon', info.icon);
      icon.style.color = info.color;
      const nm = el('span', 'home-term-name', t.name);
      const s = proc.byKey[t.id];
      const metrics = el('span', 'home-term-metrics', s ? `${fmtPct(s.cpu)} · ${fmtMem(s.mem)}` : '');
      row.append(dot, icon, nm, metrics);
      if (t.external) {
        row.title = 'External window — open its workspace to interact';
        row.classList.add('home-term-ext');
        row.addEventListener('click', () => hooks.switchWorkspace(ws.id));
      } else {
        row.title = `${t.name} — click to peek (interact without leaving Home)`;
        row.addEventListener('click', () => openPeek(t.id));
      }
      rows.appendChild(row);
    }
    if (!ws.terminals.length) rows.appendChild(el('div', 'side-empty', 'No terminals.'));
    card.appendChild(rows);
    grid.appendChild(card);
  }
}

// --- peek overlay -----------------------------------------------------------
// Shows the live pane of ANY terminal on top of Home. The pane element moves
// into the overlay (xterm survives reparenting) and returns to #panes on
// close — workspace state, layouts and the active workspace stay untouched.

function ensurePeekEl() {
  let overlay = document.getElementById('peek-overlay');
  if (overlay) return overlay;
  overlay = el('div', 'peek-overlay hidden');
  overlay.id = 'peek-overlay';
  overlay.innerHTML = `
    <div class="peek-box">
      <div class="peek-bar">
        <span class="dot" id="peek-dot"></span>
        <span class="peek-title" id="peek-title"></span>
        <span class="peek-ws" id="peek-ws"></span>
        <span class="pane-spacer"></span>
        <button class="btn btn-ghost btn-sm" id="peek-goto">Open in workspace ⤢</button>
        <button class="pane-btn" id="peek-close" title="Close (Esc)">×</button>
      </div>
      <div class="peek-body" id="peek-body"></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePeek();
  });
  overlay.querySelector('#peek-close').addEventListener('click', closePeek);
  overlay.querySelector('#peek-goto').addEventListener('click', () => {
    const id = peekTermId;
    const found = id && S.findTerminal(id);
    closePeek();
    if (found) {
      found.ws.activeTerminalId = id;
      hooks.switchWorkspace(found.ws.id);
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && peekTermId) closePeek();
  });
  return overlay;
}

export function openPeek(termId) {
  const found = S.findTerminal(termId);
  if (!found || found.meta.external) return;
  closePeek();
  const rt = TM.ensureRuntime(found.meta);
  const overlay = ensurePeekEl();
  peekTermId = termId;

  overlay.querySelector('#peek-title').textContent = found.meta.name;
  overlay.querySelector('#peek-ws').textContent = 'in ' + found.ws.name;
  overlay.querySelector('#peek-dot').className = 'dot st-' + TM.getStatus(termId);

  rt.pane.classList.add('peeked');
  rt.pane.classList.remove('hidden');
  overlay.querySelector('#peek-body').appendChild(rt.pane);
  overlay.classList.remove('hidden');

  requestAnimationFrame(() => {
    TM.fitTerminal(termId);
    TM.refreshTerminal(termId);
    TM.focusTerminal(termId);
  });
}

export function closePeek() {
  if (!peekTermId) return;
  const overlay = document.getElementById('peek-overlay');
  const id = peekTermId;
  peekTermId = null;
  const rt = TM.getRuntime(id);
  if (rt) {
    rt.pane.classList.remove('peeked');
    document.getElementById('panes').appendChild(rt.pane);
  }
  if (overlay) overlay.classList.add('hidden');
  // let the normal renderer decide the pane's visibility again
  hooks.renderAll();
}

export function getPeekTermId() {
  return peekTermId;
}

// keep the peek header dot fresh from the live tick
export function updatePeek() {
  if (!peekTermId) return;
  const dot = document.getElementById('peek-dot');
  if (dot) dot.className = 'dot st-' + TM.getStatus(peekTermId);
}

export function pulseHomeMap(evt) {
  if (!isHome() || !map || evt.type !== 'msg') return;
  if (!evt.fromSpace || !evt.toSpace) return;
  if (evt.fromSpace === evt.toSpace) return;
  const hubId = evt.topic && map.topicByName ? map.topicByName[evt.topic] : null;
  if (hubId && map.pos.has(hubId)) {
    map.pulse(evt.fromSpace, hubId);
    setTimeout(() => map.pulse(hubId, evt.toSpace), 450);
  } else {
    map.pulse(evt.fromSpace, evt.toSpace);
  }
}
