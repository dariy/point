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
 *
 * On a list page the presentation follows `body[data-atlas-layer]`. A detach to
 * any other page (a post, search, admin) sets `hidden` and keeps the map. The
 * next list page shows the same map at the same viewport: no new `L.map`, no
 * new tiles, no new places fetch.
 *
 * Leaflet loads on the first `mapList` or `full`, not before.
 */

import { getAtlasLayerState, isAtlasListPath } from './atlasLayerState.ts';
import { mountAtlasLayerLayout } from './atlasLayerLayout.ts';
import { mountAtlasLayerMap } from './atlasLayerMap.ts';

import type { AtlasLayerState } from './atlasLayerState.ts';
import type { AtlasLayerMapController } from './atlasLayerMap.ts';

export type AtlasPresentation = 'hidden' | 'mapList' | 'full';

/** The map container's class. CSS and the layer gesture find the map by it. */
export const ATLAS_MAP_CLASS = 'atlas-layer-map';

/**
 * A list page that replaces a list page (`/` ↔ `/tags/<slug>`) keeps the layout
 * mounted for the next page. If no page attaches in this time (the new page
 * failed to load), the layout is released and the map is hidden.
 */
const DETACH_MS = 10_000;

/** The presentation for a layer state on a list page. */
export function presentationForState(state: AtlasLayerState): AtlasPresentation {
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
}

export interface AtlasOcean {
  attach(): void;
  detach(path?: string, ms?: number): void;
  present(presentation: AtlasPresentation): void;
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

function defaultDeps(): AtlasOceanDeps {
  return {
    body: document.body,
    container: defaultContainer,
    mountLayout: mountAtlasLayerLayout,
    mountMap: (container, body) => mountAtlasLayerMap({ container }, body),
    observeState: defaultObserveState,
    path: () => location.pathname + location.search,
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

  const present = (p: AtlasPresentation) => {
    current = p;
    if (container) container.dataset.atlasOcean = p;
    if (p === 'hidden') map?.resize();
    else map?.show();
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
      container ??= deps.container(body);
      map ??= deps.mountMap(container, body);
      if (!layout) {
        // A return from another page: the container sits in its `list` place.
        // The state from the URL must not slide the map in; it is just there.
        if (returning) container.style.transition = 'none';
        layout = deps.mountLayout(body);
        stopObserve = deps.observeState(body, () => present(presentationForState(getAtlasLayerState(body))));
        if (returning) {
          void container.offsetHeight;
          const c = container;
          const clear = () => { c.style.transition = ''; };
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(clear));
          else clear();
        }
      }
      // A new page: the selection and the URL viewport follow the new route.
      if (newRoute) map.route();
      present(presentationForState(getAtlasLayerState(body)));
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
      map?.park();
      releaseLayout();
      present('hidden');
    },

    present,
    presentation: () => current,

    destroy() {
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

/** The current presentation. `hidden` before the first attach. */
export function atlasPresentation(): AtlasPresentation {
  return ocean?.presentation() ?? 'hidden';
}
