/**
 * atlasLayerMap — the map inside the layer, fed by the posts of the current list.
 *
 * The map is lazy. Nothing loads (no Leaflet, no data, no tiles) while the page
 * stays in `list`. On the first change out of `list` the controller loads the
 * list's posts through the pager's own `fetchPosts`, so the map has the same
 * filter as the cards, then builds the map. Later `refresh()` calls diff the
 * markers by post id; the map is never rebuilt.
 */

import { loadLeaflet, TILE_ATTR, TILE_DARK, TILE_LIGHT, TILE_MAX_NATIVE_ZOOM } from '../../utils/leaflet.ts';
import { getAtlasLayerState, replaceSearch, searchWithView, viewFromSearch } from './atlasLayerState.ts';

import type { Post } from '../../api/posts.ts';
import type { GridPagination } from '../../core/gridPager.ts';
import type { LeafletRef } from '../../utils/leaflet.ts';

/** Most pages the map reads for one list. */
export const MAX_MAP_PAGES = 30;
const MARKER_SIZE = 14;

export interface AtlasLayerMapOptions {
  /** the map container */
  container: HTMLElement;
  /** the posts of one page of the current list */
  fetchPosts: (page: number) => Promise<Post[]>;
  /** names the current filter; a new key means a new list */
  filterKey?: () => string;
  /** false once the host unmounted */
  isAlive: () => boolean;
}

export interface AtlasLayerMapController {
  /** The grid re-armed: the list may have changed. */
  refresh(pagination: GridPagination): void;
  destroy(): void;
}

function isDarkTheme(): boolean {
  const t = document.documentElement.dataset.theme;
  return t === 'dark' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

/** The place of a post: its first place tag with coordinates. */
export function postPlace(post: Post): { lat: number; lng: number } | null {
  for (const t of post.tags || []) {
    if (typeof t.latitude === 'number' && typeof t.longitude === 'number') {
      return { lat: t.latitude, lng: t.longitude };
    }
  }
  return null;
}

/** The pages of a list, first to last. */
export function pageNumbers(pagination: GridPagination): number[] {
  const first = Math.min(1, pagination.minPage ?? 1);
  const last = Math.min(Math.max(pagination.pages ?? 1, 1), first + MAX_MAP_PAGES - 1);
  const out: number[] = [];
  for (let p = first; p <= last; p++) out.push(p);
  return out;
}

/** Start the controller. It waits for the first state other than `list`. */
export function mountAtlasLayerMap(
  opts: AtlasLayerMapOptions,
  body: HTMLElement = document.body,
): AtlasLayerMapController {
  let L: LeafletRef | null = null;
  let map: any = null;
  let layer: any = null;
  const markers = new Map<number, any>();
  let pagination: GridPagination = {};
  let loadedKey: string | null = null;
  let req = 0;
  let dead = false;
  let fitted = false;

  const keyOf = () => `${opts.filterKey?.() ?? ''}|${pagination.total ?? ''}`;

  async function load() {
    const key = keyOf();
    if (key === loadedKey) return;
    const token = ++req;
    const pages = pageNumbers(pagination);
    let batches: Post[][];
    try {
      [L, batches] = await Promise.all([
        L ?? loadLeaflet(),
        Promise.all(pages.map((p) => opts.fetchPosts(p).catch(() => [] as Post[]))),
      ]);
    } catch {
      return;
    }
    if (dead || token !== req || !opts.isAlive()) return;
    loadedKey = key;
    ensureMap();
    apply(batches.flat());
  }

  function ensureMap() {
    if (map || !L) return;
    map = L.map(opts.container, {
      minZoom: 2,
      maxBounds: [[-90, -180], [90, 180]],
      maxBoundsViscosity: 1.0,
      zoomAnimation: false,
    });
    // A reload or a return from a post brings the viewport back from the URL.
    const view = viewFromSearch(location.search);
    map.setView(view ? [view.lat, view.lng] : [20, 0], view ? view.zoom : 2);
    fitted = !!view;
    map.on('moveend', () => {
      if (getAtlasLayerState(body) === 'list') return;
      const c = map.getCenter();
      replaceSearch(searchWithView(location.search, { lat: c.lat, lng: c.lng, zoom: map.getZoom() }));
    });
    L.tileLayer(isDarkTheme() ? TILE_DARK : TILE_LIGHT, {
      attribution: TILE_ATTR,
      maxZoom: 18,
      maxNativeZoom: TILE_MAX_NATIVE_ZOOM,
      noWrap: true,
      bounds: [[-90, -180], [90, 180]],
    }).addTo(map);
    layer = L.layerGroup().addTo(map);
  }

  /** Diff the markers against the posts: add the new, drop the gone. */
  function apply(posts: Post[]) {
    if (!L || !map) return;
    const seen = new Set<number>();
    const points: Array<[number, number]> = [];
    for (const post of posts) {
      const place = postPlace(post);
      if (!place || seen.has(post.id)) continue;
      seen.add(post.id);
      points.push([place.lat, place.lng]);
      if (markers.has(post.id)) continue;
      const marker = L.marker([place.lat, place.lng], {
        icon: L.divIcon({
          className: 'atlas-marker atlas-layer-marker',
          html: '<span class="atlas-marker__dot" style="width:14px;height:14px;"></span>',
          iconSize: [MARKER_SIZE, MARKER_SIZE],
          iconAnchor: [MARKER_SIZE / 2, MARKER_SIZE / 2],
        }),
        title: post.title,
        keyboard: false,
      }).addTo(layer);
      markers.set(post.id, marker);
    }
    for (const [id, marker] of markers) {
      if (seen.has(id)) continue;
      layer.removeLayer(marker);
      markers.delete(id);
    }
    map.invalidateSize();
    if (points.length && !fitted) {
      fitted = true;
      map.fitBounds(points, { padding: [40, 40], maxZoom: 12 });
    }
  }

  const sync = () => {
    if (getAtlasLayerState(body) !== 'list') void load();
    else map?.invalidateSize();
  };
  const mo = new MutationObserver(sync);
  mo.observe(body, { attributes: true, attributeFilter: ['data-atlas-layer'] });

  return {
    refresh(next) {
      pagination = next || {};
      // A list that changed while the map is up, or a map that is waiting
      // for its first open: only the first case loads now.
      if (getAtlasLayerState(body) !== 'list') void load();
    },
    destroy() {
      dead = true;
      mo.disconnect();
      map?.remove();
      map = null;
      markers.clear();
    },
  };
}
