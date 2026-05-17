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
 * @param {{ file_type? }} [params]
 * @returns {Promise<{ folders: { year, month, path }[] }>}
 */
export function getMediaFolders(params = {}) {
  return api.get('/api/media/folders', params);
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
 * Rename a media item.
 * @param {number} id
 * @param {string} newFilename
 * @returns {Promise<object>}
 */
export function renameMedia(id, newFilename) {
  return api.post(`/api/media/${id}/rename`, { new_filename: newFilename });
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

/**
 * Analyze an existing media item with AI (Gemini) to suggest title, tags, and excerpt.
 * @param {number} id
 * @returns {Promise<{ title: string|null, tags: string[], excerpt: string|null }>}
 */
export function analyzeMedia(id) {
  return api.post(`/api/media/${id}/analyze`);
}

/**
 * Analyze a stored media file by its URL path (e.g. "/2024/08/photo.jpg").
 * @param {string} path
 * @returns {Promise<{ title: string|null, tags: string[], excerpt: string|null }>}
 */
export function analyzeMediaByPath(path) {
  return api.post('/api/media/analyze-path', { path });
}

/**
 * Re-extract EXIF data from the original file on disk.
 * Overwrites any manually edited EXIF with camera-extracted values.
 * @param {number} id
 * @returns {Promise<object>} Updated media object
 */
export function reextractMediaEXIF(id) {
  return api.post(`/api/media/${id}/reextract`, {});
}

/**
 * Write EXIF fields back to the media file and update the DB.
 * Only alphanumeric and space characters are accepted.
 * @param {number} id
 * @param {Record<string, string>} fields  e.g. { Make: "Canon", Model: "EOS R5" }
 * @returns {Promise<object>} Updated media object
 */
export function updateMediaEXIF(id, fields) {
  return api.put(`/api/media/${id}/exif`, fields);
}

/**
 * Revert media EXIF metadata to the original values captured at upload.
 * @param {number} id
 * @returns {Promise<object>} Updated media object
 */
export function revertMediaEXIF(id) {
  return api.post(`/api/media/${id}/revert-exif`, {});
}
