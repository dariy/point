/**
 * Settings API — blog configuration.
 *
 * Backend prefix: /api/settings
 */

import { api } from './client.js';

/**
 * The settings map. Every value is a string on the wire — the store is a
 * key/value table — so a boolean arrives as "true"/"false" and a number as its
 * digits, and each reader parses what it needs.
 *
 * @typedef {Record<string, string>} Settings
 */

/**
 * Get public blog settings (no auth required).
 * @returns {Promise<Settings>}
 */
export function getPublicSettings() {
  return api.get('/api/settings/public');
}

/**
 * Get all settings (admin, requires auth).
 * @returns {Promise<Settings>}
 */
export function getAllSettings() {
  return api.get('/api/settings');
}

/**
 * Update settings (admin, requires auth).
 * @param {Settings} data  Key-value setting pairs
 * @returns {Promise<Settings>}
 */
export function updateSettings(data) {
  return api.put('/api/settings', data);
}
