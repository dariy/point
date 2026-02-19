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
   * @param {string} key
   * @returns {unknown}
   */
  get(key) {
    return this._state[key];
  }

  /**
   * Write a value and notify subscribers.
   * @param {string} key
   * @param {unknown} value
   */
  set(key, value) {
    this._state[key] = value;
    if (this._listeners[key]) {
      this._listeners[key].forEach((fn) => fn(value));
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
}

/** Singleton store instance shared across the application. */
export const store = new Store();

// ── Well-known store keys (documented here for discoverability) ────────────
//
//  'user'     {object|null}         Current authenticated user, or null
//  'settings' {object}              Public blog settings from /api/settings/public
//  'theme'    {'dark'|'light'|'auto'}  Active UI theme
//  'toast'    {message, type, id}   Most recent toast notification
