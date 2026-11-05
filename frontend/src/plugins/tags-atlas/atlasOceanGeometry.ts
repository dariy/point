/**
 * atlasOceanGeometry — pure geometry for the ocean's window presentation
 * (atlasOcean.ts). No DOM, no Leaflet.
 *
 * In a window the map keeps its full box and is clipped to a smaller rect with
 * `clip-path: inset(…)`. These functions compute:
 *
 *   clipInsets     the insets that show `rect` of the map box
 *   windowOffset   where the window centre is, from the box centre, in pixels
 *   intersectRect  the part of a rect inside another (a slot in a scroller)
 *   tweenRect      a rect between two rects at `t` (0…1)
 *   createTapGate  a tap or a drag, from the pointer moves
 */

/** A rect in viewport pixels, as from `getBoundingClientRect`. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Pointer moves of this size or more (in CSS pixels) make a drag, not a tap. */
export const TAP_SLOP_PX = 6;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The insets that clip `box` (the map container) to `rect`. Each inset is in
 * 0…box size. A rect partly outside the box shows only its part inside the box.
 * A rect fully outside the box shows nothing (`top + bottom >= height` or
 * `left + right >= width`).
 */
export function clipInsets(rect: Rect, box: Rect): Insets {
  return {
    top: clamp(rect.top - box.top, 0, box.height),
    left: clamp(rect.left - box.left, 0, box.width),
    bottom: clamp(box.top + box.height - (rect.top + rect.height), 0, box.height),
    right: clamp(box.left + box.width - (rect.left + rect.width), 0, box.width),
  };
}

/** True when the insets leave no part of the box. */
export function insetsEmpty(insets: Insets, box: Rect): boolean {
  return insets.top + insets.bottom >= box.height || insets.left + insets.right >= box.width;
}

/** The `clip-path` value for the insets. */
export function insetCss(insets: Insets): string {
  const px = (v: number) => `${Math.round(v * 100) / 100}px`;
  return `inset(${px(insets.top)} ${px(insets.right)} ${px(insets.bottom)} ${px(insets.left)})`;
}

/**
 * The window centre minus the box centre, in pixels. A map whose centre is
 * `project(latLng) - offset` shows `latLng` at the window centre.
 */
export function windowOffset(rect: Rect, box: Rect): Point {
  return {
    x: rect.left + rect.width / 2 - (box.left + box.width / 2),
    y: rect.top + rect.height / 2 - (box.top + box.height / 2),
  };
}

/**
 * The part of `a` inside `b`. No overlap gives a rect of zero width or height
 * (clipInsets then shows nothing).
 */
export function intersectRect(a: Rect, b: Rect): Rect {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** The rect at `t` on the line from `a` (t = 0) to `b` (t = 1). */
export function tweenRect(a: Rect, b: Rect, t: number): Rect {
  return {
    left: lerp(a.left, b.left, t),
    top: lerp(a.top, b.top, t),
    width: lerp(a.width, b.width, t),
    height: lerp(a.height, b.height, t),
  };
}

/** The point at `t` on the line from `a` to `b`. */
export function tweenPoint(a: Point, b: Point, t: number): Point {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

/** Ease-in-out for the tween (cubic). */
export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export interface TapGate {
  down(id: number, x: number, y: number): void;
  move(id: number, x: number, y: number): void;
  up(id: number): void;
  /** True when the gesture so far is a tap: one pointer, no move past the slop. */
  isTap(): boolean;
}

/**
 * Tells a tap from a drag or a pinch. A gesture starts at the first `down` with
 * no other pointer down. It is a drag when a pointer moves `slop` px or more
 * from its start, and a pinch when a second pointer goes down. Either one stays
 * in force until the next gesture starts.
 */
export function createTapGate(slop = TAP_SLOP_PX): TapGate {
  const starts = new Map<number, Point>();
  let moved = false;
  return {
    down(id, x, y) {
      if (starts.size === 0) moved = false;
      else moved = true; // a second finger: a pinch
      starts.set(id, { x, y });
    },
    move(id, x, y) {
      const s = starts.get(id);
      if (s && Math.hypot(x - s.x, y - s.y) >= slop) moved = true;
    },
    up(id) {
      starts.delete(id);
    },
    isTap: () => !moved,
  };
}
