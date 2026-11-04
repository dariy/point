/**
 * atlasLayerHost — keeps the live map when one list page replaces another.
 *
 * A move between `/` and `/tags/<slug>` replaces the page component, and the
 * old page destroys its GridPager. If the pager destroyed the map there, the
 * next page would build a new map: the tiles flash, the map refits and the
 * places load again. So GridPager.destroy parks the layout and the map here when
 * the new URL is a list page, and the next GridPager takes them.
 *
 * A parked map that no pager takes in PARK_MS (the new page failed to load) is
 * destroyed. A move to any other page (a post, search, admin) destroys the map
 * at once.
 */

import { isAtlasListPath } from './atlasLayerState.ts';
import type { AtlasLayerMapController } from './atlasLayerMap.ts';

/** What a GridPager owns of the layer: the layout cleanup and the map. */
export interface AtlasLayerKept {
  layout: () => void;
  map: AtlasLayerMapController | null;
}

const PARK_MS = 10_000;

let parked: AtlasLayerKept | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function release(kept: AtlasLayerKept): void {
  kept.map?.destroy();
  kept.layout();
}

/**
 * Park the layer for the next list page, or destroy it when `path` is not a
 * list page. Returns true when the layer is parked.
 */
export function parkAtlasLayer(
  kept: AtlasLayerKept,
  path: string = location.pathname + location.search,
  ms: number = PARK_MS,
): boolean {
  dropParkedAtlasLayer();
  if (!isAtlasListPath(path)) {
    release(kept);
    return false;
  }
  kept.map?.setOwner(null);
  parked = kept;
  timer = setTimeout(dropParkedAtlasLayer, ms);
  return true;
}

/** Take the parked layer, if there is one. The caller owns it from now on. */
export function takeParkedAtlasLayer(): AtlasLayerKept | null {
  clearTimeout(timer);
  timer = undefined;
  const kept = parked;
  parked = null;
  return kept;
}

/** Destroy the parked layer, if there is one. */
export function dropParkedAtlasLayer(): void {
  const kept = takeParkedAtlasLayer();
  if (kept) release(kept);
}
