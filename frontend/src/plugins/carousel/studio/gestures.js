/**
 * Carousel Studio — deck-mode direct manipulation.
 *
 * Drag to pan, pinch or wheel to zoom, arrow keys to nudge: one module over one
 * small host surface, so the page keeps owning the document and this keeps
 * owning the pointer bookkeeping. It mirrors `attachWindowFileDrop`'s shape
 * (bind, hand back the release) with one difference — the controller outlives a
 * render, because a wheel gesture's debounced commit has to.
 *
 *   const gestures = createDeckGestures(host);   // once, at construction
 *   gestures.attach(frames);                     // after every render
 *   gestures.destroy();                          // at unmount
 *
 * Nothing here writes to the DOM by itself and nothing here holds a document:
 * a live gesture paints through `host.paint` with a provisional slide (no state
 * change, no rebuild, no decode) and lands in the document through
 * `host.commit` exactly once, when the gesture ends.
 */

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
  /** The in-flight gesture: { i, frame, pointers, crop, startCrop, start, moved }. */
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

  const onPointerDown = (e, frame, i) => {
    if (e.button != null && e.button > 0) return;
    const slide = host.slideAt(i);
    if (!slide) return;
    if (!drag || drag.i !== i) {
      drag = { i, frame, pointers: new Map(), crop: { ...slide.crop }, moved: false };
    }
    frame.setPointerCapture?.(e.pointerId);
    drag.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Re-baseline on every pointer down: a second finger arriving starts a
    // pinch from where the drag left off rather than from where it began.
    drag.start = pointerCentroid(drag.pointers);
    drag.startCrop = { ...drag.crop };
    frame.classList.add("is-dragging");
    e.preventDefault?.();
  };

  const onPointerMove = (e, frame, i) => {
    const slide = host.slideAt(i);
    if (!drag || drag.i !== i || !drag.pointers.has(e.pointerId) || !slide) return;
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
