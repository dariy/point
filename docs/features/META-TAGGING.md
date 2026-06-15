# Meta-Tag System (Hierarchical Tagging)

The Photo Blog Engine features a robust **Meta-tag System** that allows for hierarchical organization of tags. This system enables tags to logically "contain" other tags, creating a parent-child relationship that simplifies content discovery and organization.

## 🌟 Key Concepts

### Meta-tags (Parent Tags)
A **Meta-tag** is a tag that has one or more child tags. Posts associated with its children are automatically considered part of the meta-tag.

### Hierarchical Relationships
Tags can have multiple parents and multiple children. This allows for a flexible DAG (Directed Acyclic Graph) structure rather than a strict tree, supporting complex categorizations (e.g., `#newyork` can be a child of both `#city` and `#us`).

### Recursive Post Counting
A tag's `post_count` reflects the total number of **unique published posts** associated with itself and all of its descendants recursively. This ensures that meta-tags accurately represent the breadth of content they encompass.

### Recursive Post Retrieval
When viewing a tag's archive page or filtering by a tag in the gallery, the system automatically includes posts from all descendant tags. This provides a "broad-to-narrow" browsing experience.

---

## 🛠️ Implementation Details

### Data Model
The hierarchy is managed via a many-to-many `tag_relationships` association table:

```python
# app/models/tag.py
tag_relationships = Table(
    "tag_relationships",
    Base.metadata,
    Column("parent_id", Integer, ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
    Column("child_id", Integer, ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
)
```

The `Tag` model includes `parents` and `children` relationships:
- `parents`: Tags that logically contain this tag.
- `children`: Tags logically contained by this tag.

### Service Logic (`TagService`)

#### 1. Recursive Traversal
The system uses recursive traversal to identify all ancestors or descendants while preventing infinite loops caused by potential circular references.

```python
async def get_descendant_tag_ids(self, tag_id: int) -> set[int]:
    # Returns all IDs in the subtree, including the tag_id itself.
    # Uses a visited set to avoid circular references.
```

#### 2. Automatic Count Propagation
When a post's tags are updated, the system identifies all affected tags and their ancestors to recalculate their recursive post counts.

```python
async def update_post_counts_recursive(self, tag_ids: list[int]) -> None:
    # Recalculates counts for provided tags and all their ancestors.
```

### API & UI Integration
- **Public Archive**: `/tags/{slug}` (gallery) use recursive filtering by default.
- **Light Interface**:
  - Filtering by parent tag in the Tag Manager.
  - Multi-select parent assignment in the Tag Editor.
  - Real-time recursive count updates on tagging actions.

---

## 🔄 Circular Reference Handling
While the UI and Service layers attempt to prevent logical cycles (e.g., A → B → A), the underlying traversal algorithms are hardened with "visited" sets to ensure system stability even if cycles are manually introduced in the database.

---

## 📈 Example Scenario
1. Create tags: `#nature` (Meta), `#forest`, `#pine`.
2. Set `#nature` as parent of `#forest`.
3. Set `#forest` as parent of `#pine`.
4. Create a post tagged with `#pine`.
5. **Result**:
   - `#pine.post_count` = 1
   - `#forest.post_count` = 1
   - `#nature.post_count` = 1
   - Viewing `/tags/nature` shows the post tagged with `#pine`.

---

## Tag-Graph Snapshot (Current Model)

The original Python implementation above was the starting point. The current Go implementation replaced graph-as-behavior-flags with typed columns and an in-memory snapshot.

### Typed flag columns

Each tag row now carries its properties directly:

| Column | Type | Meaning |
|---|---|---|
| `hidden` | `BOOLEAN` | Tag hidden from all public surfaces |
| `hides_posts` | `BOOLEAN` | Posts carrying this tag hidden from guests |
| `kind` | `TEXT` | `'topic'` (default) or `'year'` |
| `nav_order` | `INTEGER NULL` | Position in public navigation; `NULL` = not in nav |
| `in_breadcrumbs` | `BOOLEAN` | Tag shown in breadcrumb path |
| `show_related` | `BOOLEAN` | Related tags shown as children in the sidebar |
| `in_ancestor_flyout` | `BOOLEAN` | Tag included in the ancestor flyout on archive pages |

### TagGraph: the in-memory snapshot

`TagService` holds a single `*TagGraph` value that is rebuilt once per write and read from atomically on every request:

```go
type TagGraph struct {
    ByID, BySlug        map[int64]Tag / map[string]Tag
    Children, Parents   map[int64][]int64   // adjacency, ordered by edge sort_order
    EffectiveHidden     map[int64]bool      // BFS from hidden=true tags
    EffectiveHidesPosts map[int64]bool      // BFS from hides_posts=true tags
    HiddenVia           map[int64]int64     // tagID → ancestor that caused hiding
    CountsPublic        map[int64]int64     // recursive post counts (guests)
    CountsAdmin         map[int64]int64     // recursive post counts (admin)
    NavTree             []NavTagNode        // ordered nav tags
    YearTags            []Tag               // kind='year', sorted
}
```

The graph is **invalidated** by any tag write and any post-tag mutation (post save, publish, schedule-fire, delete, restore). Because the engine is single-process + SQLite there is no cross-process coherence problem.

### Inheritance semantics

Both `hidden` and `hides_posts` use a single BFS rule: a tag carries the effective flag if it or **any ancestor** has the flag set. There are no other inheritance semantics.

Property columns (`nav_order`, `in_breadcrumbs`, `show_related`, `in_ancestor_flyout`) apply to the tag itself only — they do not propagate.

### Per-edge sort order

The `tag_relationships` table carries a `sort_order` column per edge, allowing a tag to have an independent position under each of its parents. Dragging in the admin tree reorders only the affected sibling group, leaving all other parent relationships untouched.
