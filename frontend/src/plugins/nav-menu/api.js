import { api } from '../../api/client.js';

/**
 * Navigation menu: hierarchical tag tree scoped to the current user's auth level.
 * Guests receive only public/visible tags; admins receive all tags.
 *
 * @returns {Promise<{ menu: object[] }>}
 */
export function getNavMenu() {
  return api.get('/api/pages/nav');
}

/**
 * Admin: get current nav menu config (mode + custom items).
 *
 * @returns {Promise<{ mode: string, items: object[] }>}
 */
export function getAdminNavMenu() {
  return api.get('/api/nav-menu');
}

/**
 * Admin: save nav menu config.
 *
 * @param {{ mode: string, items: object[] }} data
 * @returns {Promise<{ mode: string, items: object[] }>}
 */
export function updateAdminNavMenu(data) {
  return api.put('/api/nav-menu', data);
}
