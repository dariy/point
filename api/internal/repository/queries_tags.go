package repository

import (
	"context"
	"database/sql"
	"fmt"

	"point-api/internal/models"
)

// GetTagAncestors returns the ancestor chain from root to the given tag.
func (r *sqliteRepository) GetTagAncestors(ctx context.Context, tagID int64) ([]models.Tag, error) {
	// Iterative traversal: find parents of parents until no more parents
	visited := map[int64]bool{tagID: true}
	var ancestors []models.Tag
	currentID := tagID

	for {
		parents, err := r.GetTagParents(ctx, currentID)
		if err != nil || len(parents) == 0 {
			break
		}
		// Prefer a parent that is in_breadcrumbs; fall back to the first
		// unvisited parent so single-parent chains are unaffected.
		var chosen *models.Tag
		for i := range parents {
			p := &parents[i]
			if visited[p.ID] {
				continue
			}
			if chosen == nil {
				chosen = p // first unvisited = fallback
			}
			if p.InBreadcrumbs {
				chosen = p // prefer the breadcrumb-flagged branch
				break
			}
		}
		if chosen == nil {
			break
		}
		visited[chosen.ID] = true
		ancestors = append([]models.Tag{*chosen}, ancestors...)
		currentID = chosen.ID
	}

	return ancestors, nil
}

// GetTagWithChildren returns a tag with all its direct children.
func (r *sqliteRepository) GetTagDescendants(ctx context.Context, tagID int64) ([]models.Tag, error) {
	visited := map[int64]bool{tagID: true}
	var result []models.Tag
	queue := []int64{tagID}

	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]

		children, err := r.GetTagChildren(ctx, current)
		if err != nil {
			continue
		}
		for _, child := range children {
			if !visited[child.ID] {
				visited[child.ID] = true
				result = append(result, child)
				queue = append(queue, child.ID)
			}
		}
	}

	return result, nil
}

// GetCoOccurringTags returns tags that appear on the same posts as tagID,
// ordered by co-occurrence count descending. System tags (slug starting with "_")
// and the tag itself are excluded.
func (r *sqliteRepository) GetCoOccurringTags(ctx context.Context, tagID int64, publicOnly bool) ([]models.Tag, error) {
	statusClause := ""
	if publicOnly {
		statusClause = "AND p.status = 'published'"
	}
	q := fmt.Sprintf(`
SELECT t.id, t.name, t.slug, t.description, t.kind, t.hidden, t.hides_posts, t.nav_order, t.in_breadcrumbs, t.show_related, t.in_ancestor_flyout, t.latitude, t.longitude, t.post_count, t.created_at
FROM tags t
JOIN post_tags pt ON t.id = pt.tag_id
JOIN posts p ON pt.post_id = p.id
WHERE p.deleted_at IS NULL
AND pt.post_id IN (
    SELECT pt2.post_id FROM post_tags pt2
    JOIN posts p2 ON pt2.post_id = p2.id
    WHERE pt2.tag_id = ? AND p2.deleted_at IS NULL %s
)
AND t.id != ?
AND t.post_count > 0
GROUP BY t.id
ORDER BY COUNT(*) DESC, t.name ASC`, statusClause)

	rows, err := r.db.QueryContext(ctx, q, tagID, tagID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var tags []models.Tag
	for rows.Next() {
		var t models.Tag
		if err := rows.Scan(&t.ID, &t.Name, &t.Slug, &t.Description, &t.Kind,
			&t.Hidden, &t.HidesPosts, &t.NavOrder, &t.InBreadcrumbs,
			&t.ShowRelated, &t.InAncestorFlyout, &t.Latitude, &t.Longitude,
			&t.PostCount, &t.CreatedAt); err != nil {
			return nil, err
		}
		tags = append(tags, t)
	}
	return tags, rows.Err()
}

// TagRelationship represents a parent-child tag relationship pair with an optional sort order.
type TagRelationship struct {
	ParentID  int64         `json:"parent_id"`
	ChildID   int64         `json:"child_id"`
	SortOrder sql.NullInt64 `json:"sort_order"`
}

// GetAllTagRelationships returns all (parent_id, child_id, sort_order) pairs from tag_relationships,
// ordered by parent_id and sort_order.
func (r *sqliteRepository) GetAllTagRelationships(ctx context.Context) ([]TagRelationship, error) {
	const q = `SELECT parent_id, child_id, sort_order FROM tag_relationships ORDER BY parent_id, sort_order ASC, child_id ASC`
	rows, err := r.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = rows.Close()
	}()
	var pairs []TagRelationship
	for rows.Next() {
		var p TagRelationship
		if err := rows.Scan(&p.ParentID, &p.ChildID, &p.SortOrder); err != nil {
			return nil, err
		}
		pairs = append(pairs, p)
	}
	return pairs, rows.Err()
}

// ClearTagParents removes all parent relationships for a tag (rows where child_id = tagID).
func (r *sqliteRepository) ClearTagParents(ctx context.Context, childID int64) error {
	const q = `DELETE FROM tag_relationships WHERE child_id = ?`
	_, err := r.db.ExecContext(ctx, q, childID)
	return err
}

// ClearTagChildren removes all child relationships for a tag (rows where parent_id = tagID).
func (r *sqliteRepository) ClearTagChildren(ctx context.Context, parentID int64) error {
	const q = `DELETE FROM tag_relationships WHERE parent_id = ?`
	_, err := r.db.ExecContext(ctx, q, parentID)
	return err
}

// GetTagsWithoutLocation returns tags that have no coordinates set.
// Only tags whose IDs are in the provided set are considered.
func (r *sqliteRepository) GetTagsWithoutLocation(ctx context.Context, tagIDs []int64) ([]models.Tag, error) {
	if len(tagIDs) == 0 {
		return nil, nil
	}

	args := make([]interface{}, len(tagIDs))
	placeholders := ""
	for i, id := range tagIDs {
		args[i] = id
		if i > 0 {
			placeholders += ","
		}
		placeholders += "?"
	}

	q := `
SELECT t.id, t.name, t.slug, t.description, t.kind, t.hidden, t.hides_posts, t.nav_order, t.in_breadcrumbs, t.show_related, t.in_ancestor_flyout, t.latitude, t.longitude, t.post_count, t.created_at
FROM tags t
WHERE t.id IN (` + placeholders + `) AND t.latitude IS NULL`

	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = rows.Close()
	}()

	var items []models.Tag
	for rows.Next() {
		var t models.Tag
		if err := rows.Scan(
			&t.ID, &t.Name, &t.Slug, &t.Description, &t.Kind,
			&t.Hidden, &t.HidesPosts, &t.NavOrder, &t.InBreadcrumbs,
			&t.ShowRelated, &t.InAncestorFlyout, &t.Latitude, &t.Longitude,
			&t.PostCount, &t.CreatedAt,
		); err != nil {
			return nil, err
		}
		items = append(items, t)
	}
	return items, rows.Err()
}

// FindTagsByNames returns tags whose lowercased name is in the given list.
func (r *sqliteRepository) FindTagsByNames(ctx context.Context, names []string) ([]models.Tag, error) {
	if len(names) == 0 {
		return nil, nil
	}

	args := make([]interface{}, len(names))
	placeholders := ""
	for i, n := range names {
		args[i] = n
		if i > 0 {
			placeholders += ","
		}
		placeholders += "?"
	}

	q := `
SELECT id, name, slug, description, kind, hidden, hides_posts, nav_order, in_breadcrumbs, show_related, in_ancestor_flyout, latitude, longitude, post_count, created_at
FROM tags WHERE lower(name) IN (` + placeholders + `)`

	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = rows.Close()
	}()

	var items []models.Tag
	for rows.Next() {
		var t models.Tag
		if err := rows.Scan(
			&t.ID, &t.Name, &t.Slug, &t.Description, &t.Kind,
			&t.Hidden, &t.HidesPosts, &t.NavOrder, &t.InBreadcrumbs,
			&t.ShowRelated, &t.InAncestorFlyout, &t.Latitude, &t.Longitude,
			&t.PostCount, &t.CreatedAt,
		); err != nil {
			return nil, err
		}
		items = append(items, t)
	}
	return items, rows.Err()
}

// PostTagInfo is a lightweight tag descriptor for embedding in post list responses.
type PostTagInfo struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
	Slug string `json:"slug"`
}

// GetTagsByPostIDs bulk-fetches tags for a list of post IDs.
// Returns a map of postID → []PostTagInfo.
func (r *sqliteRepository) GetTagsByPostIDs(ctx context.Context, postIDs []int64) (map[int64][]PostTagInfo, error) {
	result := make(map[int64][]PostTagInfo)
	if len(postIDs) == 0 {
		return result, nil
	}

	args := make([]interface{}, len(postIDs))
	placeholders := ""
	for i, id := range postIDs {
		args[i] = id
		if i > 0 {
			placeholders += ","
		}
		placeholders += "?"
	}

	q := `
SELECT pt.post_id, t.id, t.name, t.slug
FROM post_tags pt
JOIN tags t ON t.id = pt.tag_id
WHERE pt.post_id IN (` + placeholders + `)
ORDER BY t.name ASC`

	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = rows.Close()
	}()

	for rows.Next() {
		var postID int64
		var tag PostTagInfo
		if err := rows.Scan(&postID, &tag.ID, &tag.Name, &tag.Slug); err != nil {
			return nil, err
		}
		result[postID] = append(result[postID], tag)
	}
	return result, rows.Err()
}

// GetChildrenOfTag returns direct children of parentID, ordered by edge sort_order ASC, name ASC.
func (r *sqliteRepository) GetChildrenOfTag(ctx context.Context, parentID int64) ([]models.Tag, error) {
	const q = `
SELECT t.id, t.name, t.slug, t.description, t.kind, t.hidden, t.hides_posts, t.nav_order, t.in_breadcrumbs, t.show_related, t.in_ancestor_flyout, t.latitude, t.longitude, t.post_count, t.created_at
FROM tags t
JOIN tag_relationships tr ON tr.child_id = t.id
WHERE tr.parent_id = ?
ORDER BY tr.sort_order ASC, t.name ASC`
	return r.scanTags(ctx, q, parentID)
}

// GetRootTags returns tags that have no parents, ordered by name ASC.
func (r *sqliteRepository) GetRootTags(ctx context.Context) ([]models.Tag, error) {
	const q = `
SELECT t.id, t.name, t.slug, t.description, t.kind, t.hidden, t.hides_posts, t.nav_order, t.in_breadcrumbs, t.show_related, t.in_ancestor_flyout, t.latitude, t.longitude, t.post_count, t.created_at
FROM tags t
LEFT JOIN tag_relationships tr ON tr.child_id = t.id
WHERE tr.parent_id IS NULL
ORDER BY t.name ASC`
	return r.scanTags(ctx, q)
}

// UpdateTagSortOrder updates sort_order on all edges where child_id = id.
func (r *sqliteRepository) UpdateTagSortOrder(ctx context.Context, id int64, sortOrder int32) error {
	_, err := r.db.ExecContext(ctx, `UPDATE tag_relationships SET sort_order = ? WHERE child_id = ?`, sortOrder, id)
	return err
}

// UpdateEdgeSortOrder updates sort_order on the specific edge (parentID, childID).
func (r *sqliteRepository) UpdateEdgeSortOrder(ctx context.Context, parentID, childID int64, sortOrder int32) error {
	_, err := r.db.ExecContext(ctx, `UPDATE tag_relationships SET sort_order = ? WHERE parent_id = ? AND child_id = ?`, sortOrder, parentID, childID)
	return err
}

// scanTags is a helper that executes a query and scans the result rows into []models.Tag.
func (r *sqliteRepository) scanTags(ctx context.Context, q string, args ...interface{}) ([]models.Tag, error) {
        rows, err := r.db.QueryContext(ctx, q, args...)
        if err != nil {
                return nil, err
        }
        defer func() {
                _ = rows.Close()
        }()
        var items []models.Tag
        for rows.Next() {
                var t models.Tag
                if err := rows.Scan(
                        &t.ID, &t.Name, &t.Slug, &t.Description, &t.Kind,
                        &t.Hidden, &t.HidesPosts, &t.NavOrder, &t.InBreadcrumbs,
                        &t.ShowRelated, &t.InAncestorFlyout, &t.Latitude, &t.Longitude,
                        &t.PostCount, &t.CreatedAt,
                ); err != nil {
                        return nil, err
                }
                items = append(items, t)
        }
        return items, rows.Err()
}

// SearchTags returns tags whose name matches the query.
func (r *sqliteRepository) SearchTags(ctx context.Context, query string, limit int) ([]models.Tag, error) {
	if query == "" {
		return nil, nil
	}
	const q = `
SELECT id, name, slug, description, kind, hidden, hides_posts,
       nav_order, in_breadcrumbs, show_related, in_ancestor_flyout,
       latitude, longitude, post_count, created_at
FROM tags
WHERE LOWER(name) LIKE '%' || LOWER(?) || '%'
   OR LOWER(slug) LIKE '%' || LOWER(?) || '%'
ORDER BY post_count DESC, name ASC
LIMIT ?`

	return r.scanTags(ctx, q, query, query, limit)
}
