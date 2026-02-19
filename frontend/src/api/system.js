/**
 * System API — stats, logs, cache, backups.
 *
 * Backend prefix: /api/system
 */

import { api } from './client.js';

/** @returns {Promise<object>} SystemStats */
export function getStats() {
  return api.get('/api/system/stats');
}

/**
 * @param {{ log_type?: string, lines?: number }} [params]
 * @returns {Promise<string[]>}
 */
export function getLogs(params = {}) {
  return api.get('/api/system/logs', params);
}

/**
 * Clear the server-side file cache.
 * @param {string} [pattern]
 * @returns {Promise<object>}
 */
export function clearCache(pattern = 'all') {
  return api.request(`/api/system/cache/clear?pattern=${encodeURIComponent(pattern)}`, {
    method: 'POST',
  });
}

/** @returns {Promise<object>} */
export function createBackup() {
  return api.post('/api/system/backup');
}

/** @returns {Promise<object[]>} */
export function listBackups() {
  return api.get('/api/system/backups');
}

/**
 * @param {string} filename
 * @returns {Promise<object>}
 */
export function restoreBackup(filename) {
  return api.post(`/api/system/backups/${encodeURIComponent(filename)}/restore`);
}

/**
 * @param {string} filename
 * @returns {Promise<object>}
 */
export function deleteBackup(filename) {
  return api.delete(`/api/system/backups/${encodeURIComponent(filename)}`);
}

/** @returns {Promise<object[]>} */
export function getMigrations() {
  return api.get('/api/system/migrations');
}
