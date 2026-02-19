/**
 * System API — stats, logs, backups, cache.
 *
 * Backend prefix: /api/system
 */

import { api } from './client.js';

/**
 * Get system statistics (disk, DB, media counts).
 * @returns {Promise<object>}
 */
export function getStats() {
  return api.get('/api/system/stats');
}

/**
 * Get recent application log entries.
 * @param {{ lines?: number, level?: string }} [params]
 * @returns {Promise<{ entries: object[] }>}
 */
export function getLogs(params = {}) {
  return api.get('/api/system/logs', params);
}

/**
 * List backup archives.
 * @returns {Promise<object[]>}
 */
export function listBackups() {
  return api.get('/api/system/backups');
}

/**
 * Trigger an immediate backup.
 * @returns {Promise<object>}
 */
export function createBackup() {
  return api.post('/api/system/backups');
}

/**
 * Delete a backup archive by filename.
 * @param {string} filename
 * @returns {Promise<null>}
 */
export function deleteBackup(filename) {
  return api.delete(`/api/system/backups/${encodeURIComponent(filename)}`);
}

/**
 * Flush the server-side file cache.
 * @returns {Promise<object>}
 */
export function flushCache() {
  return api.post('/api/system/cache/flush');
}
