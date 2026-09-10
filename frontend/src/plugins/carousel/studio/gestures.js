/**
 * Carousel Studio — deck-mode direct manipulation.
 *
 * Drag to pan, pinch or wheel to zoom, arrow keys to nudge: one module over one
 * small host surface, so the page keeps owning the document and this keeps
 * owning the pointer bookkeeping. It mirrors `attachWindowFileDrop`'s shape
 * (bind, hand back the release) with one difference — the controller outlives a
 * render, because a wheel gesture's debounced commit has to.
 *
 * The same machine drives two fields. With no layer selected a frame's pointer
 * pans and zooms the slide's `crop` (S2). With a layer selected and the press
 * landing on that layer or one of its eight resize handles, the identical
 * provisional-write-then-commit cycle moves and resizes the layer's `box`
 * instead — through `host.commitLayer` rather than `host.commit`, snapping to
 * the safe area and canvas guides on the way. A press that misses the selected
 * layer still falls through to the crop gesture, so pan/zoom is unchanged
 * wherever a layer is not in the way.
 *
 *   const gestures = createDeckGestures(host);   // once, at construction
 *   gestures.attach(frames);                     // after every render
 *   gestures.destroy();                          // at unmount
 *
 * A touch drag is not claimed at pointerdown. The frame is `touch-action:
 * pan-y`, so a vertical drag belongs to the page — this waits for the movement
 * to declare a direction (`gestureDirection`, the same helper and the same
 * 8px threshold the tags manager separates swipe from scroll with) and lets go
 * of a vertical one. A mouse or pen has no such ambiguity and still claims the
 * press immediately, as does a second finger: a pinch is never a scroll.
 *
 * Nothing here writes to the DOM by itself and nothing here holds a document:
 * a live gesture paints through `host.paint` with a provisional slide (no state
 * change, no rebuild, no decode) and lands in the document through
 * `host.commit` exactly once, when the gesture ends.
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
 * Snap a dragged box's live edges to the canvas guides — its own edges and
 * centre lines at `0`, `0.5`, `1`, plus the safe-area rect — within `tol`
 * fractions per axis. A `move` snaps whichever of the three verticals
 * (left / centre / right) and three horizontals is closest; a `resize` snaps
 * only the edges its anchor is dragging. Returns the adjusted box and the guide
 * lines that engaged, for the caller to draw. `suppressed` (a modifier key held)
 * returns the box untouched with no guides.
 *
 * @returns {{box:{x:number,y:number,w:number,h:number}, guides:{v:number[],h:number[]}}}
 */
export function snapBox(box, mode, anchor, safe, tol, suppressed) {
  const guides = { v: [], h: [] };
  if (suppressed) return { box, guides };

  const vLines = [0, 0.5, 1, ...(safe ? [safe.x, safe.x + safe.w] : [])];
  const hLines = [0, 0.5, 1, ...(safe ? [safe.y, safe.y + safe.h] : [])];
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
 * @property {() => {srcW: number|null, srcH: number|null, aspect: string}} dims
 *   The live source size and aspect — read per event, never cached.
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
 * @property {() => {i: number, j: number, box: {x:number,y:number,w:number,h:number}}|null} [activeLayer]
 *   The selected layer — its slide index, its index in that slide, and its
 *   current box (0..1 of the canvas) — or null when no layer is selected. Read
 *   per press: it decides whether a press moves a layer or pans the slide.
 * @property {() => {x:number,y:number,w:number,h:number}|null} [safeArea]
 *   The slide's safe-area rect in canvas fractions, for snapping. Null disables
 *   safe-area snap (centre and edge guides still apply).
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
  /** Listener removers for the currently bound frames. */
  let bound = [];
  /** The in-flight gesture, tagged by `kind`: a `"crop"` pan/pinch
   *  ({ i, frame, pointers, crop, startCrop, start, moved }) or a `"layer"`
   *  move/resize ({ i, j, frame, mode, anchor, rect, startX, startY, startBox,
   *  box, moved }). One at a time — a press mid-gesture is ignored. */
  let drag = null;
  /** A crop written to the DOM but not yet committed to the document (a wheel
   *  gesture, which has no release event to commit on). */
  let pending = null;
  let pendingTimer = null;
  let destroyed = false;

  const clamp = (crop) => {
    const { srcW, srcH } = host.dims();
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
    const { srcW, srcH } = host.dims();
    const next = clamp(crop);
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
    const dfx = (e.clientX - drag.startX) / (drag.rect.width || 1);
    const dfy = (e.clientY - drag.startY) / (drag.rect.height || 1);
    if (past(e.clientX - drag.startX, e.clientY - drag.startY)) drag.moved = true;

    const raw = dragBox(drag.startBox, drag.mode, drag.anchor, dfx, dfy);
    const tol = {
      x: SNAP_PX / (drag.rect.width || 1),
      y: SNAP_PX / (drag.rect.height || 1),
    };
    const { box, guides } = drag.moved
      ? snapBox(raw, drag.mode, drag.anchor, host.safeArea?.() || null, tol, e.altKey || e.metaKey)
      : { box: raw, guides: { v: [], h: [] } };
    drag.box = clampBox(box);
    host.paintLayer?.(drag.i, drag.j, drag.box, guides);
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
    host.commitLayer?.(ended.i, ended.j, ended.box);
  };

  /** Take the pointer for the crop gesture: capture it, dress the frame, and
   *  stop the browser doing anything else with the event. */
  const claimCrop = (e, frame) => {
    frame.setPointerCapture?.(e.pointerId);
    frame.classList.add("is-dragging");
    e.preventDefault?.();
  };

  const onPointerDown = (e, frame, i) => {
    if (e.button != null && e.button > 0) return;
    const slide = host.slideAt(i);
    if (!slide) return;

    // A layer takes the press only when its own layer is selected and the press
    // lands on it or a handle; anything else falls through to the crop gesture,
    // so pan/zoom is unchanged wherever a layer is not in the way.
    if (!drag) {
      const active = host.activeLayer?.();
      const rect = frameRect(frame);
      const hit =
        active && active.i === i
          ? hitLayer(rect, active.box, e.clientX, e.clientY)
          : null;
      if (hit) {
        frame.setPointerCapture?.(e.pointerId);
        frame.classList.add("is-dragging");
        drag = {
          kind: "layer",
          i,
          j: active.j,
          frame,
          mode: hit.mode,
          anchor: { h: hit.h, v: hit.v },
          rect,
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
      drag = {
        kind: "crop",
        i,
        frame,
        pointers: new Map(),
        crop: { ...slide.crop },
        moved: false,
        // A single finger has not said yet whether it is panning the crop or
        // scrolling the page; every other input has.
        undecided: e.pointerType === "touch",
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
    const slide = host.slideAt(i);
    if (!drag || drag.i !== i || !drag.pointers.has(e.pointerId) || !slide) return;

    // The undecided single finger, resolved. Below the threshold the movement
    // is still noise, so nothing moves and nothing is claimed; a vertical call
    // drops the gesture entirely and the page scrolls with the finger it was
    // always meant for.
    if (drag.undecided) {
      const dir = gestureDirection(e.clientX - drag.start.cx, e.clientY - drag.start.cy);
      if (!dir) return;
      if (dir === "vertical") {
        drag = null;
        return;
      }
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
    const scale = panScale(drag.startCrop, slide.fit, box, host.dims());
    const dx = now.cx - drag.start.cx;
    const dy = now.cy - drag.start.cy;
    // The image follows the pointer, so the crop moves the other way.
    const crop = clamp({
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
    if (!slide || !e.deltaY) return;
    e.preventDefault?.();
    // deltaMode: 0 pixels, 1 lines, 2 pages — normalize to pixels so a Firefox
    // notch and a Chrome notch zoom by the same amount.
    const px =
      e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const base = pending?.i === i ? pending.crop : slide.crop;
    const crop = clamp(zoomCrop(base, Math.exp(px * WHEEL_ZOOM)));

    pending = { i, crop };
    host.paint(i, { ...slide, crop });
    // A wheel gesture has no release event, so the commit is debounced: one
    // document mutation per burst instead of one per notch.
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(commitPending, WHEEL_COMMIT_MS);
  };

  const onFrameKey = (e, i) => {
    const slide = host.slideAt(i);
    if (!slide) return;

    // With a layer selected the arrows drive it, not the crop: a plain arrow
    // nudges the box, shift-arrow resizes it from its far edge, both at the
    // `KEY_PAN` scale the crop nudge uses.
    const active = host.activeLayer?.();
    if (active && active.i === i && typeof e.key === "string" && e.key.startsWith("Arrow")) {
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
      host.commitLayer?.(i, active.j, clampBox(box));
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
     * Bind to this render's deck frames, releasing the previous render's.
     * Each frame's index comes from its own `data-slice`.
     *
     * @param {ArrayLike<HTMLElement>} frames
     */
    attach(frames) {
      detach();
      if (destroyed) return;
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
