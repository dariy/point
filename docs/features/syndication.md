# Syndication & SEO

Small, boring-on-purpose features that make the blog a good web citizen.

## What is implemented

- **RSS 2.0** at `/feed.xml` (plugin `rss`, routes `/feed.xml` and `/feed`):
  auto-generated from published posts, reflects blog title/description settings,
  cached for one hour. Disabling the plugin 404s the routes and removes feed links.
- **XML sitemap**: all public posts and tag pages, cached six hours.
- **robots.txt**: dynamically generated — allows public content, blocks admin and API
  paths.
- **Serve-time `<head>` metadata** on the three public route families — `/`, `/tags/:slug`
  and `/posts/:slug` — built in `api/cmd/api/seo.go` and spliced into the shell before
  any JS runs, so a link shared into a chat unfurls with a title, a description and a
  card image instead of the placeholder title. The homepage and tag archives describe
  themselves from settings and from the tag; a post carries `og:type=article` and its
  first usable photograph at the 1024 rung. A post opened from inside an archive is
  served at `/tags/:slug?slug=<post>` (that is how `ViewContext` serializes the view),
  so that URL is described as the post, not as the archive.
- **Per-post SEO meta description** (editor Details) for snippet control.
- **Canonical URLs** are emitted server-side on all three families and then kept in
  sync by the SPA page modules (`setCanonical` updates the served element in place;
  `removeCanonical` on unmount). A paginated canonical — the feed, an archive — carries
  the page number and nothing else: `?path=`, `?per_page=` and campaign parameters
  address the same page and would each be a duplicate of it. A post canonicalises to
  its bare `/posts/:slug`, page number included in what is dropped, because the page
  belongs to the feed the reader came through and not to the post.
- **`HEAD_HTML`** env var: extra HTML injected into `<head>` at serve time (analytics
  snippets, verification tags) — deployment-controlled, not stored in the DB, and
  composed with the other serve-time injections (plugin manifest, per-post meta) in the
  serve-time shell build in `api/cmd/api/assets.go` (`loadHTMLShells`).
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
  infrastructure; serve-time `<head>` injection covers crawlers' needs for the SPA.
- **Nothing is described that an anonymous reader could not already read.** A draft, a
  post withdrawn to hidden and a scheduled post all fall through to the generic shell,
  as does a published post filed under a `hides_posts` tag — the post API 404s that one
  to a guest, so the head must not describe it — and a tag marked hidden, and a tag
  under the `min_tag_posts_to_show` floor. Both gates read the same tag snapshot the
  public read paths do (`BuildTagView`, `GetPostBySlug`), and a snapshot that fails to
  load is treated as "hidden", never as "visible".
- A tag archive's card image is the **site logo, not a post's photograph**: an archive
  has no one photograph, and choosing one would mean running the per-post visibility
  gate (a post hidden through a `hides_posts` tag is still filed under this tag) over
  candidates until one passes.
- The `<title>` is composed exactly as `setPageTitle()` composes it on the client, so
  hydration is not a visible title change. `X-Forwarded-Proto` is honoured when building
  absolute URLs, but read as an enum — the first entry, and only `http` or `https`, since
  a proxy chain appends to that header and a client can send one directly;
  `X-Forwarded-Host` deliberately is not honoured at all, because guest shells are stamped
  `public, max-age=60` and shared caches key on `Host` — honouring a header they do not
  key on is how one visitor's spoofed request poisons everyone else's canonical.
