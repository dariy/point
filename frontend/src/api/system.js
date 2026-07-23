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

/**
 * Move out — step 1: re-verify the password and get a one-time download token.
 * @param {string} filename
 * @param {string} sha256pw - sha256-hex of the account password
 * @returns {Promise<{token: string}>}
 */
export function authorizeBackupDownload(filename, sha256pw) {
  return api.post(`/api/system/backups/${encodeURIComponent(filename)}/authorize-download`, {
    current_name: sha256pw,
  });
}

/**
 * Move out — step 2: the URL a browser navigates to in order to stream the
 * archive (supports HTTP range/resume; not fetched through the JSON client).
 * @param {string} filename
 * @param {string} token - one-time token from authorizeBackupDownload
 * @returns {string}
 */
export function backupDownloadUrl(filename, token) {
  return `/api/system/backups/${encodeURIComponent(filename)}/download?token=${encodeURIComponent(token)}`;
}

/**
 * Move in — upload a local .tar.gz into the backups folder (staging only; it is
 * NOT applied — the user restores it afterward if they choose). Uses XHR (not the
 * JSON client) so the File streams as the raw body and we get upload progress.
 * @param {File} file
 * @param {(fraction:number)=>void} [onProgress] - 0..1 upload progress
 * @param {string} [expectedChecksum] - optional sha256-hex to verify the upload
 * @returns {Promise<object>}
 */
export function uploadBackupArchive(file, onProgress, expectedChecksum) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/system/backups/upload');
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/gzip');
    if (expectedChecksum) xhr.setRequestHeader('X-Archive-SHA256', expectedChecksum);
    xhr.upload.addEventListener('progress', (e) => {
      if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
    });
    xhr.addEventListener('load', () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText || '{}'); } catch { /* non-JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.message || `Upload failed (${xhr.status})`));
    });
    xhr.addEventListener('error', () => reject(new Error('Upload failed')));
    xhr.send(file);
  });
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
