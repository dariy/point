/**
 * Shared filter state of the atlas-layer post list.
 *
 * The map sets `place` (a geo-tag slug) and the timeline sets `years`. Both
 * live here, and the list reads one request from here. The map and the timeline
 * never query the list on their own.
 */

/** [startYear, endYear], inclusive. */
export type YearRange = [number, number];

export interface ListFilter {
  place: string | null;
  years: YearRange | null;
}

/** What the list loads: the home feed, or the posts of one geo-tag. */
export interface ListRequest {
  /** Geo-tag slug to load from the tag endpoint; null loads the home feed. */
  place: string | null;
  year_from?: number;
  year_to?: number;
}

export const NO_FILTER: ListFilter = { place: null, years: null };

/** Replace the geo-tag filter. The time filter stays. */
export function withPlace(filter: ListFilter, place: string | null): ListFilter {
  return { ...filter, place: place || null };
}

/** Replace the time filter. The geo-tag filter stays. */
export function withYears(filter: ListFilter, years: YearRange | null): ListFilter {
  return { ...filter, years: years ? [years[0], years[1]] : null };
}

/** True when at least one filter is on. */
export function isFiltered(filter: ListFilter): boolean {
  return filter.place !== null || filter.years !== null;
}

/** The one request for the list: geo-tag AND time range when both are on. */
export function listRequest(filter: ListFilter): ListRequest {
  const req: ListRequest = { place: filter.place };
  if (filter.years) {
    req.year_from = filter.years[0];
    req.year_to = filter.years[1];
  }
  return req;
}
