/**
 * The Atlas return marker: a post opened from the Atlas leaves a context behind,
 * and closing the post hands it back as a return state. This module owns both
 * sessionStorage keys; no other file reads or writes them.
 */

const OPEN_KEY = 'atlasOpenContext';
const RETURN_KEY = 'atlasReturn';

/** The Atlas state to restore when the post closes. */
export interface AtlasOpenContext {
  placeTagId: number;
  sheetPage?: number;
  sheetPerPage?: number;
  /** The Atlas URL to return to (`/map?timeline=…`). */
  returnUrl?: string;
}

/** The open context, keyed to the post that was opened. */
export interface AtlasReturn extends AtlasOpenContext {
  postSlug?: string;
}

function read<T>(key: string): T | null {
  try {
    return JSON.parse(sessionStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

/** Leave the marker before navigating from the Atlas to a post. */
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
 * Move the open context to the return key, keyed to `postSlug`. Returns the URL
 * to navigate to (`/map` when the context has none), or null when the post was
 * not opened from the Atlas.
 */
export function takeAtlasReturn(postSlug: string): string | null {
  const ctx = read<AtlasOpenContext>(OPEN_KEY);
  if (!ctx) return null;
  try {
    sessionStorage.removeItem(OPEN_KEY);
    sessionStorage.setItem(RETURN_KEY, JSON.stringify({ ...ctx, postSlug }));
  } catch { /* ignore */ }
  return ctx.returnUrl || '/map';
}

/** Read and remove the return state left by takeAtlasReturn. */
export function consumeAtlasReturn(): AtlasReturn | null {
  const ctx = read<AtlasReturn>(RETURN_KEY);
  try {
    sessionStorage.removeItem(RETURN_KEY);
  } catch { /* ignore */ }
  return ctx;
}
