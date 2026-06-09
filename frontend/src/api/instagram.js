/**
 * Instagram API — connection status and OAuth management.
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
