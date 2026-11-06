/**
 * atlasFromPost — the way back from the full map to the post's sheet widget.
 *
 * A tap on the sheet's map (ImmersiveSheetViewer.ts::_onMapTap) writes two
 * history entries:
 *
 *   the post's entry      { sheet: 'open', atlasReturn? }   (replaceState)
 *   the tag page's entry  { fromPost, fromTitle, sheet: 'open' }   (pushState)
 *
 * Browser Back lands on the post's entry: the viewer opens its sheet and the
 * ocean shrinks the full map into the slot (atlasOcean.ts::collapse). The full
 * map shows a "‹ <post title>" chip while its entry has `fromPost`; a tap on
 * it is `history.back()`, the same move as Back.
 *
 * `atlasReturn` keeps the list URL marker (utils/atlasReturn.ts) of a post that
 * the map layer opened: the post page drops that marker when it unmounts, and
 * the return puts it back, so a close of the post still lands on the list URL.
 */

/** The full map's entry: the post it came from. */
export interface FromPost {
  slug: string;
  title: string;
}

/** The post's entry: open the sheet, and the list URL marker to put back. */
export interface SheetReturn {
  atlasReturn: string | null;
}

/** The chip's class. */
export const FROM_POST_CHIP_CLASS = 'atlas-from-post';

function record(state: unknown): Record<string, unknown> | null {
  return state && typeof state === 'object' ? state as Record<string, unknown> : null;
}

/** The post the full map came from, or null when the entry has no `fromPost`. */
export function fromPostOf(state: unknown): FromPost | null {
  const s = record(state);
  const slug = s?.fromPost;
  if (typeof slug !== 'string' || !slug) return null;
  return { slug, title: typeof s?.fromTitle === 'string' ? s.fromTitle : '' };
}

/** The history state for the full map's entry. */
export function fromPostState(slug: string, title: string): Record<string, unknown> {
  return { fromPost: slug, fromTitle: title, sheet: 'open' };
}

/** The post's entry asks for the open sheet, or null. */
export function sheetReturnOf(state: unknown): SheetReturn | null {
  const s = record(state);
  if (s?.sheet !== 'open' || s.fromPost) return null;
  return { atlasReturn: typeof s.atlasReturn === 'string' && s.atlasReturn ? s.atlasReturn : null };
}

/** The post's entry with the open sheet (and the list URL marker, when there is one). */
export function sheetReturnState(state: unknown, atlasReturn: string | null): Record<string, unknown> {
  const s: Record<string, unknown> = { ...(record(state) ?? {}), sheet: 'open' };
  if (atlasReturn) s.atlasReturn = atlasReturn;
  else delete s.atlasReturn;
  return s;
}

/** True when a move to `path` with `state` is a Back to a post's open sheet. */
export function isSheetReturn(path: string, state: unknown): boolean {
  const pathname = path.split(/[?#]/, 1)[0];
  return /^\/posts\/[^/]+\/?$/.test(pathname) && sheetReturnOf(state) !== null;
}

/**
 * Show the chip when `show` is true and the current entry has `fromPost`;
 * remove it otherwise. The ocean calls this after each presentation change.
 */
export function syncFromPostChip(show: boolean, doc: Document = document, hist: History = history): void {
  const from = show ? fromPostOf(hist.state) : null;
  let chip = doc.body.querySelector<HTMLButtonElement>(`:scope > .${FROM_POST_CHIP_CLASS}`);
  if (!from) {
    chip?.remove();
    return;
  }
  if (!chip) {
    chip = doc.createElement('button');
    chip.type = 'button';
    chip.className = FROM_POST_CHIP_CLASS;
    // The previous entry is the post (the tap pushed this entry from it).
    chip.addEventListener('click', () => hist.back());
    doc.body.append(chip);
  }
  const title = from.title || 'Post';
  chip.textContent = `‹ ${title}`;
  chip.setAttribute('aria-label', `Back to ${title}`);
}
