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
 * anywhere else in this module). A second finger arriving before that happens
 * still claims the pinch, exactly as it does with the modifier held.
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

import { gestureDirection } from "../../../components/light/tags/tagGestures.js";
import { clampPan, deckSlideFitCSS } from "../geometry.js";

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
/** Pointer travel below this is a click, not a drag. */
const DRAG_SLOP_PX = 3;
/** A press within this many CSS px of a selected layer's edge grabs the resize
 *  handle there rather than moving the layer. */
const HANDLE_GRAB_PX = 12;
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
export function hitLayer(rect, box, cx, cy) {
  if (!rect.width || !rect.height) return null;
  const fx = (cx - rect.left) / rect.width;
  const fy = (cy - rect.top) / rect.height;
  const tx = HANDLE_GRAB_PX / rect.width;
  const ty = HANDLE_GRAB_PX / rect.height;
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

/** Clamp a box to the canvas the way `normalizeBox` (`document.js`) does — a
 *  preview-smoothness clamp only; the commit re-clamps through the mutator. */
function clampBox(box) {
  const w = Math.min(Math.max(box.w, MIN_BOX), 1);
  const h = Math.min(Math.max(box.h, MIN_BOX), 1);
  return {
    x: Math.min(Math.max(box.x, 0), 1 - w),
    y: Math.min(Math.max(box.y, 0), 1 - h),
    w,
    h,
  };
}

/** The box a move or resize of `startBox` by `(dfx, dfy)` canvas fractions
 *  produces, before snapping and clamping. A resize keeps the anchored edge put
 *  and never crosses it — a width dragged past zero pins to `MIN_BOX`. */
export function dragBox(startBox, mode, anchor, dfx, dfy) {
  if (mode === "move") {
    return { ...startBox, x: startBox.x + dfx, y: startBox.y + dfy };
  }
  let { x, y, w, h } = startBox;
  if (anchor.h < 0) {
    w = Math.max(MIN_BOX, startBox.w - dfx);
    x = startBox.x + startBox.w - w;
  } else if (anchor.h > 0) {
    w = Math.max(MIN_BOX, startBox.w + dfx);
  }
  if (anchor.v < 0) {
    h = Math.max(MIN_BOX, startBox.h - dfy);
    y = startBox.y + startBox.h - h;
  } else if (anchor.v > 0) {
    h = Math.max(MIN_BOX, startBox.h + dfy);
  }
  return { x, y, w, h };
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
 *   drag and the wheel path call it. The host owns the scroller; this module
 *   never touches it directly, the same as every other DOM write.
 * @property {() => {i: number, j: number, box: {x:number,y:number,w:number,h:number},
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
 * @property {(i: number, j: number, box: {x:number,y:number,w:number,h:number}, guides: {v:number[],h:number[]}) => void} [paintLayer]
 *   Paint layer `j` of slide `i` at a provisional box, plus the snap guides that
 *   engaged — the layer twin of `paint`.
 * @property {(i: number, j: number, box: {x:number,y:number,w:number,h:number}) => void} [commitLayer]
 *   Write a finished box into the document, through the layer mutator (which
 *   re-clamps) — the layer twin of `commit`.
 */

/**
 * Build the controller. Handlers are bound by `attach` and released by the next
 * `attach` or by `destroy`; the pending wheel commit deliberately survives a
 * re-attach, so a burst that happens to straddle a rebuild still lands once.
 *
 * @param {DeckGestureHost} host
 */
export function createDeckGestures(host) {
  /** Listener removers for the currently bound columns. */
  let bound = [];
  /** How many columns the last `attach` bound — the deck's slide count, which
   *  is what turns one column's rect into the whole deck's. */
  let count = 0;
  /** The in-flight gesture, tagged by `kind`: a `"crop"` pan/pinch
   *  ({ i, frame, pointers, crop, startCrop, start, moved, undecided }), a
   *  `"layer"` move/resize ({ i, slide, j, frame, mode, anchor, space,
   *  startX, startY, startBox, box, moved }), or a `"pane"` scroll-by-hand
   *  ({ i, frame, startX, lastX, moved }) — where `i` is
   *  the column holding the pointer and `slide` the index the box commits to,
   *  the two being the same thing for everything but a span layer. One at a
   *  time — a press mid-gesture is ignored. */
  let drag = null;
  /** A crop written to the DOM but not yet committed to the document (a wheel
   *  gesture, which has no release event to commit on). */
  let pending = null;
  let pendingTimer = null;
  let destroyed = false;

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
    if (sameCrop(next, slide.crop, srcW, srcH)) {
      host.paint(i, slide);
      host.select(i);
      return;
    }
    host.commit(i, next);
  };

  const commitPending = () => {
    const p = pending;
    pending = null;
    pendingTimer = null;
    if (!p || destroyed) return;
    commitCrop(p.i, p.crop);
  };

  /** True once a layer press has travelled past the slop threshold. */
  const past = (a, b) => Math.abs(a) > DRAG_SLOP_PX || Math.abs(b) > DRAG_SLOP_PX;

  const onLayerMove = (e) => {
    if (!drag || drag.kind !== "layer") return;
    const { rect, lines, tol } = drag.space;
    const dfx = (e.clientX - drag.startX) / (rect.width || 1);
    const dfy = (e.clientY - drag.startY) / (rect.height || 1);
    if (past(e.clientX - drag.startX, e.clientY - drag.startY)) drag.moved = true;

    const raw = dragBox(drag.startBox, drag.mode, drag.anchor, dfx, dfy);
    const { box, guides } = drag.moved
      ? snapBox(raw, drag.mode, drag.anchor, lines, tol, e.altKey || e.metaKey)
      : { box: raw, guides: { v: [], h: [] } };
    drag.box = clampBox(box);
    host.paintLayer?.(drag.slide, drag.j, drag.box, guides);
    e.preventDefault?.();
  };

  const onLayerUp = (e, frame) => {
    const ended = drag;
    drag = null;
    frame.releasePointerCapture?.(e.pointerId);
    frame.classList.remove("is-dragging");
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
  const claimCrop = (e, frame) => {
    frame.setPointerCapture?.(e.pointerId);
    frame.classList.add("is-dragging");
    e.preventDefault?.();
  };

  // A press or a key on the reorder handle nested in the column belongs to
  // `attachPointerReorder` / the arrow-key reorder in `index.js`, not to this
  // gesture — without the guard both would claim the same pointerdown or
  // ArrowLeft/ArrowRight, since the handle's own listeners don't (and, being a
  // capture-phase document listener for the pointer case, can't) stop the
  // column's bubble-phase ones from also running.
  const onHandle = (e) => Boolean(e.target?.closest?.(".carousel-studio__rail-handle"));

  const onPointerDown = (e, frame, i) => {
    if (e.button != null && e.button > 0) return;
    if (onHandle(e)) return;
    const slide = host.slideAt(i);
    if (!slide) return;

    // A layer takes the press only when its own layer is selected and the press
    // lands on it or a handle; anything else falls through to the crop gesture,
    // so pan/zoom is unchanged wherever a layer is not in the way. A slide layer
    // is grabbable on its own column only; a span layer on every column it
    // reaches, because its box spans them all.
    if (!drag) {
      const active = host.activeLayer?.();
      const span = active?.scope === "span";
      const rect = span ? deckRect(frameRect(frame), i, count) : frameRect(frame);
      const hit =
        active && (span || active.i === i)
          ? hitLayer(rect, active.box, e.clientX, e.clientY)
          : null;
      if (hit) {
        frame.setPointerCapture?.(e.pointerId);
        frame.classList.add("is-dragging");
        drag = {
          kind: "layer",
          i,
          slide: active.i,
          j: active.j,
          frame,
          mode: hit.mode,
          anchor: { h: hit.h, v: hit.v },
          space: layerSpace(
            rect,
            host.safeArea?.(span ? "span" : "slide") || null,
            span ? deckSeams(count) : [],
          ),
          startX: e.clientX,
          startY: e.clientY,
          startBox: { ...active.box },
          box: { ...active.box },
          moved: false,
        };
        e.preventDefault?.();
        return;
      }
    }
    if (drag && drag.kind === "layer") return;

    if (!drag || drag.i !== i) {
      const modified = e.ctrlKey || e.shiftKey;
      if (e.pointerType !== "touch" && !modified) {
        // A mouse or pen with no modifier: drag the strip itself. A finger
        // gets this for free from `touch-action`; a mouse has no native
        // drag-to-scroll of its own, so this drives it through the host —
        // which owns the scroller, the same way it owns every other write.
        drag = { kind: "pane", i, frame, lastX: e.clientX, startX: e.clientX, moved: false };
        frame.setPointerCapture?.(e.pointerId);
        frame.classList.add("is-dragging");
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
        undecided: e.pointerType === "touch" && !modified,
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

  const onPointerMove = (e, frame, i) => {
    if (drag && drag.kind === "layer") {
      if (drag.i === i) onLayerMove(e);
      return;
    }
    if (drag && drag.kind === "pane") {
      if (drag.i !== i) return;
      const dx = e.clientX - drag.lastX;
      drag.lastX = e.clientX;
      if (Math.abs(e.clientX - drag.startX) > DRAG_SLOP_PX) drag.moved = true;
      // The content follows the pointer, the same convention a touch's own
      // native pan already uses: a leftward drag moves the strip left,
      // revealing what is to its right.
      host.scrollPaneBy(-dx);
      e.preventDefault?.();
      return;
    }
    const slide = host.slideAt(i);
    if (!drag || drag.i !== i || !drag.pointers.has(e.pointerId) || !slide) return;

    // The undecided single finger: no modifier and not yet a pinch, so
    // `touch-action` is already panning the strip (and, off-axis, the page)
    // with it — nothing here claims the pointer or paints a crop. Only
    // whether it passed the slop threshold matters, so a release that turns
    // out to have been a scroll doesn't also select the tile (`onPointerUp`
    // reads `!drag` the same way an abandoned gesture always has).
    if (drag.undecided) {
      const dx = e.clientX - drag.start.cx;
      const dy = e.clientY - drag.start.cy;
      if (Math.abs(dx) > DRAG_SLOP_PX || Math.abs(dy) > DRAG_SLOP_PX) drag = null;
      return;
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

    if (Math.abs(dx) > DRAG_SLOP_PX || Math.abs(dy) > DRAG_SLOP_PX || ratio !== 1) {
      drag.moved = true;
    }
    drag.crop = crop;
    // Straight to the DOM — no state change, so a drag costs no rebuild and no
    // decode, only two style writes per frame.
    host.paint(i, { ...slide, crop });
    e.preventDefault?.();
  };

  const onPointerUp = (e, frame, i) => {
    if (drag && drag.kind === "layer") {
      if (drag.i === i) onLayerUp(e, frame);
      return;
    }
    if (drag && drag.kind === "pane") {
      if (drag.i !== i) return;
      const ended = drag;
      drag = null;
      frame.releasePointerCapture?.(e.pointerId);
      frame.classList.remove("is-dragging");
      if (!ended.moved) {
        // A click, not a drag: select the slide, same as a tap always has.
        host.select(i);
      }
      return;
    }
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

  const onWheel = (e, i) => {
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
  const detach = () => {
    for (const off of bound) off();
    bound = [];
  };

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
        /** @type {Array<[string, (e: any) => void, object|undefined]>} */
        const handlers = [
          ["pointerdown", (e) => onPointerDown(e, frame, i), undefined],
          ["pointermove", (e) => onPointerMove(e, frame, i), undefined],
          ["pointerup", (e) => onPointerUp(e, frame, i), undefined],
          ["pointercancel", (e) => onPointerUp(e, frame, i), undefined],
          // Not passive: a zoom over the strip must not also scroll the page.
          ["wheel", (e) => onWheel(e, i), { passive: false }],
          ["keydown", (e) => onFrameKey(e, i), undefined],
          ["focus", () => { if (!drag) host.select(i); }, undefined],
        ];
        for (const [type, fn, opts] of handlers) {
          frame.addEventListener(type, fn, opts);
          bound.push(() => frame.removeEventListener(type, fn, opts));
        }
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
  /** Listener removers for the currently bound stage. */
  let bound = [];
  /** The in-flight drag, or null. One at a time. */
  let drag = null;
  let destroyed = false;

  const detach = () => {
    for (const off of bound) off();
    bound = [];
  };

  /** Take the pointer: capture it, dress the stage, and stop the browser doing
   *  anything else with the event. */
  const claim = (e, stage) => {
    stage.setPointerCapture?.(e.pointerId);
    stage.classList?.add("is-anchoring");
    host.dress?.(true);
    e.preventDefault?.();
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
      const dir = gestureDirection(e.clientX - drag.startX, e.clientY - drag.startY);
      if (!dir) return;
      if (dir === "horizontal") {
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
    stage.releasePointerCapture?.(e.pointerId);
    stage.classList?.remove("is-anchoring");
    host.dress?.(false);
    if (!ended.moved) return;
    // A drag that ran into the end of the slack lands back where it started;
    // committing that would mark the studio dirty and re-cut a strip whose
    // pixels are identical. Repaint from the document instead.
    if (sameAnchor(ended.anchorY, ended.startAnchor, ended.trimmedH)) {
      host.paint(ended.startAnchor);
      return;
    }
    host.commit(ended.anchorY);
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
      /** @type {Array<[string, (e: any) => void]>} */
      const handlers = [
        ["pointerdown", (e) => onPointerDown(e, stage)],
        ["pointermove", (e) => onPointerMove(e, stage)],
        ["pointerup", (e) => onPointerUp(e, stage)],
        ["pointercancel", (e) => onPointerUp(e, stage)],
      ];
      for (const [type, fn] of handlers) {
        stage.addEventListener(type, fn);
        bound.push(() => stage.removeEventListener(type, fn));
      }
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
