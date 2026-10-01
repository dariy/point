/**
 * Plugins API — admin plugin management.
 *
 * Backend prefix: /api/plugins (admin-only). Unlike the enabled-only client
 * manifest in window.__PLUGINS__, these endpoints list the full catalog
 * (enabled and disabled) so the admin can toggle each plugin.
 */

import { api } from './client.ts';

/**
 * One plugin of the admin catalog — pluginView in api/internal/api/plugins.go.
 * `slot_rule` is the cardinality of the plugin's slot ("0+", "0-1", "1", "1+"),
 * and `locked` marks a plugin its slot may not be left without.
 */
export interface PluginView {
  id: string;
  title?: string;
  type: PluginType;
  slot?: string;
  slot_rule?: string;
  routes?: string[];
  enabled: boolean;
  default_enabled: boolean;
  locked?: boolean;
}

/** List the full plugin catalog with each plugin's enabled state. */
export function getPlugins(): Promise<PluginView[]> {
  return api.get('/api/plugins');
}

/**
 * Enable or disable a plugin.
 *
 * @param id - Plugin id
 * @param enabled - Desired enabled state
 * @returns The updated plugin view
 */
export function setPluginEnabled(id: string, enabled: boolean): Promise<PluginView> {
  return api.patch(`/api/plugins/${encodeURIComponent(id)}`, { enabled });
}

/** Fetch the preset definitions and the active preset id. */
export function getPresets(): Promise<{ presets: Record<string, string[]>, active: string }> {
  return api.get('/api/plugins/presets');
}

/**
 * Replace the plugin membership of a preset.
 *
 * @param id - Preset id
 * @param pluginIds - Plugins the preset should enable
 */
export function updatePreset(
  id: string,
  pluginIds: string[],
): Promise<{ presets: Record<string, string[]>, active: string }> {
  return api.put(`/api/plugins/presets/${encodeURIComponent(id)}`, { plugins: pluginIds });
}

/**
 * Apply a preset: set every plugin's enabled state from it (corrected to satisfy
 * the slot rules) and mark it active. Returns the full plugin catalog post-apply.
 *
 * @param id - Preset id
 */
export function applyPreset(id: string): Promise<PluginView[]> {
  return api.post(`/api/plugins/presets/${encodeURIComponent(id)}/apply`);
}
