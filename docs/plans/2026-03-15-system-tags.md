# System Tags

> **Created**: 2026-03-15
> **Status**: Planned

## Context

The `tags` table carries 6 boolean flag columns (`is_important`, `is_featured`, `is_hidden`, `is_hidden_posts`, `include_in_breadcrumbs`, `show_related_tags_as_children`) that encode tag behavior as special cases in the API. This plan replaces all of them with **system tags**: reserved tags whose slug starts with `_`. Behavior is expressed through ordinary parent–child relationships in `tag_relationships`, making the model uniform, removing special-cased SQL columns, and giving admins a single hierarchy UI for everything.

Additionally, `tags_filters` is renamed to `menu` everywhere (frontend + API response keys), and `is_important` is simply removed with no replacement.

---

## System Tags Catalogue

| Slug | Name | Replaces | Semantics |
|------|------|----------|-----------|
| `_system` | System | — | Parent of all system tags; purely organizational |
| `_root` | Root | `is_featured` | Children appear in the top navigation menu |
| `_hidden` | Hidden | `is_hidden` | Children are hidden from public view |
| `_hide_posts` | Hide Posts | `is_hidden_posts` | Children have their posts hidden from public |
| `_is_in_breadcrumbs` | In Breadcrumbs | `include_in_breadcrumbs` | Children appear in breadcrumb navigation |
| `_with_related` | With Related | `show_related_tags_as_children` | Children render their children as "related tags" |
| `_pending` | Pending | — | Auto-assigned to orphaned tags (no other parent) |

`_system` is parent of all other system tags. `is_important` is removed with no replacement.

---

## Additional Constraints

1. **Slug prefix reserved**: any slug starting with `_` is rejected for user-created tags (API returns 400).
2. **System tags immutable**: system tags cannot be renamed, re-parented, or deleted via the API.
3. **System tags cannot be children of user tags**: `SetTagParents` / `SetTagChildren` must reject linking a system tag as a child of a user tag.
4. **`_system` cannot be a user-tag parent**: only the 6 sibling system tags may be children of `_system`.
5. **Excluded from public APIs**: tags with `_`-prefix slug are filtered out of all public-facing list responses and tag clouds.
6. **Excluded from `post_count`**: system tags never accumulate post counts.
7. **`_pending` as an admin signal**: the admin UI can highlight tags under `_pending` to surface unorganized tags needing attention.
8. **No circular lock**: a user tag can be a child of `_root` AND of `_hidden` simultaneously (e.g., visible in menu but individually locked when logged in as admin).
9. **Validation on parent assignment**: when the user tries to set a system tag as a child of another tag (i.e., a user tag becomes parent of a system tag), the API must reject it.

---

## Performance Analysis

| Scenario | Old approach | New approach |
|----------|-------------|-------------|
| Nav menu build | `WHERE is_featured = 1 OR no-parent` (boolean index scan) | `WHERE parent_id = root_system_id` (indexed FK join; system tag IDs cached at startup) |
| Hidden tag filtering | `WHERE is_hidden = 1` (boolean) | `WHERE parent_id = hidden_system_id` (same complexity) |
| Hidden-posts recursive CTE | Seeds from `is_hidden_posts = 1` | Seeds from `SELECT child_id FROM tag_relationships WHERE parent_id = hide_posts_id` — same CTE body |
| Single-tag lookup | `WHERE slug = ?` + boolean columns in result | Same; no boolean columns to fetch |

**Verdict**: negligible difference. SQLite indexed FK lookups on `tag_relationships` match boolean index scans in cost. System tag IDs are cached at service init so no extra DB round-trip per request.

---

## Implementation Plan

### Phase 1 — API: Schema & Migrations (`api/`)

**Files**: `api/sql/schema.sql`, `api/cmd/api/main.go`

Add startup migrations in `main.go` in two ordered phases:

**Phase A — Seed system tags and migrate data (boolean columns still present in DB):**

a. Seed system tags with fixed slugs (INSERT OR IGNORE):
   `_system`, `_root`, `_hidden`, `_hide_posts`, `_is_in_breadcrumbs`, `_with_related`, `_pending`

b. Seed system tag relationships: all 6 are children of `_system`.

c. Migrate existing flag data into `tag_relationships` (reading boolean columns while they still exist):
   - `is_featured = 1` → parent=`_root`
   - `is_hidden = 1` → parent=`_hidden`
   - `is_hidden_posts = 1` → parent=`_hide_posts`
   - `include_in_breadcrumbs = 1` → parent=`_is_in_breadcrumbs`
   - `show_related_tags_as_children = 1` → parent=`_with_related`

d. Assign `_pending` to any tag with no parent after migration.

**Phase B — Remove boolean columns (only after data is fully migrated):**

e. Remove columns from `schema.sql`:
   ```
   is_important, is_featured, is_hidden, is_hidden_posts,
   include_in_breadcrumbs, show_related_tags_as_children
   ```

f. Drop columns via table-rebuild migration (SQLite <3.35 compatibility):
   Recreate `tags` without the 6 boolean columns (`is_important`, `is_featured`, `is_hidden`, `is_hidden_posts`, `include_in_breadcrumbs`, `show_related_tags_as_children`).

Each phase is guarded by the standard `ApplyMigration` idempotency check so it runs exactly once.

3. Regenerate sqlc models: `cd api && sqlc generate`

### Phase 2 — API: Repository (`api/internal/repository/extended.go`, `api/sql/queries.sql`)

- Remove all references to dropped columns from sqlc queries.
- Update recursive CTE for hidden-posts filtering: seed from `tag_relationships WHERE parent_id = $hidePostsID` instead of `tags WHERE is_hidden_posts = 1`.
- Add helper: `GetTagIDBySlug(ctx, slug) int64` (or use existing `GetTagBySlug`).
- System tag IDs are loaded once in the service layer, not the repository.

### Phase 3 — API: Service Layer (`api/internal/services/tag_service.go`)

- **Add** `SystemTagIDs` struct cached at init: `Root`, `Hidden`, `HidePosts`, `InBreadcrumbs`, `WithRelated`, `Pending`, `System`.
- `GetHierarchicalNavTags()`:
  - Remove `is_featured` / `parentsOf[t.ID] == 0` root-selection logic.
  - Root IDs = direct children of `_root` system tag.
  - Filter out system tags from the node tree.
  - Remove `IsFeatured` field from `NavTagNode`; add `IsRelated` via "_with_related" child check.
- `buildEffectivelyHiddenIDs()`: seed from children of `_hidden` (not `t.IsHidden`).
- `buildEffectivelyHiddenPostsTagIDs()`: seed from children of `_hide_posts`.
- `CreateTag()` / `UpdateTag()`:
  - Reject slugs starting with `_` (400 Bad Request).
  - Auto-assign `_pending` as parent if no parents given after save.
  - Remove `_pending` if user assigns another parent.
- `SetTagParents()` / `SetTagChildren()`:
  - Reject: system tag as child of a user tag.
  - Reject: user tag as child of `_system` directly.
- `DeleteTag()`: reject system tag slugs.
- `GetTagBySlug()` / `GetTagByID()`: 404 for system tags on public endpoints.
- `ListTags()`:
  - Public: exclude tags with `_` prefix slug.
  - Admin: include system tags, mark them `is_system: true` in response.

### Phase 4 — API: Handlers & Mappers (`api/internal/api/tags.go`, `api/internal/api/mappers.go`)

- Remove `IsImportant`, `IsFeatured`, `IsHidden`, `IsHiddenPosts`, `IncludeInBreadcrumbs`, `ShowRelatedTagsAsChildren` from `CreateTagRequest`, `UpdateTagRequest`, and all response types.
- Add `IsSystem bool` to tag response (true when slug starts with `_`).
- `injectTagHiddenFields()` mapper: derive `IsHidden` / `IsHiddenPosts` from service-computed sets (or remove from public responses entirely — they're irrelevant once system tags are not returned publicly).
- Rename `nav_tags` response key `tags_filters` → `menu` in `GetHomePage` and `GetTagPage` page handlers (`api/internal/api/pages.go`).

### Phase 5 — Frontend: API Client & Utilities

**Files**:
- `frontend/src/api/tags.js`: remove boolean flag fields from create/update payloads.
- `frontend/src/api/pages.js`: rename `tags_filters` → `menu` in response destructuring.
- `frontend/src/utils/tags.js`: remove `is_hidden` / `is_hidden_posts` flag checks (backend already excludes system-hidden tags from public responses; lock icons become irrelevant for public users).

### Phase 6 — Frontend: Public UI

**Files**:
- `frontend/src/components/public/PublicHeaderTagsBar.js`:
  - Read from `menu` key (renamed from `tags_filters`).
  - Remove explicit `is_hidden` filter (backend handles it).
  - Remove `is_featured` references.
- `frontend/src/components/public/PublicHeader.js`: update breadcrumb logic if `is_hidden` / `is_hidden_posts` flags were used for lock icons (simplify or remove lock icons for public users since system tags are already filtered server-side).
- `frontend/src/pages/public/TagPage.js`: update `nav_tags` → `menu` key reference.
- `frontend/src/pages/public/HomePage.js`: same rename.
- `frontend/src/components/public/PostCard.js`: remove `is_hidden` / `is_hidden_posts` tag flag checks.
- `frontend/src/components/public/TagCloud.js`: remove lock icon checks.

### Phase 7 — Frontend: Admin UI (`frontend/src/pages/light/TagsManagerPage.js`)

- **Remove** flag checkboxes from the modal edit form: `is_important`, `is_featured`, `is_hidden`, `is_hidden_posts`, `include_in_breadcrumbs`, `show_related_tags_as_children`.
- **System tag locking**: tags with `is_system: true` render with a lock/shield icon in tree and list views. No edit button, no delete button, no drag handle.
- **Parent selector**: in the "Parents" checkbox panel, show system tags (`_root`, `_hidden`, `_hide_posts`, `_is_in_breadcrumbs`, `_with_related`, `_pending`) at top as a distinct group. Exclude `_system` from this list (not user-assignable).
- **Children selector**: disallow assigning system tags as children.
- **`_pending` highlight**: show a notice/badge in the UI when tags are under `_pending` to prompt organization.
- **Rename** any `tags_filters` UI labels to `menu`.

---

## Key Files

| File | Change |
|------|--------|
| `api/sql/schema.sql` | Remove 6 boolean columns from `tags` (Phase B) |
| `api/sql/queries.sql` | Remove boolean columns from all tag queries |
| `api/internal/models/models.go` | Auto-regenerated by sqlc |
| `api/internal/services/tag_service.go` | Replace flag-based logic with system tag ID lookups |
| `api/internal/repository/extended.go` | Update hidden-posts CTE seed |
| `api/internal/api/tags.go` | Validation, request/response structs |
| `api/internal/api/mappers.go` | Remove flag fields, add is_system |
| `api/internal/api/pages.go` | Rename tags_filters → menu |
| `api/cmd/api/main.go` | Startup migrations + system tag seeding |
| `frontend/src/api/tags.js` | Remove boolean flag payloads |
| `frontend/src/api/pages.js` | Rename tags_filters → menu |
| `frontend/src/utils/tags.js` | Remove flag-based lock icon checks |
| `frontend/src/pages/light/TagsManagerPage.js` | Lock system tags, remove flag checkboxes |
| `frontend/src/components/public/PublicHeaderTagsBar.js` | Use menu key, remove flag checks |
| `frontend/src/components/public/PublicHeader.js` | Update breadcrumb/lock logic |
| `frontend/src/pages/public/TagPage.js` | menu key rename |
| `frontend/src/pages/public/HomePage.js` | menu key rename |
| `frontend/src/components/public/PostCard.js` | Remove flag checks |
| `frontend/src/components/public/TagCloud.js` | Remove flag checks |

---

## Verification

1. **API tests**: `./scripts/run-tests.sh` — existing tag service tests must pass; add tests for:
   - Slug-prefix rejection (cannot create `_foo`)
   - System tag immutability (update/delete returns 403/400)
   - `_pending` auto-assignment on orphaned create
   - Nav tree returns children of `_root` only
   - Hidden filtering via `_hidden` children
2. **Manual admin flow**: Create a tag with no parent → verify it appears under `_pending` in admin tree.
3. **Manual nav flow**: Add a tag as child of `_root` → verify it appears in the header menu.
4. **Manual hidden flow**: Add a tag as child of `_hidden` → verify it disappears from public tag lists.
5. **Migration check**: Start API against an existing DB with boolean flags → verify system tags seeded and relationships migrated correctly, no data loss.
6. **`menu` rename**: Verify public header nav bar renders correctly after rename.
