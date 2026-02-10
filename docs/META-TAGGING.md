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
- **Public Archive**: `/tag/{slug}` and `/tags/{slug}` (gallery) use recursive filtering by default.
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
   - Viewing `/tag/nature` shows the post tagged with `#pine`.
