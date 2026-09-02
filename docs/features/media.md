# Media Pipeline

A unified media library for photos, video, and audio, owned by `MediaService`
(`api/internal/services/media_service.go`) with all files under `STORAGE_PATH`, filed
by upload date (`/YYYY/MM/…`).

## What is implemented

- **Upload**: multi-format (JPEG/PNG/WebP/…, video, audio) with MIME sniffing
  (`media_mime.go`), size limit (`MAX_UPLOAD_SIZE_MB`), and **SHA256 dedup** — the same
  bytes uploaded twice resolve to one stored file (this is what makes Instagram import
  re-runs cheap).
- **Thumbnails**: a fixed ladder of four rungs — 128/256/512/1024 px on the **longest
  side**, aspect-preserving (`imaging.Fit`), JPEG only (the binary is CGO-free, so no
  WebP/AVIF encoder). Written eagerly at upload and lazily on first request, to
  `media/variants/<size>/YYYY/MM/<base>.jpg`. Requested as
  `/YYYY/MM/<file>?s=<size>&v=<gen>`; `s` must be a rung or the request is a 400.
  Legacy `?thumb` still resolves (bare → 512, `?thumb=128` → 128), so old
  `posts.thumbnail_path` rows and published post content keep working with no data
  migration. Only `JPEG_QUALITY` is configurable; there is no dimension setting.
- **Cache-busting**: `v` is one **global** generation token (`thumbnail_generation` in
  settings) — global because the frontend call sites that build a media URL hold a bare
  path string and nothing else. A variant whose `v` matches gets a long TTL; a stale or
  missing `v` gets a short one, so an outdated URL is never pinned. **Rebuild**
  (`/light/system`) is a token roll, not a re-encode: purge the derived tree, mint a
  fresh token, drop the cached public pages that baked the old `v` into their URLs, then
  prewarm recent uploads in the background. It returns in milliseconds and moves every
  variant URL on the site at once. `media/thumbnails/` survives the purge — it holds
  client-captured video poster frames, which no server-side decoder can reproduce.
- **EXIF**: extraction from JPEGs (camera, exposure, ISO, focal length, GPS, date);
  admin-editable with revert-to-original (`exif_writer.go` writes changes back).
- **Photo library import**: `PHOTO_LIBRARY_PATH` points at a read-only library (e.g. a
  Lightroom export); Point imports new files without moving originals. Also exposed as
  a picker (`PhotoLibraryPickerDialog`) and as the sandbox root for MCP uploads.
- **Library UI**: folder-tree browser (breadcrumb + folder chips on narrow screens),
  type filters, rename with safe-character validation (post references stay intact),
  orphaned-media detection and cleanup (individual or bulk), storage stats by type.
- **Drag-and-drop creation**: dropping an image anywhere in the admin uploads it and
  opens a new post pre-populated with that media; the Web Share Target (PWA) feeds the
  same flow from a phone's share sheet.

## Media visibility

Media files are **private until referenced by a visible published post** — visibility
is recalculated from post state, with a recalc endpoint for repair. This is
server-enforced (guests can't fetch media belonging to hidden/draft posts).

Gotchas from production:

- The sync has failed silently in several places historically — treat
  visibility-sync errors as privacy bugs, never best-effort.
- A post being "visible" includes tag-driven hiding (see
  [hidden-visibility.md](hidden-visibility.md)): a hidden feature-tag once made public
  feature pages lose their media.
- Batch recalcs have a known N+1.

## Key decisions

- **Content-addressed dedup at the service layer** rather than per-caller checks.
- **Posts reference media by path** (serialized in post content nodes, matched by
  `IMAGE_PATH_RE` in the editor) — renames go through the service so references update.
  That is also how a caller asks for a post's media: `GET /api/media?paths=/YYYY/MM/file`
  (repeated, up to 500, batched client-side) resolves exactly those and skips paging.
  `media.post_id` is not the answer — it is only set for files uploaded from the editor,
  so it misses anything picked out of the library.
- **Originals are immutable-ish**: EXIF edits keep the original values recoverable.
  A variant is never served as the `src` of an article image either — `src` stays on the
  bare original so the lightbox and `extractMedia`'s `src` capture still open full size.
- **`<img srcset>`, never `<picture>`**: `postMedia.js` splits server-rendered HTML with
  a regex whose `VOID_TAGS` list has no `picture`, so a `<picture>` is misread as a text
  block and silently breaks immersive slides. Article `srcset` is injected *after*
  bluemonday (`srcset.go`), deliberately outside the sanitizer policy — that is what
  stops an author writing their own `srcset` full of arbitrary URLs.
- **The engine names no CDN.** Cache headers are written for shared caches in general;
  which one sits in front of a deployment is the operator's business, not the engine's.
- SVG uploads are currently allowlisted but served unsanitized same-origin — open
  security item.
