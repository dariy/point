/**
 * Media API — file upload and media library.
 *
 * Backend prefix: /api/media
 */

import { api } from './client.js';

/**
 * List media items.
 * @param {{ page?, per_page?, file_type?, folder?, orphaned_only? }} [params]
 * @returns {Promise<{ media: object[], total, page, per_page, pages }>}
 */
export function listMedia(params = {}) {
  return api.get('/api/media', params);
}

/**
 * Get distinct year/month folders from the media library.
 * @returns {Promise<{ folders: { year, month, path }[] }>}
 */
export function getMediaFolders() {
  return api.get('/api/media/folders');
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
 * Upload a single file.
 * @param {File}    file
 * @param {{ alt_text?, caption?, post_id? }} [meta]
 * @returns {Promise<object>}
 */
export function uploadMedia(file, meta = {}) {
  const form = new FormData();
  form.append('file', file);
  if (meta.alt_text) form.append('alt_text', meta.alt_text);
  if (meta.caption)  form.append('caption', meta.caption);
  if (meta.post_id)  form.append('post_id', String(meta.post_id));
  return api.upload('/api/media/upload', form);
}

/**
 * Upload multiple files.
 * @param {File[]} files
 * @param {number} [postId]
 * @returns {Promise<{ uploaded: object[], failed: object[], total_uploaded, total_failed }>}
 */
export function uploadMultiple(files, postId) {
  const form = new FormData();
  files.forEach((f) => form.append('files', f));
  if (postId) form.append('post_id', String(postId));
  return api.upload('/api/media/upload/multiple', form);
}

/**
 * Update media metadata (alt_text, caption, post_id).
 * @param {number} id
 * @param {{ alt_text?, caption?, post_id? }} data
 * @returns {Promise<object>}
 */
export function updateMedia(id, data) {
  return api.patch(`/api/media/${id}`, data);
}

/**
 * Delete a media item.
 * @param {number} id
 * @returns {Promise<object>}
 */
export function deleteMedia(id) {
  return api.delete(`/api/media/${id}`);
}

/**
 * Get storage statistics.
 * @returns {Promise<object>}
 */
export function getMediaStats() {
  return api.get('/api/media/stats');
}

/**
 * List orphaned media files.
 * @returns {Promise<{ media: object[], total, total_size_bytes }>}
 */
export function getOrphanedMedia() {
  return api.get('/api/media/orphaned');
}

/**
 * Delete all orphaned media files.
 * @returns {Promise<object>}
 */
export function deleteOrphanedMedia() {
  return api.delete('/api/media/orphaned');
}
