/**
 * The Atlas return marker: a post opened from the map layer leaves the list URL
 * behind (it carries the layer state and the map viewport), and closing the post
 * hands that URL back. This module owns the sessionStorage key; no other file
 * reads or writes it.
 */

const OPEN_KEY = 'atlasOpenContext';

/** The URL of the list page to restore when the post closes. */
export interface AtlasOpenContext {
  returnUrl: string;
}

/** Leave the marker before navigating from the map layer to a post. */
export function markAtlasOpen(ctx: AtlasOpenContext): void {
  try {
    sessionStorage.setItem(OPEN_KEY, JSON.stringify(ctx));
  } catch { /* ignore */ }
}

/** Drop a stale open marker. */
export function clearAtlasOpen(): void {
  try {
    sessionStorage.removeItem(OPEN_KEY);
  } catch { /* ignore */ }
}

/**
 * Read and remove the open marker. Returns the list URL to navigate to, or
 * null when the post was not opened from the map layer.
 */
export function takeAtlasReturn(): string | null {
  try {
    const ctx = JSON.parse(sessionStorage.getItem(OPEN_KEY) || 'null') as AtlasOpenContext | null;
    sessionStorage.removeItem(OPEN_KEY);
    return ctx?.returnUrl || null;
  } catch {
    return null;
  }
}
