# Tag System

Tags are Point's organizing spine: a multi-parent hierarchy (DAG) with recursive
archives and counts, typed behavior flags, geo-coordinates, and an in-memory snapshot
that makes every read O(1). This document describes the current (Go) model; it
supersedes the retired system-tag design and the original Python-era META-TAGGING doc.

## Core concepts

- **Meta-tags**: a tag with children logically contains them. `#newyork` can sit under
  both `#city` and `#us` — the structure is a DAG, not a tree.
- **Recursive retrieval**: a tag's archive page includes posts from all descendant
  tags (broad-to-narrow browsing).
- **Recursive counts**: `post_count` rolls up unique published posts from the whole
  subtree; separate public and admin counts.
- **An edge means "is part of", always.** Taxonomy is the only thing the graph
  encodes; behaviors are typed columns.

## Data model

```sql
tags
  id, name, slug (UNIQUE), description
  kind          TEXT DEFAULT 'topic'   -- 'topic' | 'year'
  hidden        BOOLEAN                -- inherits to all descendants
  hides_posts   BOOLEAN                -- inherits to all descendants
  nav_order     INTEGER NULL           -- NULL = not in public nav
  in_breadcrumbs, show_related, in_ancestor_flyout  BOOLEAN  -- tag-local
  latitude, longitude REAL             -- geo-tags (used by map + geocoding)
  post_count    INTEGER                -- denormalized rollup

tag_relationships
  parent_id, child_id  (PK)
  sort_order    INTEGER                -- position under THIS parent
```

Key points:

- **Per-edge `sort_order`**: a multi-parent tag has an independent position under each
  parent; drag-reordering in the admin tree renumbers only the affected sibling group.
  This also makes breadcrumbs deterministic (primary parent = lowest-ordered edge).
- **`kind='year'`** requires the slug to parse as a year; timeline and map year-range
  queries are an indexed filter, not a recursive CTE.
- **Cycle rejection at write time** (409 with the offending path); read-path
  visited-sets remain as belt-and-suspenders.
- **Unfiled is computed**: a tag with no parents is unfiled; the admin tree pins an
  "Unfiled (N)" queue with file-under / merge / delete actions.

## The TagGraph snapshot

`TagService` holds one `*TagGraph` rebuilt per write and read atomically per request:

```go
type TagGraph struct {
    ByID, BySlug        map[...]Tag
    Children, Parents   map[int64][]int64  // ordered by edge sort_order
    EffectiveHidden     map[int64]bool     // BFS from hidden=true
    EffectiveHidesPosts map[int64]bool     // BFS from hides_posts=true
    HiddenVia           map[int64]int64    // tagID → ancestor that caused hiding
    CountsPublic, CountsAdmin map[int64]int64
    NavTree             []NavTagNode
    YearTags            []Tag
}
```

Built lazily on first read; **invalidated by any tag write and any post-tag mutation**
(post save, publish, schedule-fire, delete, restore). Single process + SQLite means no
cross-process coherence problem. Nav trees, tag clouds, breadcrumbs, timeline year
sets, and visibility checks are all field reads from this snapshot.

## Inheritance — one rule

> A tag is effectively hidden (or effectively hides its posts) if the flag is set on
> the tag itself or on any ancestor. **No other property inherits.**

See [hidden-visibility.md](hidden-visibility.md) for the full guest/admin response
contract (`effective_hidden`, `effective_hides_posts`, `hidden_via`, 404 rules).

## Write API

- `PATCH /api/tags/:id` — partial update of scalar fields; absent field = untouched
  (the historical save-wipes-sort-order/custom_url bug class is unrepresentable).
- Structure edits are explicit: parents/children set-replacement endpoints plus a
  `move` operation (parent + position) that never touches the tag's other parents.
- Parentless creation is legal and lands in Unfiled.

## Admin & editor surfaces

- `/light/tags` (TagsManagerPage): the tree shows the whole truth — nav tags in
  `nav_order`, filed roots, pinned Unfiled queue; row badges for nav/hidden/inherited
  (inherited chips link to the ancestor that set the flag)/geo/year; every drag has a
  dialog twin (`Move…`) for touch parity; **merge tags** re-tags all posts.
- The post editor's TagsInput autocompletes with parent paths and counts and offers a
  deliberate-create popover with an inline parent picker.
- `TagFamilyPopover` (shared with the public site) shows ancestors + children for any
  tag chip.
- Geocoding: tags can be geocoded via Nominatim (`point_geocode_tag` over MCP, or the
  tag editor); coordinates feed the map visualization.

## History / rationale (why it looks like this)

The previous design encoded behaviors as graph edges to reserved `_`-prefixed "system
tags" (`_hidden`, `_root`, `_in_timeline`, …). It was retired because: the graph meant
three unrelated things; there were three different inheritance semantics; identity by
string prefix leaked into ~29 call sites; every public read rebuilt the world (one
guest request loaded the full graph 4× and ran the count CTE 3×); and PUT-everything
writes silently destroyed ordering. The migration (`tag_flags_from_system_tags`)
translated edges to the typed columns above and deleted all twelve system tags; the
`_` slug prefix is no longer reserved.

Rejected alternatives, kept for the record: an EAV `tag_attributes` table (recreates
system tags one table over), strict tree (multi-parent is genuinely used), closure
tables (write amplification to optimize reads a snapshot already makes O(1)),
per-post visibility instead of `hides_posts` (the real use case is subtree hiding).

## Notes for future development

- `tag_service.go` is still large; decomposition is planned.
- Any new tag behavior should be a typed column + (if it must inherit) a second BFS in
  the snapshot builder — never a reserved tag or string convention.
- `min_tag_posts_to_show` applies to effective (rolled-up) counts at read time.
