/**
 * Carousel Studio — direct manipulation on the stage.
 *
 * Ctrl/Shift-drag to pan, pinch or Ctrl/Shift-wheel to zoom, arrow keys to
 * nudge: one module over one small host surface — the stage's own deck
 * columns — so the page keeps owning the document and this keeps owning the
 * pointer bookkeeping. It mirrors `attachWindowFileDrop`'s shape (bind, hand
 * back the release) with one difference — the controller outlives a render,
 * because a wheel gesture's debounced commit has to.
 *
 * A plain drag or wheel is the strip's own horizontal scroll, not the crop —
 * `.carousel-studio__stage-slide` fills the whole tile, so with no modifier
 * gesture at all a deck column would leave nothing else to scroll the strip
 * with, on a touchscreen most of all. Ctrl or Shift held at the press (mouse
 * or pen; a finger has neither, short of an attached keyboard) is what asks
 * for the crop instead. Pinch never needs it: a second finger is never a
 * scroll and is always the zoom, whatever the first finger was doing.
 *
 * That gate is a fine pointer's. In the touch layout (S10) the strip does not
 * scroll at all: `carousel.css` locks the scroller and the page moves it by
 * script, one slide at a time. A plain drag has nothing left to scroll there,
 * so `"pane"` is never the drag kind and a plain drag — finger, pen or mouse —
 * pans the crop directly. Ctrl/Shift still reaches the crop too, so a hybrid
 * device with a keyboard loses nothing. `isTouchLayout` (`studio/layout.js`) is
 * the one name this module asks that question by, read once per press: two
 * functions over one media query is exactly the drift `layout.js` exists to
 * stop, and the widened grab targets below read the same query.
 *
 * The same machine drives two fields. With no layer selected a column's
 * Ctrl/Shift-pointer pans and zooms the slide's `crop` (S2); a plain pointer
 * pans the strip. With a layer selected and the press landing on that layer
 * or one of its eight resize handles, the identical provisional-write-then-
 * commit cycle moves and resizes the layer's `box` instead — through
 * `host.commitLayer` rather than `host.commit`, snapping to the safe area and
 * canvas guides on the way, and unconditionally: a selected layer's own
 * handles are a deliberate, visually scoped target, not the tile's ambient
 * default, so they carry no modifier gate. A press that misses the selected
 * layer still falls through to the crop gesture, so pan/zoom is unchanged
 * wherever a layer is not in the way.
 *
 * A ninth handle, above the box's own top edge and not one of the eight
 * `hitLayer` derives, drives `box.rotate` the same way: press, provisional
 * paint, one commit on release. It carries no snap — an angle has no safe-area
 * or seam to land on — but does carry its own modifier, Shift, to round to
 * 15° increments; Shift is free here because it only gates the wheel zoom
 * (S2.1), never a pointer drag.
 *
 * It drives that field in either of two coordinate spaces, because a layer's
 * `box` is normalized to whatever it belongs to. A slide layer's is fractions
 * of one slide, so the pressed column is the space. A spanning layer's is
 * fractions of the whole deck, so the space is every column laid side by side
 * — a press on *any* column it reaches grabs it, the pointer maths run in deck
 * fractions, and the seams join the guides it snaps to. `layerSpace` is the one
 * place that difference lives; every handler below reads it and knows nothing
 * about which space it is in.
 *
 *   const gestures = createDeckGestures(host);   // once, at construction
 *   gestures.attach(frames);                     // after every render
 *   gestures.destroy();                          // at unmount
 *
 * A touch drag is not claimed at pointerdown either way. Without the modifier
 * the column is `touch-action: pan-x pan-y`, so the finger is left to the
 * browser's own panning of the strip (and, on the other axis, the page) — no
 * JS gesture is ever started for it, only a slop-threshold watch so a release
 * that turned out to be a scroll still doesn't select the tile it ended over
 * (`drag = null` once past `DRAG_SLOP_PX`, same as a `null`-returning abandon
 * anywhere else in this module). The touch layout is where that watch resolves
 * the other way: the tile is `touch-action: none` there and no scroller is left
 * to hand the finger back to, so the first resolved direction — either axis —
 * claims the crop instead of abandoning it. A second finger arriving before
 * that happens still claims the pinch, exactly as it does with the modifier
 * held. That
 * watch is keyed on `pointerType === "touch"` specifically, never on "not a
 * mouse" — a stylus starts to move because it meant to, so a pen claims the
 * gesture at the press the same as a mouse does, and never sits in the
 * undecided state a finger does.
 *
 * The column holding a selected layer is `touch-action: none` (`carousel.css`,
 * `is-layer-armed`), not `pan-x pan-y`, so a one-finger drag on it is this
 * module's from the first pixel and never the scroller's to contest —
 * `PRESS_KINDS`' unconditional claim already assumed as much, but the
 * `pan-x pan-y` sitting under it until S8 let the browser start its own pan on
 * the same finger regardless. That is scoped to the one armed column; every
 * other one keeps scrolling the strip with a finger, panning under an empty
 * patch of any column, exactly as before.
 *
 * A second finger onto a `"layer"` drag already in flight is a pinch too —
 * `onLayerPointerAdd`/`onLayerPinchMove` — and this is the touch answer to the
 * Ctrl/Shift a finger can never hold: distance apart scales the box about its
 * own centre, the angle between the two fingers rotates it, and one finger
 * lifting out hands the gesture back to the one still down rather than ending
 * it. `HANDLE_GRAB_PX`, `ROTATE_HANDLE_OFFSET_PX` and `ROTATE_HANDLE_HIT_PX`
 * each carry a `_COARSE` twin, read behind `matchMedia("(pointer: coarse)")`
 * the way `studio/layout.js` reads its own breakpoint — a finger's eight
 * resize handles and its rotate handle grab a ~44px target, not a mouse
 * cursor's.
 *
 * Nothing here writes to the DOM by itself and nothing here holds a document:
 * a live gesture paints through `host.paint` with a provisional slide (no state
 * change, no rebuild, no decode) and lands in the document through
 * `host.commit` exactly once, when the gesture ends.
 *
 * `createAnchorGesture` is the panorama half of the same idea over the one
 * field panorama mode has: `anchorY`, where the crop band sits in whatever
 * vertical slack the strip leaves. It is a separate small controller rather
 * than a branch in the one above, because the two never coexist — the stage is
 * either n framed columns or one projected band — and because the panorama
 * stage has no crop, no zoom and no layers to route a press between. What it
 * shares is the cycle: provisional paint on every move, one commit on release,
 * and the same direction-declaring touch claim, mirrored to the other axis.
 */

import { clampPan, deckSlideFitCSS } from "../geometry.js";
import { isTouchLayout } from "./layout.js";
import {
  DRAG_SLOP_PX,
  claimPointer,
  commitIfChanged,
  createListenerGroup,
  createMultiTapWatcher,
  pastSlop,
  releasePointer,
  resolveTouchClaim,
} from "./pointerSession.js";

/** Wheel-notch → zoom factor. One notch (100px) is ~16%, and the exponential
 *  keeps zooming in and back out along the same path. */
const WHEEL_ZOOM = 0.0015;
/** One arrow press pans this fraction of the visible crop (5× with shift). */
const KEY_PAN = 0.02;
/** One `+`/`-` press zooms by this factor. */
const KEY_ZOOM = 1.1;
/** A wheel gesture has no release event — commit this long after the last tick.
 *  Long enough that a scroll burst is one document mutation, short enough that
 *  the dirty badge feels immediate. */
const WHEEL_COMMIT_MS = 140;
/** A press within this many CSS px of a selected layer's edge grabs the resize
 *  handle there rather than moving the layer. */
const HANDLE_GRAB_PX = 12;
/** How far above the box's own top edge the rotate handle sits, in CSS px —
 *  matches its `top` in carousel.css. Clear of `HANDLE_GRAB_PX` so the two
 *  handles' grab zones never overlap. */
const ROTATE_HANDLE_OFFSET_PX = 24;
/** A press within this many CSS px of the rotate handle grabs it. */
const ROTATE_HANDLE_HIT_PX = 8;
/** The same three constants, under a coarse (touch) pointer — a finger is not
 *  a mouse cursor, so the grab zones widen to a ~44px target. Mirrors
 *  `carousel.css`'s own `@media (pointer: coarse)` block, selected by the same
 *  `isTouchLayout()` the press routing reads: one query, one name for it.
 *  `ROTATE_HANDLE_OFFSET_PX_COARSE` is the one number both sides must actually
 *  agree on, since it also clears the rotate handle's widened hit circle from
 *  the resize band below it. */
const HANDLE_GRAB_PX_COARSE = 22;
const ROTATE_HANDLE_OFFSET_PX_COARSE = 48;
const ROTATE_HANDLE_HIT_PX_COARSE = 22;
/** One Shift-held rotate drag snaps to this many degrees. */
const ROTATE_SNAP_DEG = 15;
/** A dragged layer edge within this many CSS px of a guide clicks onto it. */
const SNAP_PX = 7;
/** The smallest a layer box may be on either axis — one pixel of the 1080px
 *  canvas width, matching `MIN_BOX` in `document.js`. Below it a layer is
 *  ungrabbable, so the preview clamp holds it here too. */
const MIN_BOX = 1 / 1080;

/** `frame.getBoundingClientRect()`, or a zero box where there is no layout
 *  (a headless test frame that never opts into one). */
function frameRect(frame) {
  const r = frame.getBoundingClientRect?.();
  return r && r.width ? r : { left: 0, top: 0, width: 0, height: 0 };
}

/** A client point as a fraction of `frame`'s own rect — the ink tool's
 *  coordinate space while a session is open, since a slide-scoped layer's
 *  `box` is already fractions of exactly this rect (`pressContext`'s own
 *  `rect` for the non-span case). */
function frameFraction(frame, clientX, clientY) {
  const rect = frameRect(frame);
  return {
    fx: (clientX - rect.left) / (rect.width || 1),
    fy: (clientY - rect.top) / (rect.height || 1),
  };
}

/**
 * The whole rect a spanning layer's `box` is fractions of, from the rect of
 * column `i` of `count`. The columns are equal widths laid side by side, so the
 * deck box follows from any one of them exactly — no second measurement, and no
 * dependence on the stage element the columns happen to sit in.
 *
 * @param {{left:number,top:number,width:number,height:number}} rect
 * @param {number} i
 * @param {number} count
 */
export function deckRect(rect, i, count) {
  const n = Math.max(1, count);
  return {
    left: rect.left - i * rect.width,
    top: rect.top,
    width: rect.width * n,
    height: rect.height,
  };
}

/**
 * The lines a dragged box snaps to, per axis, in the space it is dragged in:
 * that space's edges and centre, its safe-area rect, and `seams` — the deck's
 * slide boundaries, which exist only in deck space and are what makes a
 * headline land *on* a seam rather than a pixel off it.
 *
 * @param {{x:number,y:number,w:number,h:number}|null} safe
 * @param {number[]} [seams]  extra vertical lines, in the space's fractions
 * @returns {{v:number[], h:number[]}}
 */
export function snapLines(safe, seams = []) {
  return {
    v: [0, 0.5, 1, ...(safe ? [safe.x, safe.x + safe.w] : []), ...seams],
    h: [0, 0.5, 1, ...(safe ? [safe.y, safe.y + safe.h] : [])],
  };
}

/** The deck's internal slide boundaries in deck fractions — `n - 1` of them,
 *  since `0` and `1` are already guides in every space. */
export function deckSeams(count) {
  const n = Math.max(1, count);
  return Array.from({ length: n - 1 }, (_, k) => (k + 1) / n);
}

/**
 * The coordinate space one layer gesture runs in: the rect the layer's `box` is
 * fractions of, the snap tolerance `SNAP_PX` is worth in that rect, and the
 * guide lines to snap against.
 *
 * Resolved once per press and read by every move until the release — in one
 * place rather than in each handler, so a layer whose box is normalized to
 * something other than the column that was pressed is a change here and nowhere
 * else.
 *
 * @param {{left:number,top:number,width:number,height:number}} rect
 * @param {{x:number,y:number,w:number,h:number}|null} safe
 * @param {number[]} [seams]
 */
export function layerSpace(rect, safe, seams = []) {
  return {
    rect,
    lines: snapLines(safe, seams),
    tol: { x: SNAP_PX / (rect.width || 1), y: SNAP_PX / (rect.height || 1) },
  };
}

/**
 * Which part of a selected layer a press at `(cx, cy)` lands on, or `null` when
 * it misses — in which case the crop gesture takes the press instead. A press
 * near an edge or corner (`HANDLE_GRAB_PX`, converted to box fractions through
 * the frame's own size) is a resize with that edge's `{h, v}` anchor
 * (`-1`/`0`/`1` per axis, `0` meaning "this axis does not move"); a press inside
 * the box is a move.
 *
 * @param {{left:number,top:number,width:number,height:number}} rect
 * @param {{x:number,y:number,w:number,h:number}} box  0..1 of the canvas
 * @param {number} cx
 * @param {number} cy
 * @returns {{mode:'move'|'resize', h:-1|0|1, v:-1|0|1}|null}
 */
export function hitLayer(rect, box, cx, cy, grabPx = HANDLE_GRAB_PX) {
  if (!rect.width || !rect.height) return null;
  const { fx, fy } = unrotatePoint(rect, box, cx, cy);
  const tx = grabPx / rect.width;
  const ty = grabPx / rect.height;
  const withinX = fx >= box.x - tx && fx <= box.x + box.w + tx;
  const withinY = fy >= box.y - ty && fy <= box.y + box.h + ty;
  if (!withinX || !withinY) return null;

  const nearL = Math.abs(fx - box.x) <= tx;
  const nearR = Math.abs(fx - (box.x + box.w)) <= tx;
  const nearT = Math.abs(fy - box.y) <= ty;
  const nearB = Math.abs(fy - (box.y + box.h)) <= ty;
  if (nearL || nearR || nearT || nearB) {
    return { mode: "resize", h: nearL ? -1 : nearR ? 1 : 0, v: nearT ? -1 : nearB ? 1 : 0 };
  }
  return { mode: "move", h: 0, v: 0 };
}

/**
 * Whether `(cx, cy)` lands inside `box` (fractions of `rect`) — the
 * containment half of {@link hitLayer}, with no handle tolerance. A layer
 * that is not the current selection shows no resize handles, so the stage's
 * click-to-select only needs to know the press is inside it, not which edge
 * it's near.
 *
 * @param {{left:number,top:number,width:number,height:number}} rect
 * @param {{x:number,y:number,w:number,h:number}} box  0..1 of the canvas
 * @param {number} cx
 * @param {number} cy
 * @returns {boolean}
 */
export function layerContains(rect, box, cx, cy) {
  if (!rect.width || !rect.height) return false;
  const { fx, fy } = unrotatePoint(rect, box, cx, cy);
  return fx >= box.x && fx <= box.x + box.w && fy >= box.y && fy <= box.y + box.h;
}

/**
 * The inverse of {@link rotateHandlePoint}'s rotation: turns a client point
 * into the fraction it would land on if `box` carried no `rotate` at all.
 * `hitLayer` and `layerContains` test this point rather than the raw screen
 * fraction, so the eight resize zones (and the plain containment test) grab
 * where the rotated chrome is actually drawn, not where an axis-aligned box
 * would be.
 *
 * @param {{left:number,top:number,width:number,height:number}} rect
 * @param {{x:number,y:number,w:number,h:number,rotate?:number}} box
 * @param {number} cx
 * @param {number} cy
 * @returns {{fx:number, fy:number}}
 */
export function unrotatePoint(rect, box, cx, cy) {
  const w = rect.width || 1;
  const h = rect.height || 1;
  const rotate = box.rotate || 0;
  if (!rotate) return { fx: (cx - rect.left) / w, fy: (cy - rect.top) / h };
  const ccx = rect.left + (box.x + box.w / 2) * w;
  const ccy = rect.top + (box.y + box.h / 2) * h;
  const rad = (-rotate * Math.PI) / 180;
  const dx = cx - ccx;
  const dy = cy - ccy;
  const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
  return { fx: (ccx + rx - rect.left) / w, fy: (ccy + ry - rect.top) / h };
}

/** The rotate handle's centre in client coordinates: `ROTATE_HANDLE_OFFSET_PX`
 *  above the box's own unrotated top-centre, then rotated about the box
 *  centre by `box.rotate` — the same transform the CSS handle rides on its
 *  rotated parent (`.carousel-studio__chrome-box`, `carousel.css`), worked out
 *  by hand because this module has no DOM to measure it from. The rotation
 *  runs in client pixels, not `rect`'s fractions, so it stays a true angle
 *  whatever the frame's aspect ratio is.
 *
 * @param {{left:number,top:number,width:number,height:number}} rect
 * @param {{x:number,y:number,w:number,h:number,rotate?:number}} box  0..1 of rect
 */
export function rotateHandlePoint(rect, box, offsetPx = ROTATE_HANDLE_OFFSET_PX) {
  const cx = rect.left + (box.x + box.w / 2) * rect.width;
  const cy = rect.top + (box.y + box.h / 2) * rect.height;
  const hx = cx;
  const hy = rect.top + box.y * rect.height - offsetPx;
  const rad = ((box.rotate || 0) * Math.PI) / 180;
  const dx = hx - cx;
  const dy = hy - cy;
  return {
    x: cx + dx * Math.cos(rad) - dy * Math.sin(rad),
    y: cy + dx * Math.sin(rad) + dy * Math.cos(rad),
  };
}

/**
 * Whether `(cx, cy)` lands within `ROTATE_HANDLE_HIT_PX` of the rotate
 * handle. Checked before {@link hitLayer} — the handle sits well clear of the
 * box's own edges, so the two never contend for the same press.
 *
 * @param {{left:number,top:number,width:number,height:number}} rect
 * @param {{x:number,y:number,w:number,h:number,rotate?:number}} box
 * @param {number} cx
 * @param {number} cy
 * @param {number} [hitPx] `ROTATE_HANDLE_HIT_PX` by default, its coarse-pointer twin under a touch press.
 * @param {number} [offsetPx] `ROTATE_HANDLE_OFFSET_PX` by default, its coarse-pointer twin under a touch press.
 */
export function hitRotateHandle(
  rect,
  box,
  cx,
  cy,
  hitPx = ROTATE_HANDLE_HIT_PX,
  offsetPx = ROTATE_HANDLE_OFFSET_PX,
) {
  if (!rect.width || !rect.height) return false;
  const p = rotateHandlePoint(rect, box, offsetPx);
  return Math.hypot(cx - p.x, cy - p.y) <= hitPx;
}

/** Clamp a box to the canvas the way `normalizeBox` (`document.js`) does — a
 *  preview-smoothness clamp only; the commit re-clamps through the mutator.
 *  Spreads `box` for the same reason `dragBox` and `snapBox` do: the clamp owns
 *  only the four geometry fields, and a rebuilt `{x,y,w,h}` would drop a layer's
 *  `rotate` into every provisional frame of a drag. */
function clampBox(box) {
  const w = Math.min(Math.max(box.w, MIN_BOX), 1);
  const h = Math.min(Math.max(box.h, MIN_BOX), 1);
  return {
    ...box,
    x: Math.min(Math.max(box.x, 0), 1 - w),
    y: Math.min(Math.max(box.y, 0), 1 - h),
    w,
    h,
  };
}

/** The box a move or resize of `startBox` by `(dfx, dfy)` canvas fractions
 *  produces, before snapping and clamping. A move needs no rotation: the
 *  parent element doesn't rotate, and translating a box's local `x/y` moves
 *  it by the same screen amount whatever `rotate` is. A resize keeps the
 *  anchored edge put on screen and never crosses it — a width dragged past
 *  zero pins to `MIN_BOX`. `rect` (only its `width`/`height`) is what turns
 *  `dfx/dfy` from screen fractions into the box's own axes; a caller with no
 *  rotated layers may omit it, since every rotation term below cancels out
 *  when `startBox.rotate` is `0`. Spreads `startBox` in both branches (rather
 *  than rebuilding `{x,y,w,h}` by hand) so a rotated layer's `rotate` rides
 *  through a move or resize untouched — drop it and the provisional paint
 *  would flash the layer back to unrotated for the length of the drag. */
export function dragBox(startBox, mode, anchor, dfx, dfy, rect) {
  if (mode === "move") {
    return { ...startBox, x: startBox.x + dfx, y: startBox.y + dfy };
  }
  const rectW = rect?.width || 1;
  const rectH = rect?.height || 1;
  const rotate = startBox.rotate || 0;

  // The screen-space pointer delta, rotated into the box's own axes — a
  // resize handle on a rotated box has to grow along the layer's own edges,
  // not the screen's, or it shears away from the pointer.
  const rad = (-rotate * Math.PI) / 180;
  const dpx = dfx * rectW;
  const dpy = dfy * rectH;
  const ldx = (dpx * Math.cos(rad) - dpy * Math.sin(rad)) / rectW;
  const ldy = (dpx * Math.sin(rad) + dpy * Math.cos(rad)) / rectH;

  const w = anchor.h ? Math.max(MIN_BOX, startBox.w + anchor.h * ldx) : startBox.w;
  const h = anchor.v ? Math.max(MIN_BOX, startBox.h + anchor.v * ldy) : startBox.h;

  // No rotation: the anchored edge is exactly the untouched startBox value,
  // same as ever — this is the overwhelmingly common case, and the plain
  // assignment below is exact where the general formula past this point
  // would only be exact up to a float ulp.
  if (!rotate) {
    const x = anchor.h < 0 ? startBox.x + startBox.w - w : startBox.x;
    const y = anchor.v < 0 ? startBox.y + startBox.h - h : startBox.y;
    return { ...startBox, x, y, w, h };
  }

  // The corner opposite the dragged handle is the anchor. Its half-extent
  // shrinks or grows with `w`/`h`, and that change has to be turned back
  // through the box's own rotation (the forward half of the transform
  // `unrotatePoint` inverts) before it can be added to the box's centre —
  // otherwise the anchor corner drifts on screen as the box resizes.
  const radF = (rotate * Math.PI) / 180;
  const ox = (-anchor.h * (startBox.w - w)) / 2;
  const oy = (-anchor.v * (startBox.h - h)) / 2;
  const dcx = (ox * rectW * Math.cos(radF) - oy * rectH * Math.sin(radF)) / rectW;
  const dcy = (ox * rectW * Math.sin(radF) + oy * rectH * Math.cos(radF)) / rectH;

  const x = startBox.x + startBox.w / 2 + dcx - w / 2;
  const y = startBox.y + startBox.h / 2 + dcy - h / 2;
  return { ...startBox, x, y, w, h };
}

/**
 * Snap a dragged box's live edges to `lines` — whatever `snapLines` resolved for
 * the space this drag is in — within `tol` fractions per axis. A `move` snaps
 * whichever of the three verticals (left / centre / right) and three
 * horizontals is closest; a `resize` snaps only the edges its anchor is
 * dragging. Returns the adjusted box and the guide lines that engaged, for the
 * caller to draw. `suppressed` (a modifier key held) returns the box untouched
 * with no guides.
 *
 * The lines arrive resolved rather than being derived here: this function knows
 * nothing about safe areas, canvases or decks, so a second coordinate space
 * costs it no branch at all.
 *
 * @param {{v:number[], h:number[]}} lines
 * @returns {{box:{x:number,y:number,w:number,h:number}, guides:{v:number[],h:number[]}}}
 */
export function snapBox(box, mode, anchor, lines, tol, suppressed) {
  const guides = { v: [], h: [] };
  if (suppressed) return { box, guides };

  const vLines = lines?.v || [];
  const hLines = lines?.h || [];
  const next = { ...box };

  /** Nearest line to `value` within `t`, or null. */
  const near = (value, lines, t) => {
    let best = null;
    let bestD = t;
    for (const line of lines) {
      const d = Math.abs(value - line);
      if (d <= bestD) {
        bestD = d;
        best = line;
      }
    }
    return best;
  };

  // Which edges are live: a move drags all three; a resize only its anchor's.
  const xEdges =
    mode === "move"
      ? [["x", 0], ["x", box.w / 2], ["x", box.w]]
      : anchor.h < 0
        ? [["x", 0]]
        : anchor.h > 0
          ? [["x", box.w]]
          : [];
  const yEdges =
    mode === "move"
      ? [["y", 0], ["y", box.h / 2], ["y", box.h]]
      : anchor.v < 0
        ? [["y", 0]]
        : anchor.v > 0
          ? [["y", box.h]]
          : [];

  for (const [, off] of xEdges) {
    const line = near(box.x + off, vLines, tol.x);
    if (line == null) continue;
    if (mode === "move") next.x = line - off;
    else if (anchor.h < 0) {
      next.x = line;
      next.w = box.x + box.w - line;
    } else {
      next.w = line - box.x;
    }
    guides.v.push(line);
    break;
  }
  for (const [, off] of yEdges) {
    const line = near(box.y + off, hLines, tol.y);
    if (line == null) continue;
    if (mode === "move") next.y = line - off;
    else if (anchor.v < 0) {
      next.y = line;
      next.h = box.y + box.h - line;
    } else {
      next.h = line - box.y;
    }
    guides.h.push(line);
    break;
  }
  return { box: next, guides };
}

/** The midpoint and spread of the live pointers — one finger gives `dist: 0`,
 *  which is what makes the same handler serve a drag and a pinch. */
export function pointerCentroid(pointers) {
  const pts = [...pointers.values()];
  if (!pts.length) return { cx: 0, cy: 0, dist: 0 };
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const dist =
    pts.length < 2 ? 0 : Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  return { cx, cy, dist };
}

/** Scale a crop about its own centre. `ratio > 1` widens the crop (zooms out). */
export function zoomCrop(crop, ratio) {
  const w = crop.w * ratio;
  const h = crop.h * ratio;
  return { x: crop.x + (crop.w - w) / 2, y: crop.y + (crop.h - h) / 2, w, h };
}

/** Whether two crops resolve to the same whole source pixels — the only
 *  difference the render can see, since `deckSlideRects` rounds there. */
export function sameCrop(a, b, srcW, srcH) {
  const w = srcW || 1;
  const h = srcH || 1;
  return (
    Math.round(a.x * w) === Math.round(b.x * w) &&
    Math.round(a.y * h) === Math.round(b.y * h) &&
    Math.round(a.w * w) === Math.round(b.w * w) &&
    Math.round(a.h * h) === Math.round(b.h * h)
  );
}

/**
 * Normalized source units per CSS pixel of the slide's image element, read
 * from the same `deckSlideFitCSS` the preview draws with — which is what makes
 * a 100px drag move the image 100px, at any zoom and either `fit`.
 *
 * @param {{x: number, y: number, w: number, h: number}} crop
 * @param {'cover'|'contain'} fit
 * @param {{width: number, height: number}} box  the image element's box
 * @param {{srcW: number|null, srcH: number|null, aspect: string}} dims
 */
export function panScale(crop, fit, box, { srcW, srcH, aspect }) {
  const css = deckSlideFitCSS(srcW || 0, srcH || 0, aspect, crop, fit);
  const per = (sizePct, px) => (sizePct > 0 && px > 0 ? 100 / sizePct / px : 0);
  return { x: per(css.size[0], box.width), y: per(css.size[1], box.height) };
}

/**
 * @typedef {object} DeckGestureHost  Everything this module is not allowed to
 *   own: the source pixels, the document, and every write to either.
 * @property {(i: number) => {srcW: number|null, srcH: number|null, aspect: string}} dims
 *   The pixel size of slide `i`'s source, and the deck's aspect — read per
 *   event, never cached. Per slide, because a deck can name a different photo
 *   on each one and a crop is normalized against its own source.
 * @property {(i: number) => import('../document.js').CarouselSlide|null} slideAt
 *   The document's slide `i`, or null if there is none.
 * @property {(i: number, slide: import('../document.js').CarouselSlide) => void} paint
 *   Paint a provisional slide straight to the DOM, without committing it.
 * @property {(i: number, crop: {x: number, y: number, w: number, h: number}) => void} commit
 *   Write a finished crop into the document. Already clamped, and already
 *   known to differ from the slide's own.
 * @property {(i: number) => void} select  Make slide `i` the selection.
 * @property {(i: number) => void} refocus  Slide `i` is about to lose focus to
 *   a rebuild; put it back afterwards.
 * @property {(px: number) => void} scrollPaneBy  Scroll the strip sideways by
 *   `px` CSS pixels (positive moves it the way a positive `deltaX`/`deltaY`
 *   would). The un-modified default of a drag or a wheel over a column —
 *   `touch-action` already gives a finger this for free, so only the mouse
 *   drag and the wheel path call it. No drag calls it in the touch layout,
 *   where the scroller is locked and a plain drag pans the crop instead; the
 *   wheel path still does, and moves nothing there, which costs nothing and
 *   keeps a device with both a wheel and a touchscreen behaving. The host owns
 *   the scroller; this module never touches it directly, the same as every
 *   other DOM write.
 * @property {() => {i: number, j: number, box: {x:number,y:number,w:number,h:number,rotate?:number},
 *   scope?: 'slide'|'span'}|null} [activeLayer]
 *   The selected layer — the slide index to commit it to, its index in that
 *   slide's list, its current box, and the space that box is fractions of
 *   (`"slide"`, the default, or `"span"` for a deck-wide layer, whose `i` is
 *   the document's span pseudo-slide). Null when no layer is selected. Read per
 *   press: it decides whether a press moves a layer or pans the slide, and in
 *   which space.
 * @property {(scope: 'slide'|'span') => {x:number,y:number,w:number,h:number}|null} [safeArea]
 *   The safe-area rect of `scope`'s space, in that space's fractions, for
 *   snapping. Null disables safe-area snap (centre, edge and seam guides still
 *   apply).
 * @property {(i: number, j: number, box: {x:number,y:number,w:number,h:number,rotate?:number}, guides: {v:number[],h:number[]}) => void} [paintLayer]
 *   Paint layer `j` of slide `i` at a provisional box, plus the snap guides that
 *   engaged — the layer twin of `paint`. A rotate drag calls this with empty
 *   guides — an angle has nothing in `lines` to snap to.
 * @property {(i: number, j: number, box: {x:number,y:number,w:number,h:number,rotate?:number}) => void} [commitLayer]
 *   Write a finished box into the document, through the layer mutator (which
 *   re-clamps) — the layer twin of `commit`.
 * @property {(i: number) => Array<{scope:'slide'|'span', j: number, box:{x:number,y:number,w:number,h:number}}>} [layersOnColumn]
 *   Every layer painted on column `i`, topmost (last-painted) first — the
 *   column's own slide layers, then any span layer whose coverage reaches it
 *   — matching the DOM stacking order `layerNodes`/`spanNodes`
 *   (`studio/panels.js`) paint in. Read on a press that misses the active
 *   layer, to hit-test the stage's click-to-select against every *other*
 *   layer there.
 * @property {(i: number, j: number, scope: 'slide'|'span') => void} [selectLayer]
 *   Select layer `j` of `scope` directly from the stage — `i` is the pressed
 *   column, for `scope: "slide"` only (a span layer's selection isn't
 *   slide-bound). The click-to-select twin of `select`; both converge on the
 *   same `selectedLayer`/`layerScope` the side-panel list already writes.
 * @property {(i: number, j: number, scope: 'slide'|'span') => void} [editLayer]
 *   Enter on-canvas editing for the already-selected layer `j` of `scope` —
 *   `i` is the column the double-click landed on. A no-op where the layer
 *   isn't a `text` layer; that check needs the layer's own `type`, which this
 *   module never reads, so it is the host's to make.
 * @property {() => boolean} [isEditing]
 *   Whether an on-canvas text edit is in progress anywhere on the stage. True
 *   for the whole gesture surface, not just the column being edited: every
 *   `onPointerDown`/`onDoubleClick` bails out while it holds, so the only way
 *   out of an edit is the blur (or Escape) that ends it.
 * @property {() => void} [flushFields]
 *   Commit the properties rail's focused field, if any, before a press, a
 *   wheel notch or a frame key claims the gesture. Every path here calls
 *   `e.preventDefault()`, which suppresses the focus change a text field's
 *   own `change` depends on — this is the host's chance to commit it anyway.
 * @property {(i: number) => {mode: 'draw'|'erase'}|null} [drawSession]
 *   The ink tool's session, if column `i` is the one it is scoped to — read
 *   on every press ahead of every other `PRESS_KINDS` attempt and the crop
 *   fallback, since a session claims the whole column while it is open. Null
 *   everywhere else, including every other column while one is open.
 * @property {(fx: number, fy: number) => void} [inkDrawStart]
 *   Begin a fresh stroke at this column-fraction point — a session's own
 *   `"draw"` press.
 * @property {(fx: number, fy: number) => void} [inkDrawMove]
 *   Append a point to the stroke in progress — called once per
 *   `getCoalescedEvents` entry, not once per `pointermove`, so a fast stylus
 *   line samples at the device's own rate rather than the frame rate.
 * @property {() => void} [inkDrawEnd]
 *   Finish the stroke in progress on release. Never writes to the document —
 *   the session commits once, when it ends, not once per stroke.
 * @property {(fx: number, fy: number) => void} [inkEraseAt]
 *   Drop whichever of the session's own strokes this column-fraction point
 *   touches, whole — the eraser never cuts one in half. Called on the press
 *   and on every coalesced move point of an `"erase"`-mode session.
 * @property {() => void} [inkDrawAbort]
 *   Throw away the stroke in progress instead of finishing it — a second
 *   finger landed on a live `"ink-draw"` drag, so the first finger's mark was
 *   the opening half of a two- or three-finger tap, not a stroke the user
 *   wanted. The gesture calls this *instead of* `inkDrawEnd` for that drag.
 * @property {(count: number) => void} [multiTap]
 *   `count` fingers tapped the stage together — 2 or 3, the only counts this
 *   module reports. What they do is the host's: inside an ink session they
 *   step the session's own strokes, anywhere else the document's history.
 */

/**
 * Build the controller. Handlers are bound by `attach` and released by the next
 * `attach` or by `destroy`; the pending wheel commit deliberately survives a
 * re-attach, so a burst that happens to straddle a rebuild still lands once.
 *
 * @param {DeckGestureHost} host
 */
export function createDeckGestures(host) {
  const listeners = createListenerGroup();
  /** How many columns the last `attach` bound — the deck's slide count, which
   *  is what turns one column's rect into the whole deck's. */
  let count = 0;
  /** The in-flight gesture, tagged by `kind`: a `"crop"` pan/pinch
   *  ({ i, frame, pointers, crop, startCrop, start, moved, undecided }), a
   *  `"layer"` move/resize/pinch ({ i, slide, j, frame, mode, anchor, space,
   *  startX, startY, startBox, box, moved, pointers, pinch? }), a `"rotate"`
   *  drag ({ i, slide, j, frame, centerX, centerY, startX, startY, startAngle,
   *  startRotate, startBox, box, moved }), a `"pane"` scroll-by-hand
   *  ({ i, frame, startX, lastX, moved }), or an `"ink-draw"`/`"ink-erase"`
   *  session stroke ({ i, frame, pointers, aborted }) — the stroke's own points and the
   *  session's strokes both live in `host`'s own state (`index.js`), not
   *  here, since they outlive any one press — where `i` is
   *  the column holding the pointer and `slide` the index the box commits to,
   *  the two being the same thing for everything but a span layer. One at a
   *  time — a press mid-gesture is ignored, except a second finger onto a
   *  `"layer"` drag already in flight (`onLayerPointerAdd`), which turns it
   *  into a pinch: `pointers` grows to two and `pinch` — the baseline
   *  distance, angle and box the two fingers scale and rotate from — appears
   *  once it does. */
  let drag = null;
  /** A crop written to the DOM but not yet committed to the document (a wheel
   *  gesture, which has no release event to commit on). */
  let pending = null;
  let pendingTimer = null;
  let destroyed = false;
  /** Two- and three-finger taps, read off the same pointer stream every
   *  handler below already sees — one watcher for the whole deck, not one
   *  per column, since the fingers of a tap need not land on the same one.
   *  Only 2 and 3 have a meaning here; every other count is a tap the host
   *  has nothing to do with, starting with the single tap that is already
   *  every other gesture's own press. */
  const multiTap = createMultiTapWatcher({
    onTap: (count) => {
      if (count === 2 || count === 3) host.multiTap?.(count);
    },
  });

  /** Clamp a crop against the pixels of slide `i`'s own source — a deck may
   *  name a different photo per slide, so the dimensions are asked for per
   *  slide rather than once for the deck. */
  const clamp = (i, crop) => {
    const { srcW, srcH } = host.dims(i);
    return clampPan(crop, srcW || 0, srcH || 0);
  };

  /**
   * The one commit point for a gesture's crop. A drag that ran into the edge of
   * the source lands back on the crop it started from — give or take a float
   * ulp from the clamp — and committing that would mark the studio dirty and
   * re-encode a slide whose pixels are identical. So: repaint from the document
   * and leave it alone.
   */
  const commitCrop = (i, crop) => {
    const slide = host.slideAt(i);
    if (!slide) return;
    const { srcW, srcH } = host.dims(i);
    const next = clamp(i, crop);
    commitIfChanged(
      (a, b) => sameCrop(a, b, srcW, srcH),
      next,
      slide.crop,
      () => {
        host.paint(i, slide);
        host.select(i);
      },
      (n) => host.commit(i, n),
    );
  };

  const commitPending = () => {
    const p = pending;
    pending = null;
    pendingTimer = null;
    if (!p || destroyed) return;
    commitCrop(p.i, p.crop);
  };

  const onLayerMove = (e) => {
    if (!drag || drag.kind !== "layer") return;
    if (drag.pointers.size > 1) {
      if (!drag.pointers.has(e.pointerId)) return;
      drag.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      onLayerPinchMove();
      e.preventDefault?.();
      return;
    }
    const { rect, lines, tol } = drag.space;
    const dfx = (e.clientX - drag.startX) / (rect.width || 1);
    const dfy = (e.clientY - drag.startY) / (rect.height || 1);
    if (pastSlop(e.clientX - drag.startX, e.clientY - drag.startY)) drag.moved = true;

    const raw = dragBox(drag.startBox, drag.mode, drag.anchor, dfx, dfy, rect);
    // The guides are axis-aligned; a rotated box's own edges aren't, so there
    // is no honest line for it to snap to. Route it through `suppressed`
    // rather than growing a second, rotation-aware snapping model.
    const suppressed = Boolean(raw.rotate) || e.altKey || e.metaKey;
    const { box, guides } = drag.moved
      ? snapBox(raw, drag.mode, drag.anchor, lines, tol, suppressed)
      : { box: raw, guides: { v: [], h: [] } };
    drag.box = clampBox(box);
    host.paintLayer?.(drag.slide, drag.j, drag.box, guides);
    e.preventDefault?.();
  };

  /** A second finger landing on a `"layer"` drag already in flight: the touch
   *  answer to the Ctrl/Shift a finger can never hold, since a modifier drag
   *  isn't what a finger has to offer. From here the pair drives scale and
   *  rotation instead of the single finger's translate/resize — a mouse or
   *  pen drag never calls this, since neither carries a second pointer id. */
  const onLayerPointerAdd = (e, frame) => {
    if (drag.pointers.size >= 2) return;
    drag.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const [a, b] = Array.from(drag.pointers.values());
    drag.pinch = {
      dist: Math.hypot(b.x - a.x, b.y - a.y),
      angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
      box: { ...drag.box },
    };
    claimPointer(e, frame, "is-dragging");
  };

  /**
   * Two fingers on the active layer: distance apart scales it about its own
   * centre, the angle between them rotates it — the same pair of numbers
   * {@link pointerCentroid}'s `dist` and this module's own angle maths already
   * read for the crop pinch and the rotate handle, just read together. Scale
   * writes `w`/`h` (and re-derives `x`/`y` so the centre holds); rotate writes
   * `box.rotate` and nothing else, the same rule the ninth handle's own drag
   * keeps — the two never cross-contaminate each other's field.
   */
  const onLayerPinchMove = () => {
    const [a, b] = Array.from(drag.pointers.values());
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    const ratio = drag.pinch.dist > 0 ? dist / drag.pinch.dist : 1;
    const rotateDelta = angle - drag.pinch.angle;
    const start = drag.pinch.box;
    const w = Math.min(Math.max(start.w * ratio, MIN_BOX), 1);
    const h = Math.min(Math.max(start.h * ratio, MIN_BOX), 1);
    const cx = start.x + start.w / 2;
    const cy = start.y + start.h / 2;
    drag.moved = true;
    drag.box = clampBox({
      ...start,
      w,
      h,
      x: cx - w / 2,
      y: cy - h / 2,
      rotate: (start.rotate || 0) + rotateDelta,
    });
    host.paintLayer?.(drag.slide, drag.j, drag.box, { v: [], h: [] });
  };

  /** The angle from the box's own (fixed) centre to `(x, y)`, in degrees —
   *  `atan2` in client-pixel space, so it reads the true angle whatever the
   *  frame's aspect ratio is. */
  const pointerAngle = (drag, x, y) =>
    (Math.atan2(y - drag.centerY, x - drag.centerX) * 180) / Math.PI;

  const onRotateMove = (e) => {
    if (!drag || drag.kind !== "rotate") return;
    if (pastSlop(e.clientX - drag.startX, e.clientY - drag.startY)) drag.moved = true;
    // Wrapped into (-180, 180] so a press near the ±180° seam doesn't jump.
    const delta = (((pointerAngle(drag, e.clientX, e.clientY) - drag.startAngle + 180) % 360) + 360) % 360 - 180;
    let rotate = drag.startRotate + delta;
    if (e.shiftKey) rotate = Math.round(rotate / ROTATE_SNAP_DEG) * ROTATE_SNAP_DEG;
    drag.box = { ...drag.startBox, rotate };
    host.paintLayer?.(drag.slide, drag.j, drag.box, { v: [], h: [] });
    e.preventDefault?.();
  };

  /** The release half of both a layer move/resize and a rotate drag — the
   *  same not-moved-is-a-click bail, the same commit through `commitLayer`.
   *  A `"layer"` drag with two fingers down loses only the one that lifted —
   *  the same partial-release rule `onCropUp` uses for a pinch — and rebases
   *  the survivor as a fresh single-finger translate from where the pinch
   *  left off, rather than ending the gesture under the finger still down. */
  const endLayerDrag = (e, frame) => {
    if (drag.pointers?.size > 1) {
      drag.pointers.delete(e.pointerId);
      frame.releasePointerCapture?.(e.pointerId);
      if (drag.pointers.size === 1) {
        const [pt] = Array.from(drag.pointers.values());
        drag.startX = pt.x;
        drag.startY = pt.y;
        drag.startBox = { ...drag.box };
      }
      return;
    }
    const ended = drag;
    drag = null;
    releasePointer(e, frame, "is-dragging");
    if (!ended.moved) {
      // A press that never travelled: keep the layer selected, move nothing —
      // the slop threshold is what stops a select-click from nudging.
      host.select(ended.i);
      return;
    }
    host.commitLayer?.(ended.slide, ended.j, ended.box);
  };

  /** Take the pointer for the crop gesture: capture it, dress the frame, and
   *  stop the browser doing anything else with the event. */
  const claimCrop = (e, frame) => claimPointer(e, frame, "is-dragging");

  // A press or a key on the reorder handle nested in the column belongs to
  // `attachPointerReorder` / the arrow-key reorder in `index.js`, not to this
  // gesture — without the guard both would claim the same pointerdown or
  // ArrowLeft/ArrowRight, since the handle's own listeners don't (and, being a
  // capture-phase document listener for the pointer case, can't) stop the
  // column's bubble-phase ones from also running.
  const onHandle = (e) => Boolean(e.target?.closest?.(".carousel-studio__rail-handle"));

  /** Everything a fresh press's rotate/layer/select attempts ask in common —
   *  computed once, since all three read the same "what's active here".
   *  `touch` is the press's one touch-layout read, handed in by
   *  `onPointerDown`: here it picks the widened `_COARSE` grab constants,
   *  there it decides the drag kind. */
  const pressContext = (frame, i, touch) => {
    const active = host.activeLayer?.();
    const span = active?.scope === "span";
    const rect = span ? deckRect(frameRect(frame), i, count) : frameRect(frame);
    const grabbable = active && (span || active.i === i);
    return { active, span, rect, grabbable, touch };
  };

  /**
   * The first-claim-wins table a fresh press is tried against, in the
   * priority order the stage draws them in: the rotate handle over the
   * move/resize handles over every other layer on the column. Each entry
   * claims the press (and returns `true`) or defers to the next — the same
   * shape `LAYER_BUILDERS`/`LAYER_PAINTERS` use for a kind-keyed table, not
   * a switch.
   */
  const PRESS_KINDS = [
    // rotate: a press on the ninth handle, above the box's own top edge.
    (e, frame, i, ctx) => {
      const hitPx = ctx.touch ? ROTATE_HANDLE_HIT_PX_COARSE : ROTATE_HANDLE_HIT_PX;
      const offsetPx = ctx.touch ? ROTATE_HANDLE_OFFSET_PX_COARSE : ROTATE_HANDLE_OFFSET_PX;
      if (
        !ctx.grabbable ||
        !hitRotateHandle(ctx.rect, ctx.active.box, e.clientX, e.clientY, hitPx, offsetPx)
      ) {
        return false;
      }
      const cx = ctx.rect.left + (ctx.active.box.x + ctx.active.box.w / 2) * ctx.rect.width;
      const cy = ctx.rect.top + (ctx.active.box.y + ctx.active.box.h / 2) * ctx.rect.height;
      drag = {
        kind: "rotate",
        i,
        slide: ctx.active.i,
        j: ctx.active.j,
        frame,
        centerX: cx,
        centerY: cy,
        startX: e.clientX,
        startY: e.clientY,
        startAngle: (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI,
        startRotate: ctx.active.box.rotate || 0,
        startBox: { ...ctx.active.box },
        box: { ...ctx.active.box },
        moved: false,
      };
      claimPointer(e, frame, "is-dragging");
      return true;
    },
    // layer: a press on the active layer's own box or one of its eight
    // move/resize handles.
    (e, frame, i, ctx) => {
      const grabPx = ctx.touch ? HANDLE_GRAB_PX_COARSE : HANDLE_GRAB_PX;
      const hit = ctx.grabbable ? hitLayer(ctx.rect, ctx.active.box, e.clientX, e.clientY, grabPx) : null;
      if (!hit) return false;
      drag = {
        kind: "layer",
        i,
        slide: ctx.active.i,
        j: ctx.active.j,
        frame,
        mode: hit.mode,
        anchor: { h: hit.h, v: hit.v },
        space: layerSpace(
          ctx.rect,
          host.safeArea?.(ctx.span ? "span" : "slide") || null,
          ctx.span ? deckSeams(count) : [],
        ),
        startX: e.clientX,
        startY: e.clientY,
        startBox: { ...ctx.active.box },
        box: { ...ctx.active.box },
        moved: false,
        // A second finger arriving mid-drag turns this into a pinch — see
        // `onLayerPointerAdd`/`onLayerPinchMove`. A mouse or pen drag never
        // grows past one entry.
        pointers: new Map([[e.pointerId, { x: e.clientX, y: e.clientY }]]),
      };
      claimPointer(e, frame, "is-dragging");
      return true;
    },
    // select: the press missed the active layer (or nothing is active), but
    // still lands on some *other* layer painted on this column — the
    // stage's click-to-select. Topmost first, and a plain containment test —
    // an unselected layer shows no handles to grab.
    (e, frame, i) => {
      const picked = (host.layersOnColumn?.(i) || []).find((cand) =>
        layerContains(
          cand.scope === "span" ? deckRect(frameRect(frame), i, count) : frameRect(frame),
          cand.box,
          e.clientX,
          e.clientY,
        ),
      );
      if (!picked) return false;
      e.preventDefault?.();
      host.selectLayer?.(i, picked.j, picked.scope);
      return true;
    },
  ];

  // Mid on-canvas edit, no press claims a gesture — one on the
  // `contenteditable` block itself belongs to it (caret placement,
  // selection, the works; `carousel.css` re-enables `pointer-events` there
  // for exactly this, over an ancestor chain that is otherwise `pointer-
  // events: none` so the stage can hit-test box coordinates instead of DOM
  // targets everywhere else), and one anywhere else on the column is what a
  // click outside a focused textarea always is — a plain blur, which commits
  // the edit (`index.js`'s `_exitTextEdit`) — not a layer grab. Without this,
  // the active layer's own move zone (`hitLayer`, below) would claim it and
  // `preventDefault` the very focus change that blur depends on.
  const onPointerDown = (e, frame, i) => {
    host.flushFields?.();
    if (e.button != null && e.button > 0) return;
    if (onHandle(e)) return;
    if (host.isEditing?.()) return;
    const slide = host.slideAt(i);
    if (!slide) return;

    // One read of the media query per press, for every branch below that cares
    // — the grab tolerances, the drag kind, and the claim policy `onCropMove`
    // applies to a finger that has not declared a direction yet.
    const touch = isTouchLayout();

    // The ink tool's own session, scoped to one column by `host.drawSession`
    // (`index.js`): while it answers for this one, a press here draws or
    // erases instead of selecting, panning or cropping — every other column
    // is untouched, exactly as `is-layer-armed` scopes a layer drag to one.
    if (!drag) {
      const session = host.drawSession?.(i);
      if (session) {
        e.preventDefault?.();
        claimPointer(e, frame, "is-drawing");
        const { fx, fy } = frameFraction(frame, e.clientX, e.clientY);
        const pointers = new Set([e.pointerId]);
        if (session.mode === "erase") {
          drag = { kind: "ink-erase", i, frame, pointers, aborted: false };
          host.inkEraseAt?.(fx, fy);
        } else {
          drag = { kind: "ink-draw", i, frame, pointers, aborted: false };
          host.inkDrawStart?.(fx, fy);
        }
        return;
      }
    }

    // A second (or third) finger onto a live ink drag. It is never a second
    // stroke: a session is one pointer's at a time, and a finger landing
    // beside one already drawing is the rest of a two- or three-finger tap.
    // So abort the stroke in progress — without this the fingers that came
    // to undo a mark leave one first — and swallow every further press until
    // the whole group lifts, so the third finger of a redo tap cannot start
    // a fresh stroke of its own either. The tap itself is the watcher's to
    // report, on the last release.
    if (drag && (drag.kind === "ink-draw" || drag.kind === "ink-erase") && drag.i === i) {
      drag.pointers.add(e.pointerId);
      if (drag.kind === "ink-draw" && !drag.aborted) host.inkDrawAbort?.();
      drag.aborted = true;
      e.preventDefault?.();
      return;
    }

    // A layer takes the press only when its own layer is selected and the press
    // lands on it or a handle; anything else falls through to the crop gesture,
    // so pan/zoom is unchanged wherever a layer is not in the way. A slide layer
    // is grabbable on its own column only; a span layer on every column it
    // reaches, because its box spans them all.
    if (!drag) {
      const ctx = pressContext(frame, i, touch);
      if (PRESS_KINDS.some((attempt) => attempt(e, frame, i, ctx))) return;
    }
    if (drag && drag.kind === "layer") {
      // A second finger, still on the column the drag started on, is a pinch
      // — see `onLayerPointerAdd`. One landing elsewhere (a span layer's
      // other columns) is left alone: pinch reads both fingers off one rect,
      // and a press mid-gesture on a column that isn't driving it claims
      // nothing here either way.
      if (drag.i === i) onLayerPointerAdd(e, frame);
      return;
    }

    if (!drag || drag.i !== i) {
      const modified = e.ctrlKey || e.shiftKey;
      if (!touch && e.pointerType !== "touch" && !modified) {
        // A mouse or pen with no modifier: drag the strip itself. A finger
        // gets this for free from `touch-action`; a mouse has no native
        // drag-to-scroll of its own, so this drives it through the host —
        // which owns the scroller, the same way it owns every other write.
        // Never in the touch layout: the scroller is locked there, so a plain
        // drag has nothing to scroll and pans the crop instead.
        drag = { kind: "pane", i, frame, lastX: e.clientX, startX: e.clientX, moved: false };
        claimPointer(e, frame, "is-dragging", { preventDefault: false });
        return;
      }
      drag = {
        kind: "crop",
        i,
        frame,
        pointers: new Map(),
        crop: { ...slide.crop },
        moved: false,
        // A touch with no modifier has not said yet whether it is a pinch or
        // just the finger `touch-action` is already panning the strip (and
        // the page) with; every other case — Ctrl/Shift held, or a mouse/pen
        // that already asked for the crop above — is decided immediately.
        // The touch layout does not shorten this wait, it only changes how it
        // ends: the tile is `touch-action: none` there, so `touchOwnsBoth`
        // below turns the first resolved direction into a claim rather than a
        // hand-back. Waiting is still what keeps a tap a tap.
        undecided: e.pointerType === "touch" && !modified,
        touchOwnsBoth: touch,
      };
    }
    drag.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // A second finger is a pinch, and a pinch is never a scroll — take the
    // gesture now, whatever the first finger was still deciding.
    if (drag.pointers.size > 1) drag.undecided = false;
    if (!drag.undecided) claimCrop(e, frame);
    // Re-baseline on every pointer down: a second finger arriving starts a
    // pinch from where the drag left off rather than from where it began.
    drag.start = pointerCentroid(drag.pointers);
    drag.startCrop = { ...drag.crop };
  };

  const onPaneMove = (e) => {
    const dx = e.clientX - drag.lastX;
    drag.lastX = e.clientX;
    if (Math.abs(e.clientX - drag.startX) > DRAG_SLOP_PX) drag.moved = true;
    // The content follows the pointer, the same convention a touch's own
    // native pan already uses: a leftward drag moves the strip left,
    // revealing what is to its right.
    host.scrollPaneBy(-dx);
    e.preventDefault?.();
  };

  const onPaneUp = (e, frame, i) => {
    const ended = drag;
    drag = null;
    releasePointer(e, frame, "is-dragging");
    if (!ended.moved) {
      // A click, not a drag: select the slide, same as a tap always has.
      host.select(i);
    }
  };

  const onCropMove = (e, frame, i) => {
    const slide = host.slideAt(i);
    if (!drag || drag.i !== i || !drag.pointers.has(e.pointerId) || !slide) return;

    // The undecided single finger: no modifier and not yet a pinch, so
    // `touch-action` is already panning the strip (and, off-axis, the page)
    // with it — nothing here claims the pointer or paints a crop. Only
    // whether a direction has resolved matters, so a release that turns out
    // to have been a scroll doesn't also select the tile (`onCropUp` reads
    // `!drag` the same way an abandoned gesture always has). Neither axis is
    // this gesture's own — the tile is `touch-action: pan-x pan-y` — so any
    // resolved direction hands the finger back.
    //
    // Both axes are its own in the touch layout: the tile is `touch-action:
    // none` and the strip does not scroll, so there is no scroller left to
    // hand anything back to. The direction resolving is then the claim, and
    // this same move goes on to pan the crop from the press point.
    if (drag.undecided) {
      const claimed = resolveTouchClaim(
        e.clientX - drag.start.cx,
        e.clientY - drag.start.cy,
        () => drag.touchOwnsBoth,
      );
      if (claimed === "abandon") {
        drag = null;
        return;
      }
      if (claimed !== "claim") return;
      drag.undecided = false;
      claimCrop(e, frame);
    }

    drag.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const now = pointerCentroid(drag.pointers);
    const img = frame.querySelector(".carousel-studio__frame-img");
    const box = img?.getBoundingClientRect?.() || { width: 0, height: 0 };
    // Two fingers spreading apart shrink the crop; one finger leaves it alone.
    const ratio =
      drag.start.dist > 0 && now.dist > 0 ? drag.start.dist / now.dist : 1;
    const zoomed = zoomCrop(drag.startCrop, ratio);
    const scale = panScale(drag.startCrop, slide.fit, box, host.dims(i));
    const dx = now.cx - drag.start.cx;
    const dy = now.cy - drag.start.cy;
    // The image follows the pointer, so the crop moves the other way.
    const crop = clamp(i, {
      ...zoomed,
      x: zoomed.x - dx * scale.x,
      y: zoomed.y - dy * scale.y,
    });

    if (pastSlop(dx, dy) || ratio !== 1) {
      drag.moved = true;
    }
    drag.crop = crop;
    // Straight to the DOM — no state change, so a drag costs no rebuild and no
    // decode, only two style writes per frame.
    host.paint(i, { ...slide, crop });
    e.preventDefault?.();
  };

  const onCropUp = (e, frame, i) => {
    if (!drag || drag.i !== i) return;
    const ended = drag;
    ended.pointers.delete(e.pointerId);
    frame.releasePointerCapture?.(e.pointerId);
    if (ended.pointers.size) {
      // A finger lifted out of a pinch — carry on with the rest.
      ended.start = pointerCentroid(ended.pointers);
      ended.startCrop = { ...ended.crop };
      return;
    }

    frame.classList.remove("is-dragging");
    drag = null;
    if (!ended.moved) {
      // A click, not a drag: select the slide and leave its framing alone.
      host.select(i);
      return;
    }
    commitCrop(i, ended.crop);
  };

  /** Every point `getCoalescedEvents` hands one `pointermove` — a fast
   *  stylus line is many samples per frame, and reading only the dispatched
   *  event would chain them into a chord instead of a smooth curve
   *  (`Behaviour`). `host.inkDrawMove` appends each one to the stroke in
   *  progress and repaints the draft; no state change, same as every other
   *  provisional paint in this module. */
  const onInkDrawMove = (e, frame) => {
    if (!drag || drag.kind !== "ink-draw" || drag.aborted) return;
    const events = e.getCoalescedEvents?.() || [e];
    for (const ev of events) {
      const { fx, fy } = frameFraction(frame, ev.clientX, ev.clientY);
      host.inkDrawMove?.(fx, fy);
    }
    e.preventDefault?.();
  };

  /** The same coalesced read, for the eraser: every point along the drag is
   *  tested against the session's own strokes, not just the ones the
   *  dispatched event lands on — a fast wipe must not skip a mark between
   *  two samples. */
  const onInkEraseMove = (e, frame) => {
    if (!drag || drag.kind !== "ink-erase" || drag.aborted) return;
    const events = e.getCoalescedEvents?.() || [e];
    for (const ev of events) {
      const { fx, fy } = frameFraction(frame, ev.clientX, ev.clientY);
      host.inkEraseAt?.(fx, fy);
    }
    e.preventDefault?.();
  };

  /** The release half of both ink drags: `"ink-draw"` finalizes the stroke in
   *  progress (`host.inkDrawEnd`), `"ink-erase"` has nothing left to do —
   *  every touch already erased live. Neither ever writes to the document:
   *  the session commits once, when it ends (`index.js`'s `_endDrawSession`),
   *  not once per stroke.
   *
   *  The drag ends when the *last* of its pointers lifts, not the first: a
   *  drag a second finger aborted is still holding one or two fingers that
   *  must not fall through to the crop gesture on their way up. An aborted
   *  drag finalizes nothing — `host.inkDrawAbort` already threw the stroke
   *  away. */
  const endInkDrag = (e, frame) => {
    releasePointer(e, frame, "is-drawing");
    drag.pointers.delete(e.pointerId);
    if (drag.pointers.size) return;
    const { kind, aborted } = drag;
    drag = null;
    if (kind === "ink-draw" && !aborted) host.inkDrawEnd?.();
  };

  /** Every kind but `"crop"` dispatches the same way: only the column that
   *  started it hears its move/up, and `"crop"` — the fallback — reads its
   *  own guard, since a pinch may span more than one pointer over one
   *  column. A table over `drag.kind`, not a switch, in the same spirit as
   *  `LAYER_BUILDERS`/`LAYER_PAINTERS`. */
  const MOVE_HANDLERS = {
    rotate: onRotateMove,
    layer: onLayerMove,
    pane: onPaneMove,
    "ink-draw": onInkDrawMove,
    "ink-erase": onInkEraseMove,
  };
  const END_HANDLERS = {
    rotate: endLayerDrag,
    layer: endLayerDrag,
    pane: onPaneUp,
    "ink-draw": endInkDrag,
    "ink-erase": endInkDrag,
  };

  const onPointerMove = (e, frame, i) => {
    const handler = drag && MOVE_HANDLERS[drag.kind];
    if (handler) {
      if (drag.i === i) handler(e, frame, i);
      return;
    }
    onCropMove(e, frame, i);
  };

  const onPointerUp = (e, frame, i) => {
    const handler = drag && END_HANDLERS[drag.kind];
    if (handler) {
      if (drag.i === i) handler(e, frame, i);
      return;
    }
    onCropUp(e, frame, i);
  };

  /** Double-click-to-edit: only for the layer already selected (`.3`'s
   *  single click is what gets it there), and only for a press that lands on
   *  its own box — a double-click elsewhere on the column is the crop
   *  gesture's own `onPointerDown`/`onPointerUp` pair, twice, and needs no
   *  help from here. `host.editLayer` itself no-ops for anything but a
   *  `text` layer, since the type is not this module's to know. */
  const onDoubleClick = (e, frame, i) => {
    if (host.isEditing?.()) return;
    const active = host.activeLayer?.();
    if (!active) return;
    const span = active.scope === "span";
    if (!span && active.i !== i) return;
    const rect = span ? deckRect(frameRect(frame), i, count) : frameRect(frame);
    if (!layerContains(rect, active.box, e.clientX, e.clientY)) return;
    e.preventDefault?.();
    host.editLayer?.(i, active.j, active.scope || "slide");
  };

  const onWheel = (e, i) => {
    host.flushFields?.();
    const slide = host.slideAt(i);
    if (!slide) return;

    if (!e.ctrlKey && !e.shiftKey) {
      // Plain wheel: scroll the strip sideways — the axis a trackpad swipe or
      // a plain drag already moves it on — not the crop. Ctrl+wheel is what a
      // trackpad's own pinch-to-zoom already sends on every browser that
      // supports it, which is what makes Ctrl (or Shift, for a plain wheel
      // with no trackpad) the zoom's natural gate rather than an arbitrary one.
      if (!e.deltaX && !e.deltaY) return;
      e.preventDefault?.();
      host.scrollPaneBy(e.deltaX || e.deltaY);
      return;
    }
    if (!e.deltaY) return;
    e.preventDefault?.();
    // deltaMode: 0 pixels, 1 lines, 2 pages — normalize to pixels so a Firefox
    // notch and a Chrome notch zoom by the same amount.
    const px =
      e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const base = pending?.i === i ? pending.crop : slide.crop;
    const crop = clamp(i, zoomCrop(base, Math.exp(px * WHEEL_ZOOM)));

    pending = { i, crop };
    host.paint(i, { ...slide, crop });
    // A wheel gesture has no release event, so the commit is debounced: one
    // document mutation per burst instead of one per notch.
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(commitPending, WHEEL_COMMIT_MS);
  };

  const onFrameKey = (e, i) => {
    host.flushFields?.();
    if (onHandle(e)) return;
    const slide = host.slideAt(i);
    if (!slide) return;

    // With a layer selected the arrows drive it, not the crop: a plain arrow
    // nudges the box, shift-arrow resizes it from its far edge, both at the
    // `KEY_PAN` scale the crop nudge uses.
    const active = host.activeLayer?.();
    if (
      active &&
      (active.scope === "span" || active.i === i) &&
      typeof e.key === "string" &&
      e.key.startsWith("Arrow")
    ) {
      const b = active.box;
      const dx = KEY_PAN * b.w;
      const dy = KEY_PAN * b.h;
      let box = null;
      if (e.shiftKey) {
        if (e.key === "ArrowRight") box = { ...b, w: b.w + dx };
        else if (e.key === "ArrowLeft") box = { ...b, w: b.w - dx };
        else if (e.key === "ArrowDown") box = { ...b, h: b.h + dy };
        else if (e.key === "ArrowUp") box = { ...b, h: b.h - dy };
      } else {
        if (e.key === "ArrowRight") box = { ...b, x: b.x + dx };
        else if (e.key === "ArrowLeft") box = { ...b, x: b.x - dx };
        else if (e.key === "ArrowDown") box = { ...b, y: b.y + dy };
        else if (e.key === "ArrowUp") box = { ...b, y: b.y - dy };
      }
      if (!box) return;
      e.preventDefault?.();
      host.refocus(i);
      host.commitLayer?.(active.i, active.j, clampBox(box));
      return;
    }

    const { crop } = slide;
    const step = KEY_PAN * (e.shiftKey ? 5 : 1);
    let next = null;
    switch (e.key) {
      case "ArrowLeft":
        next = { ...crop, x: crop.x - crop.w * step };
        break;
      case "ArrowRight":
        next = { ...crop, x: crop.x + crop.w * step };
        break;
      case "ArrowUp":
        next = { ...crop, y: crop.y - crop.h * step };
        break;
      case "ArrowDown":
        next = { ...crop, y: crop.y + crop.h * step };
        break;
      case "+":
      case "=":
        next = zoomCrop(crop, 1 / KEY_ZOOM);
        break;
      case "-":
      case "_":
        next = zoomCrop(crop, KEY_ZOOM);
        break;
      default:
        return;
    }
    e.preventDefault?.();
    // The nudge rebuilds the strip under the user's fingers; the page puts
    // focus back so the next arrow press keeps working.
    host.refocus(i);
    commitCrop(i, next);
  };

  /** Release the current frames' listeners. The pending wheel commit is left
   *  alone — a rebuild between two notches is not the end of the gesture. */
  const detach = () => listeners.release();

  return {
    /**
     * Bind to this render's deck columns, releasing the previous render's.
     * Each column's index comes from its own `data-slice`, and how many there
     * are is the deck's slide count — which is what `deckRect` needs to turn
     * one column into the whole deck.
     *
     * @param {ArrayLike<HTMLElement>} frames
     */
    attach(frames) {
      detach();
      if (destroyed) return;
      count = Array.from(frames).length;
      for (const frame of Array.from(frames)) {
        const i = Number(frame.dataset.slice);
        // The tap watcher is fed after the gesture handler, never before: a
        // tap fires on the same `pointerup` that ends whatever drag the
        // fingers also made, and the undo it asks for has to see the drag
        // already settled.
        listeners.bind(frame, [
          ["pointerdown", (e) => { onPointerDown(e, frame, i); multiTap.down(e); }, undefined],
          ["pointermove", (e) => { onPointerMove(e, frame, i); multiTap.move(e); }, undefined],
          ["pointerup", (e) => { onPointerUp(e, frame, i); multiTap.up(e); }, undefined],
          ["pointercancel", (e) => { onPointerUp(e, frame, i); multiTap.cancel(e); }, undefined],
          ["dblclick", (e) => onDoubleClick(e, frame, i), undefined],
          // Not passive: a zoom over the strip must not also scroll the page.
          ["wheel", (e) => onWheel(e, i), { passive: false }],
          ["keydown", (e) => onFrameKey(e, i), undefined],
          ["focus", () => { if (!drag) host.select(i); }, undefined],
        ]);
      }
    },

    detach,

    /** Unmount: drop the listeners and the debounced commit with them. */
    destroy() {
      destroyed = true;
      detach();
      clearTimeout(pendingTimer);
      pendingTimer = null;
      pending = null;
      drag = null;
      multiTap.reset();
    },
  };
}

// ── Panorama: the vertical anchor ───────────────────────────────────────────

/**
 * CSS pixels of vertical travel the panorama band has on a stage `stageH` px
 * tall. `trimmedH * scale` is the slack in canvas pixels — the source height the
 * strip throws away, resampled the way the render will — and the stage shows
 * `dstH` canvas pixels in `stageH` CSS ones, so the same ratio carries it into
 * the pixels the pointer moves in.
 *
 * Zero when the crop leaves no slack, which is the same condition the rail is
 * drawn under (`report.trimmedH > 1` in `panels.js`): there is nothing to drag.
 *
 * @param {number} stageH  the stage's CSS height
 * @param {number} dstH    canvas height for the deck's aspect
 * @param {number} trimmedH source px trimmed off the height
 * @param {number} scale   canvas px per source px
 */
export function anchorSlackPx(stageH, dstH, trimmedH, scale) {
  if (!(stageH > 0) || !(dstH > 0) || !(trimmedH > 0) || !(scale > 0)) return 0;
  return (trimmedH * scale * stageH) / dstH;
}

/**
 * The `anchorY` a vertical drag of `dy` CSS px from `startAnchor` produces.
 *
 * The band follows the pointer, so the anchor runs against it: dragging *down*
 * pulls the image down, which is to say it shows more of the source's top, and
 * `anchorY` is measured from that top. Same sign convention as the crop pan,
 * for the same reason.
 *
 * @param {number} startAnchor
 * @param {number} dy  pointer travel, CSS px, positive downwards
 * @param {number} slackPx  from {@link anchorSlackPx}
 */
export function dragAnchor(startAnchor, dy, slackPx) {
  if (!(slackPx > 0)) return startAnchor;
  return Math.min(1, Math.max(0, startAnchor - dy / slackPx));
}

/** Whether two anchors land the band on the same source pixel — the only
 *  difference the render can see. The twin of `sameCrop`, in the one dimension
 *  a panorama anchor has. */
export function sameAnchor(a, b, trimmedH) {
  return Math.round(a * trimmedH) === Math.round(b * trimmedH);
}

/**
 * @typedef {object} AnchorGestureHost
 * @property {() => {anchorY:number, trimmedH:number, scale:number, dstH:number}|null} metrics
 *   The document's anchor and what the current strategy leaves to move it
 *   through — read per press, never cached, and `null` whenever there is
 *   nothing to drag (deck mode, no source pixels yet, no vertical slack).
 * @property {(anchorY: number) => void} paint  Paint a provisional anchor
 *   straight to the DOM, without committing it.
 * @property {(anchorY: number) => void} commit  Write a finished anchor into
 *   the document. Already clamped, and already known to move the band.
 * @property {(dragging: boolean) => void} [dress]  The gesture started or
 *   ended — the page's cue to show the rail and the grabbing cursor.
 */

/**
 * Build the panorama anchor controller: one vertical drag on the stage, moving
 * the crop band through its slack.
 *
 *   const anchor = createAnchorGesture(host);   // once, at construction
 *   anchor.attach(stage);                       // after every panorama render
 *   anchor.detach();                            // when the stage goes to deck
 *   anchor.destroy();                           // at unmount
 *
 * @param {AnchorGestureHost} host
 */
export function createAnchorGesture(host) {
  const listeners = createListenerGroup();
  /** The in-flight drag, or null. One at a time. */
  let drag = null;
  let destroyed = false;

  const detach = () => listeners.release();

  /** Take the pointer: capture it, dress the stage, and stop the browser doing
   *  anything else with the event. */
  const claim = (e, stage) => {
    claimPointer(e, stage, "is-anchoring");
    host.dress?.(true);
  };

  const onPointerDown = (e, stage) => {
    if (drag || (e.button != null && e.button > 0)) return;
    const m = host.metrics?.();
    if (!m) return;
    const rect = stage.getBoundingClientRect?.();
    const slackPx = anchorSlackPx(rect?.height || 0, m.dstH, m.trimmedH, m.scale);
    if (!(slackPx > 0)) return;

    drag = {
      stage,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startAnchor: m.anchorY,
      anchorY: m.anchorY,
      trimmedH: m.trimmedH,
      slackPx,
      moved: false,
      // A single finger has not said yet whether it is moving the band or
      // panning the strip sideways; a mouse or pen has.
      undecided: e.pointerType === "touch",
    };
    if (!drag.undecided) claim(e, stage);
  };

  const onPointerMove = (e, stage) => {
    if (!drag || e.pointerId !== drag.pointerId) return;

    // The undecided finger, resolved — the mirror of the deck column's call.
    // The stage is `touch-action: pan-x` while there is slack, so a sideways
    // drag belongs to the scroller and this lets go of it; below the threshold
    // the movement is still noise.
    if (drag.undecided) {
      const claimed = resolveTouchClaim(
        e.clientX - drag.startX,
        e.clientY - drag.startY,
        (dir) => dir === "vertical",
      );
      if (claimed === null) return;
      if (claimed === "abandon") {
        drag = null;
        return;
      }
      drag.undecided = false;
      claim(e, stage);
    }

    const dy = e.clientY - drag.startY;
    if (Math.abs(dy) > DRAG_SLOP_PX) drag.moved = true;
    drag.anchorY = dragAnchor(drag.startAnchor, dy, drag.slackPx);
    // Straight to the DOM — no state change, so a drag costs no rebuild and no
    // decode, only the background-position writes the band already lives on.
    host.paint(drag.anchorY);
    e.preventDefault?.();
  };

  const onPointerUp = (e, stage) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const ended = drag;
    drag = null;
    releasePointer(e, stage, "is-anchoring");
    host.dress?.(false);
    if (!ended.moved) return;
    // A drag that ran into the end of the slack lands back where it started;
    // committing that would mark the studio dirty and re-cut a strip whose
    // pixels are identical. Repaint from the document instead.
    commitIfChanged(
      (a, b) => sameAnchor(a, b, ended.trimmedH),
      ended.anchorY,
      ended.startAnchor,
      () => host.paint(ended.startAnchor),
      (n) => host.commit(n),
    );
  };

  return {
    /**
     * Bind to this render's panorama stage, releasing the previous render's.
     * A falsy stage (deck mode, or no builder on screen) just releases.
     *
     * @param {HTMLElement|null} stage
     */
    attach(stage) {
      detach();
      if (destroyed || !stage) return;
      listeners.bind(stage, [
        ["pointerdown", (e) => onPointerDown(e, stage)],
        ["pointermove", (e) => onPointerMove(e, stage)],
        ["pointerup", (e) => onPointerUp(e, stage)],
        ["pointercancel", (e) => onPointerUp(e, stage)],
      ]);
    },

    detach,

    /** Unmount: drop the listeners and any half-finished drag. */
    destroy() {
      destroyed = true;
      detach();
      drag = null;
    },
  };
}
