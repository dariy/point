# Instagram Integration

Two directions, both implemented and gated behind the `instagram` plugin:

- **Cross-posting (outbound)** — publish a Point post's photos to an Instagram
  Business/Creator account (single image or ≤10-image carousel) automatically on
  publish or on demand.
- **Import (inbound)** — pull the connected account's existing posts into Point as
  drafts, re-runnable as an idempotent sync.

Both stay true to Point's self-hosted ethos: the admin brings their **own** Meta app
credentials (like the bring-your-own-Gemini-key pattern); Point operates no shared
OAuth proxy or infrastructure.

## Cross-posting

### Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Auth model | Self-hoster's own Meta app (App ID + Secret) + OAuth redirect → long-lived token | Self-contained; no Point infra; no Meta app review needed in Development mode |
| Media types | Single image + carousel (≤10) | Covers photo-blog posts; video deferred |
| Trigger | Per-post opt-in toggle, auto on publish (manual & scheduled), plus manual "Publish now" | Covers all publish surfaces |

### How it works (Graph API v25.0, `api/internal/services/instagram_service.go`)

Two-step per publish: create a media container (`POST /{ig-user-id}/media`, child
containers + a `CAROUSEL` parent for multi-image), then publish it
(`POST /{ig-user-id}/media_publish`). Constraints that shape the design:

- Image URLs must be **publicly reachable** by Meta — built from `APP_URL` + media
  path. Unset/localhost `APP_URL` fails fast with an actionable error.
- Rate limit: 25 published posts / 24 h per account.
- Long-lived tokens last ~60 days; a daily scheduler task refreshes them within ~7 days
  of expiry.

### Storage

- `blog_secrets` (never returned to clients): `instagram_app_id/app_secret`,
  `instagram_access_token/user_id/username/token_expires_at`.
- `blog_settings`: `enable_instagram`, `instagram_default_share`,
  `instagram_caption_template` (`{title}`, `{excerpt}`, `{tags}`, `{link}`).
- `posts` columns: `instagram_share`, `instagram_status` (`none|pending|published|failed`),
  `instagram_media_id`, `instagram_published_at`, `instagram_error`.

### Endpoints (admin-only)

`GET /api/instagram/connect` (OAuth redirect, CSRF state) · `GET .../callback` ·
`POST .../disconnect` · `GET .../status` · `POST /api/posts/:id/instagram/publish`.

Cross-posting is **best-effort**: failure records `instagram_status=failed` +
`instagram_error` and never blocks the Point publish; the editor surfaces the error
with a retry. (Known gap: some failures are too silent.)

## Import

`InstagramImportService` (`api/internal/services/instagram_import_service.go`)
orchestrates: page through `GET /{ig-user-id}/media` (captions, permalinks, carousel
children) → batch-dedup → download CDN media → create draft posts.

- **Dedup / idempotency** is keyed on an indexed `posts.imported_instagram_id` column,
  checked against **both** `imported_instagram_id` and `instagram_media_id` — so re-runs
  skip previous imports *and* posts that originated in Point and were cross-posted out.
- **Mapping**: title = first caption line (date title when empty); remainder = body;
  `excerpt` = original permalink; carousels become multi-image posts; status = draft
  (review before publishing). Media downloads go through `MediaService.UploadFile`,
  which already dedups by SHA256 and files under `/YYYY/MM/`.
- **API**: `POST /api/instagram/import` starts a background goroutine;
  `GET /api/instagram/import/status` reports in-memory progress; the last-run summary
  persists in `blog_settings` for display after reload.
- **UI**: an "Instagram Import" card on `/light/system` (last run, counts,
  Import/Sync Now, live progress), shown only when Instagram is connected.

## Out of scope

- Video / Reels publishing (needs async container status polling), Stories, comments,
  insights.
- Hashtag → tag conversion nuances beyond caption parsing.
- A Point-operated central OAuth proxy (rejected: Meta app review + shared infra).

## Meta app setup (operator guide)

1. [developers.facebook.com](https://developers.facebook.com) → Create App, type
   **Business**, add **Instagram Graph API**.
2. Permissions: `instagram_basic`, `instagram_content_publish` (Development mode is
   enough for a personal install when the account is an app tester/developer).
3. OAuth redirect URI: `https://yourblog.example.com/api/instagram/callback` —
   `APP_URL` must match exactly (no trailing slash).
4. Copy App ID / App Secret into Point **Settings → Instagram**, enable, Connect.
5. The account must be Instagram **Business or Creator** linked to a Facebook Page.
