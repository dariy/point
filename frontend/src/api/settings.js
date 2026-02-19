/**
 * Settings API — blog configuration.
 *
 * Backend prefix: /api/settings
 */

import { api } from './client.js';

/**
 * Get public blog settings (no auth required).
 * @returns {Promise<object>}
 */
export function getPublicSettings() {
  return api.get('/api/settings/public');
}

/**
 * Get all settings (admin, requires auth).
 * @returns {Promise<object>}
 */
export function getAllSettings() {
  return api.get('/api/settings');
}

/**
 * Update settings (admin, requires auth).
 * @param {object} data  Key-value setting pairs
 * @returns {Promise<object>}
 */
export function updateSettings(data) {
  return api.put('/api/settings', data);
}
