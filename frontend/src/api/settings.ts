/**
 * Settings API — blog configuration.
 *
 * Backend prefix: /api/settings
 */

import { api } from './client.ts';

/**
 * The settings map. Every value is a string on the wire — the store is a
 * key/value table — so a boolean arrives as "true"/"false" and a number as its
 * digits, and each reader parses what it needs.
 */
export type Settings = Record<string, string>;

/** Get public blog settings (no auth required). */
export function getPublicSettings(): Promise<Settings> {
  return api.get('/api/settings/public');
}

/** Get all settings (admin, requires auth). */
export function getAllSettings(): Promise<Settings> {
  return api.get('/api/settings');
}

/**
 * Update settings (admin, requires auth).
 *
 * @param data - Key-value setting pairs
 */
export function updateSettings(data: Settings): Promise<Settings> {
  return api.put('/api/settings', data);
}
