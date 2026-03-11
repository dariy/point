/**
 * Offline API client for Point.
 */
import { api } from './client.js';

/**
 * Get offline stats from the server.
 */
export async function getOfflineStats() {
  const resp = await api.get('/api/system/offline/stats');
  return resp.data;
}

/**
 * Get full offline snapshot from the server.
 */
export async function getOfflineSnapshot() {
  const resp = await api.get('/api/system/offline/snapshot');
  return resp.data;
}
