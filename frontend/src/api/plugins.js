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

/**
 * Fetch the preset definitions and the active preset id.
 * @returns {Promise<{presets:Record<string,string[]>, active:string}>}
 */
export function getPresets() {
  return api.get('/api/plugins/presets');
}

/**
 * Replace the plugin membership of a preset.
 * @param {string} id Preset id
 * @param {string[]} pluginIds Plugins the preset should enable
 * @returns {Promise<{presets:Record<string,string[]>, active:string}>}
 */
export function updatePreset(id, pluginIds) {
  return api.put(`/api/plugins/presets/${encodeURIComponent(id)}`, { plugins: pluginIds });
}

/**
 * Apply a preset: set every plugin's enabled state from it (keeping core areas
 * non-empty) and mark it active. Returns the full plugin catalog post-apply.
 * @param {string} id Preset id
 * @returns {Promise<Array<object>>}
 */
export function applyPreset(id) {
  return api.post(`/api/plugins/presets/${encodeURIComponent(id)}/apply`);
}
