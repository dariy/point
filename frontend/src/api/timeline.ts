import { api } from './client.ts';

/** One year or decade tag on the timeline — services.TimelinePill. */
export interface TimelinePill {
  slug: string;
  name: string;
  /** The decade's first year when `is_decade`. */
  year: number;
  is_decade: boolean;
  post_count: number;
}

/**
 * GET /api/timeline — services.TimelinePayload. The server answers 404 rather
 * than send an empty `pills`.
 */
export interface TimelinePayload {
  pills: TimelinePill[];
  /** First and last year. */
  extent: { min: number, max: number };
}

/**
 * A location tag and how many of the date tag's posts it shares —
 * services.LocationLink.
 */
export interface LocationLink {
  slug: string;
  name: string;
  post_count: number;
}

/**
 * Fetch timeline payload (pills and extent).
 *
 * @param params.context - Optional context tag slug
 */
export function getTimeline({ context }: { context?: string } = {}): Promise<TimelinePayload> {
  const params: Record<string, string | number | boolean> = {};
  if (context) params.context = context;
  return api.get('/api/timeline', params);
}

/**
 * Fetch location tags co-occurring with a specific date tag.
 *
 * @param params.tag - Date tag slug
 * @param params.context - Optional context tag slug
 * @param params.limit - Optional results limit (default 10)
 */
export function getTimelineLocations({ tag, context, limit }: {
  tag: string;
  context?: string;
  limit?: number;
}): Promise<LocationLink[]> {
  const params: Record<string, string | number | boolean> = { tag };
  if (context) params.context = context;
  if (limit) params.limit = limit;
  return api.get('/api/timeline/locations', params);
}
