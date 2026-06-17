# Epic point-g34b — Import Instagram account into Point engine

## Context

Point already cross-posts **outbound** (Point post → Instagram) via the existing
`instagram_service.go` (OAuth, long-lived token in `blog_secrets`, Graph API
`v25.0`, carousel publishing) and records the published media ID in
`posts.instagram_media_id`.

This epic builds the **inbound** direction: pull an Instagram account's existing
posts into Point as native posts. Requirements from the epic + clarifications:

- **Smart import all posts**, re-runnable as a sync (no duplicates on re-run).
- **No duplicates**, including posts that *originated in Point* and were
  cross-posted out — those carry `posts.instagram_media_id` and must be skipped.
- **Preserve the original permalink in the excerpt** of each imported post.
- Trigger from an **admin UI button** on SystemPage (re-runnable sync).
- Title = **first line of caption**; remainder = body; empty caption → date title.
- Imported posts are **drafts** (review before publishing).
- Dedup keyed on a new **indexed `posts.imported_instagram_id`** column.

The plumbing we reuse: `InstagramService.get()` (authenticated Graph GET,
`instagram_service.go:79`), `MediaService.UploadFile([]byte,...)` (SHA256 dedup,
`media_service.go:169`), `PostService.CreatePost` (3-return,
`post_service.go:396`), the `db.go` migration column-list pattern (`db.go:198`),
and the SystemPage card pattern (`SystemPage.js`).

## Approach

### 1. Schema + model: `imported_instagram_id` (foundation)
- Add column via the existing migration list in `api/internal/repository/db.go`
  (alongside the `instagram_*` block ~line 205):
  `ALTER TABLE posts ADD COLUMN imported_instagram_id TEXT` and a
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_imported_instagram_id ...`.
  Mirror in `api/sql/schema.sql`.
- Add `ImportedInstagramID sql.NullString` to the `Post` struct
  (`api/internal/models/models.go:65`) and to all `RETURNING *` scans in
  `queries.sql.go` (CreatePost, GetPostBySlug, etc.).
- Extend `CreatePostParams` (repo + service + `queries.sql` CreatePost insert) to
  accept `imported_instagram_id`.
- New repo query: `GetExistingInstagramIDs(ctx, ids []string) ([]string, error)`
  returning, for a batch of IG media IDs, those already present in **either**
  `imported_instagram_id` **or** `instagram_media_id`. This is the dedup primitive.

### 2. Instagram service: list account media
- Add `ListUserMedia(ctx) ([]InstagramMedia, error)` to `instagram_service.go`,
  paging `GET /{ig-user-id}/media?fields=id,caption,media_type,media_url,permalink,timestamp,thumbnail_url,children{media_url,media_type,thumbnail_url}`
  via the existing `get()` helper, following `paging.next` cursors.
- Define `InstagramMedia` (ID, Caption, MediaType, MediaURL, Permalink,
  Timestamp, Children []child). Map `CAROUSEL_ALBUM` → ordered children.

### 3. Media download helper
- Helper to fetch CDN bytes from an IG `media_url` (own `http.Client` with
  timeout, like `instagram_service.go:28`) and hand them to
  `MediaService.UploadFile` (which already dedups by SHA256 and writes
  `/YYYY/MM/...`). Returns the stored bare path for content serialization.

### 4. Import orchestration service
- New `InstagramImportService` (deps: InstagramService, MediaService,
  PostService, Repository), method `ImportAccount(ctx, progress func(...))`.
- Flow: `ListUserMedia` → batch dedup via `GetExistingInstagramIDs` → for each
  new item: download all images (carousel → many), build post content
  (node/path serialization matching `PostEditPage` `IMAGE_PATH_RE` format), set
  title (first caption line) / body (remainder) / `excerpt = permalink` /
  `status = draft` / `imported_instagram_id = media.ID`, call
  `PostService.CreatePost`. Collect `{imported, skipped, errors}`.
- Idempotent re-run: previously imported + Point-origin cross-posted items are
  skipped via the combined dedup query.

### 5. API endpoint(s)
- Admin-only routes in `api/internal/api/instagram.go`:
  `POST /api/instagram/import` (starts a background goroutine, returns running
  status) and `GET /api/instagram/import/status` (in-memory progress: running,
  imported, skipped, errors, last-run timestamp). Persist last-run summary to
  `blog_settings` (`instagram_import_last_run`, counts) for display after reload.

### 6. Frontend: SystemPage card + API module
- Add `triggerInstagramImport()` / `getInstagramImportStatus()` to
  `frontend/src/api/instagram.js`.
- Add an "Instagram Import" card to `frontend/src/pages/light/SystemPage.js`:
  last-run time, last counts, "Import / Sync Now" button, live progress polling
  while running. Gate on Instagram being connected (reuse `getInstagramStatus`).

### 7. Tests
- Repo test for `GetExistingInstagramIDs` (matches both columns) using in-memory
  SQLite (`repository_test.go` helpers).
- Import-service unit test with a faked InstagramService media list + mocked
  MediaService/PostService: asserts dedup skips, carousel handling, excerpt =
  permalink, draft status, first-line title mapping.

## br subtasks (children of point-g34b)

Create with `br create`, `--type task`, parent `point-g34b`; wire dependencies
with `br dep add`:

1. **Schema + model: `imported_instagram_id` column, scans, dedup query** — foundation, blocks 4.
2. **InstagramService.ListUserMedia (paged Graph media fetch)** — blocks 4.
3. **Media download-from-URL helper → MediaService.UploadFile** — blocks 4.
4. **InstagramImportService.ImportAccount orchestration** (dep: 1,2,3) — blocks 5.
5. **API: POST /import + GET /import/status (background + last-run persistence)** (dep: 4) — blocks 6.
6. **Frontend: SystemPage import card + instagram.js API functions** (dep: 5).
7. **Tests: dedup repo query + import-service unit tests** (dep: 4).

## Verification

- Backend: `cd api && go build ./... && go test ./internal/repository/... ./internal/services/...`.
- Run locally: `scripts/run-local.sh` (localhost:8001), connect Instagram in
  Settings, open `/light/system`, click **Import / Sync Now**.
  - First run: posts appear as drafts under `/light/posts`, each with the IG
    permalink in its excerpt and images attached.
  - Second run: status reports all **skipped** (0 imported) — proves idempotency.
  - Create a Point post, cross-post it to Instagram, then re-run import: that
    item is **skipped** (matched via `instagram_media_id`), not re-imported.
- CSS: none expected; if SystemPage styling is touched, edit
  `frontend/css/light/*.css` then `scripts/build-css.sh` (never the generated
  `light.css`).
