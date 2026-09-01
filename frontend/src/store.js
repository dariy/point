/**
 * Global reactive state store.
 *
 * A minimal pub/sub key-value store. Components subscribe to specific keys
 * and are notified immediately when that key changes.
 *
 * Usage:
 *   import { store } from '../store.js';
 *
 *   // Read
 *   const user = store.get('user');
 *
 *   // Write (notifies all subscribers of 'user')
 *   store.set('user', { id: 1, username: 'alice' });
 *
 *   // Subscribe
 *   const unsub = store.subscribe('user', (value) => { ... });
 *   // Later:
 *   unsub(); // stop listening
 *
 *   // Subscribe to one slice, so unrelated writes to the key are free
 *   store.subscribeSelector('settings', s => s.blog_title, (title) => { ... });
 *
 *   // Patch an object key, keeping its identity when nothing actually changed
 *   store.merge('settings', { blog_title: 'Point' });
 *
 * Two guards keep a write from costing a repaint it does not owe. set() does
 * not notify when the value is the one already there (Object.is), and
 * subscribeSelector() does not notify when the selected slice is unchanged.
 * Both matter because the usual subscriber calls setState(), which tears down
 * and rebuilds the component's whole subtree — the most expensive possible
 * response to "nothing happened".
 */

class Store {
  constructor() {
    /** @type {Record<string, unknown>} */
    this._state = {};
    /** @type {Record<string, Set<Function>>} */
    this._listeners = {};
  }

  /**
   * Read a value.
   *
   * The store holds `unknown` because any key may hold anything; `T` lets a
   * caller that knows the shape say so, either by annotating the variable it
   * reads into or by declaring it on the function that returns it. Unstated,
   * it stays `unknown` and the caller has to narrow.
   *
   * @template [T=unknown]
   * @param {string} key
   * @returns {T}
   */
  get(key) {
    return /** @type {T} */ (this._state[key]);
  }

  /**
   * Write a value and notify subscribers.
   *
   * A write of the value already in place is dropped: no assignment, no
   * dispatch. The comparison is Object.is, so it catches primitives and
   * preserved references but says nothing about two objects with equal
   * contents. A payload rebuilt on every fetch — settings parsed from JSON,
   * say — is a fresh reference each time and will never be caught here; that
   * is what merge() is for.
   *
   * @param {string} key
   * @param {unknown} value
   */
  set(key, value) {
    if (Object.is(this._state[key], value) && key in this._state) return;
    this._state[key] = value;
    const listeners = this._listeners[key];
    if (!listeners) return;
    // Dispatch over a snapshot, skipping anyone unsubscribed along the way.
    //
    // Both halves matter because subscribers re-render, and a Component's
    // re-render releases the current render's subscriptions and takes out
    // fresh ones (see Component.registerCleanup). Iterating the live Set
    // would visit those replacements — Set.forEach visits entries added
    // during iteration — and each would re-render and resubscribe again,
    // which does not terminate. The `has` check is the other direction: a
    // subscriber torn down by an earlier callback in this same dispatch must
    // not be called after it has gone.
    for (const fn of [...listeners]) {
      if (this._listeners[key]?.has(fn)) fn(value);
    }
  }

  /**
   * Subscribe to changes on a key.
   * @param {string} key
   * @param {Function} callback  Called with the new value whenever it changes
   * @returns {Function}  Unsubscribe function
   */
  subscribe(key, callback) {
    if (!this._listeners[key]) this._listeners[key] = new Set();
    this._listeners[key].add(callback);
    return () => this._listeners[key].delete(callback);
  }

  /**
   * Subscribe to one slice of a key.
   *
   * The well-known keys below are coarse on purpose — 'settings' is every
   * public setting in one object — and a subscriber of the whole key wakes up
   * for every write to any part of it. This is the escape valve: a header
   * watching the blog title stays asleep while an unrelated setting is saved.
   *
   * The selector runs on every write; keep it a plain read. Its result is
   * compared with Object.is, so return a primitive or a stable reference —
   * `s => ({ a: s.a })` builds a new object each time and never compares equal.
   *
   * @param {string} key
   * @param {Function} select    Maps the key's value to the slice to watch
   * @param {Function} callback  Called with (slice, value) when the slice changes
   * @returns {Function}  Unsubscribe function
   */
  subscribeSelector(key, select, callback) {
    let previous = select(this._state[key]);
    return this.subscribe(key, (value) => {
      const next = select(value);
      if (Object.is(previous, next)) return;
      previous = next;
      callback(next, value);
    });
  }

  /**
   * Patch an object-valued key, keeping the current object when the patch
   * changes nothing.
   *
   * `store.set(key, { ...store.get(key), ...patch })` — the shape every
   * settings writer used before this existed — hands set() a fresh reference
   * whatever the patch contains, so the Object.is guard there never fires and
   * a re-fetch of unchanged settings repaints everything subscribed to them.
   * merge() compares the merged result against what is there, one level deep,
   * and returns without writing when they match.
   *
   * Shallow by design: values are compared with Object.is, so a nested object
   * rebuilt by the caller counts as a change. The settings payload is flat
   * primitives after normalizeSettings(), which is what makes this enough.
   *
   * @param {string} key
   * @param {object} patch
   */
  merge(key, patch) {
    const current = /** @type {object|undefined} */ (this._state[key]);
    const next = { ...current, ...patch };
    if (current && typeof current === 'object' && shallowEqual(current, next)) return;
    this.set(key, next);
  }
}

/**
 * Same keys, and every value Object.is-equal.
 * @param {object} a
 * @param {object} b
 */
function shallowEqual(a, b) {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => Object.is(a[k], b[k]));
}

/**
 * Singleton store instance shared across the application.
 *
 * A plain module constant is safe here because the core and all plugin
 * entries are bundled in ONE esbuild pass with --splitting (see
 * scripts/build-js.sh): this module lands in a single shared chunk, so every
 * importer — app.js and plugin chunks alike — gets the same instance.
 */
export const store = new Store();

// ── Well-known store keys (documented here for discoverability) ────────────
//
//  'user'           {object|null}              Current authenticated user, or null
//  'settings'       {object}                  Public blog settings from /api/settings/public
//  'theme'          {'dark'|'light'|'auto'}   Active UI theme
//  'pagination'     {page, pages, total}|null  Grid page state feeding the footer paginator
//  'toast'          {message, type, id}        Most recent toast notification
//  'offline_status' {pending, failed, syncing, has_ops}  Mutation queue state
