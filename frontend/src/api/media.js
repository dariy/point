/**
 * Media API — file upload and media library.
 *
 * Backend prefix: /api/media
 */

import { api } from './client.js';

/**
 * List media items.
 * @param {{ page?: number, per_page?: number, type?: string, q?: string }} [params]
 * @returns {Promise<{ items: object[], total: number, page: number, per_page: number, pages: number }>}
 */
export function listMedia(params = {}) {
  return api.get('/api/media', params);
}

/**
 * Get a single media item by ID.
 * @param {number} id
 * @returns {Promise<object>}
 */
export function getMedia(id) {
  return api.get(`/api/media/${id}`);
}

/**
 * Upload a file. The `file` argument must be a File object from an <input>.
 * An optional `caption` string may be attached.
 *
 * @param {File}   file
 * @param {string} [caption]
 * @returns {Promise<object>}
 */
export function uploadMedia(file, caption = '') {
  const form = new FormData();
  form.append('file', file);
  if (caption) form.append('caption', caption);
  return api.upload('/api/media', form);
}

/**
 * Update media metadata (caption, alt_text).
 * @param {number} id
 * @param {{ caption?: string, alt_text?: string }} data
 * @returns {Promise<object>}
 */
export function updateMedia(id, data) {
  return api.put(`/api/media/${id}`, data);
}

/**
 * Delete a media item.
 * @param {number} id
 * @returns {Promise<null>}
 */
export function deleteMedia(id) {
  return api.delete(`/api/media/${id}`);
}
