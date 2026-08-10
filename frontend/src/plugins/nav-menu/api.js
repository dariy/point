import { api } from '../../api/client.js';

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
