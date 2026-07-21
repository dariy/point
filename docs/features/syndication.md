# Syndication & SEO

Small, boring-on-purpose features that make the blog a good web citizen.

## What is implemented

- **RSS 2.0** at `/feed.xml` (plugin `rss`, routes `/feed.xml` and `/feed`):
  auto-generated from published posts, reflects blog title/description settings,
  cached for one hour. Disabling the plugin 404s the routes and removes feed links.
- **XML sitemap**: all public posts and tag pages, cached six hours.
- **robots.txt**: dynamically generated — allows public content, blocks admin and API
  paths.
- **Per-post SEO meta description** (editor Details) for snippet control; canonical
  URLs are managed by the SPA page modules (`removeCanonical` on unmount).
- **`HEAD_HTML`** env var: extra HTML injected into `<head>` at serve time (analytics
  snippets, verification tags) — deployment-controlled, not stored in the DB, and
  composed with the other serve-time injections (plugin manifest, per-post meta) in the
  single `</head>` rewrite in `api/cmd/api/main.go`.
- **Auth-isolated injection**: two HTML shells are built at serve time — the public
  shell carries `HEAD_HTML`, the admin shell omits it entirely. Admin routes and any
  authenticated request always get the admin shell, so third-party script from
  `HEAD_HTML` never reaches an authenticated document, shrinking the XSS blast
  radius. `CSP_SCRIPT_SRC` / `CSP_CONNECT_SRC` let the operator extend the
  Content-Security-Policy to match whatever origin `HEAD_HTML` loads from
  (sanitized before being appended to the directives).
- Because of this isolation, login lives at a standalone, hard-loaded `/light/login`
  page rather than an in-SPA overlay: reaching it (`window.location.assign`, not a
  soft route change) guarantees the credential form always renders in a fresh
  document that never inherited injected markup from a prior guest page, and logout
  hard-navigates for the same reason.

## Key decisions

- All three documents are **generated with short caches**, not static files — they
  track content and settings with zero operator work, while caching keeps the cost
  negligible.
- Guest visibility rules apply: hidden posts/tags never appear in the feed or sitemap
  (the same server-side filtering as every public read).
- Server-side rendering for SEO was considered and rejected as orthogonal
  infrastructure; per-post serve-time `<head>` injection (meta/OG tags on
  `/posts/:slug`) covers crawlers' needs for the SPA.
