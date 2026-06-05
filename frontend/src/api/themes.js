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

/**
 * Get the system-wide custom CSS.
 * @returns {Promise<object>} { css: string }
 */
export function getCustomCSS() {
  return api.get('/api/themes/custom-css');
}

/**
 * Update the system-wide custom CSS.
 * @param {string} css
 * @returns {Promise<void>}
 */
export function updateCustomCSS(css) {
  return api.put('/api/themes/custom-css', { css });
}
