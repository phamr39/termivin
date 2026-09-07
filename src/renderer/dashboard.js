// Workspace dashboard: the communication map gets the space (terminals as
// chips, topics as bus bars, traffic as glowing traces), and a slim side
// panel manages the bus — counts, topics + representative, token usage and
// the live activity feed. The old card grid lived here before; the canvas
// already shows all of that, so the dashboard now answers the one question
// the canvas can't: "how are my agents talking to each other?"

import * as S from './state.js';
import * as TM from './term-manager.js';
import { typeInfo, isAgentType } from './presets.js';
import { BusMap } from './busmap.js';
import {
  getBusStats, getProcStats, getTokens,
  fmtTokens, fmtMem, fmtPct, fmtAgo, normCwd,
} from './dash-data.js';

let map = null;
let hooks = null; // { openInCanvas(termId), switchWorkspace(wsId), uiPrompt, uiConfirm, ... }
let refreshing = false;

// Filter state for the Terminals card — kept in module scope so it survives
// the 1.5s live tick (which never rebuilds the header, only redraws rows).
// Reset when the user leaves the dashboard.
let filterQuery = '';
let filterStatus = 'all';

// Only one row menu open at a time; stored so a second ⋯ click can toggle it
// and outside clicks can close it.
let rowMenuTermId = null;
let rowMenuOutside = null;

export function initWorkspaceDashboard(uiHooks) {
  hooks = uiHooks;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Full rebuild — on entering the view or when the terminal set changes.
export function renderWorkspaceDashboard() {
  const dash = document.getElementById('dashboard');
  const ws = S.activeWorkspace();
  if (!ws || ws.view !== 'dashboard') return;

  dash.innerHTML = `
    <div class="wsdash">
      <div class="wsdash-map">
        <div class="wsdash-map-canvas" id="wsmap-canvas"></div>
        <div class="wsdash-legend">
          <span class="lg"><span class="dot st-working"></span>working</span>
          <span class="lg"><span class="dot st-idle"></span>idle</span>
          <span class="lg"><span class="dot st-approval"></span>approval</span>
          <span class="lg"><span class="lg-trace"></span>bus traffic</span>
          <span class="lg"><span class="lg-listen"></span>listens to topic</span>
        </div>
        <div class="wsdash-map-empty hidden" id="wsmap-empty"></div>
      </div>
      <aside class="wsdash-side">
        <section class="side-card">
          <div class="side-title">Terminals
            <span class="side-title-count" id="wsdash-terms-shown"></span>
          </div>
          <div class="side-tiles" id="wsdash-tiles"></div>
          <div class="wsdash-filter">
            <input type="search" id="wsdash-search" class="side-search"
              placeholder="Filter by name or role…" spellcheck="false" />
            <div class="side-chips" id="wsdash-chips">
              <button class="side-chip active" data-f="all">All</button>
              <button class="side-chip" data-f="working">Working</button>
              <button class="side-chip" data-f="idle">Idle</button>
              <button class="side-chip" data-f="approval">Approval</button>
              <button class="side-chip" data-f="off-bus">Off bus</button>
              <button class="side-chip" data-f="exited">Exited</button>
              <button class="side-chip" data-f="saved">Saved</button>
            </div>
          </div>
          <div class="side-rows" id="wsdash-terms"></div>
          <div class="side-empty hidden" id="wsdash-terms-empty">
            No terminals match this filter.
          </div>
          <div class="side-bulk" id="wsdash-bulk"></div>
        </section>
        <section class="side-card">
          <div class="side-title">Awaiting reply
            <span class="side-title-count" id="wsdash-asks-count"></span>
          </div>
          <div class="side-rows" id="wsdash-asks"></div>
          <div class="side-hint">Push types <code>termivin recv --wait 60</code> into the agent — press Enter yourself to run it.</div>
        </section>
        <section class="side-card">
          <div class="side-title">Topics
            <button class="btn btn-ghost btn-sm side-title-btn" id="wsdash-newtopic">+ New</button>
          </div>
          <div class="side-note hidden" id="wsdash-busnote">No agent is on the bus yet — press 🔗 on an agent pane to connect it.</div>
          <div class="side-rows" id="wsdash-topics"></div>
          <div class="side-hint">A topic reaches every agent here; other workspaces reach only its representative.</div>
        </section>
        <section class="side-card">
          <div class="side-title">Tokens today</div>
          <div class="side-tokens" id="wsdash-tokens"></div>
        </section>
        <section class="side-card side-card-feed">
          <div class="side-title">Bus activity</div>
          <div class="side-feed" id="wsdash-feed"></div>
        </section>
      </aside>
    </div>`;

  map = new BusMap(document.getElementById('wsmap-canvas'), {
    mode: 'workspace',
    onNodeClick: (id) => {
      if (id.startsWith('ext:')) hooks.switchWorkspace(id.slice(4));
      else hooks.openInCanvas(id);
    },
  });

  // Wire the Terminals card's search + status chips once. Row rebuilds run on
  // the 1.5s live tick without touching the header, so handlers here survive.
  const search = document.getElementById('wsdash-search');
  search.value = filterQuery;
  search.addEventListener('input', () => {
    filterQuery = search.value.trim().toLowerCase();
    refreshWorkspaceDashboard(true);
  });
  const chipRow = document.getElementById('wsdash-chips');
  for (const chip of chipRow.querySelectorAll('.side-chip')) {
    chip.classList.toggle('active', chip.dataset.f === filterStatus);
    chip.addEventListener('click', () => {
      filterStatus = chip.dataset.f;
      for (const c of chipRow.querySelectorAll('.side-chip')) {
        c.classList.toggle('active', c.dataset.f === filterStatus);
      }
      refreshWorkspaceDashboard(true);
    });
  }

  document.getElementById('wsdash-newtopic').addEventListener('click', async () => {
    const name = await hooks.uiPrompt(
      'Topic name (agents everywhere can reach it as #name):',
      { title: 'New topic', okLabel: 'Create' });
    if (!name) return;
    const res = await window.termivin.busTopicCreate({ name, spaceId: ws.id });
    if (!res.ok) await hooks.uiAlert(res.error, { title: 'Could not create topic' });
    refreshWorkspaceDashboard(true);
  });

  refreshWorkspaceDashboard(true);
}

// Light refresh — called from the 1.5s live tick while the view is open.
export async function refreshWorkspaceDashboard(force = false) {
  const ws = S.activeWorkspace();
  if (!ws || ws.view !== 'dashboard') return;
  if (!document.getElementById('wsmap-canvas')) return renderWorkspaceDashboard();
  if (refreshing && !force) return;
  refreshing = true;
  try {
    const [stats, proc, tok] = await Promise.all([getBusStats(), getProcStats(), getTokens()]);
    drawMap(ws, stats);
    drawTiles(ws, proc);
    drawTermRows(ws, proc, tok, stats);
    drawBulkActions(ws, stats);
    drawAwaitingReply(ws, stats);
    drawTopics(ws, stats);
    drawTokens(ws, tok);
    drawFeed(ws, stats);
  } finally {
    refreshing = false;
  }
}

function agentInfo(stats, termId) {
  return stats.agents.find((a) => a.id === termId) || null;
}

function drawMap(ws, stats) {
  const termIds = new Set(ws.terminals.map((t) => t.id));
  const nodes = ws.terminals.map((t) => {
    const info = typeInfo(t.external ? 'external' : t.type);
    const a = agentInfo(stats, t.id);
    const traffic = a ? a.traffic : { sent: 0, recv: 0 };
    const role = a && a.role;
    // "On the bus" is anything the bus has actually touched: a registered
    // role, past traffic, or mail waiting. Every Termivin terminal hears
    // topic broadcasts, so a node with traces must never read as offline.
    const onBus = !!(a && (a.registered || a.pending || traffic.sent + traffic.recv > 0));
    return {
      id: t.id,
      label: t.name,
      icon: info.icon,
      color: info.color,
      status: TM.getStatus(t.id),
      sub: role || (onBus ? 'on the bus' : t.external ? 'external window' : 'off the bus'),
      badge: a && a.pending ? '✉ ' + a.pending : null,
      dim: !onBus,
      // Distinguishes "in my workspace but not on the bus" from external chips
      // (which are dim too but read differently — accent color + ⇄ icon).
      offBus: !onBus && !t.external,
      title: `${t.name}\n${info.label}${role ? '\nrole: ' + role : ''}\nsent ${traffic.sent} · received ${traffic.recv}\n${onBus ? '' : '(not on the bus — press 🔗 on the pane to connect)\n'}click to open in canvas`,
    };
  });

  // aggregate cross-workspace traffic into one dim chip per other workspace
  const extLinks = new Map(); // spaceId -> { name, count, peer }
  const links = [];
  const seenPairs = new Set();
  for (const l of stats.links) {
    const aIn = termIds.has(l.from);
    const bIn = termIds.has(l.to);
    if (aIn && bIn) {
      const k = l.from < l.to ? l.from + '|' + l.to : l.to + '|' + l.from;
      if (seenPairs.has(k)) {
        const existing = links.find((x) => (x.a + '|' + x.b === k) || (x.b + '|' + x.a === k));
        if (existing) existing.count += l.count;
      } else {
        seenPairs.add(k);
        links.push({ a: l.from, b: l.to, count: l.count, kind: 'traffic' });
      }
    } else if (aIn || bIn) {
      const local = aIn ? l.from : l.to;
      const remote = aIn ? l.to : l.from;
      const rInfo = stats.agents.find((x) => x.id === remote);
      const spaceId = rInfo ? rInfo.space : 'unknown';
      const cur = extLinks.get(spaceId) || {
        name: rInfo ? rInfo.spaceName : 'other workspace', count: 0, locals: new Map(),
      };
      cur.count += l.count;
      cur.locals.set(local, (cur.locals.get(local) || 0) + l.count);
      extLinks.set(spaceId, cur);
    }
  }
  for (const [spaceId, x] of extLinks) {
    const id = 'ext:' + spaceId;
    nodes.push({
      id,
      label: x.name,
      icon: '⇄',
      color: '#b48ce8',
      status: 'attached',
      sub: 'other workspace',
      dim: true,
      title: `Cross-workspace traffic with "${x.name}"\nclick to switch there`,
    });
    for (const [local, count] of x.locals) {
      links.push({ a: local, b: id, count, kind: 'traffic' });
    }
  }

  // topics of this workspace as central bus bars; the hub itself signals "every
  // agent here hears it", so no dashed listen line per agent is drawn — a
  // full-mesh of dashed lines converging on one hub turns the map into
  // spaghetti even with only a handful of agents. The only per-topic wire we
  // still draw is a single subtle "rep" line so the representative is visible
  // without having to read the sub-text.
  const hubs = stats.topics
    .filter((t) => t.spaceId === ws.id)
    .map((t) => ({
      id: 'topic:' + t.id,
      label: t.name,
      sub: t.effectiveRepName ? 'rep: ' + t.effectiveRepName : 'no representative',
      title: `#${t.name}\nEvery agent here hears it; outside workspaces reach ${t.effectiveRepName || '(nobody)'}.`,
    }));
  for (const t of stats.topics.filter((t) => t.spaceId === ws.id)) {
    if (t.effectiveRepId && termIds.has(t.effectiveRepId)) {
      links.push({ a: t.effectiveRepId, b: 'topic:' + t.id, count: 0, kind: 'rep' });
    }
  }

  map.render(nodes, hubs, links);
  map.topicByName = Object.fromEntries(
    stats.topics.filter((t) => t.spaceId === ws.id).map((t) => [t.name, 'topic:' + t.id]));

  // The centered overlay only appears when the map is truly empty (nothing it
  // could cover); the "nobody on the bus" nudge lives in the side panel.
  const empty = document.getElementById('wsmap-empty');
  if (!ws.terminals.length) {
    empty.classList.remove('hidden');
    empty.textContent = 'No terminals yet — create one to see it on the map.';
  } else {
    empty.classList.add('hidden');
  }
  const note = document.getElementById('wsdash-busnote');
  if (note) {
    const anyOnBus = stats.agents.some((a) => a.space === ws.id &&
      (a.registered || a.pending || (a.traffic && a.traffic.sent + a.traffic.recv > 0)));
    note.classList.toggle('hidden', anyOnBus);
  }
}

function drawTiles(ws, proc) {
  const box = document.getElementById('wsdash-tiles');
  let working = 0, idle = 0, approval = 0, off = 0;
  for (const t of ws.terminals) {
    const st = TM.getStatus(t.id);
    if (st === 'working') working++;
    else if (st === 'idle' || st === 'attached') idle++;
    else if (st === 'approval') approval++;
    else off++;
  }
  let cpu = 0, mem = 0;
  for (const t of ws.terminals) {
    const s = proc.byKey[t.id];
    if (s) { cpu += s.cpu; mem += s.mem; }
  }
  box.innerHTML = '';
  const tile = (label, value, cls = '') => {
    const d = el('div', 'side-tile ' + cls);
    d.append(el('div', 'side-tile-v', String(value)), el('div', 'side-tile-l', label));
    box.appendChild(d);
  };
  tile('total', ws.terminals.length);
  tile('working', working, working ? 'tile-working' : '');
  tile('idle', idle, idle ? 'tile-idle' : '');
  tile('approval', approval, approval ? 'tile-approval' : '');
  tile('off', off);
  tile('CPU', fmtPct(cpu), '');
  tile('RAM', fmtMem(mem), '');
}

// Does a terminal pass the current search + status filter? Kept separate so
// bulk actions can reuse it — "Stop all idle" respects the filter chip.
function matchesFilter(t, agentInfoMap) {
  const st = TM.getStatus(t.id);
  const a = agentInfoMap.get(t.id) || null;
  const traffic = a ? a.traffic : { sent: 0, recv: 0 };
  const onBus = !!(a && (a.registered || a.pending || traffic.sent + traffic.recv > 0));
  if (filterStatus !== 'all') {
    if (filterStatus === 'off-bus') {
      if (t.external || onBus || !isAgentType(t.type)) return false;
    } else if (filterStatus !== st) {
      return false;
    }
  }
  if (filterQuery) {
    const hay = (t.name + ' ' + (a && a.role ? a.role : '')).toLowerCase();
    if (!hay.includes(filterQuery)) return false;
  }
  return true;
}

function drawTermRows(ws, proc, tok, stats) {
  const box = document.getElementById('wsdash-terms');
  const empty = document.getElementById('wsdash-terms-empty');
  const countEl = document.getElementById('wsdash-terms-shown');
  box.innerHTML = '';
  const agentInfoMap = new Map((stats.agents || []).map((a) => [a.id, a]));
  const filtered = ws.terminals.filter((t) => matchesFilter(t, agentInfoMap));

  if (countEl) {
    // "3 of 12" when a filter is on; just the total when nothing is filtered.
    const showing = filtered.length;
    const total = ws.terminals.length;
    countEl.textContent = (filterQuery || filterStatus !== 'all') && showing !== total
      ? `${showing} of ${total}` : total ? String(total) : '';
  }

  if (!filtered.length) {
    empty.classList.remove('hidden');
    empty.textContent = ws.terminals.length
      ? 'No terminals match this filter.'
      : 'No terminals yet — create one to see it here.';
    return;
  }
  empty.classList.add('hidden');

  for (const t of filtered) {
    const info = typeInfo(t.external ? 'external' : t.type);
    const st = TM.getStatus(t.id);
    const s = proc.byKey[t.id];
    const a = agentInfoMap.get(t.id);
    const traffic = a ? a.traffic : { sent: 0, recv: 0 };
    const onBus = !!(a && (a.registered || a.pending || traffic.sent + traffic.recv > 0));

    const row = el('div', 'side-row');
    const dot = el('span', 'dot st-' + st);
    const icon = el('span', 'side-row-icon', info.icon);
    icon.style.color = info.color;
    const name = el('span', 'side-row-name', t.name);
    const metrics = el('span', 'side-row-metrics',
      s ? `${fmtPct(s.cpu)} · ${fmtMem(s.mem)}` : '—');
    row.append(dot, icon, name, metrics);

    if (st === 'approval') {
      // quick approve/deny without leaving the map
      const yes = el('button', 'btn btn-approve btn-sm side-approve', '✓');
      yes.title = 'Approve';
      yes.addEventListener('click', (e) => {
        e.stopPropagation();
        TM.approve(t.id, true);
        refreshWorkspaceDashboard(true);
      });
      const no = el('button', 'btn btn-deny btn-sm side-approve', '✗');
      no.title = 'Deny';
      no.addEventListener('click', (e) => {
        e.stopPropagation();
        TM.approve(t.id, false);
        refreshWorkspaceDashboard(true);
      });
      row.append(yes, no);
      row.classList.add('side-row-approval');
    }

    // Per-row ⋯ button — opens a menu with all the pane-level actions so the
    // dashboard is enough to manage many agents without opening each pane.
    const more = el('button', 'side-row-more', '⋯');
    more.title = 'Actions';
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      openAgentRowMenu(t.id, more, { onBus, isRunning: TM.isRunning(t.id), meta: t, agent: a });
    });
    row.append(more);

    const tips = [
      t.name,
      info.label + (a && a.role ? ' · ' + a.role : ''),
      onBus
        ? `sent ${traffic.sent} · received ${traffic.recv}` + (a && a.pending ? ` · ${a.pending} unread` : '')
        : (isAgentType(t.type) && !t.external ? 'not on the bus' : ''),
      'click to open in canvas',
    ].filter(Boolean);
    row.title = tips.join('\n');
    row.addEventListener('click', () => hooks.openInCanvas(t.id));
    box.appendChild(row);
  }
}

// Small action menu anchored under the ⋯ button on a terminal row. Same
// closing dance as the pane's ⋯ menu — a second click on the same anchor
// toggles, any outside click dismisses.
function openAgentRowMenu(termId, anchor, ctx) {
  const reopening = rowMenuTermId === termId;
  closeRowMenu();
  if (reopening) return;

  // Distinct class from ui.js's .pane-menu so closeRowMenu() below never rips
  // an open pane menu off the DOM as a side effect. Styling piggybacks on
  // .pane-menu via a shared selector in styles.css.
  const menu = el('div', 'pane-menu dash-row-menu');
  const add = (label, fn, danger = false) => {
    const item = el('button', 'pane-menu-item' + (danger ? ' pane-menu-danger' : ''), label);
    item.addEventListener('click', () => {
      closeRowMenu();
      fn();
    });
    menu.appendChild(item);
  };

  const meta = ctx.meta;
  add('👁   Open in canvas', () => hooks.openInCanvas(termId));
  add('✎   Rename…', () => hooks.renameTerm(termId));
  if (!meta.external && isAgentType(meta.type)) {
    if (ctx.agent && ctx.agent.pending) {
      add(`📬   Push (${ctx.agent.pending} unread)`, () => hooks.nudgeAgent(termId));
    } else {
      add('📬   Push recv into pane', () => hooks.nudgeAgent(termId));
    }
    if (!ctx.onBus) add('🔗   Connect to bus', () => hooks.connectAgent(termId));
  }
  menu.appendChild(el('div', 'pane-menu-sep'));
  if (!meta.external) {
    if (ctx.isRunning) {
      add('■   Stop process', () => hooks.stopTerm(termId));
    } else {
      add('↻   Restart', () => hooks.restartTerm(termId));
    }
  }
  const cwd = meta.cwd;
  if (cwd) add('📁   Open folder', () => hooks.revealFolder(cwd));
  menu.appendChild(el('div', 'pane-menu-sep'));
  add('✕   Remove terminal', () => hooks.removeTerm(termId), true);

  document.body.appendChild(menu);
  rowMenuTermId = termId;

  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  menu.style.left = Math.max(6, Math.min(r.right - w, window.innerWidth - w - 6)) + 'px';
  menu.style.top = Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 6) + 'px';

  rowMenuOutside = (e) => {
    if (menu.contains(e.target) || e.target === anchor) return;
    closeRowMenu();
  };
  window.addEventListener('mousedown', rowMenuOutside, true);
}

function closeRowMenu() {
  document.querySelectorAll('.dash-row-menu').forEach((m) => m.remove());
  rowMenuTermId = null;
  if (rowMenuOutside) {
    window.removeEventListener('mousedown', rowMenuOutside, true);
    rowMenuOutside = null;
  }
}

// Common one-click ops surfaced at the bottom of the Terminals card. Only
// buttons whose target set is non-empty are drawn — a "Restore 0 saved" would
// just be noise. Every bulk button is gated on a uiConfirm so a stray click
// on an eleven-agent workspace never nukes work by accident.
function drawBulkActions(ws, stats) {
  const box = document.getElementById('wsdash-bulk');
  if (!box) return;
  box.innerHTML = '';
  const agentInfoMap = new Map((stats.agents || []).map((a) => [a.id, a]));
  const isAgent = (t) => !t.external && isAgentType(t.type);

  const savedAgents = ws.terminals.filter((t) => isAgent(t) && !TM.isRunning(t.id));
  const mailAgents = ws.terminals.filter((t) => {
    const a = agentInfoMap.get(t.id);
    return isAgent(t) && TM.isRunning(t.id) && a && a.pending > 0;
  });
  const offBusAgents = ws.terminals.filter((t) => {
    const a = agentInfoMap.get(t.id);
    const traffic = a ? a.traffic : { sent: 0, recv: 0 };
    const onBus = !!(a && (a.registered || a.pending || traffic.sent + traffic.recv > 0));
    return isAgent(t) && TM.isRunning(t.id) && !onBus;
  });

  const btn = (label, cls, onClick) => {
    const b = el('button', 'btn btn-sm side-bulk-btn ' + cls, label);
    b.addEventListener('click', onClick);
    return b;
  };

  if (savedAgents.length) {
    box.appendChild(btn(`⚡ Restore ${savedAgents.length} saved`, 'btn-primary',
      async () => {
        const ok = await hooks.uiConfirm(
          `Restore ${savedAgents.length} saved terminal(s) with their restore command?`,
          { title: 'Restore all saved', okLabel: 'Restore' });
        if (!ok) return;
        for (const t of savedAgents) await TM.spawnTerminal(t, { useRestore: true });
        hooks.renderAll();
      }));
  }
  if (mailAgents.length) {
    box.appendChild(btn(`📬 Push ${mailAgents.length} with mail`, 'btn-primary',
      async () => {
        const ok = await hooks.uiConfirm(
          `Type "termivin recv --wait 60" into ${mailAgents.length} agent pane(s)? The command is typed but not submitted — press Enter yourself in each pane.`,
          { title: 'Push all with unread mail', okLabel: 'Push all' });
        if (!ok) return;
        for (const t of mailAgents) await hooks.nudgeAgent(t.id);
      }));
  }
  if (offBusAgents.length) {
    box.appendChild(btn(`🔗 Connect ${offBusAgents.length} off-bus`, 'btn-ghost',
      async () => {
        const ok = await hooks.uiConfirm(
          `Type the bus connect prompt into ${offBusAgents.length} agent pane(s) that aren't registered yet? The prompt is typed but not submitted.`,
          { title: 'Connect all off-bus', okLabel: 'Connect all' });
        if (!ok) return;
        for (const t of offBusAgents) await hooks.connectAgent(t.id);
      }));
  }
}

// Open asks (kind='ask' the recipient hasn't replied to yet) + agents with
// unread mail waiting in their bus queue. Every row has a Push button that
// types `termivin recv --wait 60` into the recipient's pane — the fix for the
// "agent stops responding after a while" problem, which really is "the agent
// forgot to poll and the message is sitting in its queue unread".
function drawAwaitingReply(ws, stats) {
  const box = document.getElementById('wsdash-asks');
  const countEl = document.getElementById('wsdash-asks-count');
  if (!box) return;
  box.innerHTML = '';
  const termIds = new Set(ws.terminals.map((t) => t.id));
  const asks = (stats.openAsks || []).filter(
    (a) => termIds.has(a.to) || termIds.has(a.from));
  // Roll in "has unread mail but no explicit ask waiting" so the same panel
  // covers both cases: an outright question, and a note that just piled up.
  const seenAgents = new Set(asks.map((a) => a.to));
  const mailOnly = stats.agents.filter(
    (a) => a.space === ws.id && a.pending > 0 && !seenAgents.has(a.id));

  const total = asks.length + mailOnly.length;
  if (countEl) countEl.textContent = total ? String(total) : '';
  if (!total) {
    box.appendChild(el('div', 'side-empty', 'No pending questions or unread messages.'));
    return;
  }

  const nudgeableInWorkspace = (termId) => termIds.has(termId);

  for (const a of asks) {
    const row = el('div', 'side-ask');
    const dot = el('span', 'dot ask-dot');
    const who = el('div', 'side-ask-who');
    who.append(
      el('span', 'side-ask-from', a.fromName || '?'),
      el('span', 'side-ask-arrow', ' → '),
      el('span', 'side-ask-to', a.toName || '?'));
    const meta = el('div', 'side-ask-meta',
      (a.subject ? a.subject + ' · ' : '') + 'waiting ' + fmtAgo(a.ts));
    if (a.body) meta.title = a.body;
    const info = el('div', 'side-ask-info');
    info.append(who, meta);
    row.append(dot, info);
    if (nudgeableInWorkspace(a.to)) {
      const push = el('button', 'btn btn-primary btn-sm side-ask-push', '📬 Push');
      push.title = `Type 'termivin recv --wait 60' into ${a.toName || 'the agent'}'s pane`;
      push.addEventListener('click', (e) => {
        e.stopPropagation();
        hooks.nudgeAgent(a.to);
      });
      row.append(push);
    } else {
      row.append(el('span', 'side-ask-remote', 'other workspace'));
    }
    box.appendChild(row);
  }

  for (const a of mailOnly) {
    const row = el('div', 'side-ask');
    const dot = el('span', 'dot ask-dot ask-dot-mail');
    const who = el('div', 'side-ask-who');
    who.append(
      el('span', 'side-ask-to', a.name || '?'),
      el('span', 'side-ask-arrow', ' has '),
      el('span', 'side-ask-from', String(a.pending) + ' unread'));
    const meta = el('div', 'side-ask-meta', 'message(s) sitting in their bus queue');
    const info = el('div', 'side-ask-info');
    info.append(who, meta);
    row.append(dot, info);
    const push = el('button', 'btn btn-primary btn-sm side-ask-push', '📬 Push');
    push.title = `Type 'termivin recv --wait 60' into ${a.name}'s pane`;
    push.addEventListener('click', (e) => {
      e.stopPropagation();
      hooks.nudgeAgent(a.id);
    });
    row.append(push);
    box.appendChild(row);
  }
}

function drawTopics(ws, stats) {
  const box = document.getElementById('wsdash-topics');
  box.innerHTML = '';
  const agents = ws.terminals.filter((t) => !t.external && isAgentType(t.type));
  const topics = stats.topics.filter((t) => t.spaceId === ws.id);
  if (!topics.length) {
    box.appendChild(el('div', 'side-empty', 'No topics yet.'));
    return;
  }
  for (const t of topics) {
    const row = el('div', 'side-topic');
    const name = el('span', 'side-topic-name', '#' + t.name);
    const repSel = document.createElement('select');
    repSel.className = 'side-topic-rep';
    repSel.title = 'Representative — speaks for this workspace to the outside';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'rep: auto' + (t.repId ? '' : t.effectiveRepName ? ` (${t.effectiveRepName})` : '');
    repSel.appendChild(auto);
    for (const a of agents) {
      const o = document.createElement('option');
      o.value = a.id;
      o.textContent = 'rep: ' + a.name;
      if (t.repId === a.id) o.selected = true;
      repSel.appendChild(o);
    }
    repSel.addEventListener('change', async () => {
      await window.termivin.busTopicUpdate(t.id, { repId: repSel.value || null });
      refreshWorkspaceDashboard(true);
    });
    const del = el('button', 'side-topic-del', '×');
    del.title = 'Delete topic';
    del.addEventListener('click', async () => {
      if (await hooks.uiConfirm(`Delete topic #${t.name}?`, { title: 'Delete topic', okLabel: 'Delete', danger: true })) {
        await window.termivin.busTopicDelete(t.id);
        refreshWorkspaceDashboard(true);
      }
    });
    row.append(name, repSel, del);
    box.appendChild(row);
  }
}

function drawTokens(ws, tok) {
  const box = document.getElementById('wsdash-tokens');
  box.innerHTML = '';
  if (!tok) {
    box.appendChild(el('div', 'side-empty', 'No usage data.'));
    return;
  }
  const cwds = new Set(ws.terminals.map((t) => normCwd(t.cwd)).filter(Boolean));
  let claude = null;
  let codex = null;
  for (const [cwd, u] of Object.entries(tok.claude?.byCwd || {})) {
    if (cwds.has(cwd)) claude = addU(claude, u);
  }
  for (const [cwd, u] of Object.entries(tok.codex?.byCwd || {})) {
    if (cwds.has(cwd)) codex = addU(codex, u);
  }
  const row = (label, cls, u) => {
    const r = el('div', 'side-token-row');
    r.append(el('span', 'side-token-brand ' + cls, label));
    if (!u || !u.total) {
      r.append(el('span', 'side-token-val', 'no usage today'));
    } else {
      r.append(el('span', 'side-token-val',
        `${fmtTokens(u.total)} total · ${fmtTokens(u.output)} out · ${fmtTokens(u.cacheRead)} cached`));
    }
    box.appendChild(r);
  };
  row('✳ Claude', 'brand-claude', claude);
  row('◆ Codex', 'brand-codex', codex);
  box.appendChild(el('div', 'side-hint', 'From this workspace\'s project folders, today.'));
}

function addU(acc, u) {
  if (!acc) acc = { total: 0, output: 0, cacheRead: 0 };
  acc.total += u.total || 0;
  acc.output += u.output || 0;
  acc.cacheRead += u.cacheRead || 0;
  return acc;
}

function drawFeed(ws, stats) {
  const box = document.getElementById('wsdash-feed');
  const rows = stats.recent
    .filter((m) => m.fromSpace === ws.id || m.toSpace === ws.id)
    .slice(-9)
    .reverse();
  box.innerHTML = '';
  if (!rows.length) {
    box.appendChild(el('div', 'side-empty', 'No messages yet this session.'));
    return;
  }
  for (const m of rows) {
    const row = el('div', 'feed-row');
    const when = el('span', 'feed-when', fmtAgo(m.ts));
    const what = el('span', 'feed-what');
    const topic = m.topic ? ` #${m.topic}` : '';
    const cross = m.fromSpace !== m.toSpace ? ' ⇄' : '';
    what.textContent = `${m.fromName} → ${m.toName}${topic}${cross}`;
    if (m.subject) what.title = m.subject;
    row.append(when, what);
    box.appendChild(row);
  }
}

// Live pulse from a bus event (wired by ui.js).
export function pulseWorkspaceMap(evt) {
  const ws = S.activeWorkspace();
  if (!ws || ws.view !== 'dashboard' || !map || evt.type !== 'msg') return;
  const termIds = new Set(ws.terminals.map((t) => t.id));
  let a = evt.from;
  let b = evt.to;
  if (!termIds.has(a) && evt.fromSpace) a = 'ext:' + evt.fromSpace;
  if (!termIds.has(b) && evt.toSpace) b = 'ext:' + evt.toSpace;
  if (!termIds.has(evt.from) && !termIds.has(evt.to)) return;
  // topic messages route visually through their bus bar
  const hubId = evt.topic && map.topicByName ? map.topicByName[evt.topic] : null;
  if (hubId && map.pos.has(hubId)) {
    map.pulse(a, hubId);
    setTimeout(() => map.pulse(hubId, b), 450);
  } else {
    map.pulse(a, b);
  }
}
