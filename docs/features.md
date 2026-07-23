# Point Engine — Feature Reference

A complete feature listing for the Point self-hosted photo blog engine.
For in-depth technical documentation per feature (implementation, architecture
decisions, future-development notes) see [`features/`](./features/) — index in
[README.md](./README.md).

---

## Deployment & Infrastructure

| Feature | Description |
|---|---|
| Single-container deployment | Run the entire stack with one `docker run` command — no compose file or external services required. |
| Multi-architecture images | Pre-built images for amd64 and arm64 published to GitHub Container Registry (ghcr.io). |
| Zero external dependencies | All data lives in a single SQLite file. No Postgres, Redis, or cloud storage accounts needed. |
| Non-root container | The runtime process runs as an unprivileged user, following security best practices. |
| Graceful shutdown | SIGTERM/SIGINT triggers a clean 30-second drain so in-flight requests finish before the process exits. |
| Health endpoint | `GET /health` returns a liveness signal suitable for Docker health checks and orchestrators. |
| Version check | `GET /api/system/version` reports the running release and whether a newer version is available on GitHub. |
| Production setup guide | Documented nginx + systemd + TLS setup for running Point as a hardened long-lived service. |

---

## Media Management

*Full details: [Media Pipeline](./features/media.md)*

| Feature | Description |
|---|---|
| Multi-format upload | Accepts photos (JPEG, PNG, WebP, etc.), videos, and audio files in a single unified media library. |
| Automatic thumbnails | Generates cropped thumbnails on upload using configurable width, height, and JPEG quality. |
| EXIF extraction | Reads camera make/model, date, exposure time, f-number, ISO, focal length, and GPS from JPEG files automatically. |
| EXIF editing & revert | Admins can edit extracted EXIF fields and revert to the original on-disk values at any time. |
| Photo library import | Point a read-only path (e.g. a Lightroom export folder) at the engine; it imports new files without moving or copying originals. |
| Folder browser | The media library is browsable by folder and filterable by file type (image, video, audio). |
| Orphaned media cleanup | Detects media files not referenced by any post and removes them individually or in bulk. |
| Thumbnail rebuild | Regenerates thumbnails for all media or only those missing a thumbnail — useful after changing dimensions. |
| Media rename | Renames a media file with validation (safe characters only) while keeping all post references intact. |
| Storage statistics | Dashboard card showing total disk usage broken down by media type. |

---

## AI-Powered Assistance

*Full details: [AI Analysis](./features/ai-analysis.md)*

| Feature | Description |
|---|---|
| Gemini image analysis | Integrates with Google Gemini to analyze uploaded images and suggest a title, tags, and excerpt. |
| One-click AI fill | Each AI-supported field in the post editor has a sparkle button that populates it from the analysis result. |
| Customizable prompts | The prompt for each AI field (title, tags, excerpt) is configurable in Settings, allowing fine-tuned output. |
| Model fallback chain | Automatically tries gemini-2.0-flash then falls back to gemini-1.5-flash if the primary model is unavailable. |
| Fully optional | Point runs with all features intact when no Gemini API key is configured — AI is a progressive enhancement. |

---

## Content & Publishing

*Full details: [Content & Publishing](./features/publishing.md)*

| Feature | Description |
|---|---|
| Markdown editor | Posts are written in Markdown with GitHub-flavored extensions (tables, strikethrough, autolinks). |
| Syntax highlighting | Fenced code blocks are highlighted server-side via Chroma, supporting dozens of languages. |
| HTML formatter | Authors can switch to raw HTML for full layout control when Markdown isn't enough. |
| Post scheduling | Set a future publish date/time; the background scheduler auto-publishes within one minute of the target. |
| Post statuses | Four lifecycle states — draft, scheduled, published, hidden — with clean status transitions. |
| Featured flag | Mark posts as featured for use in curated grids or highlighted sections. |
| Auto-save | The post editor saves a draft automatically every 30 seconds so no work is lost. |
| Preview links | Generate a time-limited, shareable URL to let collaborators or clients review an unpublished post. |
| View count | Each post tracks how many times it has been viewed, visible in the admin list and post detail. |
| SEO meta description | Per-post meta description field for search engine snippet control. |

---

## Tagging & Organization

*Full details: [Tag System](./features/tag-system.md), [Hidden Posts & Tags](./features/hidden-visibility.md)*

| Feature | Description |
|---|---|
| Hierarchical tag system | Tags form a directed acyclic graph (DAG): a tag can have multiple parents and multiple children. |
| Recursive post counts | A parent tag's post count includes all posts on itself and every descendant — accurately reflecting its full scope. |
| Recursive post retrieval | Browsing a parent tag's archive automatically surfaces posts from all child tags, enabling broad-to-narrow discovery. |
| Tag visibility control | `hidden` removes a tag from all public navigation; `hides_posts` hides posts carrying that tag from guests. Both flags are typed columns on the `tags` table. |
| Inherited hidden status | Both `hidden` and `hides_posts` propagate to all descendants via BFS — one toggle to hide an entire sub-hierarchy or make all its posts guest-invisible. |
| Location-aware tags | Tags can store a latitude/longitude coordinate, making them show up as pins on the map page. |
| Tag reordering | Drag tags into a custom display order from the tag manager. |

---

## Public Blog Frontend

*Full details: [Public UX](./features/public-ux.md), [Tags Visualization](./features/tags-visualization.md), [Timeline](./features/timeline.md), [Immersive Mode & Slideshow](./features/immersive.md)*

| Feature | Description |
|---|---|
| Responsive post grid | Paginated photo grid adapts gracefully to any screen size. |
| Tag cloud | Sidebar tag cloud weighted by post count for at-a-glance content discovery. |
| Tag archive pages | Each tag has a dedicated archive page with a breadcrumb reflecting its position in the hierarchy. |
| Tags overview page | A hierarchical tags page showing every public tag with thumbnails and post counts. |
| Full-text search | Public search page queries post titles and content with paginated results. |
| Interactive SVG timeline | Horizontal timeline bar showing years and decades; clicking a period filters the view. Supports location drill-down within a time range. |
| Map view | Leaflet-powered world map with country polygon fills for country-type tags and proportional circle markers for cities; clicking a marker navigates to that tag's archive. |
| Immersive viewer | Full-screen, distraction-free post view with no chrome — ideal for photo stories. |
| Media lightbox | Keyboard-navigable full-screen media viewer with pinch-to-zoom, swipe navigation, and drag-to-pan on touch devices. |

---

## Themes & Customization

*Full details: [Themes](./features/themes.md)*

| Feature | Description |
|---|---|
| Light / dark / auto modes | Three built-in theme modes; auto follows the OS preference via `prefers-color-scheme`. |
| Theme toggle | Visitors can override the auto mode with a persistent toggle saved to localStorage. |
| CSS theme system | Custom themes are defined as CSS files. |
| CSS custom property overrides | Every color and spacing value is exposed as a CSS custom property for surgical per-site tweaks. |
| Blog metadata settings | Blog title and description are configurable from the admin Settings page and reflected in the public UI and RSS feed. |

---

## Syndication & SEO

*Full details: [Syndication & SEO](./features/syndication.md)*

| Feature | Description |
|---|---|
| RSS 2.0 feed | Auto-generated RSS feed of published posts, served at `/feed.xml` and cached for one hour. |
| XML sitemap | Auto-generated sitemap covering all public posts and tag pages, cached for six hours. |
| robots.txt | Dynamically generated robots.txt that allows public content and blocks the admin and API paths. |

---

## Offline & PWA

| Feature | Description |
|---|---|
| Service Worker caching | The SPA shell is cached with stale-while-revalidate, so returning visitors load instantly even on flaky connections. |
| Offline fallback | When the network is unavailable, a friendly offline page is served instead of a browser error. |
| Web Share Target | On supported mobile browsers, Point appears in the system share sheet — share a photo from your gallery directly into a new post draft. |
| Image caching layer | The Service Worker maintains a dedicated image cache, reducing repeat-visit bandwidth for media-heavy blogs. |
| Offline snapshot API | An admin-triggered snapshot bundles post data for offline reading scenarios. |

---

## Admin Panel

*Full details: [Admin UX](./features/admin-ux.md); Security page: [Auth & Account Security](./features/auth.md)*

| Feature | Description |
|---|---|
| Dashboard | At-a-glance stats: total posts, media count, tag count, server uptime, and new-version notification. |
| Post list | Searchable, filterable (by status and featured flag) list of all posts with inline status indicators. |
| Drag-and-drop upload | Drop a file anywhere on any admin page to instantly upload it and open a new post pre-populated with that media. |
| Tag manager | Full tag tree with inline create, edit, and delete; drag to reorder; multi-parent assignment. |
| Media library | Browse, filter, rename, and bulk-delete media; view storage stats and clean up orphaned files. |
| Settings page | Configure blog metadata, Gemini AI key, photo library import path, active theme, and thumbnail dimensions. |
| Security page | View all active sessions with device/IP info; revoke individual sessions or log out all other devices; change password; trigger a password reset link. |
| System page | Create, restore, download (move out), and upload/restore (move in) tar.gz backups — download and upload re-verify the account password; stream live application logs; view disk usage; trigger photo library import; rebuild thumbnails. |

---

## Security

*Full details: [Auth & Account Security](./features/auth.md)*

| Feature | Description |
|---|---|
| bcrypt password hashing | Passwords are hashed with bcrypt at the default cost factor — never stored in plaintext. |
| HTTP-only session cookies | Session tokens are set as HTTP-only cookies, invisible to JavaScript and immune to XSS token theft. |
| Configurable session TTL | Session lifetime defaults to 30 days and is adjustable per deployment via environment variable. |
| One-time password reset tokens | Reset tokens are hashed before storage, single-use, and expire after one hour. |
| Secrets isolation | Sensitive values (API keys, reset tokens) are never returned by API endpoints. |
| Guest content filtering | All visibility rules are enforced server-side; guest responses contain only public-safe content — the frontend never makes access decisions. |
| Auth-guarded admin routes | Every admin route requires a valid session; unauthenticated requests are redirected to the login page. |
