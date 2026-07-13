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

/**
 * Geocode city/country descendant tags that have no coordinates yet.
 * Uses Nominatim (OpenStreetMap). This can be slow — rate-limited to 1 req/sec.
 * @returns {Promise<{status: string, updated_count: number, message: string, errors?: string[]}>}
 */
export function updateMapCoords() {
  return api.post('/api/system/map/update-coords');
}

/**
 * List folders and importable files in the external photo library.
 * @param {string} [path] - Relative path within the library (default root)
 * @returns {Promise<{path: string, folders: string[], files: Array<{name: string, path: string}>}>}
 */
export function getPhotoLibraryContents(path = '') {
  return api.get('/api/system/photo-library', { path });
}

/**
 * Import specific files from the external photo library into site media.
 * @param {string[]} paths - Relative paths within the library
 * @returns {Promise<{imported: number, skipped: number, errors: string[]}>}
 */
export function importSelectedPhotos(paths) {
  return api.post('/api/system/photo-library/import', { paths });
}

/**
 * Get the URL to preview a file from the external photo library.
 * @param {string} path - Relative path within the library
 * @returns {string}
 */
export function getPhotoLibraryFileUrl(path) {
  return `/api/system/photo-library/file?path=${encodeURIComponent(path)}`;
}

/**
 * Check current and latest available version.
 * Result is cached server-side for 24 hours.
 * @returns {Promise<{current: string, latest: string, update_available: boolean}>}
 */
export function getVersion() {
  return api.get('/api/system/version');
}

/**
 * Get disk usage for the data directory.
 * @returns {Promise<{total: number, free: number, used: number}>}
 */
export function getDiskInfo() {
  return api.get('/api/system/disk');
}

/**
 * Audit internal post links: reports links on publicly reachable posts whose
 * target anonymous visitors cannot open (missing, unpublished, hidden by tag).
 * @returns {Promise<{issues: Array<{source_id:number, source_slug:string, source_title:string, target_slug:string, reason:string}>, scanned: number}>}
 */
export function auditPostLinks() {
  return api.get('/api/system/audit/post-links');
}
