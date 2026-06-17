/**
 * postMedia — shared helpers for extracting media items from a post's HTML.
 *
 * These were originally private to PostContent; they are factored out here so
 * MediaViewer can parse the media of adjacent posts (for cross-post peek /
 * preload) without duplicating the logic.
 *
 * An "item" is `{ type: 'image'|'video'|'audio'|'html', url?, alt?, html? }`,
 * the same shape MediaViewer renders.
 */

const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "ogv", "m4v", "avi", "mkv"]);
const AUDIO_EXTS = new Set(["mp3", "m4a", "ogg", "wav", "flac", "aac", "opus"]);
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "heic", "heif", "bmp"]);

/** Return 'video', 'audio', 'image', or null based on file extension. */
export function mediaTypeFromPath(path) {
  const ext = (path.split(".").pop() || "").toLowerCase();
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (IMAGE_EXTS.has(ext)) return "image";
  return null;
}

/** Strip all HTML tags, returning plain text. */
export function stripHtml(html) {
  if (!html) return "";
  let previous;
  do {
    previous = html;
    html = html.replace(/<[^>]*>/g, "");
  } while (html !== previous);
  return html;
}

/** Extract media items from a single HTML fragment (no <hr> splitting). */
export function extractMedia(html) {
  const items = [];
  for (const m of html.matchAll(/<img[^>]+>/gi)) {
    const src = (m[0].match(/\ssrc="([^"]*)"/i) || [])[1] || "";
    const alt = (m[0].match(/\salt="([^"]*)"/i) || [])[1] || "";
    if (src) items.push({ type: "image", url: src, alt });
  }
  for (const m of html.matchAll(/<(?:video|source)[^>]*\ssrc="([^"]*)"[^>]*/gi)) if (m[1]) items.push({ type: "video", url: m[1] });
  for (const m of html.matchAll(/<audio[^>]*\ssrc="([^"]*)"[^>]*/gi)) if (m[1]) items.push({ type: "audio", url: m[1] });
  if (items.length === 0) {
    const text = stripHtml(html).trim();
    for (const line of text.split(/\n+/)) {
      const url = line.trim();
      if (url) {
        const type = mediaTypeFromPath(url);
        if (type) items.push({ type, url });
      }
    }
  }
  return items;
}

/**
 * Build the ordered list of carousel items from a post's content HTML.
 * Splits on <hr> into segments, treating media-only segments as media items
 * and mixed segments as 'html' (text) slides.
 */
export function mediaFromHtml(html) {
  const items = [];
  if (html.includes("<hr>") || html.includes("<hr/>") || html.includes("<hr />")) {
    const segments = html.split(/<hr\s*\/?>/i);
    for (const segment of segments) {
      const trimmed = segment.trim();
      if (!trimmed) continue;
      const segmentMedia = extractMedia(trimmed);
      const text = stripHtml(trimmed).replace(/&nbsp;/g, " ").trim();
      if (segmentMedia.length === 1 && (text.length === 0 || text === segmentMedia[0].url)) {
        items.push(segmentMedia[0]);
      } else {
        items.push({ type: "html", html: trimmed });
      }
    }
    if (items.length > 0) return items;
  }
  return extractMedia(html);
}
