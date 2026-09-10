/**
 * Carousel Studio — undo/redo over the document.
 *
 * The document is already immutable by construction: every writer in
 * `document.js` returns a *new* `CarouselDoc`, and the page commits with
 * `setState({ doc })` under an explicit "the document IS the state" contract.
 * So history here is a ring of `doc` references — no cloning, no inverse
 * operations, no command objects. Undo is "hand back the previous reference".
 *
 * Granularity is the caller's to choose, and the studio already has the right
 * split: `studio/gestures.js` paints provisionally and commits once per gesture
 * (a wheel burst debounces to one `commit`), property forms repaint on `input`
 * and commit on `change`. Pushing at those commit points — and nowhere else —
 * reproduces the step size a user expects without any debouncing of its own.
 *
 *   const history = createHistory({ limit: 60 });
 *   history.reset(doc);        // a freshly loaded document — no undo past it
 *   history.push(nextDoc);     // at a commit point; equal documents are dropped
 *   const prev = history.undo();   // null when there is nothing to go back to
 *
 * `push` dedups, because several of the studio's writers deliberately return an
 * *equal* document when the value they were given is rejected (a pan that ran
 * into the edge of the source, a fit chip clicked twice). Reference first, then
 * `serializeDocument` only when the references differ — the normalize-and-
 * stringify is the expensive half and a re-committed reference is the common
 * case.
 */

import { serializeDocument } from "../document.js";

/** How many documents to keep. Deep enough to cover a working session, small
 *  enough that the retained slide metadata stays trivial next to the media. */
const DEFAULT_LIMIT = 60;

/**
 * @typedef {object} CarouselHistory
 * @property {boolean} canUndo   is there an earlier document to go back to?
 * @property {boolean} canRedo   is there a later one to come forward to?
 * @property {number} depth      how many documents are held (tests, mostly)
 * @property {(doc: *) => void} reset   start over from `doc` as the only entry
 * @property {(doc: *) => boolean} push  record `doc`; false when it deduped
 * @property {(doc: *) => void} replace  swap the current entry for `doc`
 * @property {() => *|null} undo   the previous document, or null
 * @property {() => *|null} redo   the next document, or null
 */

/**
 * Build a history ring.
 *
 * @param {{limit?: number}} [options]
 * @returns {CarouselHistory}
 */
export function createHistory({ limit = DEFAULT_LIMIT } = {}) {
  const cap = Math.max(1, Math.floor(limit) || DEFAULT_LIMIT);
  /** Documents oldest-first, each with the serialization `push` dedups on.
   *  @type {{doc: *, key: string}[]} */
  let entries = [];
  /** Index of the document the caller is currently showing; -1 when empty. */
  let at = -1;

  const entry = (doc) => ({ doc, key: serializeDocument(doc) });

  function reset(doc) {
    entries = doc ? [entry(doc)] : [];
    at = entries.length - 1;
  }

  function push(doc) {
    if (!doc) return false;
    if (at < 0) {
      reset(doc);
      return true;
    }
    const top = entries[at];
    // Reference first: a writer that returned the document it was given has
    // nothing to record, and that is the cheap half of the comparison.
    if (top.doc === doc) return false;
    const next = entry(doc);
    if (next.key === top.key) return false;
    // A push after an undo abandons the redo tail — the standard linear model.
    entries.length = at + 1;
    entries.push(next);
    if (entries.length > cap) entries.shift();
    at = entries.length - 1;
    return true;
  }

  /**
   * Swap the current entry for `doc` without adding a step. What a render uses:
   * it stamps `rendered` blocks onto the document the user is already looking
   * at, which is not an edit to undo — but the entry has to carry them, or
   * undoing the *next* edit would come back to a document that has to re-encode
   * every slide.
   */
  function replace(doc) {
    if (!doc) return;
    if (at < 0) reset(doc);
    else entries[at] = entry(doc);
  }

  function undo() {
    if (at <= 0) return null;
    at -= 1;
    return entries[at].doc;
  }

  function redo() {
    if (at < 0 || at >= entries.length - 1) return null;
    at += 1;
    return entries[at].doc;
  }

  return {
    get canUndo() {
      return at > 0;
    },
    get canRedo() {
      return at >= 0 && at < entries.length - 1;
    },
    get depth() {
      return entries.length;
    },
    reset,
    push,
    replace,
    undo,
    redo,
  };
}
