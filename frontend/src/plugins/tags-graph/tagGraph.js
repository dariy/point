// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.12.
/**
 * tagGraph.js — a small, dependency-free force-directed graph renderer for the
 * public /tags page, drawn on a <canvas>.
 *
 * This is the controller: it holds the graph, the view transform and the
 * interaction state, runs the animation loop, and hands the work to four
 * collaborators —
 *
 *   graphModel.js       payload → nodes/links/adjacency, and the focus walks
 *   forceLayout.js      one step of the simulation
 *   viewport.js         bounds, fit, screen↔world, hit-testing, zoom
 *   graphRenderer.js    the paint
 *   pointerControls.js  drag / pan / pinch / tap / wheel
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

import { buildGraph, expandFocus, visibleSets } from './graphModel.js';
import { ALPHA_DECAY, ALPHA_MIN, tick } from './forceLayout.js';
import { GraphRenderer } from './graphRenderer.js';
import { PointerControls } from './pointerControls.js';
import { bounds, fitScale, fitTransform, pickNode, screenToWorld, zoomAt } from './viewport.js';

/** Frames the reduced-motion path settles the layout over, off-screen. */
const SETTLE_STEPS = 400;

export class TagGraph {
  constructor(canvas, data, { onNavigate = () => {}, onHover = () => {}, onSelect = () => {} } = {}) {
    this.canvas = canvas;
    this.onNavigate = onNavigate;
    this.onHover = onHover;
    this.onSelect = onSelect;

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

    this._aNodes = []; // visible nodes (drives physics / draw / picking)
    this._aLinks = []; // visible links (both endpoints visible)
    this._needFit = true; // fit-to-view once the initial layout settles
    this._userView = false; // true once the user has zoomed/panned manually

    this._rafId = 0;
    this._running = false;
    this._destroyed = false;

    this._renderer = new GraphRenderer(canvas);
    this._model = buildGraph(data, this._cssSize());
    this._recomputeActive();
    this._controls = new PointerControls(canvas, this);
  }

  // The graph itself lives in _model (see graphModel.js); these read it.
  get nodes() { return this._model.nodes; }
  get links() { return this._model.links; }
  get nodeById() { return this._model.nodeById; }
  get neighbors() { return this._model.neighbors; }

  // ── Public API ──────────────────────────────────────────────────────────────

  start() {
    this.resize();
    this.alpha = 1;
    // Respect reduced-motion: settle the layout off-screen, then paint once.
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      for (let i = 0; i < SETTLE_STEPS && this.alpha > ALPHA_MIN; i++) {
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
    const node = this.nodes.find((n) => n.slug === slug && n.type !== 'post');
    if (node && this.selected !== node) {
      this.selected = node;
      this._draw();
    }
    return node;
  }

  getSelectionStats() {
    if (!this.selected) return null;
    const { focus } = this._expandFocus([this.selected.id]);
    let tagCount = 0;
    let postCount = 0;
    for (const id of focus) {
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
    this._renderer.resize(this._cssSize(), this.dpr);
    // Keep everything framed across viewport changes until the user takes over.
    if (this._userView) this._draw();
    else this._fitToView();
  }

  refreshTheme() {
    this._renderer.refreshTheme();
    this._draw();
  }

  destroy() {
    this._destroyed = true;
    this._running = false;
    cancelAnimationFrame(this._rafId);
    this._controls.destroy();
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

  _tick() {
    const { width, height } = this._cssSize();
    tick(this._aNodes, this._aLinks, {
      alpha: this.alpha,
      cx: width / 2,
      cy: height / 2,
      pinned: this.dragNode,
    });
  }

  // ── Visible set, view transform ──────────────────────────────────────────────

  _recomputeActive() {
    const active = visibleSets(this._model, this.hiddenTypes);
    this._aNodes = active.nodes;
    this._aLinks = active.links;
  }

  _cssSize() {
    return {
      width: this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || 800,
      height: this.canvas.clientHeight || 520,
    };
  }

  /** The current transform, in the shape viewport.js takes. */
  _view() {
    return { scale: this.scale, tx: this.tx, ty: this.ty };
  }

  _bounds() {
    return bounds(this._aNodes);
  }

  _fitScale() {
    return fitScale(this._aNodes, this._cssSize());
  }

  /** Center + scale so all visible nodes fit the viewport. */
  _fitToView() {
    const fit = fitTransform(this._aNodes, this._cssSize());
    if (fit) {
      this.scale = fit.scale;
      this.tx = fit.tx;
      this.ty = fit.ty;
    }
    this._draw();
  }

  _screenToWorld(sx, sy) {
    return screenToWorld(this._view(), sx, sy);
  }

  _pickNode(sx, sy) {
    return pickNode(this._aNodes, this._view(), sx, sy);
  }

  _zoomAt(sx, sy, factor) {
    this._needFit = false;
    this._userView = true;
    // Min zoom = "everything visible"; zooming out past that is pointless.
    const view = zoomAt(this._view(), sx, sy, factor, this._fitScale());
    this.scale = view.scale;
    this.tx = view.tx;
    this.ty = view.ty;
    this._draw();
  }

  // ── Highlighting + paint ─────────────────────────────────────────────────────

  _expandFocus(seedIds) {
    return expandFocus(this._model, seedIds);
  }

  /**
   * The highlight in force, or null when nothing is dimmed. A click/tap
   * selection locks it (so you can move to a related node and click it);
   * otherwise the live mouse hover drives it, and the search filter last.
   */
  _focusSets() {
    const active = this.selected || this.hovered;
    if (active) return this._expandFocus([active.id]);
    if (this.filterSet && this.filterSet.size) return this._expandFocus([...this.filterSet]);
    return null;
  }

  _draw() {
    const focusData = this._focusSets();
    const active = this.selected || this.hovered; // node with the solid ring
    this._renderer.draw({
      nodes: this._aNodes,
      links: this._aLinks,
      view: { ...this._view(), dpr: this.dpr },
      size: this._cssSize(),
      focus: focusData && focusData.focus,
      related: focusData && focusData.related,
      activeId: active ? active.id : null,
    });
  }

  // ── Host interface for PointerControls ───────────────────────────────────────

  /** Move a held node under the pointer, and reheat the layout around it. */
  _dragTo(node, sx, sy) {
    const w = this._screenToWorld(sx, sy);
    node.x = w.x;
    node.y = w.y;
    node.vx = 0;
    node.vy = 0;
    this.alpha = Math.max(this.alpha, 0.2);
    this._kick();
  }

  _setHover(node) {
    if (node === this.hovered) return;
    this.hovered = node;
    this.canvas.style.cursor = node ? 'pointer' : 'grab';
    this.onHover(node);
    this._draw();
  }

  /** First tap on a node selects it, a second opens it; empty space clears. */
  _handleTap(node) {
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
    if (this.selected) {
      this.selected = null;
      this.onSelect(null);
      this.onHover(null);
      this._draw();
    }
  }

  _navigateTo(node) {
    const href = node.type === 'post' ? `/posts/${node.slug}` : `/tags/${node.slug}`;
    this.onNavigate(href);
  }
}
