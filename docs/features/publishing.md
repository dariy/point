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
- **Titles are optional**: a post saved with an empty title is named after the day it
  was written. The pattern lives in `blog_settings.default_post_title_format`
  (/light/settings → Posts), defaults to `YYYY-MM-DD`, and is rendered by
  `FormatTitleDate` (`api/internal/services/post_title.go`) — tokens `YYYY YY MMMM MMM
  MM DDDD DDD DD HH mm ss`, `[brackets]` for literal words. `formatTitleDate`
  (`frontend/src/utils/formatters.js`) mirrors it so the editor's title placeholder
  previews what the backend will assign; the two token tables must stay in sync.
  Same-day untitled posts would derive the same slug, so `CreatePost` suffixes
  `-2`, `-3`… rather than returning a conflict the author can't act on.

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
- **The queue on the feed**: the owner's home feed extends *left* of page 1 into
  the scheduled posts — page 0 is the first future page, then -1, -2 … The
  server reports the left edge as `pagination.min_page` (1 for everyone else)
  and flags the page it returned with `pagination.scheduled`; the client
  (`GridPager`, `Pagination`, `ViewContext`) treats that as the first page
  instead of hard-coding 1, so swipe, arrow keys and the paginator all reach it.

  The queue reads **outward from the present**: soonest-first, laid out
  right-to-left and then down (`.posts-grid-reversed`, `direction: rtl`), so the
  post about to go live sits top-right — where it will land once page 1 shifts
  along. Cards are drawn faded (`.post-card.is-scheduled`) and dated by
  `scheduled_at` rather than `created_at`. Guests never see any of it, and
  neither does the owner with [revelio](hidden-visibility.md#revelio--viewing-the-site-as-a-guest)
  off. Scheduled posts count towards a tag's admin post count.
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
