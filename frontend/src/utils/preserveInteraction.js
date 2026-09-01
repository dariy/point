/**
 * preserveInteraction — carry focus, caret and scroll across a rebuild.
 *
 * Replacing a subtree destroys three things the markup does not describe: which
 * element had focus, where the caret sat inside it, and how far the container
 * was scrolled. A user typing in a search box while the results reload loses
 * the field mid-word; a list that re-renders under a scrolled viewport jumps to
 * the top. Both read as the page fighting back.
 *
 * The snapshot is a *selector*, not a node reference — the node is about to
 * stop existing, so holding it would only prove that it did. That means the
 * focused element has to be findable again by something stable: an `id`, a
 * `name`, or a `data-action`. A control with none of the three is not
 * restorable, and the snapshot says so by restoring nothing rather than
 * guessing at a position.
 *
 * The caret is restored to where it was, not to the end of the value. Those
 * agree in the common case (a search box the user is appending to) and diverge
 * in the one that matters — an edit in the middle of a word.
 */

/** Text controls are the only ones with a caret worth recording. */
const TEXTUAL = new Set(['text', 'search', 'url', 'tel', 'password', 'email', 'number']);

function hasCaret(el) {
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  return TEXTUAL.has((el.getAttribute('type') || 'text').toLowerCase());
}

/** Escape an attribute value for use inside a `[attr="…"]` selector. */
const quote = (value) => String(value).replace(/["\\]/g, '\\$&');

/**
 * A selector that will find this element again after its markup is rewritten,
 * or null when nothing about it is stable enough to try.
 *
 * Ambiguity is rejected rather than resolved. A list of rows each carrying
 * `data-action="delete"` would otherwise restore focus to the first row's
 * button whichever row the user was actually on — a wrong answer that looks
 * like a right one, and worse than leaving focus on the body.
 */
function focusSelector(container, el) {
  const unique = (selector) => {
    if (!selector) return null;
    try {
      return container.querySelectorAll(selector).length === 1 ? selector : null;
    } catch {
      return null; // an id or name that does not survive being a selector
    }
  };
  return unique(el.id && `#${globalThis.CSS?.escape ? CSS.escape(el.id) : el.id}`)
    ?? unique(el.getAttribute?.('name') && `${el.tagName.toLowerCase()}[name="${quote(el.getAttribute('name'))}"]`)
    ?? unique(el.getAttribute?.('data-action') && `[data-action="${quote(el.getAttribute('data-action'))}"]`);
}

/**
 * Snapshot the interaction state inside `container`.
 *
 * Split out from preserveInteraction() because the rebuild is not always
 * synchronous: a page that snapshots, awaits a fetch and then calls setState()
 * cannot wrap the whole thing in a callback without holding the restore across
 * an await it does not own.
 *
 * @param {HTMLElement} container
 * @returns {() => HTMLElement|null} restore — safe to call more than once, and
 *   a no-op when the element it was looking for did not come back.
 */
export function captureInteraction(container) {
  const active = globalThis.document?.activeElement;
  const inside = !!active
    && active !== container
    && active !== globalThis.document?.body
    && !!container?.contains?.(active);

  const selector = inside ? focusSelector(container, active) : null;
  const caret = inside && hasCaret(active)
    ? { start: active.selectionStart, end: active.selectionEnd, dir: active.selectionDirection }
    : null;
  const scrollTop = container?.scrollTop || 0;
  const scrollLeft = container?.scrollLeft || 0;

  return function restore() {
    if (!container) return null;
    // Only write a scroll offset that was actually somewhere: assigning 0 to a
    // container the browser has already restored would undo that.
    if (scrollTop) container.scrollTop = scrollTop;
    if (scrollLeft) container.scrollLeft = scrollLeft;
    if (!selector) return null;

    // Unique when it was snapshotted; the rebuild may have made it otherwise,
    // and the same argument applies — no restore beats the wrong one.
    const matches = container.querySelectorAll(selector);
    if (matches.length !== 1) return null;
    const el = matches[0];
    if (typeof el.focus !== 'function') return null;
    if (globalThis.document?.activeElement !== el) el.focus();

    if (caret && typeof el.setSelectionRange === 'function') {
      // The value may have been rewritten shorter under us — a range past the
      // end throws in some engines and silently clamps in others.
      const len = el.value?.length ?? 0;
      const start = Math.min(caret.start ?? len, len);
      const end = Math.min(caret.end ?? len, len);
      try {
        el.setSelectionRange(start, end, caret.dir || 'none');
      } catch {
        /* not a control that supports selection after all */
      }
    }
    return el;
  };
}

/**
 * Run `fn` — a rebuild of `container`'s contents — with focus, caret and
 * scroll put back afterwards.
 *
 * @template T
 * @param {HTMLElement} container
 * @param {() => T} fn
 * @returns {T} whatever fn returned; the restore happens either way, including
 *   when fn throws.
 */
export function preserveInteraction(container, fn) {
  const restore = captureInteraction(container);
  try {
    return fn();
  } finally {
    restore();
  }
}
