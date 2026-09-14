/**
 * Plugins API — admin plugin management.
 *
 * Backend prefix: /api/plugins (admin-only). Unlike the enabled-only client
 * manifest in window.__PLUGINS__, these endpoints list the full catalog
 * (enabled and disabled) so the admin can toggle each plugin.
 */

import { api } from './client.js';

/**
 * One plugin of the admin catalog — pluginView in api/internal/api/plugins.go.
 * `slot_rule` is the cardinality of the plugin's slot ("0+", "0-1", "1", "1+"),
 * and `locked` marks a plugin its slot may not be left without.
 *
 * @typedef {object} PluginView
 * @property {string} id
 * @property {string} [title]
 * @property {PluginType} type
 * @property {string} [slot]
 * @property {string} [slot_rule]
 * @property {string[]} [routes]
 * @property {boolean} enabled
 * @property {boolean} default_enabled
 * @property {boolean} [locked]
 */

/**
 * List the full plugin catalog with each plugin's enabled state.
 * @returns {Promise<PluginView[]>}
 */
export function getPlugins() {
  return api.get('/api/plugins');
}

/**
 * Enable or disable a plugin.
 * @param {string} id Plugin id
 * @param {boolean} enabled Desired enabled state
 * @returns {Promise<PluginView>} The updated plugin view
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
 * Apply a preset: set every plugin's enabled state from it (corrected to satisfy
 * the slot rules) and mark it active. Returns the full plugin catalog post-apply.
 * @param {string} id Preset id
 * @returns {Promise<PluginView[]>}
 */
export function applyPreset(id) {
  return api.post(`/api/plugins/presets/${encodeURIComponent(id)}/apply`);
}
