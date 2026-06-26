/**
 * tagGraph.js — a small, dependency-free force-directed graph renderer for the
 * public /tags page, drawn on a <canvas>.
 *
 * The graph has four node kinds and two edge kinds:
 *   - nodes:  plain tag | year-tag (kind='year') | geo-tag (has lat/long) | post
 *   - edges:  hierarchy (tag→tag parent/child) | membership (post→tag)
 *
 * Node radius scales with degree (number of incident edges). Nodes are
 * draggable; the view supports wheel-zoom, two-finger pinch-zoom, and
 * background-drag pan. Hover (or the search filter) highlights a node and its
 * neighbours and fades the rest; hovering a tag also lights a "second wave"
 * through its posts to the related tags that share them (those related tags get
 * a dashed ring). A first click/tap selects + highlights a node (locking the
 * highlight so you can follow its connections to a related node and click it); a
 * second click/tap on the same node opens it — a tag/year/geo node navigates to
 * /tags/<slug>, a post to /posts/<slug>. Clicking empty space clears it.
 *
 * Zoom is bounded below by "everything fits the viewport" (zooming out further
 * is pointless), and the layout auto-frames itself once it settles.
 *
 * Usage:
 *   const g = new TagGraph(canvasEl, data, { onNavigate, onHover });
 *   g.start();                    // build + run the layout
 *   g.setFilter('japan');         // highlight matching tag nodes
 *   g.setTypeHidden('post', true);// show/hide a node kind (legend toggles)
 *   g.resize();                   // after a container resize
 *   g.destroy();                  // stop the sim + remove listeners
 */

import { tagKind } from '../../utils/tags.js';

// Deterministic PRNG so the initial layout is stable across reloads.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ── Layout / physics constants (world units = CSS px at scale 1) ─────────────
const ALPHA_MIN = 0.001;
const ALPHA_DECAY = 0.0228;
const VELOCITY_DECAY = 0.82;
const REPULSION = 560; // pairwise charge strength (world px²)
const REPULSION_CUTOFF = 340;
const GRAVITY = 0.015;
const HIER_LEN = 110;
const HIER_K = 0.20;
const MEMB_LEN = 66;
const MEMB_K = 0.09;
const COLLIDE_PAD = 8; // extra gap kept between node rims (world px)
const COLLIDE_ITERS = 2;
const TAP_SLOP = 10; // max screen-px drift still counted as a tap (not a drag)

function nodeRadius(type, degree) {
  if (type === 'post') return clamp(2.5 + 1.4 * Math.sqrt(degree), 3, 11);
  // tag / year / geo
  return clamp(5 + 2.2 * Math.sqrt(degree), 6, 36);
}

export class TagGraph {
  constructor(canvas, data, { onNavigate = () => {}, onHover = () => {}, onSelect = () => {} } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onNavigate = onNavigate;
    this.onHover = onHover;
    this.onSelect = onSelect;

    this.nodes = [];
    this.links = [];
    this.nodeById = new Map();
    this.neighbors = new Map(); // node.id -> Set(node.id)

    this.alpha = 1;
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.hovered = null; // mouse hover (highlight + cursor)
    this.selected = null; // click/tap selection: 1st click selects, 2nd opens
    this.dragNode = null;
    this.panning = false;
    this.filterSet = null; // Set of node.id matching the search filter
    this.hiddenTypes = new Set(); // node types toggled off via the legend
    this._pointers = new Map(); // pointerId -> {x,y}, for multi-touch pinch
    this._pinch = null;

    this._aNodes = []; // visible nodes (drives physics / draw / picking)
    this._aLinks = []; // visible links (both endpoints visible)
    this._needFit = true; // fit-to-view once the initial layout settles
    this._userView = false; // true once the user has zoomed/panned manually

    this._rafId = 0;
    this._running = false;
    this._destroyed = false;
    this._colors = this._readColors();

    this._buildGraph(data);
    this._recomputeActive();
    this._bindEvents();
  }

  // ── Graph construction ─────────────────────────────────────────────────────

  _classifyTag(t) {
    return tagKind(t); // year / geo / tag — shared with the pills + Atlas
  }

  _buildGraph(data) {
    const rng = mulberry32(0x9e3779b9);
    const { width, height } = this._cssSize();
    const cx = width / 2;
    const cy = height / 2;
    const spread = Math.min(width, height) * 0.42 || 300;

    const place = (node) => {
      // Phyllotaxis-ish initial scatter for a calm starting state.
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * spread;
      node.x = cx + Math.cos(a) * r;
      node.y = cy + Math.sin(a) * r;
      node.vx = 0;
      node.vy = 0;
      node.degree = 0;
    };

    (data.tags || []).forEach((t) => {
      const node = {
        id: 't' + t.id,
        type: this._classifyTag(t),
        tagId: t.id,
        name: t.name,
        slug: t.slug,
        postCount: t.post_count || 0,
      };
      place(node);
      this.nodes.push(node);
      this.nodeById.set(node.id, node);
    });

    (data.posts || []).forEach((p) => {
      const node = {
        id: 'p' + p.id,
        type: 'post',
        postId: p.id,
        name: p.title || p.slug,
        slug: p.slug,
      };
      place(node);
      this.nodes.push(node);
      this.nodeById.set(node.id, node);
    });

    const addLink = (aId, bId, kind) => {
      const a = this.nodeById.get(aId);
      const b = this.nodeById.get(bId);
      if (!a || !b) return;
      this.links.push({ source: a, target: b, kind });
      a.degree++;
      b.degree++;
      if (!this.neighbors.has(a.id)) this.neighbors.set(a.id, new Set());
      if (!this.neighbors.has(b.id)) this.neighbors.set(b.id, new Set());
      this.neighbors.get(a.id).add(b.id);
      this.neighbors.get(b.id).add(a.id);
    };

    (data.hierarchyEdges || []).forEach((e) => addLink('t' + e.parent, 't' + e.child, 'hierarchy'));
    (data.membershipEdges || []).forEach((e) => addLink('p' + e.post, 't' + e.tag, 'membership'));

    // Radius depends on degree, so compute after all links are in.
    this.nodes.forEach((n) => {
      n.r = nodeRadius(n.type, n.degree);
    });
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  start() {
    this.resize();
    this.alpha = 1;
    // Respect reduced-motion: settle the layout off-screen, then paint once.
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      for (let i = 0; i < 400 && this.alpha > ALPHA_MIN; i++) {
        this.alpha += (0 - this.alpha) * ALPHA_DECAY;
        this._tick();
      }
      this.alpha = 0;
      this._needFit = false;
      this._fitToView();
      return;
    }
    this._kick();
  }

  setFilter(query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) {
      this.filterSet = null;
    } else {
      this.filterSet = new Set();
      for (const n of this.nodes) {
        if (n.type !== 'post' && n.name.toLowerCase().includes(q)) {
          this.filterSet.add(n.id);
        }
      }
    }
    this._draw();
  }

  setTypeHidden(type, hidden) {
    if (hidden) this.hiddenTypes.add(type);
    else this.hiddenTypes.delete(type);
    // Clear interaction state pointing at a now-hidden node.
    if (this.hovered && this.hiddenTypes.has(this.hovered.type)) this.hovered = null;
    if (this.selected && this.hiddenTypes.has(this.selected.type)) {
      this.selected = null;
      this.onSelect(null);
    }
    this._recomputeActive();
    this.alpha = Math.max(this.alpha, 0.25);
    this._kick();
  }

  selectNodeBySlug(slug) {
    if (!slug) {
      if (this.selected) {
        this.selected = null;
        this._draw();
      }
      return null;
    }
    const node = this.nodes.find(n => n.slug === slug && n.type !== 'post');
    if (node && this.selected !== node) {
      this.selected = node;
      this._draw();
    }
    return node;
  }

  getSelectionStats() {
    if (!this.selected) return null;
    const focusData = this._expandFocus([this.selected.id]);
    let tagCount = 0;
    let postCount = 0;
    for (const id of focusData.focus) {
      const n = this.nodeById.get(id);
      if (n) {
        if (n.type === 'post') postCount++;
        else if (n.id !== this.selected.id) tagCount++;
      }
    }
    return { tagCount, postCount };
  }

  zoomBy(factor) {
    const { width, height } = this._cssSize();
    this._zoomAt(width / 2, height / 2, factor);
  }

  resetView() {
    this.alpha = Math.max(this.alpha, 0.3);
    this._needFit = true; // re-fit once it settles again
    this._userView = false; // resume auto-framing
    this._fitToView();
    this._kick();
  }

  resize() {
    const { width, height } = this._cssSize();
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    // Keep everything framed across viewport changes until the user takes over.
    if (this._userView) this._draw();
    else this._fitToView();
  }

  refreshTheme() {
    this._colors = this._readColors();
    this._draw();
  }

  destroy() {
    this._destroyed = true;
    this._running = false;
    cancelAnimationFrame(this._rafId);
    this._unbindEvents();
  }

  // ── Simulation loop ──────────────────────────────────────────────────────────

  _kick() {
    if (this._running || this._destroyed) return;
    this._running = true;
    const loop = () => {
      if (this._destroyed) return;
      const interacting = this.dragNode || this.panning;
      if (this.alpha > ALPHA_MIN || interacting) {
        if (this.alpha > ALPHA_MIN) {
          this.alpha += (0 - this.alpha) * ALPHA_DECAY;
          this._tick();
        }
        this._draw();
        this._rafId = requestAnimationFrame(loop);
      } else {
        this._running = false;
        // Layout has settled: frame everything once so all nodes are visible.
        if (this._needFit) {
          this._needFit = false;
          this._fitToView();
        }
      }
    };
    this._rafId = requestAnimationFrame(loop);
  }

  // ── Active set + zoom-to-fit ──────────────────────────────────────────────────

  _recomputeActive() {
    const hidden = this.hiddenTypes;
    this._aNodes = hidden.size ? this.nodes.filter((n) => !hidden.has(n.type)) : this.nodes;
    this._aLinks = hidden.size
      ? this.links.filter((l) => !hidden.has(l.source.type) && !hidden.has(l.target.type))
      : this.links;
  }

  /** Bounding box (world coords) of the currently visible nodes, or null. */
  _bounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this._aNodes) {
      if (n.x - n.r < minX) minX = n.x - n.r;
      if (n.y - n.r < minY) minY = n.y - n.r;
      if (n.x + n.r > maxX) maxX = n.x + n.r;
      if (n.y + n.r > maxY) maxY = n.y + n.r;
    }
    if (minX === Infinity) return null;
    return { minX, minY, maxX, maxY };
  }

  /**
   * Smallest scale at which every visible node fits in the viewport — this is
   * the minimum zoom (zooming out past "everything visible" is pointless).
   */
  _fitScale() {
    const b = this._bounds();
    if (!b) return 0.2;
    const { width, height } = this._cssSize();
    const margin = 28; // breathing room + label space (screen px)
    const bw = Math.max(b.maxX - b.minX, 1);
    const bh = Math.max(b.maxY - b.minY, 1);
    const s = Math.min((width - margin * 2) / bw, (height - margin * 2) / bh);
    return clamp(s, 0.05, 4);
  }

  /** Center + scale so all visible nodes fit the viewport. */
  _fitToView() {
    const b = this._bounds();
    if (!b) {
      this._draw();
      return;
    }
    const { width, height } = this._cssSize();
    this.scale = this._fitScale();
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    this.tx = width / 2 - cx * this.scale;
    this.ty = height / 2 - cy * this.scale;
    this._draw();
  }

  _tick() {
    const nodes = this._aNodes;
    const { width, height } = this._cssSize();
    const cx = width / 2;
    const cy = height / 2;
    const alpha = this.alpha;

    // Spatial grid for O(n) repulsion + collision.
    const cell = REPULSION_CUTOFF;
    const grid = new Map();
    const key = (gx, gy) => gx + ',' + gy;
    for (const n of nodes) {
      const gx = Math.floor(n.x / cell);
      const gy = Math.floor(n.y / cell);
      const k = key(gx, gy);
      let bucket = grid.get(k);
      if (!bucket) grid.set(k, (bucket = []));
      bucket.push(n);
    }

    // Charge repulsion (nearby cells only).
    for (const n of nodes) {
      const gx = Math.floor(n.x / cell);
      const gy = Math.floor(n.y / cell);
      for (let ix = gx - 1; ix <= gx + 1; ix++) {
        for (let iy = gy - 1; iy <= gy + 1; iy++) {
          const bucket = grid.get(key(ix, iy));
          if (!bucket) continue;
          for (const m of bucket) {
            if (m === n || m.id < n.id) continue; // each pair once
            let dx = n.x - m.x;
            let dy = n.y - m.y;
            let d2 = dx * dx + dy * dy;
            if (d2 > REPULSION_CUTOFF * REPULSION_CUTOFF) continue;
            if (d2 < 1) {
              d2 = 1;
              dx = (n.id > m.id ? 1 : -1) * 0.5;
              dy = 0.5;
            }
            const dist = Math.sqrt(d2);
            const f = (REPULSION / d2) * alpha;
            const fx = (dx / dist) * f;
            const fy = (dy / dist) * f;
            n.vx += fx;
            n.vy += fy;
            m.vx -= fx;
            m.vy -= fy;
          }
        }
      }
    }

    // Link springs.
    for (const l of this._aLinks) {
      const rest = l.kind === 'hierarchy' ? HIER_LEN : MEMB_LEN;
      const ks = l.kind === 'hierarchy' ? HIER_K : MEMB_K;
      const a = l.source;
      const b = l.target;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const diff = ((dist - rest) / dist) * ks * alpha;
      const fx = dx * diff * 0.5;
      const fy = dy * diff * 0.5;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    // Centring gravity + integration.
    for (const n of nodes) {
      if (n === this.dragNode) continue;
      n.vx += (cx - n.x) * GRAVITY * alpha;
      n.vy += (cy - n.y) * GRAVITY * alpha;
      n.vx *= VELOCITY_DECAY;
      n.vy *= VELOCITY_DECAY;
      n.x += n.vx;
      n.y += n.vy;
    }

    // Collision resolution (separate overlapping nodes).
    for (let iter = 0; iter < COLLIDE_ITERS; iter++) {
      for (const n of nodes) {
        const gx = Math.floor(n.x / cell);
        const gy = Math.floor(n.y / cell);
        for (let ix = gx - 1; ix <= gx + 1; ix++) {
          for (let iy = gy - 1; iy <= gy + 1; iy++) {
            const bucket = grid.get(key(ix, iy));
            if (!bucket) continue;
            for (const m of bucket) {
              if (m === n || m.id < n.id) continue;
              const dx = n.x - m.x;
              const dy = n.y - m.y;
              const min = n.r + m.r + COLLIDE_PAD;
              const d2 = dx * dx + dy * dy;
              if (d2 >= min * min || d2 === 0) continue;
              const dist = Math.sqrt(d2) || 1;
              const push = (min - dist) / dist / 2;
              const px = dx * push;
              const py = dy * push;
              if (n !== this.dragNode) {
                n.x += px;
                n.y += py;
              }
              if (m !== this.dragNode) {
                m.x -= px;
                m.y -= py;
              }
            }
          }
        }
      }
    }
  }

  // ── Rendering ────────────────────────────────────────────────────────────────

  _focusSets() {
    // Returns { focus:Set<id>, related:Set<id> } | null for hover/filter dimming.
    //   focus   — every highlighted node (faded peers are dimmed)
    //   related — the "second wave" tags reached through a hovered tag's posts;
    //             ringed distinctly so the tag→post→tag connection is legible.
    // A click/tap selection locks the highlight (so you can move to a related
    // node and click it); otherwise the live mouse hover drives it.
    const active = this.selected || this.hovered;
    if (active) return this._expandFocus([active.id]);
    if (this.filterSet && this.filterSet.size) return this._expandFocus([...this.filterSet]);
    return null;
  }

  /**
   * Build the highlighted set for `seedIds`. Each seed lights its direct
   * neighbours; additionally, from a *tag* seed we step a second hop through
   * each adjacent post to the other tags that share it — surfacing related
   * tags and the two-segment path that connects them.
   */
  _expandFocus(seedIds) {
    const focus = new Set(seedIds);
    const related = new Set();
    for (const id of seedIds) {
      const seed = this.nodeById.get(id);
      const nbrs = this.neighbors.get(id);
      if (!nbrs) continue;
      const seedIsTag = seed && seed.type !== 'post';
      for (const nId of nbrs) {
        focus.add(nId);
        if (!seedIsTag) continue;
        const nNode = this.nodeById.get(nId);
        if (!nNode || nNode.type !== 'post') continue;
        // Second wave: bridge post → the other tags that carry it.
        const postNbrs = this.neighbors.get(nId);
        if (!postNbrs) continue;
        for (const tId of postNbrs) {
          if (tId === id) continue;
          focus.add(tId);
          related.add(tId);
        }
      }
    }
    return { focus, related };
  }

  _draw() {
    const ctx = this.ctx;
    const dpr = this.dpr;
    const { width, height } = this._cssSize();
    const c = this._colors;
    const focusData = this._focusSets();
    const focus = focusData && focusData.focus;
    const related = focusData && focusData.related;
    const active = this.selected || this.hovered; // node with the solid ring
    const activeId = active ? active.id : null;
    const dim = (id) => (focus ? (focus.has(id) ? 1 : 0.12) : 1);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // World transform for edges + node circles.
    ctx.setTransform(dpr * this.scale, 0, 0, dpr * this.scale, dpr * this.tx, dpr * this.ty);

    // Edges.
    for (const l of this._aLinks) {
      const a = l.source;
      const b = l.target;
      const lit = !focus || (focus.has(a.id) && focus.has(b.id));
      const isHier = l.kind === 'hierarchy';
      // With a focus, emphasise the lit path (so the tag→post→tag connection
      // reads clearly) and fade everything else hard.
      let alpha;
      if (!focus) alpha = isHier ? 0.55 : 0.18;
      else if (lit) alpha = isHier ? 0.85 : 0.6;
      else alpha = (isHier ? 0.55 : 0.18) * 0.08;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = isHier ? c.hierEdge : c.membEdge;
      ctx.lineWidth = (isHier ? 1.4 : focus && lit ? 1.3 : 0.7) / this.scale;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Node circles.
    for (const n of this._aNodes) {
      ctx.globalAlpha = dim(n.id);
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = this._nodeFill(n);
      ctx.fill();
      if (n.type !== 'post') {
        ctx.lineWidth = 1.2 / this.scale;
        ctx.strokeStyle = c.nodeStroke;
        ctx.stroke();
      }
      if (activeId === n.id) {
        ctx.lineWidth = 2.5 / this.scale;
        ctx.strokeStyle = c.primary;
        ctx.stroke();
      } else if (related && related.has(n.id)) {
        // Second-wave tag: a dashed ring distinguishes "reached through a post"
        // from the solid ring of the hovered node.
        ctx.save();
        ctx.setLineDash([4 / this.scale, 3 / this.scale]);
        ctx.lineWidth = 2 / this.scale;
        ctx.strokeStyle = c.primary;
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;

    // Labels in screen space (constant size, crisp).
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const n of this._aNodes) {
      const showAlways = n.type !== 'post' && n.r * this.scale >= 16;
      const isFocus = focus && focus.has(n.id);
      const isActive = activeId === n.id;
      if (!showAlways && !isActive && !(isFocus && n.type !== 'post')) continue;
      const sx = n.x * this.scale + this.tx;
      const sy = n.y * this.scale + this.ty;
      const fontPx = n.type === 'post' ? 11 : clamp(11 + n.r * 0.25, 11, 16);
      ctx.font = `${isActive ? 600 : 500} ${fontPx}px system-ui, sans-serif`;
      ctx.globalAlpha = focus && !isFocus && !isActive ? 0.15 : 1;
      const ly = sy + n.r * this.scale + fontPx * 0.9;
      ctx.lineWidth = 3;
      ctx.strokeStyle = c.labelHalo;
      ctx.strokeText(n.name, sx, ly);
      ctx.fillStyle = c.text;
      ctx.fillText(n.name, sx, ly);
    }
    ctx.globalAlpha = 1;
  }

  _nodeFill(n) {
    const c = this._colors;
    if (n.type === 'year') return c.year;
    if (n.type === 'geo') return c.geo;
    if (n.type === 'post') return c.post;
    return c.tag;
  }

  _readColors() {
    const cs = window.getComputedStyle(this.canvas);
    const v = (name, fallback) => {
      const got = cs.getPropertyValue(name).trim();
      return got || fallback;
    };
    return {
      tag: v('--graph-tag', v('--color-primary', '#4f7cff')),
      year: v('--graph-year', '#e0a23a'),
      geo: v('--graph-geo', '#2bb6a3'),
      post: v('--graph-post', 'rgba(140,140,160,0.45)'),
      hierEdge: v('--graph-hier-edge', v('--color-primary', '#4f7cff')),
      membEdge: v('--graph-memb-edge', v('--text-tertiary', '#8a8a9a')),
      nodeStroke: v('--graph-node-stroke', v('--surface-card', '#ffffff')),
      primary: v('--color-primary', '#4f7cff'),
      text: v('--text-primary', '#1a1a1a'),
      labelHalo: v('--graph-label-halo', v('--surface-card', '#ffffff')),
    };
  }

  // ── Interaction ──────────────────────────────────────────────────────────────

  _bindEvents() {
    this._onDown = this._pointerDown.bind(this);
    this._onMove = this._pointerMove.bind(this);
    this._onUp = this._pointerUp.bind(this);
    this._onWheel = this._wheel.bind(this);
    this._onLeave = (e) => {
      // On touch, lifting a finger fires pointerleave — don't wipe the
      // tap-selected node (that highlight must persist until the next tap).
      if (e && e.pointerType === 'touch') return;
      if (this.hovered) {
        this.hovered = null;
        this.onHover(null);
        this._draw();
      }
    };
    this.canvas.addEventListener('pointerdown', this._onDown);
    this.canvas.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('pointercancel', this._onUp);
    this.canvas.addEventListener('wheel', this._onWheel, { passive: false });
    this.canvas.addEventListener('pointerleave', this._onLeave);
  }

  _unbindEvents() {
    this.canvas.removeEventListener('pointerdown', this._onDown);
    this.canvas.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('pointercancel', this._onUp);
    this.canvas.removeEventListener('wheel', this._onWheel);
    this.canvas.removeEventListener('pointerleave', this._onLeave);
  }

  _pointerPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _screenToWorld(sx, sy) {
    return { x: (sx - this.tx) / this.scale, y: (sy - this.ty) / this.scale };
  }

  _pickNode(sx, sy) {
    const w = this._screenToWorld(sx, sy);
    let best = null;
    let bestD = Infinity;
    for (const n of this._aNodes) {
      const dx = n.x - w.x;
      const dy = n.y - w.y;
      const d2 = dx * dx + dy * dy;
      const rr = (n.r + 3) * (n.r + 3);
      if (d2 <= rr && d2 < bestD) {
        best = n;
        bestD = d2;
      }
    }
    return best;
  }

  _pointerDown(e) {
    const p = this._pointerPos(e);
    this._pointers.set(e.pointerId, p);
    this._needFit = false; // user is taking over the view

    // A second finger turns the gesture into a pinch — drop any single-pointer
    // drag/pan that the first finger started.
    if (this._pointers.size === 2) {
      this.dragNode = null;
      this.panning = false;
      this._beginPinch();
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      return;
    }
    if (this._pointers.size > 2) return;

    const node = this._pickNode(p.x, p.y);
    this._downPos = p;
    this._downTime = Date.now();
    this._moved = false;
    if (node) {
      this.dragNode = node;
      this._kick();
    } else {
      this.panning = true;
      this._panStart = { x: p.x - this.tx, y: p.y - this.ty };
    }
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  _beginPinch() {
    const [a, b] = [...this._pointers.values()];
    this._pinch = {
      startDist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      startScale: this.scale,
      // World point under the initial midpoint, kept fixed for the gesture.
      world: this._screenToWorld((a.x + b.x) / 2, (a.y + b.y) / 2),
    };
    this._moved = true; // suppress tap-navigation when the gesture ends
  }

  _pointerMove(e) {
    const p = this._pointerPos(e);
    if (this._pointers.has(e.pointerId)) this._pointers.set(e.pointerId, p);

    // Pinch: scale by the finger-distance ratio, anchored on the moving
    // midpoint (which also yields two-finger panning).
    if (this._pinch && this._pointers.size >= 2) {
      this._userView = true;
      const [a, b] = [...this._pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      this.scale = clamp(this._pinch.startScale * (dist / this._pinch.startDist), this._fitScale(), 6);
      this.tx = midX - this._pinch.world.x * this.scale;
      this.ty = midY - this._pinch.world.y * this.scale;
      this._draw();
      return;
    }

    if (this.dragNode) {
      // Ignore sub-slop jitter so a stationary tap still registers as a tap.
      if (this._downPos && Math.hypot(p.x - this._downPos.x, p.y - this._downPos.y) > TAP_SLOP) {
        this._moved = true;
      }
      const w = this._screenToWorld(p.x, p.y);
      this.dragNode.x = w.x;
      this.dragNode.y = w.y;
      this.dragNode.vx = 0;
      this.dragNode.vy = 0;
      this.alpha = Math.max(this.alpha, 0.2);
      this._kick();
      return;
    }
    if (this.panning) {
      if (this._downPos && Math.hypot(p.x - this._downPos.x, p.y - this._downPos.y) > TAP_SLOP) {
        this._moved = true;
        this._userView = true;
      }
      this.tx = p.x - this._panStart.x;
      this.ty = p.y - this._panStart.y;
      this._draw();
      return;
    }
    // Hover.
    const node = this._pickNode(p.x, p.y);
    if (node !== this.hovered) {
      this.hovered = node;
      this.canvas.style.cursor = node ? 'pointer' : 'grab';
      this.onHover(node);
      this._draw();
    }
  }

  _pointerUp(e) {
    this._pointers.delete(e.pointerId);
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }

    // Lifting a finger out of a pinch. If one finger remains, hand it back to
    // single-finger panning without a jump; otherwise the gesture is over.
    if (this._pinch) {
      if (this._pointers.size < 2) {
        this._pinch = null;
        const rest = [...this._pointers.values()][0];
        if (rest) {
          this.panning = true;
          this._panStart = { x: rest.x - this.tx, y: rest.y - this.ty };
        }
      }
      this._draw();
      return;
    }

    const wasDrag = this.dragNode;
    const wasPan = this.panning;
    this.dragNode = null;
    this.panning = false;

    // Treat a short, near-stationary press as a tap/click. For both mouse and
    // touch the first selects + highlights the node (so you can follow its
    // highlighted second-wave connections and click one); a second on the
    // already-selected node opens it.
    if (this._downPos && !this._moved && Date.now() - this._downTime < 400) {
      const node = this._pickNode(this._downPos.x, this._downPos.y);
      if (node) {
        if (this.selected && this.selected.id === node.id) {
          this._navigateTo(node);
          return;
        }
        this.selected = node;
        this.onSelect(node);
        this.onHover(node);
        this._draw();
        return;
      }
      // Tap/click on empty space clears the current selection.
      if (this.selected) {
        this.selected = null;
        this.onSelect(null);
        this.onHover(null);
        this._draw();
      }
      return;
    }
    if (wasDrag || wasPan) this._draw();
  }

  _navigateTo(node) {
    const href = node.type === 'post' ? `/posts/${node.slug}` : `/tags/${node.slug}`;
    this.onNavigate(href);
  }

  _wheel(e) {
    e.preventDefault();
    const p = this._pointerPos(e);
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    this._zoomAt(p.x, p.y, factor);
  }

  _zoomAt(sx, sy, factor) {
    this._needFit = false;
    this._userView = true;
    // Min zoom = "everything visible"; zooming out past that is pointless.
    const newScale = clamp(this.scale * factor, this._fitScale(), 6);
    const w = this._screenToWorld(sx, sy);
    this.scale = newScale;
    // Keep the point under the cursor fixed.
    this.tx = sx - w.x * this.scale;
    this.ty = sy - w.y * this.scale;
    this._draw();
  }

  _cssSize() {
    return {
      width: this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || 800,
      height: this.canvas.clientHeight || 520,
    };
  }
}
