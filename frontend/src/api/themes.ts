/**
 * Themes API — theme management.
 *
 * Backend prefix: /api/themes
 */

import { api } from './client.ts';

/**
 * A theme — services.Theme. The preview_* colours are read from the theme's
 * :root block for the admin swatch, and are omitted when the theme does not
 * declare them as plain colour literals.
 */
export interface Theme {
  name: string;
  description: string;
  /** The declared accent. */
  preview_color: string;
  preview_bg?: string;
  preview_surface?: string;
  preview_text?: string;
  preview_border?: string;
  has_dark_mode: boolean;
}

/**
 * Get all available themes.
 *
 * @returns A bare array — the handler serializes the slice directly, with no
 *   envelope object around it.
 */
export function getThemes(): Promise<Theme[]> {
  return api.get('/api/themes');
}

/** Get the currently active theme. */
export function getActiveTheme(): Promise<Theme> {
  return api.get('/api/themes/active');
}

/**
 * Set the active theme.
 *
 * @param name - Theme name to set as active
 */
export function setActiveTheme(name: string): Promise<Theme> {
  return api.put('/api/themes/active', { name });
}

/** Get the system-wide custom CSS. */
export function getCustomCSS(): Promise<{ css: string }> {
  return api.get('/api/themes/custom-css');
}

/**
 * Update the system-wide custom CSS.
 *
 * The server sanitizes what it stores; a save that lost something answers 200
 * with the list of removed constructs, and a clean save answers 204 (`null`
 * here). Callers that ignore the result get the old behavior.
 */
export function updateCustomCSS(css: string): Promise<{ css_warnings?: string[] } | null> {
  return api.put('/api/themes/custom-css', { css });
}
