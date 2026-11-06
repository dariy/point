/**
 * atlasLabels.ts — which places on the atlas map show their name.
 *
 * A place shows `● Berlin` (label mode) when its label box has space, else the
 * dot only (dot mode). The pass is greedy: the places go largest first (by
 * post count, then by id for a stable order). A label is placed when its box
 * does not overlap a label that is already placed, the dot of another place,
 * or a taken box (an open cloud's chips). Only places inside `bounds` count:
 * a place out of view takes no space.
 *
 * Pure: boxes are container px, nothing here touches the DOM or Leaflet. A
 * spatial grid keeps a pass near O(n) (the same idea as the collision grid in
 * tags-graph/forceLayout.ts).
 *
 * `clusterDots` is the step before: at a low zoom the dots of a dense area
 * overlap, and the dots that overlap by more than half a radius become one
 * cluster dot with a count.
 */

/** A box in container px. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A box relative to an anchor point. */
export interface RelBox {
  dx: number;
  dy: number;
  width: number;
  height: number;
}

/** One place for a pass. */
export interface LabelItem {
  id: number;
  /** the anchor point (the dot centre, or a shape's label point), container px */
  x: number;
  y: number;
  /** the label box, relative to the anchor */
  label: RelBox;
  /** the dot box, relative to the anchor; `null` for a shape (no dot) */
  dot: RelBox | null;
  /** larger first: the post count */
  weight: number;
}

/** Extra gap between two boxes, px. */
export const LABEL_PAD = 2;
/** Grid cell, px: about two label heights. */
const CELL = 48;

const abs = (x: number, y: number, r: RelBox): Box => ({ left: x + r.dx, top: y + r.dy, width: r.width, height: r.height });

/** Whether two boxes overlap, with `pad` px of gap kept between them. */
export function boxesOverlap(a: Box, b: Box, pad = 0): boolean {
  return (
    a.left < b.left + b.width + pad &&
    b.left < a.left + a.width + pad &&
    a.top < b.top + b.height + pad &&
    b.top < a.top + a.height + pad
  );
}

/** Whether point `x`, `y` is inside `b`. */
const inside = (x: number, y: number, b: Box): boolean =>
  x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height;

interface Entry {
  box: Box;
  /** the place id that owns the box, or -1 for a taken box */
  owner: number;
}

/** A spatial hash of boxes. */
class Grid {
  cells: Map<number, Entry[]> = new Map();

  _range(b: Box): [number, number, number, number] {
    return [
      Math.floor((b.left - LABEL_PAD) / CELL),
      Math.floor((b.top - LABEL_PAD) / CELL),
      Math.floor((b.left + b.width + LABEL_PAD) / CELL),
      Math.floor((b.top + b.height + LABEL_PAD) / CELL),
    ];
  }

  // Cell keys pack two signed 16-bit cell indexes into one number.
  static key(gx: number, gy: number): number {
    return (gx + 32768) * 65536 + (gy + 32768);
  }

  add(e: Entry): void {
    const [x0, y0, x1, y1] = this._range(e.box);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const k = Grid.key(gx, gy);
        const list = this.cells.get(k);
        if (list) list.push(e);
        else this.cells.set(k, [e]);
      }
    }
  }

  /** Whether `b` overlaps a box that `self` does not own. */
  hits(b: Box, self: number): boolean {
    const [x0, y0, x1, y1] = this._range(b);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const list = this.cells.get(Grid.key(gx, gy));
        if (!list) continue;
        for (const e of list) {
          if (e.owner === self && self !== -1) continue;
          if (boxesOverlap(b, e.box, LABEL_PAD)) return true;
        }
      }
    }
    return false;
  }
}

/**
 * The ids of the places that get a label.
 *
 * @param items - the places, in any order
 * @param bounds - the visible area; a place whose anchor is outside it does not count
 * @param taken - boxes that no label may cover (an open cloud's chips)
 */
export function declutter(items: readonly LabelItem[], bounds: Box, taken: readonly Box[] = []): Set<number> {
  const shown = items.filter((it) => inside(it.x, it.y, bounds));
  shown.sort((a, b) => b.weight - a.weight || a.id - b.id);

  const grid = new Grid();
  for (const box of taken) grid.add({ box, owner: -1 });
  for (const it of shown) if (it.dot) grid.add({ box: abs(it.x, it.y, it.dot), owner: it.id });

  const out: Set<number> = new Set();
  for (const it of shown) {
    const box = abs(it.x, it.y, it.label);
    if (grid.hits(box, it.id)) continue;
    grid.add({ box, owner: it.id });
    out.add(it.id);
  }
  return out;
}

/** One place dot for a cluster pass. */
export interface DotItem {
  id: number;
  /** the dot centre in px; any origin that does not move with a pan (the projected point at the zoom) */
  x: number;
  y: number;
  /** the dot radius, px */
  r: number;
  /** larger first: the post count */
  weight: number;
  /** a pinned place (the open cloud, a window's own place) is never inside a cluster */
  pinned?: boolean;
}

/** A group of overlapping dots: the ids, the largest place first. */
export type DotCluster = number[];

/**
 * Whether two dots overlap by more than half a radius (of the smaller dot):
 * `ra + rb - d > min(ra, rb) / 2`.
 */
export function dotsMerge(a: DotItem, b: DotItem): boolean {
  const reach = a.r + b.r - Math.min(a.r, b.r) / 2;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy < reach * reach;
}

/**
 * Group the dots that overlap (`dotsMerge`). The pass is greedy: the places go
 * largest first (by weight, then by id). A place that is in no group yet starts
 * one and takes each free place whose dot overlaps its own dot. A pinned place
 * is in no group and starts none. Only groups of two places or more are
 * returned. A spatial grid keeps the pass near O(n).
 */
export function clusterDots(items: readonly DotItem[]): DotCluster[] {
  const free = items.filter((it) => !it.pinned);
  if (free.length < 2) return [];
  free.sort((a, b) => b.weight - a.weight || a.id - b.id);

  // A cell as wide as the longest reach: a merge partner is in the 3×3 cells around.
  let maxR = 0;
  for (const it of free) maxR = Math.max(maxR, it.r);
  const cell = Math.max(1, 2 * maxR);
  const cells: Map<number, DotItem[]> = new Map();
  // Projected points at a high zoom are far past 16 bits: a wide key.
  const key = (gx: number, gy: number) => gx * 8388608 + gy;
  const cellOf = (it: DotItem): [number, number] => [Math.floor(it.x / cell), Math.floor(it.y / cell)];
  for (const it of free) {
    const [gx, gy] = cellOf(it);
    const k = key(gx, gy);
    const list = cells.get(k);
    if (list) list.push(it);
    else cells.set(k, [it]);
  }

  const taken: Set<number> = new Set();
  const out: DotCluster[] = [];
  for (const lead of free) {
    if (taken.has(lead.id)) continue;
    const [gx, gy] = cellOf(lead);
    const group: DotItem[] = [];
    for (let x = gx - 1; x <= gx + 1; x++) {
      for (let y = gy - 1; y <= gy + 1; y++) {
        for (const it of cells.get(key(x, y)) ?? []) {
          if (it.id !== lead.id && !taken.has(it.id) && dotsMerge(lead, it)) group.push(it);
        }
      }
    }
    if (!group.length) continue;
    group.sort((a, b) => b.weight - a.weight || a.id - b.id);
    taken.add(lead.id);
    for (const it of group) taken.add(it.id);
    out.push([lead.id, ...group.map((it) => it.id)]);
  }
  return out;
}
