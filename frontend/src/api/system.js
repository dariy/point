/**
 * System API — stats, logs, cache, backups.
 *
 * Backend prefix: /api/system
 */

import { api } from './client.js';

/**
 * The admin dashboard's counters — GetStats in api/internal/api/system.go.
 *
 * @typedef {object} SystemStats
 * @property {number} published_posts
 * @property {number} total_posts
 * @property {number} total_tags
 * @property {number} total_media
 * @property {number} storage_used_mb
 * @property {number} [storage_quota_mb]  Absent when no quota is configured.
 * @property {number} uptime_seconds
 * @property {boolean} import_configured  A photo library path is set.
 */

/**
 * One archive in the backups folder (ListBackups). A backup still being
 * written is listed first, with `in_progress` set, no `sha256`, and the size
 * written so far.
 *
 * @typedef {object} Backup
 * @property {string} filename
 * @property {number} size  Bytes.
 * @property {string} created_at
 * @property {string} [sha256]
 * @property {boolean} [in_progress]
 */

/**
 * One applied schema migration (repository.MigrationRecord).
 *
 * @typedef {{ id: number, name: string, applied_at: string }} Migration
 */

/** @typedef {{ status: string, message: string }} StatusMessage */

/** @returns {Promise<SystemStats>} */
export function getStats() {
  return api.get('/api/system/stats');
}

/**
 * One background job's record — GetHealth in api/internal/api/system.go. The
 * timestamps are omitted, not zeroed, when the event has not happened, so
 * "never" and "at the epoch" stay distinguishable.
 *
 * @typedef {object} TaskHealth
 * @property {string} name
 * @property {boolean} healthy  The most recent run succeeded, or none has failed.
 * @property {number} runs
 * @property {number} failures
 * @property {string} [last_run]
 * @property {string} [last_success]
 * @property {string} [last_error]
 * @property {string} [last_error_at]
 */

/**
 * Background-job health: last run / last success / last error per job.
 * Per process — a restart clears it.
 * @returns {Promise<{tasks: TaskHealth[], degraded: number, uptime: number}>}
 */
export function getHealth() {
  return api.get('/api/system/health');
}

/**
 * The last `lines` lines of the server log (100 by default, at most 1000).
 * @param {{ lines?: number }} [params]
 * @returns {Promise<string[]>}
 */
export function getLogs(params = {}) {
  return api.get('/api/system/logs', params);
}

/**
 * Clear the server-side file cache, and recalculate media visibility while at
 * it. `updated_media` counts the media whose visibility changed.
 * @param {string} [pattern]
 * @returns {Promise<{ status: string, cleared_count: number, updated_media: number }>}
 */
export function clearCache(pattern = 'all') {
  return api.request(`/api/system/cache/clear?pattern=${encodeURIComponent(pattern)}`, {
    method: 'POST',
  });
}

/**
 * Start a backup in the background; listBackups shows its progress.
 * @returns {Promise<{ status: string }>}
 */
export function createBackup() {
  return api.post('/api/system/backup');
}

/** @returns {Promise<Backup[]>} */
export function listBackups() {
  return api.get('/api/system/backups');
}

/**
 * Schedule a restore (applied on the next restart). Gated by the account
 * password — replacing all data, including the login password, is destructive.
 * @param {string} filename
 * @param {string} sha256pw - sha256-hex of the account password
 * @returns {Promise<StatusMessage>}
 */
export function restoreBackup(filename, sha256pw) {
  return api.post(`/api/system/backups/${encodeURIComponent(filename)}/restore`, {
    current_name: sha256pw,
  });
}

/**
 * @param {string} filename
 * @returns {Promise<StatusMessage>}
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
 * @typedef {object} BackupUpload
 * @property {string} status
 * @property {string} filename
 * @property {string} sha256
 * @property {string} message
 */

/**
 * Move in — upload a local .tar.gz into the backups folder (staging only; it is
 * NOT applied — the user restores it afterward if they choose). Uses XHR (not the
 * JSON client) so the File streams as the raw body and we get upload progress.
 * @param {File} file
 * @param {(fraction:number)=>void} [onProgress] - 0..1 upload progress
 * @param {string} [expectedChecksum] - optional sha256-hex to verify the upload
 * @returns {Promise<BackupUpload>}
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
      /** @type {Partial<BackupUpload>} */
      let body = {};
      try { body = JSON.parse(xhr.responseText || '{}'); } catch { /* non-JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(/** @type {BackupUpload} */ (body));
      else reject(new Error(body.message || `Upload failed (${xhr.status})`));
    });
    xhr.addEventListener('error', () => reject(new Error('Upload failed')));
    xhr.send(file);
  });
}

/** @returns {Promise<Migration[]>}  Newest first. */
export function getMigrations() {
  return api.get('/api/system/migrations');
}

/**
 * Restart the server process in place (re-exec). Used to apply a scheduled
 * restore, and for general restarts. The server is briefly unavailable.
 * @returns {Promise<StatusMessage>}
 */
export function restartServer() {
  return api.post('/api/system/restart');
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
 * @returns {Promise<{imported: number, skipped: number, errors: string[], items: import('./media.js').Media[]}>}
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
 * @returns {Promise<{current: string, latest: string, update_available: boolean, checked_at?: string, fetched: boolean, error?: string}>}
 */
export function getVersion() {
  return api.get('/api/system/version');
}

/**
 * Re-check the upstream version now, ignoring the 24h server-side cache.
 * `fetched` says whether GitHub actually answered; `error` carries the reason
 * when it didn't.
 * @returns {Promise<{current: string, latest: string, update_available: boolean, checked_at?: string, fetched: boolean, error?: string}>}
 */
export function checkVersionNow() {
  return api.post('/api/system/version/check');
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
