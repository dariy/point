# Tag System — Ground-Up Redesign Proposal

Proposal for redesigning the tag system: hierarchy semantics, system-tag
inheritance, and management in `/light/tags`. Proposal only — no
implementation. Tracked under beads issue **point-krcu**, companion to the
[Admin UX proposal](admin-ux-proposal.md), the
[Public UX proposal](public-ux-proposal.md), and the
[Timeline proposal](timeline-ux-proposal.md).

## Background

### What exists

The taxonomy core is sound and predates everything else
([META-TAGGING.md](META-TAGGING.md)): tags form a multi-parent DAG via
`tag_relationships (parent_id, child_id)`, archives are recursive (a parent
tag's page shows descendant posts), and post counts roll up through the
hierarchy. None of that is in question here.

On top of it sits the **system-tag mechanism**. Tags once had boolean
columns (`is_featured`, `is_hidden`, `is_hidden_posts`,
`include_in_breadcrumbs`, `show_related_tags_as_children`); migrations
`system_tags_phase_a/b` (`queries_migrations.go`) moved those flags *into
the graph*: a reserved tag with a `_`-prefixed slug per behavior, and
"tag X has behavior B" encoded as the edge `_B → X`. Today there are
**twelve** reserved slugs:

| System tag | Meaning | Who inherits it | Status |
|---|---|---|---|
| `_system` | groups the others in the tree | — | cosmetic only |
| `_root` | children appear in public nav | direct children only | live |
| `_hidden` | tag hidden from public surfaces | **all descendants** | live |
| `_hide_posts` | posts carrying the tag hidden from guests | **all descendants** | live |
| `_is_in_breadcrumbs` | tag shown in breadcrumb path | direct children only | live |
| `_with_related` | related tags shown as children | direct children only | live |
| `_no_ancestors` | tag excluded from ancestor flyout | direct children only | live |
| `_pending` | "unfiled" queue for parentless tags | direct children only | live, duplicated (see below) |
| `_page` | descendants excluded from public grids | all descendants | half-dead: `PageTagIDs()` has no callers; only effect is via `PublicHiddenTagIDs` (≈ hidden) |
| `_in_timeline` | descendants whose slug parses as an integer are timeline year tags | descendants that `CAST` to a year | live (timeline, map year filter) |
| `_type_page` | post tagged with it renders as "page" | attached to posts, not tags | unreachable: `CreateTag` rejects `_` slugs and `Slugify` strips `_`, so it can only exist by hand-editing the DB |
| `_type_audio` | post renders as "audio" | attached to posts | unreachable, same reason |

### Why it feels overengineered

1. **The graph means three unrelated things.** Taxonomy
   (`travel → portugal`), behavior flags (`_hidden → friends`), and scoping
   (`_in_timeline → 2024`). Every consumer must first decide which kind of
   edge it is looking at, which is why the admin tree hard-codes a
   `HIDDEN_SYSTEM` set, the parent picker hard-codes an `EXCLUDE` set, the
   editor modal re-renders five specific parents as "Features" checkboxes
   (that submit as `parent_ids`!), and the tree shows only `_root` and
   `_pending` as top-level nodes.

2. **Three different inheritance semantics**, distinguishable only by
   reading the service code: direct-children-only (`_root`,
   `_with_related`, `_is_in_breadcrumbs`, `_no_ancestors`, `_pending`),
   full-descendant BFS (`_hidden`, `_hide_posts`, `_page`), and
   descendants-whose-slug-casts-to-integer (`_in_timeline`). The docs have
   already lost track: `hidden-visibility.md` states `is_hidden_posts`
   does **not** propagate to children, while
   `buildEffectivelyHiddenPostsTagIDs` propagates it to all descendants.
   `features.md` still documents the dropped boolean columns.

3. **Identity by string prefix.** "Is this a system tag?" is answered by
   `strings.HasPrefix(slug, "_")` at 19 call sites plus
   `NOT LIKE '\_%' ESCAPE '\'` in 10 SQL queries. The prefix is load-bearing
   in validation, filtering, breadcrumbs, tag clouds, and migrations — and
   it has already collided with itself once (`DropTagNameUnique` exists
   solely because a user tag wanted the display name "root").

4. **Every public read recomputes the world.** Because flags live in the
   graph, answering "is this tag hidden?" requires loading *all* tags and
   *all* relationships and running a BFS. `tag_service.go` (1,151 lines) is
   mostly seven near-identical set-builders (`EffectivelyHiddenIDs`,
   `PublicHiddenTagIDs`, `EffectivelyHiddenPostsTagIDs`, `WithRelatedIDs`,
   `InBreadcrumbsIDs`, `PageTagIDs`, `buildEffectivelyHidden*`). One
   `GET /api/tags/slug/:slug` as a guest loads the full tag graph **four
   times** and runs the full recursive post-count CTE **three times**.
   Handlers call these in 44 places.

5. **Writes are fragile.** The API is PUT-everything: the modal must echo
   back name, slug, parents, children, and locations on every save. Two
   live consequences: every save wipes `custom_url` (UI always sends `''`)
   and — worse — **every save resets `sort_order` to NULL** (UI always
   sends `null`), silently destroying the drag-and-drop ordering the user
   set in the tree. Additionally `sort_order` is a single column on the
   tag, but a multi-parent tag sits in several sibling groups: reordering
   it under one parent clobbers its position under every other parent. A
   drag-*onto* in the tree sets `parent_ids: [target]`, silently discarding
   all other parents.

6. **Duplicate and dead mechanisms.** "Unfiled" exists twice: as real
   `_pending` edges (auto-assigned in `SetTagParents` and
   `getOrCreateTag`) *and* as a virtual presentation-layer injection in the
   `ListTags` handler for parentless tags. Cycle handling exists only
   defensively (visited-sets and `UNION` recursion guards everywhere)
   because nothing prevents writing a cycle. `custom_url` is write-only.
   `_system` is decoration. `PageTagIDs` is dead code.

The system-tag experiment bought one real thing — adding a behavior without
a schema migration — and paid for it with three inheritance semantics, a
string-prefix type system, per-request graph rebuilding, and an admin UI
whose main job is hiding the model from the user. For a single-author blog
that owns its schema and already has a disciplined `migration_history`
mechanism, that trade is upside-down.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| What the hierarchy means | **Taxonomy only.** Behaviors move to typed columns on `tags`; system tags are removed entirely | One meaning per edge; the admin tree can show the whole truth; consumers stop classifying edges |
| Multi-parent DAG | **Keep**, with cycle rejection at write time | Multi-parent is genuinely used (`lisbon` under both `portugal` and `cities`); defensive-only cycle handling is replaced by prevention |
| Inheritance | **One rule**: visibility flags (`hidden`, `hides_posts`) inherit to all descendants; everything else applies to the tag itself only | Replaces three semantics with one sentence; matches the only inheritance users actually rely on (hide a subtree) |
| Year tags | Explicit `kind = 'year'` column instead of the `_in_timeline` subtree | "Is a year" is a property of the tag, not its ancestry; timeline queries become an indexed filter instead of a recursive CTE |
| Post types | `_type_page` / `_type_audio` retire; post type becomes a `posts` concern | They are unreachable through the UI today; a post's render type was never a taxonomy fact |
| Unfiled | **Computed**: a tag with no parents is unfiled; `_pending` (both copies) removed | One source of truth; aligns with the admin proposal's pinned Unfiled queue (F3) |
| Sibling ordering | `sort_order` moves to the **edge** (`tag_relationships`); nav membership/order becomes `nav_order` on the tag | A tag has one position *per parent*; fixes the cross-group clobbering and the save-wipes-order bug class |
| Derived state | One in-process **tag-graph snapshot**, rebuilt on tag/post-tag writes | Single-process SQLite makes this trivially safe; replaces 4× graph loads + 3× count CTEs per request with one lookup |
| Write API | **PATCH semantics** + a dedicated `move` operation | Saves change only what was edited; the wipe bugs become unrepresentable |

## Design principles

1. **An edge means "is part of", always.** If a fact is not taxonomy, it
   does not live in the graph.
2. **Properties are visible where they live.** A flag is a typed column on
   the row you're looking at — not an edge to a magic node three hops away.
3. **One inheritance rule, stated in one sentence.** Visibility flows down;
   nothing else does.
4. **Invalid states are unrepresentable.** Cycles rejected on write; flags
   can't be "half-set" through a stale `parent_ids` echo; partial updates
   can't destroy unrelated fields.
5. **Read paths compute nothing twice.** Derived sets (effective hidden,
   rolled-up counts, nav tree) come from one snapshot with one rebuild
   point.

## Proposed design

### A. Data model

```sql
tags
  id            INTEGER PRIMARY KEY
  name          VARCHAR(100) NOT NULL
  slug          VARCHAR(100) NOT NULL UNIQUE
  description   TEXT
  kind          TEXT NOT NULL DEFAULT 'topic'   -- 'topic' | 'year'
  hidden        BOOLEAN NOT NULL DEFAULT 0      -- inherits ↓
  hides_posts   BOOLEAN NOT NULL DEFAULT 0      -- inherits ↓
  nav_order     INTEGER                          -- NULL = not in public nav
  in_breadcrumbs BOOLEAN NOT NULL DEFAULT 0
  show_related  BOOLEAN NOT NULL DEFAULT 0
  in_ancestor_flyout BOOLEAN NOT NULL DEFAULT 1  -- inverts _no_ancestors
  latitude      REAL                             -- tag_locations folds in
  longitude     REAL                             --   (already 1:1 by UNIQUE)
  post_count    INTEGER NOT NULL DEFAULT 0       -- denormalized, as today
  created_at    DATETIME NOT NULL

tag_relationships
  parent_id     INTEGER NOT NULL REFERENCES tags ON DELETE CASCADE
  child_id      INTEGER NOT NULL REFERENCES tags ON DELETE CASCADE
  sort_order    INTEGER NOT NULL DEFAULT 0       -- position under THIS parent
  PRIMARY KEY (parent_id, child_id)
```

Dropped: `custom_url` (write-only today), `tags.sort_order` (replaced by
per-edge order + `nav_order`), the `tag_locations` table (folds into two
nullable columns), and **all twelve system tags**.

Write-time invariants (service layer, not constraints):

- `AddTagRelationship(p, c)` walks `c`'s descendants; if `p` is among
  them → `409 Conflict`. All the visited-set scaffolding in read paths
  becomes belt-and-suspenders instead of the only line of defense.
- `kind = 'year'` requires the slug to parse as a year (`2024`, `2020s`) —
  the same `CAST` rule the timeline uses today, enforced at the door
  instead of assumed downstream.
- The `_` slug prefix becomes free after migration (nothing reserved
  remains); `DropTagNameUnique`-style workarounds end.

### B. One inheritance rule

> A tag is **effectively hidden** (or effectively hides its posts) if the
> flag is set on the tag itself or on any ancestor. No other property
> inherits.

- `hidden` — tag disappears from nav, cloud, tag pages, breadcrumbs,
  flyouts for guests; direct URL → 404. (Same as today's `_hidden`.)
- `hides_posts` — posts carrying the tag (or any descendant tag) are
  guest-invisible. (Same as today's `_hide_posts`, and now the docs and
  the code will agree that it propagates.)
- `nav_order`, `in_breadcrumbs`, `show_related`, `in_ancestor_flyout`,
  `kind`, coordinates — apply to the tag itself only, exactly as their
  system-tag predecessors did (direct-children semantics becomes "set on
  this tag").
- `min_tag_posts_to_show` keeps its current meaning, applied to effective
  (rolled-up) counts at read time.

The admin UI distinguishes *set here* from *inherited*: an inherited flag
renders as a non-interactive "Hidden — via Travel" chip linking to the
ancestor that set it (see E).

### C. The tag-graph snapshot

A single in-memory structure owned by `TagService`:

```
TagGraph {
  byID, bySlug          map lookups
  children, parents     adjacency (edges ordered by edge sort_order)
  effectiveHidden       set  (BFS from hidden=1 tags, computed once)
  effectiveHidesPosts   set
  countsPublic, countsAdmin  map[tagID]int64   (one recursive CTE each)
  navTree               []NavTagNode           (from nav_order tags)
  yearTags              []Tag                  (kind='year', sorted)
}
```

- Built lazily on first read; **invalidated** by any tag write and any
  post-tag mutation (post save / publish / schedule-fire / delete /
  restore). Single process + SQLite = no coherence problem.
- Every current set-builder (`EffectivelyHiddenIDs`,
  `PublicHiddenTagIDs`, `EffectivelyHiddenPostsTagIDs`, `WithRelatedIDs`,
  `InBreadcrumbsIDs`, `PageTagIDs`) and `GetHierarchicalNavTags` becomes a
  field read. The seven BFS implementations collapse into one builder
  function; `tag_service.go` shrinks from ~1,150 lines to a builder plus
  thin accessors. Handlers stop orchestrating 4–6 service calls per
  request.
- Timeline and map year-range queries (`queries_timeline.go`,
  `queries_posts.go`) drop their `_in_timeline` recursive CTE preambles
  for `WHERE kind = 'year' AND CAST(slug AS INTEGER) BETWEEN ? AND ?`.

### D. API

**Reads.** Tag objects gain explicit, truthful fields:

```json
{
  "id": 7, "name": "Friends", "slug": "friends", "kind": "topic",
  "hidden": false,        "effective_hidden": true,
  "hides_posts": true,    "effective_hides_posts": true,
  "hidden_via": 3,
  "nav_order": null, "in_breadcrumbs": false, "show_related": false,
  "in_ancestor_flyout": true,
  "parents": [...], "children": [...],
  "latitude": null, "longitude": null,
  "post_count": 12
}
```

`is_system` disappears (nothing is a system tag), the virtual `_pending`
parent injection disappears, and guests simply never receive
effectively-hidden tags — the existing guest/admin filtering contract
(`hidden-visibility.md`) is unchanged in spirit and finally matches the
implementation.

**Writes.**

- `PATCH /api/tags/:id` — partial update of scalar fields only
  (name, slug, description, kind, the five flags, coordinates). Absent
  field = untouched. The sort-order and custom-url wipe bugs become
  impossible by construction.
- `PUT /api/tags/:id/parents` and `/children` — structure edits stay
  explicit set-replacement (the modal's mental model), but only structure:
  flags no longer ride along in `parent_ids`.
- `POST /api/tags/:id/move {parent_id, after_id}` — one operation for the
  tree's drag-and-drop: creates/keeps the edge to `parent_id`, positions
  the edge after `after_id` (NULL = first), renumbers only that sibling
  group. Replaces today's split brain (`reorderTag` + reparent-via-update)
  and never touches the tag's other parents.
- `POST /api/tags` — as today, plus optional flags; parentless creation is
  legal and lands in Unfiled (no `_pending` edge writes).
- Cycle attempts → `409` with the offending path in the message.

### E. Admin `/light/tags`

The page stops hiding the model because there is nothing left to hide:

- **Tree = the whole truth.** Top level shows nav tags (ordered by
  `nav_order`), then other filed roots, then a pinned **Unfiled (N)**
  group (computed; admin proposal F3). No `HIDDEN_SYSTEM` set, no
  lock-icon system rows, no virtual parents.
- **Row badges** replace buried state: `⌂ nav` (in navigation), `🚫 hidden`
  / `🚫̃ inherited` (dimmed, links to the ancestor that set it), `📍`
  (coordinates), `📅` (year tag). A multi-parent row keeps the `⎇ also
  under…` hint.
- **Editor modal** groups by what things now are:
  - *Identity*: name, slug, description — unchanged.
  - *Visibility*: Hidden, Hide posts — toggles with inherited state shown
    as read-only chips ("inherited from Travel — change there").
  - *Display*: In navigation (with position), In breadcrumbs, Show related
    tags, Show in ancestor flyout.
  - *Kind*: Topic / Year (year validates slug).
  - *Structure*: parent/children pickers as today, minus the `EXCLUDE`
    list and the flags-as-checkboxes hack; the picker shows the real tree.
  - *Coordinates*: unchanged (parse / geocode).
  - Saves issue one `PATCH` (+ structure calls only if structure changed).
- **Ordering**: dragging within a parent reorders that edge group only;
  drag-onto opens a confirm ("Move under X / Also file under X") instead
  of silently discarding other parents; every drag has a `Move…` dialog
  twin (admin proposal F4 — touch parity).
- **Breadcrumb determinism**: `GetTagAncestors` today walks "first
  eligible parent" in undefined order; with per-edge `sort_order` the
  primary parent is defined (lowest-ordered edge), so breadcrumbs for
  multi-parent tags stop being arbitrary.

### F. Migration

One idempotent migration in the existing `migration_history` pattern
(`tag_flags_from_system_tags`), the exact inverse of `system_tags_phase_a`:

1. Add new columns to `tags`; add `sort_order` to `tag_relationships`
   (seeded from the child's current `tags.sort_order`).
2. Translate edges to columns:
   `_hidden → hidden=1` · `_hide_posts → hides_posts=1` ·
   `_root → nav_order = old sort_order` · `_is_in_breadcrumbs →
   in_breadcrumbs=1` · `_with_related → show_related=1` ·
   `_no_ancestors → in_ancestor_flyout=0` · `_in_timeline` descendants →
   `kind='year'` · `_page` descendants → `hidden=1` · `_pending`,
   `_system` → nothing (computed/cosmetic).
3. Fold `tag_locations` into the new columns; migrate posts tagged
   `_type_page`/`_type_audio` (if any exist in the wild) to the post-side
   type representation; then delete all `_`-prefixed tags — cascade
   removes their edges and `post_tags` rows.
4. Drop `tags.sort_order`, `custom_url`, `tag_locations`; recompute counts.
5. Docs pass: rewrite `hidden-visibility.md` (it currently documents
   dropped columns *and* contradicts the code on `_hide_posts`
   inheritance), update the Tagging table in `features.md`, append the new
   model to `META-TAGGING.md`.

Rollback safety: the migration is a pure transformation of existing data;
a pre-migration backup via the existing System backup is the escape hatch,
same as phase a/b had.

### G. What stays untouched

The multi-parent DAG and its recursive archives and counts; slug-based
public URLs; `min_tag_posts_to_show`; co-occurring related tags;
geocoding (Nominatim) and the map; the public-side tag UX defined in the
public proposal (flyout/sheet, one-click navigation); the admin-side tag
workflow defined in the admin proposal (hierarchy-aware autocomplete,
Unfiled queue, Move/Merge) — this proposal is the data-model floor those
two stand on.

## Add / remove summary

**Add:** typed flag columns + `kind` on `tags` (A) · per-edge `sort_order`
(A) · write-time cycle rejection (A) · one inheritance rule with
`effective_*` + `hidden_via` in responses (B/D) · tag-graph snapshot with
single invalidation point (C) · `PATCH` tags + `move` operation (D) ·
inherited-state chips and truth-telling tree in `/light/tags` (E).

**Remove:** all twelve system tags and the `_` prefix reservation ·
flags-as-parentage and the three inheritance semantics · 29
slug-prefix checks (19 Go + 10 SQL) · seven BFS set-builders and the
4×-graph-loads-per-request pattern · `_pending` (both the real edges and
the virtual injection) · `custom_url` and `tags.sort_order` ·
`tag_locations` as a table · the modal's `EXCLUDE`/`HIDDEN_SYSTEM`/
Features-checkbox machinery · the save-wipes-sort-order and
save-wipes-custom-url bugs · `PageTagIDs` dead code ·
`DropTagNameUnique`-class collisions.

## Mockups

### `/light/tags` — tree as the whole truth

```
┌──────────────────────────────────────────────────────────┐
│ Tags                                  [Tree|List]  + New │
├──────────────────────────────────────────────────────────┤
│ ⚠ UNFILED (2)                                            │
│   alfama          · 3   [File under…] [Edit]             │
│   sintra-night    · 1   [File under…] [Edit]             │
├──────────────────────────────────────────────────────────┤
│ ▾ Travel  ⌂1 · 48                       [✎][+][Move…][×] │
│   ▾ Portugal 📍 · 12                    [✎][+][Move…][×] │
│       Lisbon 📍 · 9  ⎇ also under Cities                 │
│ ▾ Life  ⌂2 · 31                                          │
│     Friends  🚫 hide-posts · 12                          │
│       BBQs   🚫̃ inherited · 3      ← chip links to Friends│
│ ▾ Years 📅 (kind=year, flat) 2017 … 2026                 │
└──────────────────────────────────────────────────────────┘
  ⌂n = nav position · 🚫 = set here · 🚫̃ = inherited · no lock rows
```

### Editor modal — flags are fields, not parents

```
┌─ Edit: Friends ──────────────────────────── 12 posts ──┐
│ Name  [Friends            ]   /tags/[friends         ] │
│ Description [……………………………………………………]                     │
│                                                        │
│ VISIBILITY                                             │
│  ( ) Visible  (•) Hidden from public                   │
│  [✓] Hide posts carrying this tag                      │
│      ↳ applies to BBQs, Dinners (2 descendants)        │
│                                                        │
│ DISPLAY                                                │
│  [ ] In navigation   position [—]                      │
│  [ ] In breadcrumbs  [ ] Show related  [✓] In flyout   │
│                                                        │
│ KIND   (•) Topic  ( ) Year                             │
│ ▸ Parents (1: Life)    ▸ Children (2)    ▸ Coordinates │
│                                                        │
│                          [Cancel]  [Save changes]      │
└────────────────────────────────────────────────────────┘
  Save = PATCH of changed fields only
```

## Prioritized roadmap (task breakdown)

**P0 — model and floor (everything else stands on this)**

1. Schema migration `tag_flags_from_system_tags` (A, F1–F4) with
   backup-first note in release notes
2. Cycle rejection in `AddTagRelationship` (+ tests for the 409 path)
3. Tag-graph snapshot + invalidation hooks on tag/post-tag writes (C);
   port all read paths (handlers, nav, breadcrumbs, cloud, timeline, map)
4. Delete the seven set-builders, prefix checks, and `_in_timeline` CTE
   preambles as the ports land (the deletion *is* the deliverable)

**P1 — API and admin UI**

5. `PATCH /api/tags/:id`; structure endpoints; `move` operation (D)
6. TagsManagerPage: badges, Unfiled group, Visibility/Display/Kind modal
   groups, inherited chips (E)
7. Drag-and-drop on per-edge order + drag-onto confirm + `Move…` dialog
   (E; overlaps admin proposal F4)
8. Docs rewrite: `hidden-visibility.md`, `features.md` tagging table,
   `META-TAGGING.md` addendum (F5)

**P2 — follow-through**

9. Post type off tags: `posts`-side representation replacing
   `_type_page`/`_type_audio` in `getPostType` (D, F3)
10. Free the `_` slug prefix; remove `DropTagNameUnique` (A)
11. Admin-proposal tag items that now become straightforward: Unfiled
    file-under/merge actions (F3/F5 there), hierarchy-aware autocomplete
    paths from the snapshot (F1 there)

## Considered and rejected

- **Keep system tags, just unify inheritance semantics.** Fixes one of the
  seven symptoms; the string-prefix type system, per-request BFS, UI
  hiding machinery, and flags-in-`parent_ids` all remain. The mechanism is
  the cost, not its inconsistency.
- **A `tag_attributes (tag_id, key)` table instead of columns.** Re-creates
  system tags one table over: string-keyed, untyped, invisible on the row,
  and still requiring a join/set-build to answer "is this tag hidden?".
  Five booleans and an enum on a single-author blog do not need an EAV
  escape hatch; the project demonstrably knows how to migrate schema.
- **Strict tree instead of DAG.** Multi-parent is genuinely used and cheap
  once edges only mean taxonomy; the painful parts (ordering, breadcrumbs,
  drag-onto) are fixed by per-edge order and a defined primary parent, not
  by banning the second parent.
- **Closure table / materialized ancestry in SQLite.** Write amplification
  and a second source of truth to keep consistent, to optimize reads that
  an in-process snapshot already makes O(1). Wrong tool at this scale
  (hundreds of tags, one process).
- **Per-post visibility instead of `hides_posts` on tags.** The real use
  case is "hide everything about this person/place" — a subtree property.
  Post-level hiding already exists (`status: hidden`) and stays.
- **Renaming/aliasing system tags into a nicer UI without model change.**
  The admin proposal's F-section already does this as far as it can go;
  this proposal exists because the remaining problems (inheritance
  semantics, wipe bugs, per-request rebuilds) live below the UI.
- **Doing nothing.** Two of the findings are live correctness bugs (every
  modal save destroys manual ordering; docs contradict code on
  `_hide_posts` inheritance), and every new tag feature inherits the
  three-semantics tax. The floor needs fixing before the UX proposals
  build on it.
