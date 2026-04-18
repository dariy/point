# Scheduled Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow posts to be queued with a future `scheduled_at` datetime and auto-published by a background goroutine when that time arrives.

**Architecture:** Add `scheduled_at DATETIME NULL` to `posts` and a new `'scheduled'` status value. A 1-minute periodic task in the existing `SchedulerService` calls `PostService.PublishDueScheduledPosts()`, which runs a single UPDATE … RETURNING to flip all due posts to `'published'`. The public feed is unaffected (it already filters `status = 'published'`). The admin editor gains a `datetime-local` input; the admin list shows a "Scheduled • [datetime]" badge.

**Tech Stack:** Go 1.25, Echo v4, SQLite via sqlc, Vanilla JS SPA

**Beads issues:** point-s3m → point-iik → point-4wr → point-cbp → point-z8b

---

## File Map

| File | Change |
|------|--------|
| `api/sql/schema.sql` | Add `scheduled_at DATETIME` column + index |
| `api/sql/queries.sql` | Update `CreatePost`, `UpdatePost`; add `BulkPublishScheduledPosts` |
| `api/internal/models/` | **Regenerated** — do not edit directly |
| `api/cmd/api/main.go` | Add startup migration for `scheduled_at` |
| `api/internal/services/post_service.go` | Add `ScheduledAt` to params structs; add `PublishDueScheduledPosts()` |
| `api/internal/services/scheduler.go` | Wire `PublishDueScheduledPosts` as 1-min periodic task |
| `api/internal/api/posts.go` | Accept/return `scheduled_at`; status inference logic |
| `frontend/src/pages/light/PostEditPage.js` | Add `datetime-local` schedule picker |
| `frontend/src/pages/light/PostsListPage.js` | Add 'scheduled' badge with datetime |
| `frontend/src/api/posts.js` | Pass `scheduled_at` through API calls |

---

## Task 1: DB Migration + Schema Update (point-s3m)

**Files:**
- Modify: `api/sql/schema.sql`
- Modify: `api/cmd/api/main.go`

- [ ] **Step 1: Update schema.sql to document the new column**

In `api/sql/schema.sql`, replace the posts table block ending at the index definitions. Add `scheduled_at DATETIME` after `published_at` and add a new index:

```sql
-- Posts
CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title VARCHAR(500) NOT NULL,
    slug VARCHAR(200) NOT NULL UNIQUE,
    content TEXT NOT NULL,
    excerpt TEXT,
    formatter TEXT NOT NULL DEFAULT 'markdown',
    status TEXT NOT NULL DEFAULT 'draft',
    is_featured BOOLEAN NOT NULL DEFAULT 0,
    view_count INTEGER NOT NULL DEFAULT 0,
    published_at DATETIME,
    scheduled_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thumbnail_path VARCHAR(500),
    meta_description VARCHAR(300),
    preview_token VARCHAR(64) UNIQUE,
    preview_expires_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_posts_slug ON posts(slug);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
CREATE INDEX IF NOT EXISTS idx_posts_published_at ON posts(published_at);
CREATE INDEX IF NOT EXISTS idx_posts_scheduled_at ON posts(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_posts_preview_token ON posts(preview_token);
```

- [ ] **Step 2: Add startup migration in main.go**

In `api/cmd/api/main.go`, find the migrations slice (it is a `[]struct{ name, sql string }` or similar inline slice passed to `repo.ApplyMigration()`). Add this entry **at the end** of the slice:

```go
{
    "add_scheduled_at_to_posts",
    `ALTER TABLE posts ADD COLUMN scheduled_at DATETIME;
CREATE INDEX IF NOT EXISTS idx_posts_scheduled_at ON posts(scheduled_at);`,
},
```

- [ ] **Step 3: Verify migration compiles**

```bash
cd /home/light/src/blog/point/api
go build ./cmd/api
```

Expected: no errors.

- [ ] **Step 4: Close beads issue**

```bash
bd close point-s3m
```

---

## Task 2: sqlc Queries + Regenerate (point-iik)

**Files:**
- Modify: `api/sql/queries.sql`
- Regenerated: `api/internal/models/` (do not edit)

- [ ] **Step 1: Update CreatePost query to include scheduled_at**

In `api/sql/queries.sql`, replace the `CreatePost` query:

```sql
-- name: CreatePost :one
INSERT INTO posts (
    title, slug, content, excerpt, formatter, status, is_featured, author_id, thumbnail_path, meta_description, view_count, published_at, scheduled_at, created_at, updated_at
) VALUES (
    sqlc.arg('title'), sqlc.arg('slug'), sqlc.arg('content'), sqlc.arg('excerpt'), sqlc.arg('formatter'), sqlc.arg('status'), sqlc.arg('is_featured'), sqlc.arg('author_id'), sqlc.arg('thumbnail_path'), sqlc.arg('meta_description'), 0, (CASE WHEN sqlc.arg('status') = 'published' THEN CURRENT_TIMESTAMP ELSE NULL END), sqlc.arg('scheduled_at'), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
)
RETURNING *;
```

- [ ] **Step 2: Update UpdatePost query to include scheduled_at**

In `api/sql/queries.sql`, replace the `UpdatePost` query:

```sql
-- name: UpdatePost :one
UPDATE posts
SET title = sqlc.arg('title'), slug = sqlc.arg('slug'), content = sqlc.arg('content'), excerpt = sqlc.arg('excerpt'), formatter = sqlc.arg('formatter'), status = sqlc.arg('status'), is_featured = sqlc.arg('is_featured'), thumbnail_path = sqlc.arg('thumbnail_path'), meta_description = sqlc.arg('meta_description'),
    scheduled_at = sqlc.arg('scheduled_at'),
    published_at = (CASE WHEN sqlc.arg('status') = 'published' THEN COALESCE(published_at, CURRENT_TIMESTAMP) ELSE published_at END),
    updated_at = CURRENT_TIMESTAMP
WHERE id = sqlc.arg('id') AND author_id = sqlc.arg('author_id')
RETURNING *;
```

- [ ] **Step 3: Add BulkPublishScheduledPosts query**

Append to the POSTS section of `api/sql/queries.sql`:

```sql
-- name: BulkPublishScheduledPosts :many
UPDATE posts
SET status = 'published',
    published_at = COALESCE(scheduled_at, CURRENT_TIMESTAMP),
    scheduled_at = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= CURRENT_TIMESTAMP
RETURNING *;
```

- [ ] **Step 4: Run sqlc generate**

```bash
cd /home/light/src/blog/point/api
sqlc generate
```

Expected: exits 0, regenerates files in `internal/models/`. The `Post` struct will now have `ScheduledAt sql.NullTime`. `CreatePostParams` and `UpdatePostParams` will have `ScheduledAt sql.NullTime`. A new `BulkPublishScheduledPosts` function will be generated in the query file.

- [ ] **Step 5: Verify build still compiles (it will fail — expected)**

```bash
go build ./...
```

Expected: compile errors in `post_service.go` about `models.CreatePostParams` and `models.UpdatePostParams` missing `ScheduledAt`. That's expected — we'll fix in Task 3.

- [ ] **Step 6: Close beads issue**

```bash
bd close point-iik
```

---

## Task 3: Service Layer + Scheduler (point-4wr, point-s3m)

**Files:**
- Modify: `api/internal/services/post_service.go`
- Modify: `api/internal/services/scheduler.go`

### 3a: Update post_service.go

- [ ] **Step 1: Write the failing test for PublishDueScheduledPosts**

In `api/internal/services/post_service_test.go`, find the test setup pattern (look for `TestMain` or `setupTestService`) and add:

```go
func TestPublishDueScheduledPosts(t *testing.T) {
    svc, repo := setupPostServiceTest(t)

    // Create a post with status=scheduled and scheduled_at in the past
    ctx := context.Background()
    past := time.Now().Add(-1 * time.Minute)
    post, err := svc.CreatePost(ctx, CreatePostParams{
        Title:       "Scheduled Post",
        Content:     "hello",
        Formatter:   "markdown",
        Status:      "scheduled",
        AuthorID:    1,
        ScheduledAt: &past,
    })
    require.NoError(t, err)
    require.Equal(t, "scheduled", post.Status)

    err = svc.PublishDueScheduledPosts(ctx)
    require.NoError(t, err)

    updated, err := repo.GetPost(ctx, post.ID)
    require.NoError(t, err)
    assert.Equal(t, "published", updated.Status)
    assert.False(t, updated.ScheduledAt.Valid, "scheduled_at should be cleared after publishing")
    assert.True(t, updated.PublishedAt.Valid)
}

func TestPublishDueScheduledPosts_FutureNotPublished(t *testing.T) {
    svc, repo := setupPostServiceTest(t)

    ctx := context.Background()
    future := time.Now().Add(10 * time.Minute)
    post, err := svc.CreatePost(ctx, CreatePostParams{
        Title:       "Future Post",
        Content:     "hello",
        Formatter:   "markdown",
        Status:      "scheduled",
        AuthorID:    1,
        ScheduledAt: &future,
    })
    require.NoError(t, err)

    err = svc.PublishDueScheduledPosts(ctx)
    require.NoError(t, err)

    updated, err := repo.GetPost(ctx, post.ID)
    require.NoError(t, err)
    assert.Equal(t, "scheduled", updated.Status, "future post should remain scheduled")
}
```

- [ ] **Step 2: Run the failing test**

```bash
cd /home/light/src/blog/point/api
go test ./internal/services/... -run TestPublishDueScheduledPosts -v
```

Expected: compile error — `ScheduledAt` not in `CreatePostParams` and `PublishDueScheduledPosts` undefined.

- [ ] **Step 3: Add ScheduledAt to CreatePostParams and UpdatePostParams**

In `api/internal/services/post_service.go`, update the `CreatePostParams` struct:

```go
type CreatePostParams struct {
    Title           string
    Content         string
    Excerpt         string
    Slug            string
    Formatter       string
    Status          string
    IsFeatured      bool
    AuthorID        int64
    ThumbnailPath   string
    MetaDescription string
    Tags            []string
    ScheduledAt     *time.Time
}
```

Update `UpdatePostParams`:

```go
type UpdatePostParams struct {
    ID              int64
    AuthorID        int64
    Title           string
    Content         string
    Excerpt         string
    Slug            string
    Formatter       string
    Status          string
    IsFeatured      bool
    ThumbnailPath   string
    MetaDescription string
    Tags            []string
    ScheduledAt     *time.Time
}
```

- [ ] **Step 4: Pass ScheduledAt through CreatePost and UpdatePost service methods**

In `CreatePost`, add to the `models.CreatePostParams{...}` literal:

```go
post, err := s.repo.CreatePost(ctx, models.CreatePostParams{
    Title:           p.Title,
    Slug:            p.Slug,
    Content:         normalizeContent(p.Content),
    Excerpt:         sql.NullString{String: p.Excerpt, Valid: p.Excerpt != ""},
    Formatter:       p.Formatter,
    Status:          p.Status,
    IsFeatured:      p.IsFeatured,
    AuthorID:        p.AuthorID,
    ThumbnailPath:   sql.NullString{String: p.ThumbnailPath, Valid: p.ThumbnailPath != ""},
    MetaDescription: sql.NullString{String: p.MetaDescription, Valid: p.MetaDescription != ""},
    ScheduledAt:     toNullTime(p.ScheduledAt),
})
```

In `UpdatePost`, add to the `models.UpdatePostParams{...}` literal:

```go
post, err := s.repo.UpdatePost(ctx, models.UpdatePostParams{
    Title:           p.Title,
    Slug:            p.Slug,
    Content:         normalizeContent(p.Content),
    Excerpt:         sql.NullString{String: p.Excerpt, Valid: p.Excerpt != ""},
    Formatter:       p.Formatter,
    Status:          p.Status,
    IsFeatured:      p.IsFeatured,
    ThumbnailPath:   sql.NullString{String: p.ThumbnailPath, Valid: p.ThumbnailPath != ""},
    MetaDescription: sql.NullString{String: p.MetaDescription, Valid: p.MetaDescription != ""},
    ID:              p.ID,
    AuthorID:        p.AuthorID,
    ScheduledAt:     toNullTime(p.ScheduledAt),
})
```

Add the `toNullTime` helper at the bottom of `post_service.go` (or near the other helpers):

```go
func toNullTime(t *time.Time) sql.NullTime {
    if t == nil {
        return sql.NullTime{}
    }
    return sql.NullTime{Time: *t, Valid: true}
}
```

- [ ] **Step 5: Add PublishDueScheduledPosts method**

Append to `post_service.go`:

```go
func (s *PostService) PublishDueScheduledPosts(ctx context.Context) error {
    published, err := s.repo.BulkPublishScheduledPosts(ctx)
    if err != nil {
        return err
    }
    if len(published) > 0 {
        _ = s.repo.UpdateAllTagPostCounts(ctx)
        fmt.Printf("Scheduled publishing: published %d post(s)\n", len(published))
    }
    return nil
}
```

- [ ] **Step 6: Run the failing test again — should pass now**

```bash
cd /home/light/src/blog/point/api
go test ./internal/services/... -run TestPublishDueScheduledPosts -v
```

Expected: PASS for both `TestPublishDueScheduledPosts` and `TestPublishDueScheduledPosts_FutureNotPublished`.

### 3b: Wire into scheduler

- [ ] **Step 7: Add scheduled post publishing to SchedulerService.Start**

In `api/internal/services/scheduler.go`, inside `func (s *SchedulerService) Start(ctx context.Context)`, add after the existing periodic tasks:

```go
// Periodic task: Publish scheduled posts (every 1 minute)
go s.runPeriodic(ctx, "scheduled post publishing", 1*time.Minute, s.postService.PublishDueScheduledPosts)
```

- [ ] **Step 8: Full build + test pass**

```bash
cd /home/light/src/blog/point/api
go build ./...
go test ./internal/services/...
```

Expected: all pass, no compile errors.

- [ ] **Step 9: Commit**

```bash
cd /home/light/src/blog/point
git add api/sql/schema.sql api/sql/queries.sql api/internal/models/ api/internal/services/post_service.go api/internal/services/scheduler.go api/cmd/api/main.go
git commit -m "feat: add scheduled_at column, sqlc queries, and auto-publish goroutine"
```

- [ ] **Step 10: Close beads issues**

```bash
bd close point-iik point-4wr
```

---

## Task 4: API Handler Changes (point-cbp)

**Files:**
- Modify: `api/internal/api/posts.go`

- [ ] **Step 1: Write the failing test for CreatePost with scheduled_at**

In `api/internal/api/posts_test.go`, find the existing `TestCreatePost` test and add a new test:

```go
func TestCreatePost_Scheduled(t *testing.T) {
    h, cleanup := setupTestHandler(t)
    defer cleanup()

    future := time.Now().Add(24 * time.Hour).UTC().Format(time.RFC3339)
    body := fmt.Sprintf(`{"title":"Scheduled","content":"hello","status":"draft","scheduled_at":%q}`, future)

    rec, c := newAuthRequest(t, http.MethodPost, "/api/posts", strings.NewReader(body))
    err := h.CreatePost(c)
    require.NoError(t, err)
    require.Equal(t, http.StatusCreated, rec.Code)

    var resp map[string]interface{}
    require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
    assert.Equal(t, "scheduled", resp["status"])
    assert.NotNil(t, resp["scheduled_at"])
}

func TestCreatePost_ScheduledInPast_PublishesImmediately(t *testing.T) {
    h, cleanup := setupTestHandler(t)
    defer cleanup()

    past := time.Now().Add(-1 * time.Hour).UTC().Format(time.RFC3339)
    body := fmt.Sprintf(`{"title":"PastScheduled","content":"hello","scheduled_at":%q}`, past)

    rec, c := newAuthRequest(t, http.MethodPost, "/api/posts", strings.NewReader(body))
    err := h.CreatePost(c)
    require.NoError(t, err)
    require.Equal(t, http.StatusCreated, rec.Code)

    var resp map[string]interface{}
    require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
    assert.Equal(t, "published", resp["status"], "past scheduled_at should immediately publish")
}
```

- [ ] **Step 2: Run the failing tests**

```bash
cd /home/light/src/blog/point/api
go test ./internal/api/... -run TestCreatePost_Scheduled -v
```

Expected: FAIL — `scheduled_at` field unknown in request.

- [ ] **Step 3: Add scheduled_at to CreatePostRequest**

In `api/internal/api/posts.go`, update `CreatePostRequest`:

```go
type CreatePostRequest struct {
    Title           string  `json:"title"`
    Content         string  `json:"content"`
    Excerpt         string  `json:"excerpt"`
    Slug            string  `json:"slug"`
    Formatter       string  `json:"formatter"`
    Status          string  `json:"status"`
    IsFeatured      bool    `json:"is_featured"`
    ThumbnailPath   string  `json:"thumbnail_path"`
    MetaDescription string  `json:"meta_description"`
    Tags            []string `json:"tags"`
    ScheduledAt     *string `json:"scheduled_at"`
}
```

- [ ] **Step 4: Add scheduled_at to UpdatePostRequest**

```go
type UpdatePostRequest struct {
    Title           string  `json:"title"`
    Content         string  `json:"content"`
    Excerpt         string  `json:"excerpt"`
    Slug            string  `json:"slug"`
    Formatter       string  `json:"formatter"`
    Status          string  `json:"status"`
    IsFeatured      bool    `json:"is_featured"`
    ThumbnailPath   string  `json:"thumbnail_path"`
    MetaDescription string  `json:"meta_description"`
    Tags            []string `json:"tags"`
    ScheduledAt     *string `json:"scheduled_at"`
}
```

- [ ] **Step 5: Add parseScheduledAt helper**

Add this function near the top of the handler section in `posts.go` (after imports):

```go
// parseScheduledAt parses an optional RFC3339 scheduled_at string.
// Returns (nil, nil) when s is nil or empty (clear/no schedule).
// Returns (nil, error) on parse failure.
// Returns (&t, nil) on success.
func parseScheduledAt(s *string) (*time.Time, error) {
    if s == nil || *s == "" {
        return nil, nil
    }
    t, err := time.Parse(time.RFC3339, *s)
    if err != nil {
        return nil, fmt.Errorf("invalid scheduled_at: must be RFC3339 (e.g. 2026-04-17T15:04:05Z)")
    }
    return &t, nil
}
```

You'll need to ensure `"time"` and `"fmt"` are in the imports of `posts.go`. Check with `go build` — they are likely already imported.

- [ ] **Step 6: Wire parseScheduledAt into CreatePost handler**

In `func (h *PostHandler) CreatePost`, after binding the request and setting defaults, add:

```go
scheduledAt, err := parseScheduledAt(req.ScheduledAt)
if err != nil {
    return c.JSON(http.StatusBadRequest, map[string]string{"detail": err.Error()})
}

// If scheduled_at is in the future, override status to 'scheduled'
if scheduledAt != nil && time.Now().Before(*scheduledAt) {
    req.Status = "scheduled"
} else if scheduledAt != nil {
    // scheduled_at is in the past — publish immediately, clear the schedule
    req.Status = "published"
    scheduledAt = nil
}
```

Then update the `services.CreatePostParams{...}` call to include `ScheduledAt: scheduledAt`.

- [ ] **Step 7: Wire parseScheduledAt into UpdatePost handler**

In `func (h *PostHandler) UpdatePost`, after binding the request, add:

```go
scheduledAt, err := parseScheduledAt(req.ScheduledAt)
if err != nil {
    return c.JSON(http.StatusBadRequest, map[string]string{"detail": err.Error()})
}

if scheduledAt != nil && time.Now().Before(*scheduledAt) {
    req.Status = "scheduled"
} else if scheduledAt != nil {
    req.Status = "published"
    scheduledAt = nil
}
```

Then include `ScheduledAt: scheduledAt` in `services.UpdatePostParams{...}`.

- [ ] **Step 8: Add scheduled_at to buildPostResponse**

In `func buildPostResponse`, add to the returned map:

```go
"scheduled_at": nullTime(post.ScheduledAt),
```

- [ ] **Step 9: Run the tests**

```bash
cd /home/light/src/blog/point/api
go test ./internal/api/... -run TestCreatePost_Scheduled -v
```

Expected: PASS.

- [ ] **Step 10: Run full test suite**

```bash
cd /home/light/src/blog/point
./scripts/run-tests.sh
```

Expected: all tests pass.

- [ ] **Step 11: Commit**

```bash
cd /home/light/src/blog/point
git add api/internal/api/posts.go
git commit -m "feat: accept and return scheduled_at in post create/update handlers"
```

- [ ] **Step 12: Close beads issue**

```bash
bd close point-cbp
```

---

## Task 5: Frontend — Schedule Picker + Scheduled Badge (point-z8b)

**Files:**
- Modify: `frontend/src/pages/light/PostEditPage.js`
- Modify: `frontend/src/pages/light/PostsListPage.js`
- Modify: `frontend/src/api/posts.js`

### 5a: Pass scheduled_at through the API client

No changes needed. `createPost(data)` and `updatePost(id, data)` in `frontend/src/api/posts.js` forward the entire `data` object to the API, so `scheduled_at` is included automatically when callers include it in the payload.

### 5b: Post editor schedule picker

- [ ] **Step 2: Add scheduled_at to post state in PostEditPage**

In `api/internal/api/posts.go` `PostEditPage.js`, find where `post` data is loaded into component state. Look for the section around line 517–575 where `post.status` and `post.is_featured` are normalized. Add:

```js
if (post.scheduled_at) {
    // Normalize to datetime-local format (YYYY-MM-DDTHH:MM) in local time
    const d = new Date(post.scheduled_at);
    post.scheduled_at_local = d.toISOString().slice(0, 16);
} else {
    post.scheduled_at_local = '';
}
```

- [ ] **Step 3: Add the datetime-local input to the editor template**

In `PostEditPage.js`, find the `render()` method or the HTML template string. Locate the status `<select>` element (it has `id="status-select"`). Add the schedule picker **above** it:

```html
<div class="field-group" id="schedule-field">
  <label for="schedule-input">Publish at</label>
  <input type="datetime-local" id="schedule-input"
         value="${escapeHtml(this.state.post?.scheduled_at_local || '')}"
         min="${new Date().toISOString().slice(0, 16)}">
  <button type="button" id="clear-schedule-btn" class="btn btn-sm btn-ghost"
          style="display:${this.state.post?.scheduled_at_local ? 'inline' : 'none'}">
    Clear schedule
  </button>
</div>
```

- [ ] **Step 4: Wire the schedule input to auto-save**

In the `afterRender()` or `bindEvents()` method, add:

```js
const scheduleInput = this.$('#schedule-input');
const clearBtn = this.$('#clear-schedule-btn');

scheduleInput?.addEventListener('change', () => {
    const val = scheduleInput.value; // "YYYY-MM-DDTHH:MM" or ""
    if (val) {
        const iso = new Date(val).toISOString();
        clearBtn.style.display = 'inline';
        this._autoSaveField({ scheduled_at: iso });
    }
});

clearBtn?.addEventListener('click', () => {
    scheduleInput.value = '';
    clearBtn.style.display = 'none';
    this._autoSaveField({ scheduled_at: '' });
});
```

- [ ] **Step 5: Include scheduled_at in _buildSavePayload (or equivalent)**

Find the method that assembles the post body for save (search for where `status` and `formatter` are collected into a save object — around line 549 in the current file). Add `scheduled_at` to the payload:

```js
scheduled_at: this.$('#schedule-input')?.value
    ? new Date(this.$('#schedule-input').value).toISOString()
    : (this.state.post?.scheduled_at || ''),
```

### 5c: Scheduled badge in admin post list

- [ ] **Step 6: Add 'scheduled' to STATUS_LABELS in PostsListPage**

In `PostsListPage.js`, find:

```js
const STATUS_LABELS = {
  published: 'Published',
  draft: 'Draft',
```

Add:

```js
const STATUS_LABELS = {
  published: 'Published',
  draft: 'Draft',
  scheduled: 'Scheduled',
  hidden: 'Hidden',
  page: 'Page',
};
```

- [ ] **Step 7: Add 'scheduled' to the status filter options**

In `PostsListPage.js`, find:

```js
const statusOptions = ['', 'draft', 'published', 'hidden', 'page'].map((s) => {
```

Change to:

```js
const statusOptions = ['', 'draft', 'published', 'scheduled', 'hidden', 'page'].map((s) => {
```

- [ ] **Step 8: Render the scheduled badge with datetime in the post list row**

In the post list row template, find the status column rendering (around line 79–83). Replace or augment the status cell to handle the 'scheduled' case:

```js
<td class="status-col">
  ${p.status === 'scheduled'
    ? `<span class="badge badge-scheduled">
         Scheduled&nbsp;•&nbsp;${p.scheduled_at
           ? new Date(p.scheduled_at).toLocaleString([], {
               month: 'short', day: 'numeric',
               hour: '2-digit', minute: '2-digit'
             })
           : ''}
       </span>`
    : `<select class="status-select badge-${escapeHtml(p.status)} status-change-btn"
               name="status" data-id="${escapeHtml(String(p.id))}">
         ${['draft', 'published', 'hidden', 'page'].map(s => `
           <option value="${s}"${p.status === s ? ' selected' : ''}>${STATUS_LABELS[s] || s}</option>
         `).join('')}
       </select>`
  }
</td>
```

- [ ] **Step 9: Add badge-scheduled CSS style**

In `frontend/css/common/badges.css`, after the `.badge-hidden` block (line ~36), add:

```css
.badge-scheduled {
    background: #7c3aed;
    color: #fff;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 0.75rem;
    white-space: nowrap;
}
```

Then regenerate CSS bundles:

```bash
cd /home/light/src/blog/point
./scripts/build-css.sh
```

- [ ] **Step 10: Start dev server and manually test**

```bash
cd /home/light/src/blog/point/api
go run ./cmd/api &
```

Open browser at `http://localhost:8000`. Log in as admin, create a new post, set a future date in the "Publish at" picker, save. Verify:
- Post appears in admin list with purple "Scheduled • [datetime]" badge
- Post does NOT appear in the public feed
- Clear the schedule and resave — post reverts to draft
- Set a past date — post should immediately publish

- [ ] **Step 11: Commit**

```bash
cd /home/light/src/blog/point
git add frontend/src/pages/light/PostEditPage.js \
        frontend/src/pages/light/PostsListPage.js \
        frontend/src/api/posts.js \
        frontend/css/
git commit -m "feat: add schedule picker in editor and scheduled badge in admin list"
```

- [ ] **Step 12: Close beads issue + parent**

```bash
bd close point-z8b point-ck1
```

---

## Final Checklist

- [ ] All tests pass: `./scripts/run-tests.sh`
- [ ] Build succeeds: `cd api && go build ./...`
- [ ] CSS bundles rebuilt: `./scripts/build-css.sh`
- [ ] Manually tested: create scheduled post → appears in admin with badge → hidden from public feed → goroutine publishes it at the right time
- [ ] Session close protocol: `git pull --rebase && bd dolt push && git push`
