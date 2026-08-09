/**
 * forceLayout.js — one step of the /tags graph's force simulation.
 *
 * Four forces act per tick: pairwise repulsion (distance-cut off, bucketed
 * through a spatial grid so it stays O(n)), springs along the links, gravity
 * toward the viewport centre, and a collision pass that pushes overlapping
 * rims apart. Everything is scaled by `alpha`, the cooling factor, so a settled
 * layout stops moving on its own.
 *
 * Positions are world units (CSS px at scale 1) and are mutated in place.
 * Nothing here touches a canvas or the DOM.
 */

// ── Layout / physics constants ───────────────────────────────────────────────
export const ALPHA_MIN = 0.001;
export const ALPHA_DECAY = 0.0228;
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

/**
 * Advance the layout by one frame.
 *
 * @param {object[]} nodes  visible nodes, mutated in place
 * @param {object[]} links  visible links (endpoints are node objects)
 * @param {object}   opts
 * @param {number}   opts.alpha   cooling factor; 0 leaves only the collision pass
 * @param {number}   opts.cx      gravity centre, world x
 * @param {number}   opts.cy      gravity centre, world y
 * @param {object}   [opts.pinned] node held by the pointer — follows the finger,
 *                                 not the physics
 */
export function tick(nodes, links, { alpha, cx, cy, pinned = null }) {
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
  for (const l of links) {
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
    if (n === pinned) continue;
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
            if (n !== pinned) {
              n.x += px;
              n.y += py;
            }
            if (m !== pinned) {
              m.x -= px;
              m.y -= py;
            }
          }
        }
      }
    }
  }
}
