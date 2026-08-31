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
      nodes.map((n) => [n.id, n.label, n.sub, n.status, n.badge, n.dim, n.offBus]),
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
    const hubW = isGlobal ? 150 : 168;
    const hubH = 34;

    // --- layout: hubs in the middle, nodes on a ring ----------------------
    // Keep the ring compact: just big enough that chips don't collide, never
    // stretched to the container edges — a wide window otherwise flings the
    // nodes apart until the map stops reading as one network. When a hub sits
    // in the middle, force rx large enough that a chip at the horizontal
    // midline can't overlap the bus bar; and use a start angle that keeps the
    // 3 and 9 o'clock slots away from the hub whenever we can avoid them.
    const availRx = Math.max(120, w / 2 - nodeW / 2 - 28);
    const availRy = Math.max(90, h / 2 - nodeH / 2 - 30);
    const needed = (nodes.length * (nodeW + 44)) / (2 * Math.PI);
    const hubClearanceX = hubs.length ? hubW / 2 + nodeW / 2 + 20 : 0;
    const rx = Math.min(availRx, Math.max(210, needed * 1.35, hubClearanceX));
    const ry = Math.min(availRy, Math.max(140, needed * 0.95));
    // Few nodes read better spread horizontally (two chips side by side, not
    // stacked on the hub); rings only pay off from ~3 nodes up. When a hub is
    // present the ring skips 12 o'clock as the seed and rotates a half-slot,
    // so nodes flank the hub instead of landing on top of it or right beside
    // it at the horizontal midline where labels would collide with the bar.
    let startAngle;
    if (nodes.length <= 2) startAngle = Math.PI;
    else if (hubs.length) startAngle = -Math.PI / 2 + Math.PI / Math.max(3, nodes.length);
    else startAngle = -Math.PI / 2;
    nodes.forEach((n, i) => {
      const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2 + startAngle;
      this.pos.set(n.id, {
        x: cx + (nodes.length === 1 ? 0 : Math.cos(angle) * rx),
        y: cy + (nodes.length === 1 ? 0 : Math.sin(angle) * ry * 0.86),
      });
    });
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
      const bend = l.kind === 'traffic' ? Math.min(46, len * 0.16) : 0;
      const nx = (-dy / len) * bend;
      const ny = (dx / len) * bend;
      const d = `M ${pa.x} ${pa.y} Q ${mx + nx} ${my + ny} ${pb.x} ${pb.y}`;
      let cls = 'bm-trace';
      let width = 1;
      if (l.kind === 'rep') {
        cls += ' bm-rep';
        width = 1.4;
      } else if (l.kind === 'listen') {
        cls += ' bm-listen';
        width = 1;
      } else {
        width = Math.min(5, 1.4 + Math.log2(1 + (l.count || 0)));
        if ((l.count || 0) > 0) cls += ' bm-active';
      }
      const path = sel('path', { d, class: cls, 'stroke-width': width });
      if (l.kind === 'traffic' && (l.count || 0) > 0) path.setAttribute('filter', 'url(#bm-glow)');
      gTraces.appendChild(path);
      this.paths.set(linkKey(l.a, l.b), { el: path, from: l.a, to: l.b });
      if (l.kind === 'traffic' && l.count > 1) {
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
      let cls = 'bm-node';
      if (n.dim) cls += ' bm-dim';
      if (n.offBus) cls += ' bm-off';
      const g = sel('g', {
        class: cls,
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
      // Off-bus chips drop the accent color so the whole chip reads grey; the
      // status LED still keeps its own color so working/approval remains loud.
      if (n.color && !n.offBus) icon.setAttribute('fill', n.color);
      g.appendChild(icon);
      // Reserve the badge's slot when truncating the name, otherwise the
      // badge lands on top of half the label ("GlobalMonito…" underneath "3").
      const badgeTxt = n.badge ? String(n.badge) : '';
      const badgeW = badgeTxt ? Math.max(18, 8 + badgeTxt.length * 7) : 0;
      const nameAvail = nodeW - 44 - (badgeW ? badgeW + 12 : 8);
      // ~7px per glyph in the mono face at 12px — err on the tighter side.
      const nameMax = Math.max(4, Math.floor(nameAvail / 7));
      const nameTxt = n.label.length > nameMax ? n.label.slice(0, nameMax - 1) + '…' : n.label;
      const name = sel('text', { x: 44, y: 20, class: 'bm-node-name' });
      name.textContent = nameTxt;
      g.appendChild(name);
      // sub line (role / counts)
      if (n.sub) {
        const sub = sel('text', { x: 15, y: isGlobal ? 42 : 40, class: 'bm-node-sub' });
        const subMax = Math.max(6, Math.floor((nodeW - 30) / 7));
        sub.textContent = n.sub.length > subMax ? n.sub.slice(0, subMax - 1) + '…' : n.sub;
        g.appendChild(sub);
      }
      if (isGlobal && n.sub2) {
        const sub2 = sel('text', { x: 15, y: 62, class: 'bm-node-sub2' });
        sub2.textContent = n.sub2;
        g.appendChild(sub2);
      }
      // mail / count badge in the corner (width follows the text)
      if (badgeTxt) {
        const bg = sel('g', { transform: `translate(${nodeW - badgeW - 6}, 7)` });
        bg.appendChild(sel('rect', { width: badgeW, height: 15, rx: 7.5, class: 'bm-badge' }));
        const bt = sel('text', { x: badgeW / 2, y: 11, 'text-anchor': 'middle', class: 'bm-badge-text' });
        bt.textContent = badgeTxt;
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
