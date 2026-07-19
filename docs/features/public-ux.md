# Public UX

Design system for the visitor-facing SPA (routes: `/`, `/posts/:slug`, `/tags`,
`/tags/:slug`, `/search`, `/preview/:token`; pages in `frontend/src/pages/public/`,
shell components in `frontend/src/components/public/` and plugins). The 2026 redesign
(beads **point-krcu**) targeted consistency and legibility.

## Design principles

1. **The URL is the interface** — every reachable view state (tag, years, query, page,
   slide) is in the URL, restorable and shareable; Back always means "where I just was".
2. **One mental model for tags** — a tag looks and clicks the same on every surface.
3. **Click is for going; hover/long-press is for peeking** — no primary action behind
   a second click or a hover-only control.
4. **Content leads, chrome recedes** — big screens get more content, never wider text.
5. Every screen class (phone landscape, tablet, 21:9/32:9) is a designed state.

## What is implemented

- **ViewContext** (`frontend/src/utils/viewContext.js`): the single URL-backed filter
  state `{ tag, years, query, page, perPage, postSlug }`. Pages render from it;
  Timeline, header, search, and pagination *request* context changes and re-render on
  the resulting URL change — components never talk to each other directly. Designed so
  `tag` can become `tags[]` later without rework.
- **Tag interaction, unified**: one click/tap navigates everywhere. Hierarchy peek is
  hover-intent on fine pointers and **long-press** on touch (`frontend/src/utils/
  tags.js`), opening the shared family popover/bottom-sheet (ancestors above, children
  below, with counts — same `TagFamilyPopover` used in the admin). The old two-click
  flyout and 300 ms chip re-click patterns are gone.
- **Header**: four-zone single row with the measured fold engine — see
  [header-nav.md](header-nav.md) for the full design (zones, fold ladder, nav menu
  modes, `/light/menu`).
- **Explore block** (`tag-cloud` plugin, `ExploreBlock.js`): replaced the weighted
  font-size tag cloud on the home page — top tags as plain pills + "All tags →".
- **Search**: matches tag names as well as posts; SearchPage shows a tags strip above
  post results (a place seen as a pill is findable).
- **Responsive matrix**: em-based breakpoints plus pointer/orientation axes;
  `--content-max-width: clamp(75rem, 90vw, 112rem)` (`frontend/css/public/tokens.css`)
  — grids grow to 4–5 columns on ultrawide while prose stays at the narrow reading
  width; ≥44 px touch targets via hit-slop; hover parity (carets and controls always
  rendered on coarse pointers); safe-area insets.
- **Pagination, not infinite scroll** — URL-addressable, footer reachable — with
  rubber-band swipe navigation; `per_page` is device-fit and URL-persisted.
- **Sharing**: `immersive-share` plugin — native share / copy-link, per-slide URLs
  (see [immersive.md](immersive.md)).
- **Offline/PWA**: service-worker shell caching (stale-while-revalidate), offline
  fallback page, image cache, Web Share Target into a draft.

## Not (yet) implemented from the proposal

- **Filter chips row** (removable facet chips + "Clear all · N posts" between header
  and content, `aria-live`) — the context model supports it; the chrome doesn't exist.
- **Scoped search** (`/search?q=…&tag=…` carrying the current tag as a removable chip).
- **Search typeahead** with recent searches.
- Post-page side rail + figure breakout on ultrawide; visible immersive/article mode
  toggle.

## Considered and rejected

- Infinite scroll (breaks URLs, footer, position memory).
- Multi-tag AND/OR filter UI — deferred, not rejected; needs API support and fights
  the distraction-free goal.
- Mega-menu header; masonry grid (scan order, layout shift); SSR for SEO (orthogonal —
  serve-time `<head>` injection covers crawlers); sticky sidebar filling ultrawide
  dead space (chrome for its own sake).

## Notes for future development

- New public state belongs in ViewContext + the URL — never in component-private
  filter state.
- A visible tag must never 404: surfaces must respect the same visibility filters as
  tag pages (`min_tag_posts_to_show`, effective hidden).
- Any new hover affordance needs a touch path; any new gesture needs a visible
  alternative.
