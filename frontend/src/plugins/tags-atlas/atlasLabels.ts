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
