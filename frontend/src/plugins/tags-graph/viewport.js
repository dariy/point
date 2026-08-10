/**
 * viewport.js — the view maths for the /tags graph.
 *
 * One transform maps the layout's world coordinates to the canvas:
 *
 *   screen = world * scale + t
 *
 * Every reverse lookup (hit-testing, zoom-at-cursor, dragging) goes through
 * {@link screenToWorld}, which must stay its exact inverse — if it drifts,
 * clicks land next to the node the user aimed at.
 *
 * A `view` is any `{ scale, tx, ty }`; a `size` is `{ width, height }` in CSS
 * px. Pure functions throughout — no canvas, no DOM, nothing mutated.
 */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const MAX_SCALE = 6; // hard zoom-in cap
const FIT_MIN_SCALE = 0.05;
const FIT_MAX_SCALE = 4; // a one-node graph must not zoom to absurdity
const EMPTY_SCALE = 0.2; // fallback for a graph with nothing in it
const FIT_MARGIN = 28; // breathing room + label space (screen px)
const PICK_SLOP = 3; // forgiving margin around a node's rim (world px)

/** Bounding box (world coords) of `nodes`, radii included, or null if empty. */
export function bounds(nodes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    if (n.x - n.r < minX) minX = n.x - n.r;
    if (n.y - n.r < minY) minY = n.y - n.r;
    if (n.x + n.r > maxX) maxX = n.x + n.r;
    if (n.y + n.r > maxY) maxY = n.y + n.r;
  }
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY };
}

function scaleFor(b, { width, height }) {
  if (!b) return EMPTY_SCALE;
  const bw = Math.max(b.maxX - b.minX, 1);
  const bh = Math.max(b.maxY - b.minY, 1);
  const s = Math.min((width - FIT_MARGIN * 2) / bw, (height - FIT_MARGIN * 2) / bh);
  return clamp(s, FIT_MIN_SCALE, FIT_MAX_SCALE);
}

/**
 * Smallest scale at which every node fits the viewport — this is the minimum
 * zoom, since zooming out past "everything visible" is pointless.
 */
export function fitScale(nodes, size) {
  return scaleFor(bounds(nodes), size);
}

/** The view that centres `nodes` and scales them to fit, or null if empty. */
export function fitTransform(nodes, size) {
  const b = bounds(nodes);
  if (!b) return null;
  const scale = scaleFor(b, size);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return {
    scale,
    tx: size.width / 2 - cx * scale,
    ty: size.height / 2 - cy * scale,
  };
}

export function screenToWorld({ scale, tx, ty }, sx, sy) {
  return { x: (sx - tx) / scale, y: (sy - ty) / scale };
}

/**
 * The node under a screen point, or null. Picking is done in world space
 * against each node's radius plus a forgiving margin; when two nodes overlap
 * the nearer centre wins, so the node whose middle you aimed at is the one you
 * get.
 */
export function pickNode(nodes, view, sx, sy) {
  const w = screenToWorld(view, sx, sy);
  let best = null;
  let bestD = Infinity;
  for (const n of nodes) {
    const dx = n.x - w.x;
    const dy = n.y - w.y;
    const d2 = dx * dx + dy * dy;
    const rr = (n.r + PICK_SLOP) * (n.r + PICK_SLOP);
    if (d2 <= rr && d2 < bestD) {
      best = n;
      bestD = d2;
    }
  }
  return best;
}

/**
 * Zoom by `factor` about a screen point, keeping whatever is under it fixed.
 * `minScale` is the caller's floor — normally {@link fitScale}.
 */
export function zoomAt(view, sx, sy, factor, minScale) {
  const scale = clamp(view.scale * factor, minScale, MAX_SCALE);
  const w = screenToWorld(view, sx, sy);
  return { scale, tx: sx - w.x * scale, ty: sy - w.y * scale };
}
