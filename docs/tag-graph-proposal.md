# Redesign `/tags`: a two-type, draggable force graph

## Context

The public `/tags` page (`frontend/src/pages/public/TagsPage.js`) renders ~200 tags as a collapsible
nested `<ul>` tree. It shows only the imposed hierarchy, conveys no magnitude, and can't express the
relationship that actually matters — which tags are **related because posts connect them**.

The redesign is a **force-directed graph** that makes two relationship types explicit:

1. **Parent/child** — tag→tag edges from the hierarchy.
2. **Related-through-post** — each post is its own node ("shadow" node) linked to every tag it
   carries; two tags are visibly related because a shared post node sits between them.

**Decisions:**
- **Post nodes:** include **all posts** as shadow nodes. Single-tag posts are rare (posts usually
  carry 5+ tags); a future toggle to hide 1-tag posts is a nice-to-have, **not** in v1.
- **Library:** the codebase already vendors **leaflet** (lazy-loaded per page) and **codejar/prismjs**
  (bundled). Add a small **force-layout module** vendored under `frontend/vendor/` and **lazy-load it
  only on this page**, mirroring the leaflet pattern in `MapPage.js`. Render on **`<canvas>`** (hundreds
  of nodes + thousands of membership edges make SVG too slow for dragging).
- **Node size = degree** (number of incident edges).
- **Timeline slicer: NOT in v1.** Surface time via **year nodes** — tags carry `kind='year'`
  (`TagGraph.YearTags`), so they come "for free" and get a **distinct visual indication**. A year node
  is **only** an explicit `kind='year'` tag — never derived from a post's `created_at`.
- **Geo-tags get their own indication.** Geography *behavior* (the map) stays out of scope (owned by
  `/map`), but a tag with coordinates (`latitude`/`longitude` set) is rendered as a **fourth, distinct
  node kind** — visual indication only.

So there are **four node kinds** (plain tag / year-tag / geo-tag / post) and **two edge kinds**
(hierarchy / membership). Node kind is derived on the frontend: `kind='year'` → year-tag; else has
`latitude`/`longitude` → geo-tag; else plain tag (fixed precedence if a tag qualifies for two).

## Approach

### 1. Backend — new `GET /api/pages/graph` endpoint

No existing endpoint returns the post↔tag incidence in bulk, so add one, wired like `GetTagsPage`
(route in `api/cmd/api/main.go` under the `/api/pages` group with `OptionalAuthMiddleware`; handler
`GetTagsGraph` in `api/internal/api/pages.go`). Reuse existing queries:
- **Tags + hierarchy:** `tagService` snapshot (`GetTagSnapshot`) for tag metadata incl. `kind` and
  `latitude`/`longitude`, plus `repo.GetAllTagRelationships()` for `(parent_id, child_id)` edges.
- **Posts + membership:** list posts (published-only when `user == nil`), then
  `repo.GetTagsByPostIDs(postIDs)` → flatten into `(post_id, tag_id)` edges.

Response shape:
```json
{
  "tags":  [{ "id", "name", "slug", "kind", "latitude", "longitude", "post_count" }],
  "posts": [{ "id", "slug", "title" }],
  "hierarchyEdges":  [{ "parent": <tagId>, "child": <tagId> }],
  "membershipEdges": [{ "post": <postId>, "tag": <tagId> }]
}
```
(No `year` field on posts. Respect `effective_hidden` tags / unpublished posts for anonymous viewers.)

### 2. Frontend data + lazy-loaded force lib

- Add `getTagsGraph()` to `frontend/src/api/pages.js` (mirror `getTagsPage`).
- Vendor a small force module at `frontend/vendor/d3-force/` and **lazy-load** it on mount (dynamic
  `import()`), as `MapPage.js` lazy-loads leaflet — keeping it out of the main `app.js` bundle.

### 3. Graph controller — new `frontend/src/utils/tagGraph.js`

Keep `TagsPage.js` thin; put canvas/physics logic here:
- Build sim node/link arrays from the payload; **degree** per node → radius.
- Each tick **draw to canvas**: membership edges (thin/faint), hierarchy edges (solid/accent), then
  nodes per kind — **plain tag** (light fill), **year-tag** (distinct), **geo-tag** (its own distinct
  indication; no map behavior), **post** (small "shadow" node).
- **Drag**: pointer hit-testing (sim `find(x,y)`); pin while dragging, release on pointerup.
- **Pan/zoom**: hand-rolled canvas transform (wheel zoom, background-drag pan) — no extra dep.
- **Hover/click**: hover highlights node + neighbors + label; click tag/year/geo node →
  `navigate('/tags/<slug>')`, click post node → navigate to that post.
- Expose `destroy()` (stop sim / remove listeners), called from `beforeUnmount`.

### 4. Rewrite the view — `frontend/src/pages/public/TagsPage.js`

Keep the shell (`site-wrapper`, header/footer mounts, `tag-header`, `#tag-filter-input`, loading/error).
Replace the tree body with: a `<canvas>` host + small **legend** + lightweight **controls** (zoom/reset),
and a **visually-hidden `<ul>`** of all tag links (alphabetical) as the keyboard/screen-reader fallback.
`mount()` fetches `getTagsGraph()` + lazy-loads the force lib, hands data to `tagGraph.js`. **Search**
reuses `#tag-filter-input` to highlight/center matching tag nodes and fade the rest. Remove tree-only
code (`_renderTag`, `_filterTree`, collapse wiring, `setupTagFlyout`); `beforeUnmount` calls `destroy()`
and `removeCanonical()`.

### 5. Styles — `frontend/css/public/tag-archive.css`

Add a `.tag-graph` block: responsive canvas container, legend, control buttons, hover label/tooltip,
`.sr-only` fallback list, and a `prefers-reduced-motion` rule. Theme-aware via existing CSS custom
properties. Trim unused `.tags-tree*` rules.

## Critical files

- `api/internal/api/pages.go` — **new** `GetTagsGraph` handler.
- `api/cmd/api/main.go` — register `GET /api/pages/graph`.
- `api/internal/repository/queries_tags.go` / `queries_posts.go` — reuse `GetAllTagRelationships`,
  `GetTagsByPostIDs`, published-posts list.
- `frontend/vendor/d3-force/…` — **new** vendored force module (lazy-loaded).
- `frontend/src/api/pages.js` — add `getTagsGraph()`.
- `frontend/src/utils/tagGraph.js` — **new** canvas/physics/interaction controller.
- `frontend/src/pages/public/TagsPage.js` — rewrite to host the graph.
- `frontend/css/public/tag-archive.css` — graph/legend/controls/sr-only/reduced-motion styles.

## Out of scope (noted for later)

- Timeline date-range slicer (year nodes stand in for v1).
- Toggle to hide single-tag posts (data supports it).
- Geography (owned by `/map`).

## Verification

1. Build frontend (`scripts/build-js.sh`) + run `scripts/run-local.sh` (localhost:8001). Confirm
   `/api/pages/graph` returns tags, posts, and both edge lists.
2. On `/tags`: four distinct node kinds + two distinguishable edge kinds; node size scales with degree;
   drag + pan/zoom work; hover highlights neighbors; clicking navigates; search highlights matching tag
   nodes; anonymous view excludes unpublished posts / hidden tags; sr-only fallback present; smooth perf.
3. Optionally capture before/after screenshots via the visual-review (Playwright) skill.
