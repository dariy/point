/**
 * graphRenderer.js — everything the /tags graph puts on the canvas.
 *
 * One paint per frame, in three passes: edges and node circles under the world
 * transform, then labels back in screen space so they stay a constant size and
 * crisp at any zoom.
 *
 * Colours come from CSS custom properties on the canvas, read once and re-read
 * on a theme change, so the graph follows the site's palette instead of
 * hard-coding one.
 */

import { clamp } from './viewport.js';

function readColors(canvas) {
  const cs = window.getComputedStyle(canvas);
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

export class GraphRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.colors = readColors(canvas);
  }

  refreshTheme() {
    this.colors = readColors(this.canvas);
  }

  /** Size the backing store for the device pixel ratio. */
  resize({ width, height }, dpr) {
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
  }

  /**
   * @param {object}   frame
   * @param {object[]} frame.nodes    visible nodes
   * @param {object[]} frame.links    visible links
   * @param {object}   frame.view     { scale, tx, ty, dpr }
   * @param {object}   frame.size     { width, height } in CSS px
   * @param {Set|null} frame.focus    highlighted ids; null means "nothing dimmed"
   * @param {Set|null} frame.related  second-wave tags, drawn with a dashed ring
   * @param {?string}  frame.activeId the hovered/selected node, with a solid ring
   */
  draw({ nodes, links, view, size, focus, related, activeId }) {
    const ctx = this.ctx;
    const c = this.colors;
    const { scale, tx, ty, dpr } = view;
    const dim = (id) => (focus ? (focus.has(id) ? 1 : 0.12) : 1);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);

    // World transform for edges + node circles.
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * tx, dpr * ty);

    // Edges.
    for (const l of links) {
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
      ctx.lineWidth = (isHier ? 1.4 : focus && lit ? 1.3 : 0.7) / scale;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Node circles.
    for (const n of nodes) {
      ctx.globalAlpha = dim(n.id);
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = this._nodeFill(n);
      ctx.fill();
      if (n.type !== 'post') {
        ctx.lineWidth = 1.2 / scale;
        ctx.strokeStyle = c.nodeStroke;
        ctx.stroke();
      }
      if (activeId === n.id) {
        ctx.lineWidth = 2.5 / scale;
        ctx.strokeStyle = c.primary;
        ctx.stroke();
      } else if (related && related.has(n.id)) {
        // Second-wave tag: a dashed ring distinguishes "reached through a post"
        // from the solid ring of the hovered node.
        ctx.save();
        ctx.setLineDash([4 / scale, 3 / scale]);
        ctx.lineWidth = 2 / scale;
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
    for (const n of nodes) {
      const showAlways = n.type !== 'post' && n.r * scale >= 16;
      const isFocus = focus && focus.has(n.id);
      const isActive = activeId === n.id;
      if (!showAlways && !isActive && !(isFocus && n.type !== 'post')) continue;
      const sx = n.x * scale + tx;
      const sy = n.y * scale + ty;
      const fontPx = n.type === 'post' ? 11 : clamp(11 + n.r * 0.25, 11, 16);
      ctx.font = `${isActive ? 600 : 500} ${fontPx}px system-ui, sans-serif`;
      ctx.globalAlpha = focus && !isFocus && !isActive ? 0.15 : 1;
      const ly = sy + n.r * scale + fontPx * 0.9;
      ctx.lineWidth = 3;
      ctx.strokeStyle = c.labelHalo;
      ctx.strokeText(n.name, sx, ly);
      ctx.fillStyle = c.text;
      ctx.fillText(n.name, sx, ly);
    }
    ctx.globalAlpha = 1;
  }

  _nodeFill(n) {
    const c = this.colors;
    if (n.type === 'year') return c.year;
    if (n.type === 'geo') return c.geo;
    if (n.type === 'post') return c.post;
    return c.tag;
  }
}
