/**
 * Notification log — session-only in-memory log of toast notifications.
 *
 * Subscribes to the 'toast' store key and accumulates entries with timestamps.
 * Maintains at most 100 entries, pruning those older than 10 minutes.
 * Writes the current list to store key 'toast_log' after each change.
 *
 * Usage:
 *   import { initNotificationLog, getRecentEntries } from './notificationLog.js';
 *   initNotificationLog(store);
 *
 * Entry shape (preserved for future use):
 *   { id: number, message: string, type: string, timestamp: number }
 */

const MAX_AGE_MS  = 10 * 60 * 1000; // 10 minutes
const MAX_ENTRIES = 100;

/** @type {{ id: number, message: string, type: string, timestamp: number }[]} */
const _log = [];
let _nextId = 1;

/**
 * Start listening to the 'toast' store key and logging notifications.
 * Call once at app startup before the router starts.
 * @param {object} storeInstance  The singleton store from store.js
 */
export function initNotificationLog(storeInstance) {
  storeInstance.subscribe('toast', (payload) => {
    if (!payload) return;
    _log.push({
      id:        _nextId++,
      message:   payload.message ?? '',
      type:      payload.type    ?? 'info',
      timestamp: Date.now(),
    });
    _prune();
    storeInstance.set('toast_log', getRecentEntries());
  });
}

/**
 * Return a pruned snapshot of recent entries (last 10 minutes, max 100).
 * Always returns a new array; safe to hand to the store.
 * @returns {{ id: number, message: string, type: string, timestamp: number }[]}
 */
export function getRecentEntries() {
  _prune();
  return [..._log];
}

function _prune() {
  const cutoff = Date.now() - MAX_AGE_MS;
  let i = 0;
  while (i < _log.length && _log[i].timestamp < cutoff) i++;
  if (i > 0) _log.splice(0, i);
  while (_log.length > MAX_ENTRIES) _log.shift();
}
