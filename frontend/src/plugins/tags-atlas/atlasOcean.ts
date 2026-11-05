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

import { getAtlasLayerState, isAtlasListPath } from './atlasLayerState.ts';
import { mountAtlasLayerLayout } from './atlasLayerLayout.ts';
import { mountAtlasLayerMap } from './atlasLayerMap.ts';

import {
  clipInsets, createTapGate, easeInOut, insetCss, intersectRect, tweenPoint, tweenRect, windowOffset,
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
}

/** What a page asks the ocean to show. */
export type AtlasPresentationRequest = Exclude<AtlasPresentation, 'window'> | AtlasWindow;

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
  /** True under `prefers-reduced-motion: reduce`. */
  reducedMotion(): boolean;
  /** Run `fn` on the next animation frame with a timestamp in ms. Returns a cancel. */
  frame(fn: (now: number) => void): () => void;
  /** The current time in ms, on the same clock as `frame`. */
  now(): number;
}

export interface AtlasOcean {
  attach(): void;
  detach(path?: string, ms?: number): void;
  present(presentation: AtlasPresentationRequest): void;
  /** Tween the clip to `presentation`. Resolves when it is in place (or replaced). */
  animateTo(presentation: AtlasPresentationRequest, ms?: number): Promise<void>;
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
    reducedMotion: () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
    frame: defaultFrame,
    now: () => (typeof requestAnimationFrame === 'function' ? performance.now() : Date.now()),
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
  // The tween in progress: a cancel, and the resolve of its promise.
  let cancelTween: (() => void) | null = null;
  let endTween: (() => void) | null = null;
  const gate = createTapGate();
  let stopInput: (() => void) | null = null;

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
      if (current !== 'window') return;
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

  /** The container and the map controller, made on the first need. */
  const ensure = () => {
    if (!container) {
      container = deps.container(body);
      stopInput = listen(container);
    }
    map ??= deps.mountMap(container, body);
    return { el: container, ctl: map };
  };

  const setClip = (rect: Rect | null, box: Rect) => {
    if (container) container.style.clipPath = rect ? insetCss(clipInsets(rect, box)) : '';
  };

  /** The part of a window on screen: its rect inside its clip. */
  const visibleRect = (w: AtlasWindow): Rect => (w.clip ? intersectRect(w.rect, w.clip) : w.rect);

  /** The rect on screen now: the window, the whole box, or nothing (hidden). */
  const shownRect = (box: Rect): Rect | null => {
    if (current === 'window') return win ? visibleRect(win) : null;
    return current === 'hidden' ? null : box;
  };

  const leaveWindow = () => {
    if (current !== 'window') return;
    win = null;
    map?.setWindowTap(null);
    if (container) container.style.clipPath = '';
  };

  /** Show the map through `w`. `recenter` false: keep the view (a tween step). */
  const presentWindow = (w: AtlasWindow, recenter = true) => {
    const { el, ctl } = ensure();
    const prev = current === 'window' ? win : null;
    current = 'window';
    el.dataset.atlasOcean = 'window';
    stopWarm();
    warmed = true;
    win = w;
    ctl.setWindowTap(() => win?.onTap?.());
    const box = deps.box(el);
    setClip(visibleRect(w), box);
    const offset = windowOffset(w.rect, box);
    if (!recenter) ctl.frame(null, offset);
    else if (w.center) ctl.frame(w.center, offset, w.zoom);
    else if (prev) {
      // The slot moved (a sheet drag or scroll): the map moves with it.
      ctl.frame(null, offset);
      const dx = w.rect.left - prev.rect.left;
      const dy = w.rect.top - prev.rect.top;
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
      clearTimeout(timer);
      timer = undefined;
      const newRoute = moved;
      moved = false;
      const returning = !!map && !layout;
      const { el, ctl } = ensure();
      if (!layout) {
        // A return from another page: the container sits in its `list` place.
        // The state from the URL must not slide the map in; it is just there.
        if (returning) el.style.transition = 'none';
        layout = deps.mountLayout(body);
        stopObserve = deps.observeState(body, () => present(presentationForState(getAtlasLayerState(body))));
        if (returning) {
          void el.offsetHeight;
          const clear = () => { el.style.transition = ''; };
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(clear));
          else clear();
        }
      }
      // A new page: the selection and the URL viewport follow the new route.
      if (newRoute) ctl.route();
      present(presentationForState(getAtlasLayerState(body)));
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
      releaseLayout();
      present('hidden');
    },

    present,

    animateTo(req, ms = TWEEN_MS) {
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
      // The tween runs in window mode: the clip moves, the box stays.
      presentWindow({ ...(target ?? win ?? { kind: 'window' }), kind: 'window', rect: from, center: undefined }, false);
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
    },

    presentation: () => current,

    destroy() {
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

/** The current presentation. `hidden` before the first attach. */
export function atlasPresentation(): AtlasPresentation {
  return ocean?.presentation() ?? 'hidden';
}
