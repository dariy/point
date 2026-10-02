/**
 * System API — stats, logs, cache, backups.
 *
 * Backend prefix: /api/system
 */

import { api } from './client.ts';
import type { Media } from './media.ts';

/** The admin dashboard's counters — GetStats in api/internal/api/system.go. */
export interface SystemStats {
  published_posts: number;
  total_posts: number;
  total_tags: number;
  total_media: number;
  storage_used_mb: number;
  /** Absent when no quota is configured. */
  storage_quota_mb?: number;
  uptime_seconds: number;
  /** A photo library path is set. */
  import_configured: boolean;
}

/**
 * One archive in the backups folder (ListBackups). A backup still being
 * written is listed first, with `in_progress` set, no `sha256`, and the size
 * written so far.
 */
export interface Backup {
  filename: string;
  /** Bytes. */
  size: number;
  created_at: string;
  sha256?: string;
  in_progress?: boolean;
}

/** One applied schema migration (repository.MigrationRecord). */
export interface Migration {
  id: number;
  name: string;
  applied_at: string;
}

export interface StatusMessage {
  status: string;
  message: string;
}

export function getStats(): Promise<SystemStats> {
  return api.get('/api/system/stats');
}

/**
 * One background job's record — GetHealth in api/internal/api/system.go. The
 * timestamps are omitted, not zeroed, when the event has not happened, so
 * "never" and "at the epoch" stay distinguishable.
 */
export interface TaskHealth {
  name: string;
  /** The most recent run succeeded, or none has failed. */
  healthy: boolean;
  runs: number;
  failures: number;
  last_run?: string;
  last_success?: string;
  last_error?: string;
  last_error_at?: string;
}

/**
 * Background-job health: last run / last success / last error per job.
 * Per process — a restart clears it.
 * `backup` reads the disk, so it survives a restart: managed is BACKUP_MANAGED,
 * enabled is whether scheduled backups run, last_backup the newest archive.
 */
export function getHealth(): Promise<{
  tasks: TaskHealth[];
  degraded: number;
  uptime: number;
  backup?: { managed: boolean, enabled: boolean, last_backup?: string };
}> {
  return api.get('/api/system/health');
}

export interface JobView {
  id: number;
  kind: string;
  /** ids from the payload; the raw payload is not sent */
  refs?: Record<string, number>;
  state: 'queued' | 'running' | 'done' | 'failed';
  attempts: number;
  max_attempts: number;
  next_run_at: string;
  last_error?: string;
}

/**
 * The durable job queue: a count per state, and the queued, running and
 * failed jobs (newest first).
 */
export function getJobs(): Promise<{ counts: Record<string, number>, jobs: JobView[] }> {
  return api.get('/api/system/jobs');
}

/** Set a failed job back to queued so that it runs again. */
export function retryJob(id: number): Promise<{ status: string }> {
  return api.post(`/api/system/jobs/${id}/retry`);
}

/** Remove every failed job. Only this manual action removes failed jobs. */
export function clearFailedJobs(): Promise<{ deleted: number }> {
  return api.post("/api/system/jobs/clear-failed");
}

/** The last `lines` lines of the server log (100 by default, at most 1000). */
export function getLogs(params: { lines?: number } = {}): Promise<string[]> {
  return api.get('/api/system/logs', params);
}

/**
 * Clear the server-side file cache, and recalculate media visibility while at
 * it. `updated_media` counts the media whose visibility changed.
 */
export function clearCache(pattern = 'all'): Promise<{
  status: string;
  cleared_count: number;
  updated_media: number;
}> {
  return api.request(`/api/system/cache/clear?pattern=${encodeURIComponent(pattern)}`, {
    method: 'POST',
  });
}

/** Start a backup in the background; listBackups shows its progress. */
export function createBackup(): Promise<{ status: string }> {
  return api.post('/api/system/backup');
}

export function listBackups(): Promise<Backup[]> {
  return api.get('/api/system/backups');
}

/**
 * Schedule a restore (applied on the next restart). Gated by the account
 * password — replacing all data, including the login password, is destructive.
 *
 * @param sha256pw - sha256-hex of the account password
 */
export function restoreBackup(filename: string, sha256pw: string): Promise<StatusMessage> {
  return api.post(`/api/system/backups/${encodeURIComponent(filename)}/restore`, {
    current_name: sha256pw,
  });
}

export function deleteBackup(filename: string): Promise<StatusMessage> {
  return api.delete(`/api/system/backups/${encodeURIComponent(filename)}`);
}

/**
 * Move out — step 1: re-verify the password and get a one-time download token.
 *
 * @param sha256pw - sha256-hex of the account password
 */
export function authorizeBackupDownload(
  filename: string,
  sha256pw: string,
): Promise<{ token: string }> {
  return api.post(`/api/system/backups/${encodeURIComponent(filename)}/authorize-download`, {
    current_name: sha256pw,
  });
}

/**
 * Move out — step 2: the URL a browser navigates to in order to stream the
 * archive (supports HTTP range/resume; not fetched through the JSON client).
 *
 * @param token - one-time token from authorizeBackupDownload
 */
export function backupDownloadUrl(filename: string, token: string): string {
  return `/api/system/backups/${encodeURIComponent(filename)}/download?token=${encodeURIComponent(token)}`;
}

export interface BackupUpload {
  status: string;
  filename: string;
  sha256: string;
  message: string;
}

/**
 * Move in — upload a local .tar.gz into the backups folder (staging only; it is
 * NOT applied — the user restores it afterward if they choose). Uses XHR (not the
 * JSON client) so the File streams as the raw body and we get upload progress.
 *
 * @param onProgress - 0..1 upload progress
 * @param expectedChecksum - optional sha256-hex to verify the upload
 */
export function uploadBackupArchive(
  file: File,
  onProgress?: (fraction: number) => void,
  expectedChecksum?: string,
): Promise<BackupUpload> {
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
      let body: Partial<BackupUpload> = {};
      try { body = JSON.parse(xhr.responseText || '{}'); } catch { /* non-JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as BackupUpload);
      else reject(new Error(body.message || `Upload failed (${xhr.status})`));
    });
    xhr.addEventListener('error', () => reject(new Error('Upload failed')));
    xhr.send(file);
  });
}

/** @returns Newest first. */
export function getMigrations(): Promise<Migration[]> {
  return api.get('/api/system/migrations');
}

/**
 * Restart the server process in place (re-exec). Used to apply a scheduled
 * restore, and for general restarts. The server is briefly unavailable.
 */
export function restartServer(): Promise<StatusMessage> {
  return api.post('/api/system/restart');
}

/**
 * Geocode city/country descendant tags that have no coordinates yet.
 * Uses Nominatim (OpenStreetMap). This can be slow — rate-limited to 1 req/sec.
 */
export function updateMapCoords(): Promise<{
  status: string;
  updated_count: number;
  message: string;
  errors?: string[];
}> {
  return api.post('/api/system/map/update-coords');
}

/**
 * List folders and importable files in the external photo library.
 *
 * @param path - Relative path within the library (default root)
 */
export function getPhotoLibraryContents(path = ''): Promise<{
  path: string;
  folders: string[];
  files: Array<{ name: string, path: string }>;
}> {
  return api.get('/api/system/photo-library', { path });
}

/**
 * Import specific files from the external photo library into site media.
 *
 * @param paths - Relative paths within the library
 */
export function importSelectedPhotos(paths: string[]): Promise<{
  imported: number;
  skipped: number;
  errors: string[];
  items: Media[];
}> {
  return api.post('/api/system/photo-library/import', { paths });
}

/**
 * Get the URL to preview a file from the external photo library.
 *
 * @param path - Relative path within the library
 */
export function getPhotoLibraryFileUrl(path: string): string {
  return `/api/system/photo-library/file?path=${encodeURIComponent(path)}`;
}

/**
 * Check current and latest available version.
 * Result is cached server-side for 24 hours.
 */
export function getVersion(): Promise<{
  current: string;
  latest: string;
  update_available: boolean;
  checked_at?: string;
  fetched: boolean;
  error?: string;
}> {
  return api.get('/api/system/version');
}

/**
 * Re-check the upstream version now, ignoring the 24h server-side cache.
 * `fetched` says whether GitHub actually answered; `error` carries the reason
 * when it didn't.
 */
export function checkVersionNow(): Promise<{
  current: string;
  latest: string;
  update_available: boolean;
  checked_at?: string;
  fetched: boolean;
  error?: string;
}> {
  return api.post('/api/system/version/check');
}

/** Get disk usage for the data directory. */
export function getDiskInfo(): Promise<{ total: number, free: number, used: number }> {
  return api.get('/api/system/disk');
}

/**
 * Audit internal post links: reports links on publicly reachable posts whose
 * target anonymous visitors cannot open (missing, unpublished, hidden by tag).
 */
export function auditPostLinks(): Promise<{
  issues: Array<{
    source_id: number;
    source_slug: string;
    source_title: string;
    target_slug: string;
    reason: string;
  }>;
  scanned: number;
}> {
  return api.get('/api/system/audit/post-links');
}
