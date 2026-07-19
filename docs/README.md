# Point Documentation

Welcome to the Point documentation.

## Architecture

- [Frontend Architecture](./architecture/frontend.md) — Vanilla JS Component System
- [Backend Architecture](./architecture/backend.md) — Go & SQLC Service Layer

## Feature docs

Technical documentation per feature: what is implemented, key architectural
decisions, out-of-scope notes, and gotchas for future development.

- [Plugin System](./features/plugin-system.md) — enabled-only manifest, registry, build pipeline
- [MCP Server](./features/mcp.md) — 28 tools at `/mcp`, OAuth 2.1 + API-key auth
- [Instagram Integration](./features/instagram-integration.md) — cross-posting and import
- [Tag System](./features/tag-system.md) — multi-parent DAG, typed flags, TagGraph snapshot
- [Hidden Posts & Tags](./features/hidden-visibility.md) — visibility rules and guest filtering
- [Tags Visualization](./features/tags-visualization.md) — `/tags` as Atlas, Map, or force Graph
- [Timeline](./features/timeline.md) — pan/zoom year control with density histogram
- [Media Pipeline](./features/media.md) — uploads, thumbnails, EXIF, library import, visibility
- [AI Analysis](./features/ai-analysis.md) — Gemini title/tags/excerpt suggestions
- [Content & Publishing](./features/publishing.md) — editor, autosave model, scheduling, previews
- [Immersive Mode & Slideshow](./features/immersive.md) — full-screen viewer plugin family
- [Comments](./features/comments.md) — supervised remark42 engine
- [Themes](./features/themes.md) — CSS-file themes, dark/light/auto
- [Header Navigation](./features/header-nav.md) — four zones, one fold engine
- [Auth & Account Security](./features/auth.md) — sessions, passkeys, API keys, recovery
- [Syndication & SEO](./features/syndication.md) — RSS, sitemap, robots, HEAD_HTML
- [Admin UX](./features/admin-ux.md) — two-layer admin design system
- [Public UX](./features/public-ux.md) — ViewContext, tag interaction, responsive matrix

Design proposals graduate into these docs once implemented (or are recorded in their
"considered and rejected" sections); proposals are not kept as separate files.

## Guides

- [Feature Reference](./features.md) — one-line listing of all engine features
- [Testing](./testing.md) — test layout and how to run
- [Usages](./usages.md) — operational recipes
- [Troubleshooting](./troubleshooting.md) — common issues and solutions

## External Links

- [GitHub Repository](https://github.com/dariy/point)
- [Quickstart Guide](../QUICKSTART.md)
- [Production Setup](../scripts/SETUP-PRODUCTION.md)
