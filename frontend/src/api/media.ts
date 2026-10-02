/**
 * Media API — file upload and media library.
 *
 * Backend prefix: /api/media
 */

import { api } from './client.ts';
import { captureVideoPoster, isVideoFile } from '../utils/videoPoster.ts';

/** A media library record — mediaToResponse in api/internal/api/mappers.go. */
export interface Media {
  id: number;
  filename: string;
  /** Public path, e.g. "/2026/03/ts_file.jpg". */
  path: string;
  /** Null on a video with no poster yet, which MediaBrowser reads as "offer to capture one". */
  thumbnail_path: string | null;
  /** Lower-cased: 'image' | 'video' | 'audio' | … */
  file_type: string;
  mime_type: string;
  /** Bytes. */
  file_size: number;
  width: number | null;
  height: number | null;
  post_id: number | null;
  uploaded_at: string;
  alt_text: string | null;
  caption: string | null;
  /** The EXIF map, as edited. */
  metadata: Record<string, any> | null;
  /** As captured at upload. */
  original_metadata: Record<string, any> | null;
  is_public: boolean;
  /** Admin responses only: set on an HEVC video that this install cannot convert. */
  hevc_note?: boolean;
}

/**
 * List media items.
 *
 * `paths` switches the endpoint out of listing mode: it resolves exactly the
 * given content paths ("/YYYY/MM/file") and ignores the paging keys, which is
 * how a caller that already knows which media it wants — the post editor, say —
 * avoids fishing for them in a page of the library. At most 500 per request.
 *
 * `orphaned_only` is deliberately absent: the handler reads page, per_page,
 * file_type, filename, folder and paths and nothing else, so any other key is
 * sent and dropped.
 */
export function listMedia(params: {
  page?: number;
  per_page?: number;
  file_type?: string;
  filename?: string;
  folder?: string;
  paths?: string[];
} = {}): Promise<{ media: Media[], total: number, page: number, per_page: number, pages: number }> {
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
 * @param paths - Content paths, e.g. "/2026/03/1712345678_shot.jpg"
 */
export async function getMediaByPaths(paths: string[]): Promise<Record<string, Media>> {
  const unique = [...new Set(paths.filter(Boolean))];
  const batches = [];
  for (let i = 0; i < unique.length; i += MEDIA_PATH_BATCH) {
    batches.push(listMedia({ paths: unique.slice(i, i + MEDIA_PATH_BATCH) }));
  }
  const byPath: Record<string, Media> = {};
  for (const result of await Promise.all(batches)) {
    for (const m of result.media || []) if (m.path) byPath[m.path] = m;
  }
  return byPath;
}

/** Get distinct year/month folders from the media library. */
export function getMediaFolders(params: { file_type?: string } = {}): Promise<{
  folders: { year: string, month: string, path: string }[];
}> {
  return api.get('/api/media/folders', params);
}

/** Get a single media item by ID. */
export function getMedia(id: number): Promise<Media> {
  return api.get(`/api/media/${id}`);
}

/**
 * Upload a single file.
 *
 * A video is accompanied by a poster frame captured here in the browser — the
 * server cannot decode video, so this is the only chance to give the file a
 * thumbnail. Capture failures are silent and leave the video poster-less.
 */
export async function uploadMedia(
  file: File,
  meta: { alt_text?: string, caption?: string, post_id?: number } = {},
): Promise<Media> {
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
 *
 * @param poster - JPEG frame
 * @returns Updated media object
 */
export function setVideoPoster(id: number, poster: Blob): Promise<Media> {
  const form = new FormData();
  form.append('poster', poster, 'poster.jpg');
  return api.upload(`/api/media/${id}/poster`, form);
}

/** Upload multiple files. */
export function uploadMultiple(
  files: File[],
  postId?: number,
): Promise<{
  uploaded: Media[];
  failed: Array<{ filename: string, error: string }>;
  total_uploaded: number;
  total_failed: number;
}> {
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
 */
export function updateMedia(
  id: number,
  data: { alt_text?: string, caption?: string, post_id?: number, metadata?: Record<string, any> },
): Promise<Media> {
  return api.patch(`/api/media/${id}`, data);
}

/** Rename a media item. */
export function renameMedia(id: number, newFilename: string): Promise<Media> {
  return api.post(`/api/media/${id}/rename`, { new_filename: newFilename });
}

/** Delete a media item. */
export function deleteMedia(id: number): Promise<null> {
  return api.delete(`/api/media/${id}`);
}

/** Get storage statistics — services.StorageStats. */
export function getMediaStats(): Promise<{
  total_bytes: number;
  total_files: number;
  image_count: number;
  video_count: number;
  audio_count: number;
  other_count: number;
}> {
  return api.get('/api/media/stats');
}

/** List orphaned media files. */
export function getOrphanedMedia(): Promise<{
  media: Media[];
  total: number;
  total_size_bytes: number;
}> {
  return api.get('/api/media/orphaned');
}

/** Delete all orphaned media files. */
export function deleteOrphanedMedia(): Promise<{
  message: string;
  deleted_count: number;
  freed_bytes: number;
  failed_count: number;
}> {
  return api.delete('/api/media/orphaned');
}

/** Analyze an existing media item with AI (Gemini) to suggest title, tags, and excerpt. */
export function analyzeMedia(id: number): Promise<{
  title: string | null;
  tags: string[];
  excerpt: string | null;
}> {
  return api.post(`/api/media/${id}/analyze`);
}

/** Analyze a stored media file by its URL path (e.g. "/2024/08/photo.jpg"). */
export function analyzeMediaByPath(path: string): Promise<{
  title: string | null;
  tags: string[];
  excerpt: string | null;
}> {
  return api.post('/api/media/analyze-path', { path });
}

/**
 * Re-extract EXIF data from the original file on disk.
 * Overwrites any manually edited EXIF with camera-extracted values.
 *
 * @returns Updated media object
 */
export function reextractMediaEXIF(id: number): Promise<Media> {
  return api.post(`/api/media/${id}/reextract`, {});
}

/**
 * Write EXIF fields back to the media file and update the DB.
 * Only alphanumeric and space characters are accepted.
 *
 * @param fields - e.g. { Make: "Canon", Model: "EOS R5" }
 * @returns Updated media object
 */
export function updateMediaEXIF(id: number, fields: Record<string, string>): Promise<Media> {
  return api.put(`/api/media/${id}/exif`, fields);
}

/**
 * Revert media EXIF metadata to the original values captured at upload.
 *
 * @returns Updated media object
 */
export function revertMediaEXIF(id: number): Promise<Media> {
  return api.post(`/api/media/${id}/revert-exif`, {});
}

/**
 * Invalidate every derived image: the server purges the variant tree, rolls the
 * thumbnail generation token and regenerates the most recent uploads in the
 * background. There is nothing to opt out of — a rebuild discards every file.
 */
export function rebuildThumbnails(): Promise<{
  message: string;
  stats: { generation: string, purged: number, legacy: number, prewarming: number };
}> {
  return api.post("/api/media/thumbnails/rebuild");
}

