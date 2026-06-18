/**
 * Instagram API — connection status, OAuth management, and account import.
 *
 * Backend prefix: /api/instagram
 */

import { api } from './client.js';

/**
 * Get Instagram connection status (admin, requires auth).
 * @returns {Promise<{ connected: boolean, username: string, token_expires_at: string, enabled: boolean }>}
 */
export function getInstagramStatus() {
  return api.get('/api/instagram/status');
}

/**
 * Disconnect Instagram account (clears stored credentials).
 * @returns {Promise<null>}
 */
export function disconnectInstagram() {
  return api.post('/api/instagram/disconnect');
}

/**
 * Trigger a background import of all Instagram posts into Point as drafts.
 * Idempotent — existing posts (matched by instagram_id or instagram_media_id) are skipped.
 * @returns {Promise<{ message: string }>}
 */
export function triggerInstagramImport() {
  return api.post('/api/instagram/import');
}

/**
 * Get the current or last-run import status.
 * @returns {Promise<{
 *   running: boolean,
 *   imported: number,
 *   skipped: number,
 *   errors: number,
 *   started_at?: string,
 *   finished_at?: string,
 *   progress?: { total: number, done: number, imported: number, skipped: number, errors: number, current: string },
 *   error?: string,
 *   messages?: string[]
 * }>}
 */
export function getInstagramImportStatus() {
  return api.get('/api/instagram/import/status');
}
