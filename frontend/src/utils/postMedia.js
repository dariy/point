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

/** Elements that never have a closing tag, for the top-level block scanner. */
const VOID_TAGS = new Set([
  "img", "br", "hr", "input", "source", "meta", "link",
  "area", "base", "col", "embed", "param", "track", "wbr",
]);

/**
 * Split an HTML fragment into its top-level blocks (a <p>, a bare <img>, a
 * <figure> and its contents, …). Nested tags stay inside their parent block.
 *
 * Regex-based to match the rest of this module, which parses without a DOM so
 * it can also run for adjacent posts during preload.
 */
export function splitTopLevelBlocks(html) {
  const blocks = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
  let depth = 0;
  let start = 0;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const isClosing = m[1] === "/";
    const name = m[2].toLowerCase();
    const isVoid = VOID_TAGS.has(name) || /\/\s*$/.test(m[3]);

    if (isVoid) {
      // A void element at the top level is a block of its own.
      if (depth === 0) {
        blocks.push(html.slice(start, tagRe.lastIndex));
        start = tagRe.lastIndex;
      }
      continue;
    }
    if (!isClosing) {
      depth++;
      continue;
    }
    depth--;
    if (depth <= 0) {
      depth = 0;
      blocks.push(html.slice(start, tagRe.lastIndex));
      start = tagRe.lastIndex;
    }
  }
  if (start < html.length) blocks.push(html.slice(start));
  return blocks.map((b) => b.trim()).filter(Boolean);
}

/**
 * Reduce a list of blocks to carousel items: runs of media-only blocks become
 * media items, and everything else accumulates into 'html' (text) slides.
 * Shared by the <hr> and no-<hr> paths so both segment content the same way.
 */
function blocksToItems(blocks) {
  const items = [];
  let pending = [];
  const flush = () => {
    if (pending.length) {
      items.push({ type: "html", html: pending.join("\n") });
      pending = [];
    }
  };
  for (const block of blocks) {
    const blockMedia = extractMedia(block);
    const text = stripHtml(block).replace(/&nbsp;/g, " ").trim();
    // Media-only means nothing is left once the media and their own URLs are
    // accounted for — so <p><img></p> and a bare list of media URLs both
    // qualify, while a <figure> with a caption does not.
    let residual = text;
    for (const item of blockMedia) residual = residual.split(item.url).join("");
    const mediaOnly = blockMedia.length > 0 && residual.trim().length === 0;
    if (mediaOnly) {
      flush();
      items.push(...blockMedia);
    } else {
      pending.push(block);
    }
  }
  flush();
  return items;
}

/**
 * Build the ordered list of carousel items from a post's content HTML.
 *
 * <hr> is the explicit slide separator: each segment becomes one slide, so a
 * mixed segment stays a single text slide even if it runs long.
 *
 * Without <hr> the content is segmented on its own top-level blocks instead.
 * That path used to return extractMedia(html), which kept only the images and
 * silently dropped every paragraph around them — a post with mixed images and
 * text lost all its prose the moment it was forced into immersive mode.
 * See point-924a.
 */
export function mediaFromHtml(html) {
  if (html.includes("<hr>") || html.includes("<hr/>") || html.includes("<hr />")) {
    const items = [];
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

  const items = blocksToItems(splitTopLevelBlocks(html));
  // Fall back to the flat scan for content with no recognisable block
  // structure (a bare list of URLs, a single inline run).
  return items.length > 0 ? items : extractMedia(html);
}
