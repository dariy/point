/**
 * The place search on the full map (AtlasPlaces.ts::_mountSearch): a pure
 * matcher over the places that the map draws. No DOM, no Leaflet.
 */

/** A place that the search can find. */
export interface SearchPlace {
  id: number;
  name: string;
  post_count?: number;
}

/** The maximum number of results that the list shows. */
export const SEARCH_LIMIT = 8;

/** Lower case, without accents (NFD, then no combining marks), trimmed. */
export function foldName(s: string): string {
  return (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * The places whose name contains `query`, case and accent insensitive. A name
 * that starts with the query comes first, then a name that contains it. In each
 * group the place with more posts comes first, then the name (A–Z). An empty
 * query gives no results.
 */
export function matchPlaces<T extends SearchPlace>(query: string, places: Iterable<T>, limit = SEARCH_LIMIT): T[] {
  const q = foldName(query);
  if (!q) return [];
  const hits: Array<{ place: T; rank: number; name: string }> = [];
  for (const place of places) {
    const name = foldName(place.name);
    const at = name.indexOf(q);
    if (at < 0) continue;
    hits.push({ place, rank: at === 0 ? 0 : 1, name });
  }
  hits.sort(
    (a, b) =>
      a.rank - b.rank ||
      (b.place.post_count || 0) - (a.place.post_count || 0) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      a.place.id - b.place.id,
  );
  return hits.slice(0, limit).map((h) => h.place);
}
