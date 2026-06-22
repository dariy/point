/**
 * Plugins API — admin plugin management.
 *
 * Backend prefix: /api/plugins (admin-only). Unlike the enabled-only client
 * manifest in window.__PLUGINS__, these endpoints list the full catalog
 * (enabled and disabled) so the admin can toggle each plugin.
 */

import { api } from './client.js';

/**
 * List the full plugin catalog with each plugin's enabled state.
 * @returns {Promise<Array<{id:string,type:string,slot?:string,routes?:string[],enabled:boolean,default_enabled:boolean}>>}
 */
export function getPlugins() {
  return api.get('/api/plugins');
}

/**
 * Enable or disable a plugin.
 * @param {string} id Plugin id
 * @param {boolean} enabled Desired enabled state
 * @returns {Promise<object>} The updated plugin view
 */
export function setPluginEnabled(id, enabled) {
  return api.patch(`/api/plugins/${encodeURIComponent(id)}`, { enabled });
}
