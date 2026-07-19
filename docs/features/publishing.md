# Content & Publishing

The post lifecycle: authoring, saving, scheduling, previewing, and the editor model.
Backend core is `PostService` (`api/internal/services/post_service.go`); the editor is
`frontend/src/pages/light/PostEditPage.js`.

## Authoring

- **Markdown** with GitHub-flavored extensions (tables, strikethrough, autolinks),
  rendered server-side; fenced code blocks highlighted via Chroma. A raw **HTML**
  formatter is available for full layout control.
- **Text / Visual editor modes**: the Visual mode is a node model
  (`parseNodes`/`serializeNodes`) over image sequences + text blocks — deliberately not
  a WYSIWYG rewrite; media references serialize as bare paths matched by
  `IMAGE_PATH_RE`.
- **Per-post custom CSS** (via the `custom-css` plugin): a CSS textarea in the editor;
  `SanitizePostCSS` enforces an explicit safe-property allowlist (excluded: `position`,
  `z-index`, `background-image`, `content`, `transform`, `animation`, `transition`),
  and sanitizer warnings surface as `css_warnings` in the API response.
  `CreatePost`/`UpdatePost` return `(post, warnings, error)`.
  Known gap: **global** custom CSS bypasses the sanitizer.
- **AI fill** per field when Gemini is configured (see
  [ai-analysis.md](ai-analysis.md)).

## Save model — autosave is the only save

There is no manual Save button. The editor autosaves on idle (with a max-wait
backstop), and a visible **autosave chip** answers "is my work safe?" at all times:
`Saving… → ✓ Saved · Xs ago → ⚠ Offline — queued → ⚠ Save failed — retry` (wired to
the offline op queue; Ctrl+S forces a save-now). The primary header button is
contextual — **Publish ▾** (now / schedule) for drafts, **Update** for published posts
— making publishing a deliberate verb rather than a status-dropdown mutation.
Everything secondary (slug, excerpt, featured, schedule, immersive, CSS, Instagram)
lives in the **Details** rail/sheet.

## Lifecycle

- **Statuses**: `draft`, `scheduled`, `published`, `hidden` — plus tag-driven hiding on
  top (see [hidden-visibility.md](hidden-visibility.md)).
- **Scheduling**: set a future date/time; `SchedulerService`
  (`api/internal/services/scheduler.go`) runs a background loop that publishes due
  posts within a minute (`PublishDueScheduledPosts`) and hosts other periodic tasks
  (Instagram token refresh, etc.). Scheduled publish triggers the same hooks as manual
  publish (Instagram cross-post, cache/RSS invalidation).
- **Preview links**: time-limited shareable token URLs (`/preview/:token`,
  `point_generate_preview_link`) for reviewing unpublished posts without auth.
- **Soft delete / trash** with restore; view counts per post; featured flag; SEO meta
  description per post.

## Creation shortcuts

- **Drag-and-drop**: drop an image on any admin page → instant upload + new post
  pre-populated with the media.
- **Web Share Target**: share a photo from a phone's gallery straight into a new draft
  (PWA manifest + service worker queue).

## Notes for future development

- Publish/withdraw must remain the single choke points for side effects — new
  integrations should hook there, not into handlers.
- Autosave applies to drafts; edits to published posts go live via explicit
  **Update** (don't introduce silent live-writes).
- Post-tag mutations invalidate the TagGraph snapshot; any new write path must do the
  same (see [tag-system.md](tag-system.md)).
