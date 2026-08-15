// The communication map: an SVG "circuit board" shared by the workspace
// dashboard (chips = terminals, bus bars = topics) and the home dashboard
// (chips = workspaces). Nodes sit on a ring around the topic hubs; links are
// glowing traces whose weight follows message volume, and live messages fire
// a signal dot along their trace (pulse()).
//
// Pure view module: callers hand it nodes/hubs/links and callbacks, it owns
// only the SVG. No app state is read here.

const NS = 'http://www.w3.org/2000/svg';

function sel(tag, attrs = {}) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

const STATUS_COLOR = {
  working: '#4e9af5',
  idle: '#3fb26f',
  approval: '#e8a13c',
  exited: '#e05d5d',
  saved: '#5c6773',
  attached: '#b48ce8',
};

// Stable key for a link regardless of direction (traces are undirected; the
// signal dot supplies the direction).
export function linkKey(a, b) {
  return a < b ? a + '|' + b : b + '|' + a;
}

export class BusMap {
  // opts: { mode: 'workspace'|'global', onNodeClick(id), onHubClick(id) }
  constructor(container, opts = {}) {
    this.container = container;
    this.opts = opts;
    this.svg = null;
    this.pos = new Map(); // nodeId/hubId -> {x, y}
    this.paths = new Map(); // linkKey -> path element
    this.nodeEls = new Map();
    this.lastSignature = '';
  }

  // nodes: [{ id, label, sub, icon, color, status, badge, dim, title }]
  // hubs:  [{ id, label, sub, title }]  (topics / relays — drawn as bus bars)
  // links: [{ a, b, count, kind: 'traffic'|'listen' }]
  render(nodes, hubs, links) {
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 500;
    // Skip the rebuild when nothing structural changed — pulses survive and
    // the DOM stays stable under the 1.5s refresh tick.
    const signature = JSON.stringify([
      w, h,
      nodes.map((n) => [n.id, n.label, n.sub, n.status, n.badge, n.dim]),
      hubs.map((t) => [t.id, t.label, t.sub]),
      links.map((l) => [l.a, l.b, l.count, l.kind]),
    ]);
    if (signature === this.lastSignature && this.svg) return;
    this.lastSignature = signature;

    this.container.innerHTML = '';
    this.pos.clear();
    this.paths.clear();
    this.nodeEls.clear();

    const svg = sel('svg', { viewBox: `0 0 ${w} ${h}`, class: 'busmap-svg' });
    this.svg = svg;
    this.container.appendChild(svg);

    const defs = sel('defs');
    defs.innerHTML = `
      <filter id="bm-glow" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="3.5" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <filter id="bm-soft" x="-40%" y="-40%" width="180%" height="180%">
        <feDropShadow dx="0" dy="3" stdDeviation="6" flood-color="#000" flood-opacity="0.45"/>
      </filter>`;
    svg.appendChild(defs);

    const gTraces = sel('g', { class: 'bm-traces' });
    const gPulses = sel('g', { class: 'bm-pulses' });
    const gNodes = sel('g', { class: 'bm-nodes' });
    svg.append(gTraces, gPulses, gNodes);
    this.gPulses = gPulses;

    const cx = w / 2;
    const cy = h / 2;
    const isGlobal = this.opts.mode === 'global';
    const nodeW = isGlobal ? 188 : 156;
    const nodeH = isGlobal ? 84 : 56;

    // --- layout: hubs in the middle, nodes on a ring ----------------------
    // Keep the ring compact: just big enough that chips don't collide, never
    // stretched to the container edges — a wide window otherwise flings the
    // nodes apart until the map stops reading as one network.
    const availRx = Math.max(120, w / 2 - nodeW / 2 - 28);
    const availRy = Math.max(90, h / 2 - nodeH / 2 - 30);
    const needed = (nodes.length * (nodeW + 44)) / (2 * Math.PI);
    const rx = Math.min(availRx, Math.max(210, needed * 1.35));
    const ry = Math.min(availRy, Math.max(140, needed * 0.95));
    // Few nodes read better spread horizontally (two chips side by side, not
    // stacked on the hub); rings only pay off from ~3 nodes up.
    const startAngle = nodes.length <= 2 ? Math.PI : -Math.PI / 2;
    nodes.forEach((n, i) => {
      const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2 + startAngle;
      this.pos.set(n.id, {
        x: cx + (nodes.length === 1 ? 0 : Math.cos(angle) * rx),
        y: cy + (nodes.length === 1 ? 0 : Math.sin(angle) * ry * 0.86),
      });
    });
    const hubW = isGlobal ? 150 : 168;
    const hubH = 34;
    hubs.forEach((t, i) => {
      const n = hubs.length;
      const spread = Math.min(120, (h - 160) / Math.max(1, n));
      this.pos.set(t.id, { x: cx, y: cy + (i - (n - 1) / 2) * (hubH + Math.max(18, spread - hubH)) });
    });

    // --- traces -----------------------------------------------------------
    for (const l of links) {
      const pa = this.pos.get(l.a);
      const pb = this.pos.get(l.b);
      if (!pa || !pb) continue;
      // arc gently away from the center so parallel traces don't stack
      const mx = (pa.x + pb.x) / 2;
      const my = (pa.y + pb.y) / 2;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const len = Math.hypot(dx, dy) || 1;
      const bend = l.kind === 'listen' ? 0 : Math.min(46, len * 0.16);
      const nx = (-dy / len) * bend;
      const ny = (dx / len) * bend;
      const d = `M ${pa.x} ${pa.y} Q ${mx + nx} ${my + ny} ${pb.x} ${pb.y}`;
      const width = l.kind === 'listen' ? 1 : Math.min(5, 1.4 + Math.log2(1 + (l.count || 0)));
      const cls = l.kind === 'listen'
        ? 'bm-trace bm-listen'
        : 'bm-trace' + ((l.count || 0) > 0 ? ' bm-active' : '');
      const path = sel('path', { d, class: cls, 'stroke-width': width });
      if (l.kind !== 'listen' && (l.count || 0) > 0) path.setAttribute('filter', 'url(#bm-glow)');
      gTraces.appendChild(path);
      this.paths.set(linkKey(l.a, l.b), { el: path, from: l.a, to: l.b });
      if (l.count > 1) {
        const label = sel('text', {
          x: mx + nx * 0.75, y: my + ny * 0.75 - 4, class: 'bm-trace-count', 'text-anchor': 'middle',
        });
        label.textContent = l.count;
        gTraces.appendChild(label);
      }
    }

    // --- hubs (topics) as bus bars ---------------------------------------
    for (const t of hubs) {
      const p = this.pos.get(t.id);
      const g = sel('g', { class: 'bm-hub', transform: `translate(${p.x - hubW / 2}, ${p.y - hubH / 2})` });
      g.appendChild(sel('rect', { width: hubW, height: hubH, rx: 17, class: 'bm-hub-body', filter: 'url(#bm-soft)' }));
      // bus-bar stripes on both ends
      for (const x of [10, hubW - 22]) {
        for (let i = 0; i < 3; i++) {
          g.appendChild(sel('rect', { x: x + i * 5, y: hubH / 2 - 5, width: 2.5, height: 10, class: 'bm-hub-pin' }));
        }
      }
      const label = sel('text', { x: hubW / 2, y: hubH / 2 + 4, 'text-anchor': 'middle', class: 'bm-hub-label' });
      label.textContent = '#' + t.label;
      g.appendChild(label);
      if (t.sub) {
        const sub = sel('text', { x: hubW / 2, y: hubH + 14, 'text-anchor': 'middle', class: 'bm-hub-sub' });
        sub.textContent = t.sub;
        g.appendChild(sub);
      }
      if (t.title) {
        const tt = sel('title');
        tt.textContent = t.title;
        g.appendChild(tt);
      }
      g.addEventListener('click', () => this.opts.onHubClick && this.opts.onHubClick(t.id));
      gNodes.appendChild(g);
    }

    // --- nodes as chips ---------------------------------------------------
    for (const n of nodes) {
      const p = this.pos.get(n.id);
      const g = sel('g', {
        class: 'bm-node' + (n.dim ? ' bm-dim' : ''),
        transform: `translate(${p.x - nodeW / 2}, ${p.y - nodeH / 2})`,
      });
      // IC pins along top and bottom edges — the chip-city signature
      const pinN = Math.floor(nodeW / 26);
      for (let i = 0; i < pinN; i++) {
        const px = 14 + i * ((nodeW - 28) / Math.max(1, pinN - 1));
        g.appendChild(sel('rect', { x: px - 1.5, y: -5, width: 3, height: 5, class: 'bm-pin' }));
        g.appendChild(sel('rect', { x: px - 1.5, y: nodeH, width: 3, height: 5, class: 'bm-pin' }));
      }
      g.appendChild(sel('rect', { width: nodeW, height: nodeH, rx: 9, class: 'bm-node-body', filter: 'url(#bm-soft)' }));
      // status LED
      const led = sel('circle', { cx: 15, cy: 16, r: 4.5, class: 'bm-led' });
      led.setAttribute('fill', STATUS_COLOR[n.status] || STATUS_COLOR.saved);
      if (n.status === 'working' || n.status === 'approval') led.classList.add('bm-led-pulse');
      g.appendChild(led);
      // type icon
      const icon = sel('text', { x: 28, y: 20, class: 'bm-node-icon' });
      icon.textContent = n.icon || '';
      if (n.color) icon.setAttribute('fill', n.color);
      g.appendChild(icon);
      // name
      const name = sel('text', { x: 44, y: 20, class: 'bm-node-name' });
      name.textContent = n.label.length > (isGlobal ? 18 : 13) ? n.label.slice(0, isGlobal ? 17 : 12) + '…' : n.label;
      g.appendChild(name);
      // sub line (role / counts)
      if (n.sub) {
        const sub = sel('text', { x: 15, y: isGlobal ? 42 : 40, class: 'bm-node-sub' });
        sub.textContent = n.sub.length > (isGlobal ? 30 : 20) ? n.sub.slice(0, isGlobal ? 29 : 19) + '…' : n.sub;
        g.appendChild(sub);
      }
      if (isGlobal && n.sub2) {
        const sub2 = sel('text', { x: 15, y: 62, class: 'bm-node-sub2' });
        sub2.textContent = n.sub2;
        g.appendChild(sub2);
      }
      // mail / count badge in the corner (width follows the text)
      if (n.badge) {
        const txt = String(n.badge);
        const bw = Math.max(18, 8 + txt.length * 7);
        const bg = sel('g', { transform: `translate(${nodeW - bw - 6}, 7)` });
        bg.appendChild(sel('rect', { width: bw, height: 15, rx: 7.5, class: 'bm-badge' }));
        const bt = sel('text', { x: bw / 2, y: 11, 'text-anchor': 'middle', class: 'bm-badge-text' });
        bt.textContent = txt;
        bg.appendChild(bt);
        g.appendChild(bg);
      }
      if (n.title) {
        const tt = sel('title');
        tt.textContent = n.title;
        g.appendChild(tt);
      }
      g.addEventListener('click', () => this.opts.onNodeClick && this.opts.onNodeClick(n.id));
      gNodes.appendChild(g);
      this.nodeEls.set(n.id, g);
    }
  }

  // Fire a signal dot from a→b along their trace (falls back to a straight
  // line when the pair has no drawn trace yet).
  pulse(a, b) {
    if (!this.svg) return;
    const entry = this.paths.get(linkKey(a, b));
    let path = entry ? entry.el : null;
    let temp = null;
    if (!path) {
      const pa = this.pos.get(a);
      const pb = this.pos.get(b);
      if (!pa || !pb) return;
      temp = sel('path', { d: `M ${pa.x} ${pa.y} L ${pb.x} ${pb.y}`, class: 'bm-trace' });
      temp.style.opacity = '0.35';
      this.svg.querySelector('.bm-traces').appendChild(temp);
      path = temp;
    }
    // animateMotion follows the path's own draw direction; flip via keyPoints
    // when the stored trace was drawn b→a.
    const reversed = entry ? entry.from !== a : false;
    const dot = sel('circle', { r: 4, class: 'bm-signal', filter: 'url(#bm-glow)' });
    const anim = sel('animateMotion', {
      dur: '0.9s',
      fill: 'freeze',
      keyPoints: reversed ? '1;0' : '0;1',
      keyTimes: '0;1',
      calcMode: 'linear',
    });
    const mpath = sel('mpath');
    mpath.setAttributeNS('http://www.w3.org/1999/xlink', 'href', '#' + this.ensurePathId(path));
    anim.appendChild(mpath);
    dot.appendChild(anim);
    this.gPulses.appendChild(dot);
    try { anim.beginElement(); } catch {}
    path.classList.add('bm-hot');
    setTimeout(() => {
      dot.remove();
      if (temp) temp.remove();
      else path.classList.remove('bm-hot');
    }, 1000);
  }

  ensurePathId(path) {
    if (!path.id) path.id = 'bmp_' + Math.random().toString(36).slice(2, 9);
    return path.id;
  }
}
