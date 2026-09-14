/**
 * Themes API — theme management.
 *
 * Backend prefix: /api/themes
 */

import { api } from './client.js';

/**
 * A theme — services.Theme. The preview_* colours are read from the theme's
 * :root block for the admin swatch, and are omitted when the theme does not
 * declare them as plain colour literals.
 *
 * @typedef {object} Theme
 * @property {string} name
 * @property {string} description
 * @property {string} preview_color  The declared accent.
 * @property {string} [preview_bg]
 * @property {string} [preview_surface]
 * @property {string} [preview_text]
 * @property {string} [preview_border]
 * @property {boolean} has_dark_mode
 */

/**
 * Get all available themes.
 * @returns {Promise<Theme[]>} A bare array — the handler serializes the slice
 *   directly, with no envelope object around it.
 */
export function getThemes() {
  return api.get('/api/themes');
}

/**
 * Get the currently active theme.
 * @returns {Promise<Theme>}
 */
export function getActiveTheme() {
  return api.get('/api/themes/active');
}

/**
 * Set the active theme.
 * @param {string} name Theme name to set as active
 * @returns {Promise<Theme>}
 */
export function setActiveTheme(name) {
  return api.put('/api/themes/active', { name });
}

/**
 * Get the system-wide custom CSS.
 * @returns {Promise<{ css: string }>}
 */
export function getCustomCSS() {
  return api.get('/api/themes/custom-css');
}

/**
 * Update the system-wide custom CSS.
 *
 * The server sanitizes what it stores; a save that lost something answers 200
 * with the list of removed constructs, and a clean save answers 204 (`null`
 * here). Callers that ignore the result get the old behavior.
 *
 * @param {string} css
 * @returns {Promise<{ css_warnings?: string[] }|null>}
 */
export function updateCustomCSS(css) {
  return api.put('/api/themes/custom-css', { css });
}
