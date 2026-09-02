/**
 * Media API — file upload and media library.
 *
 * Backend prefix: /api/media
 */

import { api } from './client.js';
import { captureVideoPoster, isVideoFile } from '../utils/videoPoster.js';

/**
 * List media items.
 *
 * `paths` switches the endpoint out of listing mode: it resolves exactly the
 * given content paths ("/YYYY/MM/file") and ignores the paging keys, which is
 * how a caller that already knows which media it wants — the post editor, say —
 * avoids fishing for them in a page of the library. At most 500 per request.
 *
 * `orphaned_only` is deliberately absent: the handler reads page, per_page,
 * file_type, folder and paths and nothing else, so any other key is sent and
 * dropped.
 *
 * @param {{ page?: number, per_page?: number, file_type?: string, folder?: string, paths?: string[] }} [params]
 * @returns {Promise<{ media: object[], total, page, per_page, pages }>}
 */
export function listMedia(params = {}) {
  return api.get('/api/media', params);
}

// Paths ride in the query string, and a photo essay can reference more of them
// than one URL should carry, so a lookup goes out in batches of this size.
const MEDIA_PATH_BATCH = 100;

/**
 * Resolve the media records at the given content paths, keyed by path.
 *
 * This is the lookup a post editor wants: a post's images are what its content
 * references, which is neither what `media.post_id` records nor what any one
 * page of the library happens to contain.
 *
 * @param {string[]} paths  Content paths, e.g. "/2026/03/1712345678_shot.jpg"
 * @returns {Promise<Record<string, object>>}
 */
export async function getMediaByPaths(paths) {
  const unique = [...new Set(paths.filter(Boolean))];
  const batches = [];
  for (let i = 0; i < unique.length; i += MEDIA_PATH_BATCH) {
    batches.push(listMedia({ paths: unique.slice(i, i + MEDIA_PATH_BATCH) }));
  }
  /** @type {Record<string, object>} */
  const byPath = {};
  for (const result of await Promise.all(batches)) {
    for (const m of result.media || []) if (m.path) byPath[m.path] = m;
  }
  return byPath;
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
 *
 * A video is accompanied by a poster frame captured here in the browser — the
 * server cannot decode video, so this is the only chance to give the file a
 * thumbnail. Capture failures are silent and leave the video poster-less.
 *
 * @param {File}    file
 * @param {{ alt_text?, caption?, post_id? }} [meta]
 * @returns {Promise<object>}
 */
export async function uploadMedia(file, meta = {}) {
  const form = new FormData();
  form.append('file', file);
  if (meta.alt_text) form.append('alt_text', meta.alt_text);
  if (meta.caption)  form.append('caption', meta.caption);
  if (meta.post_id)  form.append('post_id', String(meta.post_id));

  if (isVideoFile(file)) {
    const poster = await captureVideoPoster(file);
    if (poster) form.append('poster', poster, 'poster.jpg');
  }

  return api.upload('/api/media/upload', form);
}

/**
 * Store a poster frame for an existing video, backfilling one that was
 * uploaded before posters existed or ingested outside the admin UI.
 * @param {number} id
 * @param {Blob}   poster  JPEG frame
 * @returns {Promise<object>} Updated media object
 */
export function setVideoPoster(id, poster) {
  const form = new FormData();
  form.append('poster', poster, 'poster.jpg');
  return api.upload(`/api/media/${id}/poster`, form);
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
 * Update media metadata (alt_text, caption, post_id, metadata).
 *
 * `metadata` is the EXIF map, replaced wholesale — the visual editor's per-image
 * EXIF panel saves through here (UpdateMediaRequest in api/internal/api/media.go
 * has always read it).
 *
 * @param {number} id
 * @param {{ alt_text?: string, caption?: string, post_id?: number,
 *           metadata?: Record<string, any> }} data
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

/**
 * Invalidate every derived image: the server purges the variant tree, rolls the
 * thumbnail generation token and regenerates the most recent uploads in the
 * background. There is nothing to opt out of — a rebuild discards every file.
 * @returns {Promise<{ message: string, stats: { generation: string, purged: number, legacy: number, prewarming: number } }>}
 */
export function rebuildThumbnails() {
  return api.post("/api/media/thumbnails/rebuild");
}

