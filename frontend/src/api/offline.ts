/**
 * Offline API client for Point.
 */
import { api } from './client.ts';
import type { OfflineSnapshot } from '../utils/offlineStore.ts';

/**
 * Get offline stats from the server.
 */
export function getOfflineStats() {
  return api.get('/api/system/offline/stats');
}

/**
 * Get full offline snapshot from the server.
 */
export function getOfflineSnapshot() {
  return api.get<OfflineSnapshot>('/api/system/offline/snapshot');
}
