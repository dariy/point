# Instagram Integration

Cross-post Point posts to an Instagram **Business/Creator** account using Meta's
official Instagram Content Publishing API (Graph API). Tracked under beads epic
**point-xq28**.

## Goals

- Publish a post's photos to Instagram (single image or carousel) when the post
  is published in Point — automatically (opt-in per post) or on demand.
- Stay true to Point's self-hosted, "no Point-operated infrastructure" ethos:
  the admin brings their **own** Meta app credentials, exactly like the existing
  "bring your own Gemini key" pattern.
- Integrate cleanly with the three existing publish surfaces: **manual publish**,
  **scheduled publish**, and the **post editor**.

## Non-goals (v1)

- Importing content *from* Instagram into Point.
- Video / Reels publishing (deferred — needs async container status polling).
- Stories, comments, insights/analytics.
- A Point-operated central OAuth proxy (rejected: requires Meta app review and
  shared infra).

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Auth model | Self-hoster's **own Meta app** (App ID + Secret) + OAuth redirect flow → long-lived token | Self-contained; mirrors Gemini BYO-key; no Point infra |
| Media types | Single image **+ carousel** (≤10) | Covers the bulk of photo-blog posts; video later |
| Trigger | **Per-post opt-in toggle + auto-on-publish** (manual & scheduled) + manual "Publish to Instagram now" | Satisfies all three notes: scheduled, admin settings, manual |

## How Instagram publishing works (Graph API)

Per-account, the content-publishing flow is two-step:

1. **Create media container** — `POST /{ig-user-id}/media`
   - Single image: `image_url` (must be a **public** URL) + `caption`.
   - Carousel: create a child container per image with `is_carousel_item=true`,
     then a parent container with `media_type=CAROUSEL` + `children=[ids]`.
2. **Publish container** — `POST /{ig-user-id}/media_publish` with `creation_id`.

Constraints that shape the design:

- Image URLs **must be publicly reachable** by Meta's servers → we build absolute
  URLs from `APP_URL` (already in config) + the media path. If `APP_URL` is unset
  or points at `localhost`, publishing must fail with a clear, actionable error.
- Rate limit: **25 published posts / 24h** per account.
- Long-lived user access tokens last ~60 days and must be refreshed before expiry.

## Architecture

Follows the existing service/handler split (`api/internal/services`, `api/internal/api`).

### Storage

`blog_secrets` (encrypted-at-rest store, never returned to the client):
- `instagram_app_id`, `instagram_app_secret`
- `instagram_access_token`, `instagram_user_id`, `instagram_token_expires_at`

`blog_settings` (admin-visible config):
- `enable_instagram` (master on/off)
- `instagram_default_share` (default value of the per-post toggle)
- `instagram_caption_template` (template with `{title}`, `{excerpt}`, `{tags}`, `{link}`)

`posts` table (new columns, via the `ALTER TABLE ... ADD COLUMN` migration pattern
already used for `css`/`immersive_mode` in `repository/db.go`):
- `instagram_share` BOOLEAN DEFAULT 0 — per-post opt-in
- `instagram_status` TEXT DEFAULT 'none' — `none|pending|published|failed`
- `instagram_media_id` TEXT — published IG media id
- `instagram_published_at` DATETIME
- `instagram_error` TEXT — last failure reason (shown in editor)

### Services

- **`InstagramService`** — Graph API client (token-based) with an injectable base
  URL for tests (same pattern as `TagService.nominatimBaseURL`). Methods: create
  image/carousel container, publish, exchange OAuth code → long-lived token,
  refresh token, fetch connected account username.
- **`PostService`** — gains a `CrossPostToInstagram(post)` method that builds the
  caption, resolves public image URLs, calls `InstagramService`, and records
  status/error/media-id on the post.

### Endpoints (admin-only, `AuthMiddleware`)

- `GET  /api/instagram/connect`   → redirect to Meta OAuth (state CSRF token)
- `GET  /api/instagram/callback`  → exchange code, store long-lived token + user id
- `POST /api/instagram/disconnect`→ clear stored secrets
- `GET  /api/instagram/status`    → `{connected, username, token_expires_at, enabled}`
- `POST /api/posts/:id/instagram/publish` → manual cross-post for one post

### Auto cross-post hook

Both publish paths converge on a single guarded call:
`if enable_instagram && post.instagram_share && connected → CrossPostToInstagram`.

- **Manual publish**: `PostHandler.PublishPost` / `PostService.PublishPost`.
- **Scheduled publish**: `PostService.PublishDueScheduledPosts` (called by
  `SchedulerService` every minute) — iterate newly published posts.

Cross-posting runs **best-effort**: a failure records `instagram_status=failed`
and `instagram_error` but never blocks the Point publish. Failures are visible in
the editor with a retry button.

### Token refresh

A new daily `SchedulerService` task refreshes the long-lived token when it is
within ~7 days of `instagram_token_expires_at`.

### Frontend (Vanilla JS SPA)

- **SettingsPage**: new "Instagram" section — App ID/Secret inputs (secret-style,
  shows `*_is_set`), Connect/Disconnect button driven by `/api/instagram/status`,
  master enable toggle, default-share toggle, caption-template field. Mirrors the
  existing Gemini section.
- **PostEditPage**: "Share to Instagram" toggle (defaults to
  `instagram_default_share`), an IG status badge (`published`/`pending`/`failed`
  with error tooltip), and a "Publish to Instagram now" button.

## Failure & edge cases

- Not connected / token expired → editor + status surface a "Reconnect" prompt.
- `APP_URL` missing or local → block with explicit error (Meta can't fetch images).
- No images in post → skip with a clear message (text-only posts aren't supported).
- >10 images → publish first 10 as carousel, warn.
- Rate limit (25/24h) → record failure, surface message, allow manual retry later.

## Work breakdown

See beads epic **point-xq28** for the task list and dependency graph.
