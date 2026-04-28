/**
 * Themes API — theme management.
 *
 * Backend prefix: /api/themes
 */

import { api } from './client.js';

/**
 * Get all available themes.
 * @returns {Promise<Array>}
 */
export function getThemes() {
  return api.get('/api/themes');
}

/**
 * Get the currently active theme.
 * @returns {Promise<object>}
 */
export function getActiveTheme() {
  return api.get('/api/themes/active');
}

/**
 * Set the active theme.
 * @param {string} name Theme name to set as active
 * @returns {Promise<object>}
 */
export function setActiveTheme(name) {
  return api.put('/api/themes/active', { name });
}
