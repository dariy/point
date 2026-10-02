# Media Pipeline

A unified media library for photos, video, and audio, owned by `MediaService`
(`api/internal/services/media_service.go`) with all files under `STORAGE_PATH`, filed
by upload date (`/YYYY/MM/…`).

## What is implemented

- **Upload**: multi-format (JPEG/PNG/WebP/…, video, audio) with MIME sniffing
  (`media_mime.go`), size limit (`MAX_UPLOAD_SIZE_MB`), and **SHA256 dedup** — the same
  bytes uploaded twice resolve to one stored file (this is what makes Instagram import
  re-runs cheap).
- **Thumbnails**: a fixed ladder of six rungs — 128/256/512/1024/1600/2048 px on the
  **longest side**, aspect-preserving (`fitImage`, Catmull-Rom from `golang.org/x/image/draw`), JPEG only (the binary is CGO-free,
  so no WebP/AVIF encoder). Upload and import write the rungs up to 1024
  (`UploadMaxVariantSize`). The first request for any missing rung writes every missing
  rung, and the rebuild prewarm does the same, so 1600 and 2048 appear then. A rung at
  or above the longest side is never written. Files go to
  `media/variants/<size>/YYYY/MM/<base>.jpg`. Requested as
  `/YYYY/MM/<file>?s=<size>&v=<gen>`; `s` must be a rung or the request is a 400.
  Legacy `?thumb` still resolves (bare → 512, `?thumb=128` → 128), so old
  `posts.thumbnail_path` rows and published post content keep working with no data
  migration. Only `JPEG_QUALITY` is configurable; there is no dimension setting.
- **Decoded inputs**: JPEG, PNG, GIF, BMP, TIFF (standard library and `golang.org/x/image`) and WebP, lossy and
  lossless (pure-Go `golang.org/x/image/webp`). A decoded input gets a stored
  `width`/`height`, the JPEG ladder and the pixel guard. A WebP row stored before WebP
  decode existed has no size; the first variant request stores it
  (`MediaService.backfillDimensions`).
- **AVIF and HEIC**: AVIF decodes through `gen2brain/avif` (WASM on wazero), HEIC
  through the pure-Go `gen2brain/h265`. A 24 MP AVIF takes 3–5 s to decode, so these
  uploads do not wait for it: the upload reads the size from the header (the pixel guard
  runs there too), stores the row, and a background goroutine builds the ladder
  (`api/internal/services/media_deferred.go`). A HEIC or HEIF upload becomes a JPEG: the
  goroutine writes a full-size JPEG (quality 92) with the ICC profile and the EXIF
  (Orientation set to 1, because the decode applies `irot`/`imir`), then points the row at
  it. The HEIC file stays beside the JPEG, with the same stem, as the archival original;
  delete and rename take it along. The row keeps the HEIC checksum, so a second upload of
  the same file finds it.
- **EXIF orientation**: every decode applies the EXIF Orientation tag, so variants,
  cards and `og:image` are upright, and the stored `width`/`height` are the displayed size.
  The original file keeps its pixels and its tag. Migration `swap_dims_for_rotated_exif`
  swaps the stored size of older rows with Orientation 5–8. At the first start after that
  change, a one-time task (setting `media_orientation_variants_purged`) removes the old
  variants of rows with Orientation 2–8 and rolls the generation token.
- **ICC colour profile**: every ladder rung carries the ICC profile of its source, as
  APP2 `ICC_PROFILE` segments of 65,519 bytes or less (`services/icc.go`). The profile
  comes from JPEG APP2 segments or a PNG `iCCP` chunk. A Display P3 or Adobe RGB photo
  thus keeps its colour in grids, cards and `og:image`. A source with no profile or with
  an sRGB profile gets no APP2 segment: browsers assume sRGB. Video posters stay sRGB.
  Rungs written before this change have no profile; "Rebuild thumbnails" writes them again.
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
- **Video transcode** (full image, or any install with ffmpeg and ffprobe on the path;
  `FFMPEG_PATH` overrides the lookup): an uploaded video adds a `video.transcode` job to
  the job store (`media_video.go`). The upload returns at once. The job writes an MP4
  with H.264 High, `yuv420p`, CRF 23, the long side at most 1920 (never upscaled), AAC
  128 kb/s stereo and `-movflags +faststart`. A source that is already H.264 with AAC
  (or no audio) gets a remux (`-c copy`). The output has no global metadata. It goes to
  `media/variants/video/<YYYY>/<MM>/<name>.mp4`, through a temporary file and a rename.
  The original does not change. The media route serves the original until the MP4
  exists, then serves the MP4 at the same URL. A failed job keeps the original in
  service. ffmpeg runs with `-threads 2` and a 30 min timeout; the single job worker
  runs one video at a time. Without ffmpeg (the slim image) no job is added.
- **Video backfill**: "Rebuild thumbnails" also runs `MediaService.BackfillVideos`. It adds
  a `video.transcode` job for each video with no fresh MP4, and a `video.poster` job for
  each video with no poster. A video that has both is skipped, so it is safe to run
  again. After a backup restore, run it to write the transcodes again.

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

## Not yet implemented

### Server video path

Without ffmpeg, a video is served as it was uploaded, so an iPhone HEVC `.mov` does not
play in Firefox or on some Chrome platforms. This is the design for the rest. The epic
p-zm2s holds the work.

- **Transcode: done.** See "Video transcode" under "What is implemented". A backup leaves
  the transcode out, like every other derived file; "Rebuild thumbnails" writes it again
  (see "Video backfill").
- **Server poster: done.** With ffmpeg, an upload also enqueues a `video.poster` job
  (`media_video.go::WriteServerPoster`). It writes a frame at 10 % of the duration through
  `storePoster`, but only when no poster exists. A poster from the admin browser always
  wins and replaces a server poster. Slim keeps only the browser capture.
- **Slim does less, and says so: done.** A slim install serves the original. At upload, a
  pure-Go scan of the MP4/MOV sample description (`media_hevc.go::IsHEVCVideo`) finds
  `hvc1`/`hev1` and writes `VideoCodec: hevc` to the media metadata. When no transcode
  exists, the admin media API sets `hevc_note`, and the media library shows "HEVC: may not
  play in browsers" on the item. A video uploaded before this change has no such metadata.
- **One durable job store for all background side effects.** A SQLite table `jobs`: `id`,
  `kind`, `payload` (JSON), `state` (`queued`, `running`, `done`, `failed`), `attempts`,
  `max_attempts`, `next_run_at`, `last_error`, `created_at`, `updated_at`. One worker
  goroutine drains it, woken by a channel on enqueue and by a poll tick. It recovers
  panics with `utils.SafeGo`. At startup, a `running` row goes back to `queued`, so a
  restart loses no work. A failure retries with exponential backoff until `max_attempts`.
  The kinds are `video.transcode`, `video.poster`, `instagram.crosspost`, and later the
  federation outbox. Video jobs run one at a time, and ffmpeg gets a timeout and a thread
  limit, so a transcode cannot starve the web server.

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
- **1600 and 2048 are not written at upload**: only article bodies use them (a phone at
  DPR 3, a retina laptop), and they are the slowest rungs to encode, so upload stays fast.
  Article `<img>` tags also get `width`/`height` from the stored size when they have none
  (`srcset.go::injectArticleSrcsetDims`), so a lazy image does not move the layout.
- **`<img srcset>`, never `<picture>`**: `postMedia.ts` splits server-rendered HTML with
  a regex whose `VOID_TAGS` list has no `picture`, so a `<picture>` is misread as a text
  block and silently breaks immersive slides. Article `srcset` is injected *after*
  bluemonday (`srcset.go`), deliberately outside the sanitizer policy — that is what
  stops an author writing their own `srcset` full of arbitrary URLs.
- **GPS never leaves the server in a guest payload.** `media.metadata` keeps GPS for the
  admin UI and location tagging. Every guest emitter of post media (`GetPostBySlug`,
  `GetPostByID`, the preview-token route) passes it through `posts.go::guestMediaMetadata`:
  with `exif_visibility` at `all` a guest gets only the six keys the viewer shows
  (`EXIF_FIELDS` in `frontend/src/utils/exif.ts`); with `hide` or `admin` a guest gets no
  `metadata`. An authenticated response keeps the full blob.
- **Served originals carry no GPS by default.** With `strip_gps_public` on (the default;
  Settings → Display), the media route serves an original JPEG, PNG, WebP, TIFF, HEIC/HEIF or
  AVIF from a copy with an empty GPS IFD and with the GPS properties of its XMP packets
  blanked. The XMP match covers every namespace, so vendor properties such as
  `drone-dji:GpsLatitude` are blanked too
  (`services/gps_strip.go::NoGPSOriginal`). The copy is cleaned in place and keeps every
  byte offset, so the gain map of an Ultra HDR photo survives and is cleaned too. The copy lives under
  `media/variants/nogps/`, is written on the first request and again when the original is
  newer. The original on disk does not change. The rule applies to every requester, so a
  shared cache holds one version of each URL, and an original of these formats is never
  presigned to S3 while the rule is on. If the copy cannot be written, the route returns an error and
  does not serve the original. A PNG chunk that changes gets a new CRC. Compressed PNG text
  chunks (`zTXt`, compressed `iTXt`) and HEIF items split over more than one extent are not
  cleaned. GIF, BMP and raw originals, and video, are served unchanged. Thumbnail variants carry no metadata.
- **The engine names no CDN.** Cache headers are written for shared caches in general;
  which one sits in front of a deployment is the operator's business, not the engine's.
- SVG uploads are currently allowlisted but served unsanitized same-origin — open
  security item.
