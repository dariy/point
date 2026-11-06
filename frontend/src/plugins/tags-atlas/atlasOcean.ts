/**
 * atlasOcean — the one owner of the atlas map.
 *
 * The ocean owns the map container on `document.body`, the Leaflet map, the
 * tiles and AtlasPlaces. They live until the page unloads or `tags-atlas` is
 * off (`destroyAtlasOcean`). Pages never create or destroy the map:
 *
 *   attachAtlasOcean()   a list page (`/`, `/tags/<slug>`) armed its grid
 *   detachAtlasOcean()   that page went away
 *
 * The ocean shows the map through a presentation:
 *
 *   hidden    no map on screen (`list` state, or a page that is not a list)
 *   mapList   the map above the card strip
 *   full      the map below the header
 *   window    the map through a rect (the sheet's map slot on a post)
 *
 * A window does not resize the map. The container keeps its box, moves above
 * the viewer and is clipped to the rect (`clip-path: inset(…)`, which also
 * clips hit-testing: a click outside the rect reaches the page below). The view
 * is offset so `center` sits at the rect centre. In a window, drag and pinch
 * move the map; a tap (no move past TAP_SLOP_PX) calls `onTap`, and a tap on a
 * place calls `onTap` too, not the place's tag page. `animateTo` tweens the
 * clip (and the window centre) from one presentation to the next, at a fixed
 * zoom; under `prefers-reduced-motion: reduce` it is instant.
 *
 * A box change (a rotation) puts the window on the new box at once: a new clip
 * and a new offset, and the point at the window centre stays there. A present
 * with no centre after a size change pans the map by the move of the slot
 * centre, so the point stays at the centre of the new slot.
 *
 * `expand` is the move from a post's window to the full map. The clip grows
 * from the window to the whole box and the place comes to the centre, at the
 * window's zoom. The map stays a window over the page until the next list page
 * attaches (the tag page in `map` state). That attach shows `full`, sets the
 * zoom, selects the route's place and focuses the post's chip. Only a
 * `hidden` cancels a pending expand: a late window from the post (a re-render,
 * a resize) or a state change from a kept layout must not drop the selection.
 * For EXPAND_CLICK_GUARD_MS after that attach, the full map ignores clicks: a
 * late click of the tap must not clear the place it opens.
 *
 * `collapse` is the way back (atlasFromPost.ts). A detach to a post whose
 * history entry asks for the open sheet does not hide a shown map: it holds as
 * a window over the whole box until the post's sheet calls `collapse`. That
 * waits for the slot's first layout (a rect with a size, on screen), then
 * tweens the clip from the box to the slot and pans the place back to the
 * slot centre; the slot's zoom comes after the tween. Nothing calls `collapse`
 * in DETACH_MS: the map is hidden. While a list page in `full` has an entry
 * with `fromPost`, the ocean shows the "‹ <post title>" chip.
 *
 * On a list page the presentation follows `body[data-atlas-layer]`. A detach to
 * any other page (a post, search, admin) sets `hidden` and keeps the map. The
 * next list page shows the same map at the same viewport: no new `L.map`, no
 * new tiles, no new places fetch.
 *
 * Warm-up: a list page that attaches in the `list` state builds the map in an
 * idle callback after the attach (GridPager.arm runs after the grid render, so
 * the LCP image goes first). The container stays `visibility: hidden` and the
 * first `mapList` or `full` only shows the map. With `saveData` on, nothing
 * warms; Leaflet loads on the first `mapList` or `full`.
 */

import { getAtlasLayerState, isAtlasListPath, setAtlasLayerState, stateFromSearchOrNull, viewFromSearch } from './atlasLayerState.ts';
import { mountAtlasLayerLayout } from './atlasLayerLayout.ts';
import { mountAtlasLayerMap } from './atlasLayerMap.ts';
import { isSheetReturn, syncFromPostChip } from './atlasFromPost.ts';

import {
  clipInsets, createTapGate, easeInOut, insetCss, insetsEmpty, intersectRect, tweenPoint, tweenRect, windowOffset,
} from './atlasOceanGeometry.ts';

import type { AtlasLayerState } from './atlasLayerState.ts';
import type { AtlasLayerMapController, LatLng } from './atlasLayerMap.ts';
import type { Point, Rect } from './atlasOceanGeometry.ts';

export type AtlasPresentation = 'hidden' | 'mapList' | 'full' | 'window';

/** The map through `rect` (viewport px). */
export interface AtlasWindow {
  kind: 'window';
  rect: Rect;
  /** The point to put at the rect centre. Without it, the map moves with the rect. */
  center?: LatLng;
  /** The zoom for `center`. Without it, the zoom does not change. */
  zoom?: number;
  /**
   * The part of the page where `rect` can show (a scroller's box). The clip is
   * `rect` inside `clip`; the view still follows `rect`, so a slot that scrolls
   * under the scroller's edge keeps its map in place.
   */
  clip?: Rect;
  /** A tap in the window (not a drag or a pinch), or a tap on a place. */
  onTap?: () => void;
  /**
   * The place at `center` (a post's geo-tag). A present with `center` opens
   * its cloud with one ring; chips outside `rect` are not drawn (the rect is
   * read when the cloud is asked for: a slot that slides keeps its size).
   */
  place?: { slug: string };
}

/** What a page asks the ocean to show. */
export type AtlasPresentationRequest = Exclude<AtlasPresentation, 'window'> | AtlasWindow;

/** A move from a window to the full map (`expand`). */
export interface AtlasExpand {
  /** The place: it goes to the centre of the map. */
  center: LatLng;
  /** The full map's zoom, set after the tween. */
  zoom: number;
  /** The post whose chip the full map focuses in the place's cloud. */
  focusPostSlug?: string;
}

/** The clip tween, in ms (the same as the layer slide in atlas.css). */
export const TWEEN_MS = 280;

/** The map container's class. CSS and the layer gesture find the map by it. */
export const ATLAS_MAP_CLASS = 'atlas-layer-map';

/**
 * A list page that replaces a list page (`/` ↔ `/tags/<slug>`) keeps the layout
 * mounted for the next page. If no page attaches in this time (the new page
 * failed to load), the layout is released and the map is hidden.
 */
const DETACH_MS = 10_000;

/** After an expand's attach, the full map ignores clicks for this time (ms). */
export const EXPAND_CLICK_GUARD_MS = 500;

/** `collapse` waits at most this many frames for the slot's first layout. */
export const SETTLE_FRAMES = 60;

/** The centre of `rect`, in px from the top-left corner of `box`. */
function boxCenter(rect: Rect, box: Rect): Point {
  return { x: rect.left + rect.width / 2 - box.left, y: rect.top + rect.height / 2 - box.top };
}

/** The presentation for a layer state on a list page. */
export function presentationForState(state: AtlasLayerState): Exclude<AtlasPresentation, 'window'> {
  if (state === 'mapList') return 'mapList';
  if (state === 'map') return 'full';
  return 'hidden';
}

/** What the ocean needs from the page. Tests replace all of it. */
export interface AtlasOceanDeps {
  body: HTMLElement;
  /** Find or create the map container. Called once per ocean. */
  container(body: HTMLElement): HTMLElement;
  /** Mount the list page's layout (state from the URL, CSS vars). Returns a cleanup. */
  mountLayout(body: HTMLElement): () => void;
  /** Start the map controller. Called once per ocean. */
  mountMap(container: HTMLElement, body: HTMLElement): AtlasLayerMapController;
  /** Call `fn` when `body[data-atlas-layer]` changes. Returns a stop. */
  observeState(body: HTMLElement, fn: () => void): () => void;
  /** The current path and query. */
  path(): string;
  /** Run `fn` when the page is idle. Returns a cancel. */
  idle(fn: () => void): () => void;
  /** True when the user asks to save data (`navigator.connection.saveData`). */
  saveData(): boolean;
  /** The container's box in viewport px. */
  box(container: HTMLElement): Rect;
  /** Call `fn` when the container's box changes size (a rotation). Returns a stop. */
  observeBox(container: HTMLElement, fn: () => void): () => void;
  /** True under `prefers-reduced-motion: reduce`. */
  reducedMotion(): boolean;
  /** Run `fn` on the next animation frame with a timestamp in ms. Returns a cancel. */
  frame(fn: (now: number) => void): () => void;
  /** The current time in ms, on the same clock as `frame`. */
  now(): number;
  /** True when a move to `path` is a Back to a post's open sheet (atlasFromPost.ts). */
  sheetReturn(path: string): boolean;
  /** Show the "‹ <post title>" chip, or remove it (atlasFromPost.ts::syncFromPostChip). */
  fromPostChip(show: boolean): void;
}

export interface AtlasOcean {
  attach(): void;
  detach(path?: string, ms?: number): void;
  present(presentation: AtlasPresentationRequest): void;
  /** Tween the clip to `presentation`. Resolves when it is in place (or replaced). */
  animateTo(presentation: AtlasPresentationRequest, ms?: number): Promise<void>;
  /**
   * Grow the window to the whole box, with `target.center` at the centre and
   * no zoom change. Resolves when the tween ends: navigate then. The next
   * attach finishes the move (see the file comment); a `present('hidden')` cancels it.
   */
  expand(target: AtlasExpand, ms?: number): Promise<void>;
  /**
   * The way back from the full map: wait until `slot()` gives a window with a
   * size, then tween to it (from the held box; instant from `hidden` or under
   * reduced motion). Resolves when the window is in place, or replaced, or
   * when no layout came in SETTLE_FRAMES (the held map is hidden then).
   */
  collapse(slot: () => AtlasWindow | null, ms?: number): Promise<void>;
  presentation(): AtlasPresentation;
  destroy(): void;
}

function defaultContainer(body: HTMLElement): HTMLElement {
  const existing = body.querySelector<HTMLElement>(`:scope > .${ATLAS_MAP_CLASS}`);
  if (existing) return existing;
  const el = document.createElement('div');
  el.className = ATLAS_MAP_CLASS;
  el.setAttribute('aria-label', 'Map of the posts in this list');
  body.append(el);
  return el;
}

function defaultObserveBox(container: HTMLElement, fn: () => void): () => void {
  if (typeof ResizeObserver !== 'function') return () => {};
  const ro = new ResizeObserver(() => fn());
  ro.observe(container);
  return () => ro.disconnect();
}

function defaultObserveState(body: HTMLElement, fn: () => void): () => void {
  const mo = new MutationObserver(fn);
  mo.observe(body, { attributes: true, attributeFilter: ['data-atlas-layer'] });
  return () => mo.disconnect();
}

/** `deps.idle` in the app: an idle callback, or a timeout where there is none. */
export function defaultIdle(fn: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(fn, { timeout: 5000 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(fn, 1500);
  return () => clearTimeout(id);
}

/** `deps.saveData` in the app: true when the browser asks to save data. */
export function defaultSaveData(): boolean {
  return (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
}

function defaultFrame(fn: (now: number) => void): () => void {
  if (typeof requestAnimationFrame !== 'function') {
    const id = setTimeout(() => fn(Date.now()), 16);
    return () => clearTimeout(id);
  }
  const id = requestAnimationFrame(fn);
  return () => cancelAnimationFrame(id);
}

function defaultDeps(): AtlasOceanDeps {
  return {
    body: document.body,
    container: defaultContainer,
    mountLayout: mountAtlasLayerLayout,
    mountMap: (container, body) => mountAtlasLayerMap({ container }, body),
    observeState: defaultObserveState,
    path: () => location.pathname + location.search,
    idle: defaultIdle,
    saveData: defaultSaveData,
    box: (c) => c.getBoundingClientRect(),
    observeBox: defaultObserveBox,
    reducedMotion: () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
    frame: defaultFrame,
    now: () => (typeof requestAnimationFrame === 'function' ? performance.now() : Date.now()),
    sheetReturn: (path) => isSheetReturn(path, history.state),
    fromPostChip: (show) => syncFromPostChip(show),
  };
}

/**
 * An ocean over `deps`. The app uses one, made on the first attach
 * (`attachAtlasOcean`); tests make their own.
 */
export function createAtlasOcean(deps: AtlasOceanDeps): AtlasOcean {
  const { body } = deps;
  let container: HTMLElement | null = null;
  let map: AtlasLayerMapController | null = null;
  let layout: (() => void) | null = null;
  let stopObserve: (() => void) | null = null;
  let current: AtlasPresentation = 'hidden';
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A page detached since the last attach: the next attach is a new route.
  let moved = false;
  // The warm-up: scheduled (a cancel), done, or neither.
  let cancelWarm: (() => void) | null = null;
  let warmed = false;
  // The window: its rect, its centre and its tap callback.
  let win: AtlasWindow | null = null;
  // The box when the window was last put on screen.
  let winBox: Rect | null = null;
  // The tween in progress: a cancel, and the resolve of its promise.
  let cancelTween: (() => void) | null = null;
  let endTween: (() => void) | null = null;
  const gate = createTapGate();
  let stopInput: (() => void) | null = null;
  // An expand that waits for the next attach.
  let expanding: AtlasExpand | null = null;
  // The end of the click guard after an expand's attach (deps.now() time).
  let guardUntil = -Infinity;
  // A held map on a post (the way back): hidden when no collapse comes in time.
  let holdTimer: ReturnType<typeof setTimeout> | undefined;

  const clearHold = () => {
    clearTimeout(holdTimer);
    holdTimer = undefined;
  };

  /** The chip shows on a list page's full map (its entry decides the rest). */
  const syncChip = () => deps.fromPostChip(current === 'full' && !!layout);

  const stopTween = () => {
    cancelTween?.();
    cancelTween = null;
    const end = endTween;
    endTween = null;
    end?.();
  };

  /**
   * Window input. Capture listeners on the container run before Leaflet and
   * AtlasPlaces. They see every pointer, and in a window they stop every click:
   * a tap calls `onTap`, a click after a drag does nothing.
   */
  const listen = (el: HTMLElement) => {
    const down = (e: PointerEvent) => gate.down(e.pointerId, e.clientX, e.clientY);
    const move = (e: PointerEvent) => gate.move(e.pointerId, e.clientX, e.clientY);
    const up = (e: PointerEvent) => gate.up(e.pointerId);
    const click = (e: MouseEvent) => {
      if (current !== 'window') {
        // A late click of the widget tap would clear the place it opened.
        if (deps.now() < guardUntil) {
          e.stopImmediatePropagation();
          e.preventDefault();
        }
        return;
      }
      e.stopImmediatePropagation();
      e.preventDefault();
      if (gate.isTap()) win?.onTap?.();
    };
    const opts = { capture: true, passive: true };
    el.addEventListener('pointerdown', down, opts);
    el.addEventListener('pointermove', move, opts);
    el.addEventListener('pointerup', up, opts);
    el.addEventListener('pointercancel', up, opts);
    el.addEventListener('click', click, true);
    return () => {
      el.removeEventListener('pointerdown', down, opts);
      el.removeEventListener('pointermove', move, opts);
      el.removeEventListener('pointerup', up, opts);
      el.removeEventListener('pointercancel', up, opts);
      el.removeEventListener('click', click, true);
    };
  };

  /**
   * The box changed size (a rotation, a new viewport). In a window, Leaflet
   * keeps its top-left corner, and the clip and the window centre are for the
   * old box. Put the same window on the new box: the point at the window
   * centre stays there. The page gives the new slot rect when its layout
   * settles (a present with no centre).
   */
  const onBox = () => {
    if (current !== 'window' || !win || cancelTween || !container || !winBox) return;
    const box = deps.box(container);
    if (box.width === winBox.width && box.height === winBox.height) return;
    presentWindow({ ...win, center: undefined, zoom: undefined });
  };

  /** The container and the map controller, made on the first need. */
  const ensure = () => {
    if (!container) {
      container = deps.container(body);
      const stopListen = listen(container);
      const stopBox = deps.observeBox(container, onBox);
      stopInput = () => { stopListen(); stopBox(); };
    }
    map ??= deps.mountMap(container, body);
    return { el: container, ctl: map };
  };

  // The clip rect on screen now (a tween step included), or null for no clip.
  let clipRect: Rect | null = null;
  const setClip = (rect: Rect | null, box: Rect) => {
    clipRect = rect;
    if (container) container.style.clipPath = rect ? insetCss(clipInsets(rect, box)) : '';
  };

  /** The part of a window on screen: its rect inside its clip. */
  const visibleRect = (w: AtlasWindow): Rect => (w.clip ? intersectRect(w.rect, w.clip) : w.rect);

  /** The rect on screen now: the window, the whole box, or nothing (hidden). */
  const shownRect = (box: Rect): Rect | null => {
    // A tween that a new tween replaces goes on from where its clip is.
    if (current === 'window') return clipRect ?? (win ? visibleRect(win) : null);
    return current === 'hidden' ? null : box;
  };

  const leaveWindow = () => {
    if (current !== 'window') return;
    win = null;
    winBox = null;
    map?.setWindowTap(null);
    map?.setLabelBounds(null);
    clipRect = null;
    if (container) {
      container.style.clipPath = '';
      container.removeAttribute('aria-hidden');
    }
  };

  /** Show the map through `w`. `recenter` false: keep the view (a tween step). */
  const presentWindow = (w: AtlasWindow, recenter = true) => {
    const { el, ctl } = ensure();
    const prev = current === 'window' ? win : null;
    current = 'window';
    el.dataset.atlasOcean = 'window';
    // The slot under the window is the control (role=button): one name for a screen reader.
    el.setAttribute('aria-hidden', 'true');
    stopWarm();
    warmed = true;
    win = w;
    ctl.setWindowTap(() => win?.onTap?.());
    const box = deps.box(el);
    const prevBox = winBox;
    winBox = box;
    const vis = visibleRect(w);
    setClip(vis, box);
    // The labels count only the places in the visible part (box px).
    ctl.setLabelBounds({ left: vis.left - box.left, top: vis.top - box.top, width: vis.width, height: vis.height });
    const offset = windowOffset(w.rect, box);
    if (!recenter) ctl.frame(null, offset);
    else if (w.center) {
      const place = w.place
        // The place is at the window centre: the window in px from the place.
        ? { slug: w.place.slug, bounds: { left: -w.rect.width / 2, top: -w.rect.height / 2, width: w.rect.width, height: w.rect.height } }
        : undefined;
      ctl.frame(w.center, offset, w.zoom, place);
    }
    else if (prev && prevBox) {
      // The slot moved (a sheet drag or scroll), or it and the box changed
      // size (a rotation): the map moves with the slot centre. Leaflet keeps
      // the box's top-left corner on a resize, so the move is in box px.
      ctl.frame(null, offset);
      const dx = boxCenter(w.rect, box).x - boxCenter(prev.rect, prevBox).x;
      const dy = boxCenter(w.rect, box).y - boxCenter(prev.rect, prevBox).y;
      if (dx || dy) ctl.panBy(-dx, -dy);
    } else ctl.frame(null, offset);
  };

  const stopWarm = () => {
    cancelWarm?.();
    cancelWarm = null;
  };

  /** In `list`, build the hidden map when the page is idle (see the file comment). */
  const scheduleWarm = () => {
    if (warmed || cancelWarm || current !== 'hidden' || deps.saveData()) return;
    cancelWarm = deps.idle(() => {
      cancelWarm = null;
      if (!map || !layout || current !== 'hidden') return;
      warmed = true;
      map.warm();
    });
  };

  const present = (req: AtlasPresentationRequest) => {
    // A pending expand ends only on `hidden` (the user went to another page).
    // A window from the post or a state change before the attach keeps it.
    if (req === 'hidden') expanding = null;
    clearHold();
    stopTween();
    show(req);
  };

  const show = (req: AtlasPresentationRequest) => {
    if (typeof req === 'object') {
      presentWindow(req);
      return;
    }
    leaveWindow();
    const p = req;
    current = p;
    if (container) container.dataset.atlasOcean = p;
    // A hidden map keeps its view: its box changes size, and the next show
    // must not find a centre that `maxBounds` moved (atlasLayerMap.ts::park).
    if (p === 'hidden') map?.park();
    else {
      // A shown map is built; a warm-up has nothing left to do.
      stopWarm();
      warmed = true;
      map?.show();
    }
    syncChip();
  };

  const animateTo = (req: AtlasPresentationRequest, ms = TWEEN_MS): Promise<void> => {
    clearHold();
    stopTween();
    const box = container ? deps.box(container) : null;
    const from = box ? shownRect(box) : null;
    const to = typeof req === 'object' ? visibleRect(req) : req === 'hidden' ? null : box;
    if (!box || !from || !to || ms <= 0 || deps.reducedMotion()) {
      show(req);
      return Promise.resolve();
    }
    const target = typeof req === 'object' ? req : null;
    // The pan: the target centre goes from where it is now to the target
    // window centre, in step with the clip. The zoom does not change.
    const fromOff = target?.center ? map?.offsetOf(target.center) ?? null : null;
    const toOff = target ? windowOffset(target.rect, box) : null;
    // The tween runs in window mode: the clip moves, the box stays. It starts
    // at `from` as it is; the target's clip is for the end, not the start.
    presentWindow({ ...(target ?? win ?? { kind: 'window' }), kind: 'window', rect: from, clip: undefined, center: undefined }, false);
    const start = deps.now();
    return new Promise<void>((resolve) => {
      endTween = resolve;
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / ms);
        const e = easeInOut(t);
        setClip(tweenRect(from, to, e), box);
        if (target?.center && fromOff && toOff) map?.frame(target.center, tweenPoint(fromOff, toOff, e));
        if (t < 1) {
          cancelTween = deps.frame(step);
          return;
        }
        cancelTween = null;
        endTween = null;
        show(req);
        resolve();
      };
      cancelTween = deps.frame(step);
    });
  };

  const releaseLayout = () => {
    clearTimeout(timer);
    timer = undefined;
    stopObserve?.();
    stopObserve = null;
    layout?.();
    layout = null;
  };

  return {
    attach() {
      clearHold();
      clearTimeout(timer);
      timer = undefined;
      const newRoute = moved;
      moved = false;
      const returning = !!map && !layout;
      const { el, ctl } = ensure();
      // A kept layout read the URL of the page before (a list page, or
      // /search, which arms a grid too). A Back can restore an entry with
      // another view: the URL of this page wins.
      const fromUrl = layout ? stateFromSearchOrNull(new URL(deps.path(), 'http://x').search) : null;
      const restore = !!fromUrl && fromUrl !== getAtlasLayerState(body);
      // A return from another page, or a restored view: the container sits in
      // its `list` place. The state from the URL must not slide the map in
      // (a slide resizes Leaflet and moves the viewport); it is just there.
      const still = returning || (restore && !!map);
      if (still) el.style.transition = 'none';
      if (!layout) {
        layout = deps.mountLayout(body);
        stopObserve = deps.observeState(body, () => present(presentationForState(getAtlasLayerState(body))));
      } else if (restore) {
        setAtlasLayerState(fromUrl, body);
      }
      if (still) {
        void el.offsetHeight;
        const clear = () => { el.style.transition = ''; };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(clear));
        else clear();
      }
      const exp = expanding;
      expanding = null;
      if (exp) {
        // The end of an expand: the window covers the box, so the map is
        // already where `full` shows it. Then the zoom, then the selection.
        stopTween();
        show(presentationForState(getAtlasLayerState(body)));
        ctl.setView(exp.center, exp.zoom);
        ctl.route(exp.focusPostSlug);
        guardUntil = deps.now() + EXPAND_CLICK_GUARD_MS;
      } else {
        // A return from another page: the URL viewport is the list's own view
        // (the return URL). The parked view can be a post widget's view.
        const urlView = returning ? viewFromSearch(new URL(deps.path(), 'http://x').search) : null;
        if (urlView) ctl.useView(urlView);
        // A new page: the selection and the URL viewport follow the new route.
        if (newRoute) ctl.route();
        present(presentationForState(getAtlasLayerState(body)));
      }
      scheduleWarm();
    },

    detach(path = deps.path(), ms = DETACH_MS) {
      if (!layout) return;
      moved = true;
      if (isAtlasListPath(path)) {
        // The next list page attaches soon; keep the layout and the shown map.
        clearTimeout(timer);
        timer = setTimeout(() => { releaseLayout(); present('hidden'); }, ms);
        return;
      }
      stopWarm();
      const hold = current !== 'hidden' && deps.sheetReturn(path);
      releaseLayout();
      if (!hold) {
        present('hidden');
        return;
      }
      // A Back to the post's open sheet: the map stays on screen, over the
      // whole box, until the sheet's slot takes it (collapse).
      expanding = null;
      stopTween();
      // Window mode first: without the layout, the `list` rules move the
      // container off screen (translateY(-100%)), and the box must not be read there.
      const { el } = ensure();
      el.dataset.atlasOcean = 'window';
      presentWindow({ kind: 'window', rect: deps.box(el) }, false);
      syncChip();
      holdTimer = setTimeout(() => present('hidden'), ms);
    },

    present,

    animateTo,

    expand(target, ms = TWEEN_MS) {
      const box = container && current === 'window' ? deps.box(container) : null;
      const done = box
        ? animateTo({ kind: 'window', rect: box, center: target.center }, ms)
        : Promise.resolve();
      expanding = target;
      return done;
    },

    collapse(slot, ms = TWEEN_MS) {
      expanding = null;
      stopTween();
      let frames = 0;
      return new Promise<void>((resolve) => {
        endTween = resolve;
        const step = () => {
          const w = slot();
          // The slot's first layout: a rect with a size, inside the box.
          const box = w ? deps.box(ensure().el) : null;
          if (w && box && w.rect.width > 0 && w.rect.height > 0 && !insetsEmpty(clipInsets(visibleRect(w), box), box)) {
            cancelTween = null;
            endTween = null;
            // animateTo resolves on its own end; the hold ends with it.
            void animateTo(w, ms).then(resolve);
            return;
          }
          if (++frames >= SETTLE_FRAMES) {
            cancelTween = null;
            endTween = null;
            if (holdTimer !== undefined) present('hidden');
            resolve();
            return;
          }
          cancelTween = deps.frame(step);
        };
        step();
      });
    },

    presentation: () => current,

    destroy() {
      expanding = null;
      guardUntil = -Infinity;
      clearHold();
      stopTween();
      stopWarm();
      leaveWindow();
      stopInput?.();
      stopInput = null;
      warmed = false;
      releaseLayout();
      map?.destroy();
      map = null;
      container?.remove();
      container = null;
      current = 'hidden';
      moved = false;
      deps.fromPostChip(false);
    },
  };
}

let ocean: AtlasOcean | null = null;

/** A list page armed its grid: mount the layout and show the map for the state. */
export function attachAtlasOcean(): void {
  ocean ??= createAtlasOcean(defaultDeps());
  ocean.attach();
}

/** The list page went away. `path` is the new page. The map is kept. */
export function detachAtlasOcean(path?: string): void {
  ocean?.detach(path);
}

/** `tags-atlas` is off: remove the container and destroy the map. */
export function destroyAtlasOcean(): void {
  ocean?.destroy();
  ocean = null;
}

/**
 * Show the map as `presentation`. A window on a page with no list (a post)
 * makes the ocean and builds the map on the first call.
 */
export function presentAtlasOcean(presentation: AtlasPresentationRequest): void {
  ocean ??= createAtlasOcean(defaultDeps());
  ocean.present(presentation);
}

/** Tween the map to `presentation` (instant under reduced motion). */
export function animateAtlasOcean(presentation: AtlasPresentationRequest, ms?: number): Promise<void> {
  ocean ??= createAtlasOcean(defaultDeps());
  return ocean.animateTo(presentation, ms);
}

/** Grow the window to the full map (instant under reduced motion). See `AtlasOcean.expand`. */
export function expandAtlasOcean(target: AtlasExpand, ms?: number): Promise<void> {
  ocean ??= createAtlasOcean(defaultDeps());
  return ocean.expand(target, ms);
}

/** The way back from the full map into the sheet's slot. See `AtlasOcean.collapse`. */
export function collapseAtlasOcean(slot: () => AtlasWindow | null, ms?: number): Promise<void> {
  ocean ??= createAtlasOcean(defaultDeps());
  return ocean.collapse(slot, ms);
}

/** The current presentation. `hidden` before the first attach. */
export function atlasPresentation(): AtlasPresentation {
  return ocean?.presentation() ?? 'hidden';
}
