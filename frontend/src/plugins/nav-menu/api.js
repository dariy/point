import { api } from '../../api/client.js';

/**
 * Admin: get current nav menu config (mode + custom items).
 *
 * `tag_items` is the tags-mode tree, sent whatever the active mode is so the
 * editor can preview a mode switch before saving — see GetAdminNavMenu in
 * api/internal/api/nav_menu.go.
 *
 * @returns {Promise<{
 *   mode: string,
 *   items: object[],
 *   custom_markdown: string,
 *   inline_max: number,
 *   more_title: string,
 *   tag_items: object[],
 * }>}
 */
export function getAdminNavMenu() {
  return api.get('/api/nav-menu');
}

/**
 * Admin: save nav menu config.
 *
 * @param {{
 *   mode: string,
 *   items: object[],
 *   custom_markdown?: string,
 *   inline_max?: number,
 *   more_title?: string,
 * }} data
 * @returns {Promise<object>}
 */
export function updateAdminNavMenu(data) {
  return api.put('/api/nav-menu', data);
}
