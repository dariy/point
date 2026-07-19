# Plugin Catalog

One page per entry in the plugin registry (`api/internal/plugins/registry.go`) — what
it does and how it's wired (type, slot, routes, area). For how the plugin *system*
itself works (enabled-only manifest, build pipeline, admin toggling), see
[Plugin System](../features/plugin-system.md).

## Tag visualizations — exclusive claim on `/tags`

- [tags-atlas](tags-atlas.md) — hierarchical tags directory (default)
- [tags-map](tags-map.md) — Leaflet world map of geo-tags
- [tags-graph](tags-graph.md) — force-directed graph of tag/post relationships

## Shell slots

- [timeline](timeline.md) — pan/zoom year control with density histogram
- [tag-cloud](tag-cloud.md) — home page `ExploreBlock`
- [nav-menu](nav-menu.md) — header nav + burger tags + admin menu editor
- [breadcrumbs](breadcrumbs.md) — header context-zone trail
- [public-header](public-header.md) — public site header shell
- [public-footer](public-footer.md) — public site footer
- [distraction-free](distraction-free.md) — chrome-free post list toggle

## Content enhancers

- [immersive](immersive.md) — standard full-screen media viewer (default)
- [immersive-sheet](immersive-sheet.md) — swipe-up sheet media viewer
- [custom-css](custom-css.md) — global custom CSS injection
- [comments](comments.md) — remark42 comments widget + moderation
- [post-navigation](post-navigation.md) — prev/next post links
- [immersive-share](immersive-share.md) — share button in the media viewer
- [slideshow](slideshow.md) — auto-advancing slideshow in the media viewer

## Admin routes (core, always enabled)

- [media-library](media-library.md) — `/light/media`
- [admin-posts-list](admin-posts-list.md) — `/light/posts`
- [admin-home](admin-home.md) — `/light` dashboard

## Backend-gated services

- [instagram](instagram.md) — cross-posting + import
- [ai-analysis](ai-analysis.md) — Gemini title/tags/excerpt suggestions
- [passkeys](passkeys.md) — WebAuthn login
- [api-keys](api-keys.md) — bearer-token API access
- [backups](backups.md) — tar.gz backup/restore
- [offline-sync](offline-sync.md) — PWA service worker + write queue
- [rss](rss.md) — RSS 2.0 feed
- [mcp](mcp.md) — Model Context Protocol server (off by default)
