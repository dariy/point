/**
 * tagGraph.js — a small, dependency-free force-directed graph renderer for the
 * public /tags page, drawn on a <canvas>.
 *
 * The graph has four node kinds and two edge kinds:
 *   - nodes:  plain tag | year-tag (kind='year') | geo-tag (has lat/long) | post
 *   - edges:  hierarchy (tag→tag parent/child) | membership (post→tag)
 *
 * Node radius scales with degree (number of incident edges). Nodes are
 * draggable; the view supports wheel-zoom and background-drag pan. Hover (or the
 * search filter) highlights a node and its neighbours and fades the rest.
 * Clicking a tag/year/geo node navigates to /tags/<slug>; a post node navigates
 * to /posts/<slug>.
 *
 * Usage:
 *   const g = new TagGraph(canvasEl, data, { onNavigate, onHover });
 *   g.start();                // build + run the layout
 *   g.setFilter('japan');     // highlight matching tag nodes
 *   g.resize();               // after a container resize
 *   g.destroy();              // stop the sim + remove listeners
 */

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
const REPULSION = 340; // pairwise charge strength (world px²)
const REPULSION_CUTOFF = 260;
const GRAVITY = 0.019;
const HIER_LEN = 78;
const HIER_K = 0.22;
const MEMB_LEN = 42;
const MEMB_K = 0.10;
const COLLIDE_ITERS = 2;

function nodeRadius(type, degree) {
  if (type === 'post') return clamp(2.5 + 1.4 * Math.sqrt(degree), 3, 11);
  // tag / year / geo
  return clamp(5 + 2.2 * Math.sqrt(degree), 6, 36);
}

export class TagGraph {
  constructor(canvas, data, { onNavigate = () => {}, onHover = () => {} } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onNavigate = onNavigate;
    this.onHover = onHover;

    this.nodes = [];
    this.links = [];
    this.nodeById = new Map();
    this.neighbors = new Map(); // node.id -> Set(node.id)

    this.alpha = 1;
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.hovered = null;
    this.dragNode = null;
    this.panning = false;
    this.filterSet = null; // Set of node.id matching the search filter

    this._rafId = 0;
    this._running = false;
    this._destroyed = false;
    this._colors = this._readColors();

    this._buildGraph(data);
    this._bindEvents();
  }

  // ── Graph construction ─────────────────────────────────────────────────────

  _classifyTag(t) {
    if (t.kind === 'year') return 'year';
    if (typeof t.latitude === 'number' && typeof t.longitude === 'number') return 'geo';
    return 'tag';
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
      this._draw();
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

  zoomBy(factor) {
    const { width, height } = this._cssSize();
    this._zoomAt(width / 2, height / 2, factor);
  }

  resetView() {
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.alpha = Math.max(this.alpha, 0.3);
    this._kick();
  }

  resize() {
    const { width, height } = this._cssSize();
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this._draw();
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
      }
    };
    this._rafId = requestAnimationFrame(loop);
  }

  _tick() {
    const nodes = this.nodes;
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
    for (const l of this.links) {
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
              const min = n.r + m.r + 2;
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
    // Returns { focus:Set<id>|null, links:Set<link>|null } for hover/filter dimming.
    let focusIds = null;
    if (this.hovered) {
      focusIds = new Set([this.hovered.id]);
      const nbrs = this.neighbors.get(this.hovered.id);
      if (nbrs) for (const id of nbrs) focusIds.add(id);
    } else if (this.filterSet && this.filterSet.size) {
      focusIds = new Set(this.filterSet);
      for (const id of this.filterSet) {
        const nbrs = this.neighbors.get(id);
        if (nbrs) for (const n of nbrs) focusIds.add(n);
      }
    }
    return focusIds;
  }

  _draw() {
    const ctx = this.ctx;
    const dpr = this.dpr;
    const { width, height } = this._cssSize();
    const c = this._colors;
    const focus = this._focusSets();
    const dim = (id) => (focus ? (focus.has(id) ? 1 : 0.12) : 1);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // World transform for edges + node circles.
    ctx.setTransform(dpr * this.scale, 0, 0, dpr * this.scale, dpr * this.tx, dpr * this.ty);

    // Edges.
    for (const l of this.links) {
      const a = l.source;
      const b = l.target;
      const lit = !focus || (focus.has(a.id) && focus.has(b.id));
      const isHier = l.kind === 'hierarchy';
      ctx.globalAlpha = (isHier ? 0.55 : 0.18) * (lit ? 1 : 0.08);
      ctx.strokeStyle = isHier ? c.hierEdge : c.membEdge;
      ctx.lineWidth = (isHier ? 1.4 : 0.7) / this.scale;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Node circles.
    for (const n of this.nodes) {
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
      if (this.hovered && this.hovered.id === n.id) {
        ctx.lineWidth = 2.5 / this.scale;
        ctx.strokeStyle = c.primary;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // Labels in screen space (constant size, crisp).
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const n of this.nodes) {
      const showAlways = n.type !== 'post' && n.r * this.scale >= 16;
      const isFocus = focus && focus.has(n.id);
      const isHover = this.hovered && this.hovered.id === n.id;
      if (!showAlways && !isHover && !(isFocus && n.type !== 'post')) continue;
      const sx = n.x * this.scale + this.tx;
      const sy = n.y * this.scale + this.ty;
      const fontPx = n.type === 'post' ? 11 : clamp(11 + n.r * 0.25, 11, 16);
      ctx.font = `${isHover ? 600 : 500} ${fontPx}px system-ui, sans-serif`;
      ctx.globalAlpha = focus && !isFocus && !isHover ? 0.15 : 1;
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
    this._onLeave = () => {
      if (this.hovered) {
        this.hovered = null;
        this.onHover(null);
        this._draw();
      }
    };
    this.canvas.addEventListener('pointerdown', this._onDown);
    this.canvas.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerup', this._onUp);
    this.canvas.addEventListener('wheel', this._onWheel, { passive: false });
    this.canvas.addEventListener('pointerleave', this._onLeave);
  }

  _unbindEvents() {
    this.canvas.removeEventListener('pointerdown', this._onDown);
    this.canvas.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
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
    for (const n of this.nodes) {
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

  _pointerMove(e) {
    const p = this._pointerPos(e);
    if (this.dragNode) {
      this._moved = true;
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
      this._moved = true;
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
    const wasDrag = this.dragNode;
    const wasPan = this.panning;
    this.dragNode = null;
    this.panning = false;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    // Treat a short, near-stationary press as a click → navigate.
    if (this._downPos && !this._moved && Date.now() - this._downTime < 400) {
      const node = this._pickNode(this._downPos.x, this._downPos.y);
      if (node) {
        const href = node.type === 'post' ? `/posts/${node.slug}` : `/tags/${node.slug}`;
        this.onNavigate(href);
        return;
      }
    }
    if (wasDrag || wasPan) this._draw();
  }

  _wheel(e) {
    e.preventDefault();
    const p = this._pointerPos(e);
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    this._zoomAt(p.x, p.y, factor);
  }

  _zoomAt(sx, sy, factor) {
    const newScale = clamp(this.scale * factor, 0.2, 6);
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
