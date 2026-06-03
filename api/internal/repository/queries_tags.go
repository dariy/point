package repository

import (
	"context"
	"fmt"
	"strings"

	"point-api/internal/models"
)

// GetTagAncestors returns the ancestor chain from root to the given tag.
func (r *Repository) GetTagAncestors(ctx context.Context, tagID int64) ([]models.Tag, error) {
	// Iterative traversal: find parents of parents until no more parents
	visited := map[int64]bool{tagID: true}
	var ancestors []models.Tag
	currentID := tagID

	for {
		parents, err := r.GetTagParents(ctx, currentID)
		if err != nil || len(parents) == 0 {
			break
		}
		// Prefer eligible parents: not a system tag (slug starts with "_").
		// If multiple parents exist, skip ineligible ones so the breadcrumb
		// path only travels through tags that should be visible.
		var chosen *models.Tag
		for i := range parents {
			p := &parents[i]
			if !visited[p.ID] && !strings.HasPrefix(p.Slug, "_") {
				chosen = p
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
func (r *Repository) GetTagDescendants(ctx context.Context, tagID int64) ([]models.Tag, error) {
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
func (r *Repository) GetCoOccurringTags(ctx context.Context, tagID int64, publicOnly bool) ([]models.Tag, error) {
	statusClause := ""
	if publicOnly {
		statusClause = "AND p.status = 'published'"
	}
	q := fmt.Sprintf(`
SELECT t.id, t.name, t.slug, t.description, t.custom_url, t.sort_order, t.post_count, t.created_at
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
AND t.slug NOT LIKE '\_%%' ESCAPE '\'
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
		if err := rows.Scan(&t.ID, &t.Name, &t.Slug, &t.Description, &t.CustomUrl,
			&t.SortOrder, &t.PostCount, &t.CreatedAt); err != nil {
			return nil, err
		}
		tags = append(tags, t)
	}
	return tags, rows.Err()
}

// TagRelationship represents a parent-child tag relationship pair.
type TagRelationship struct {
	ParentID int64 `json:"parent_id"`
	ChildID  int64 `json:"child_id"`
}

// GetAllTagRelationships returns all (parent_id, child_id) pairs from tag_relationships.
func (r *Repository) GetAllTagRelationships(ctx context.Context) ([]TagRelationship, error) {
	const q = `SELECT parent_id, child_id FROM tag_relationships`
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
		if err := rows.Scan(&p.ParentID, &p.ChildID); err != nil {
			return nil, err
		}
		pairs = append(pairs, p)
	}
	return pairs, rows.Err()
}

// ClearTagParents removes all parent relationships for a tag (rows where child_id = tagID).
func (r *Repository) ClearTagParents(ctx context.Context, childID int64) error {
	const q = `DELETE FROM tag_relationships WHERE child_id = ?`
	_, err := r.db.ExecContext(ctx, q, childID)
	return err
}

// ClearTagChildren removes all child relationships for a tag (rows where parent_id = tagID).
func (r *Repository) ClearTagChildren(ctx context.Context, parentID int64) error {
	const q = `DELETE FROM tag_relationships WHERE parent_id = ?`
	_, err := r.db.ExecContext(ctx, q, parentID)
	return err
}

// GetTagsWithoutLocation returns tags that have no row in tag_locations.
// Only tags whose IDs are in the provided set are considered.
func (r *Repository) GetTagsWithoutLocation(ctx context.Context, tagIDs []int64) ([]models.Tag, error) {
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
SELECT t.id, t.name, t.slug, t.description, t.custom_url, t.sort_order, t.post_count, t.created_at
FROM tags t
LEFT JOIN tag_locations tl ON tl.tag_id = t.id
WHERE t.id IN (` + placeholders + `) AND tl.id IS NULL`

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
			&t.ID, &t.Name, &t.Slug, &t.Description, &t.CustomUrl,
			&t.SortOrder, &t.PostCount, &t.CreatedAt,
		); err != nil {
			return nil, err
		}
		items = append(items, t)
	}
	return items, rows.Err()
}

// FindTagsByNames returns tags whose lowercased name is in the given list.
func (r *Repository) FindTagsByNames(ctx context.Context, names []string) ([]models.Tag, error) {
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
SELECT id, name, slug, description, custom_url, sort_order, post_count, created_at
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
			&t.ID, &t.Name, &t.Slug, &t.Description, &t.CustomUrl,
			&t.SortOrder, &t.PostCount, &t.CreatedAt,
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
func (r *Repository) GetTagsByPostIDs(ctx context.Context, postIDs []int64) (map[int64][]PostTagInfo, error) {
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

// GetMigrations returns all rows from the migration_history table ordered by applied_at descending.
// Returns an empty slice if the table does not exist yet.
// GetChildrenOfTag returns direct children of parentID, ordered by sort_order ASC, name ASC.
func (r *Repository) GetChildrenOfTag(ctx context.Context, parentID int64) ([]models.Tag, error) {
	const q = `
SELECT t.id, t.name, t.slug, t.description, t.custom_url, t.sort_order, t.post_count, t.created_at
FROM tags t
JOIN tag_relationships tr ON tr.child_id = t.id
WHERE tr.parent_id = ?
ORDER BY t.sort_order ASC, t.name ASC`
	return r.scanTags(ctx, q, parentID)
}

// GetRootTags returns tags that have no parents, ordered by sort_order ASC, name ASC.
func (r *Repository) GetRootTags(ctx context.Context) ([]models.Tag, error) {
	const q = `
SELECT t.id, t.name, t.slug, t.description, t.custom_url, t.sort_order, t.post_count, t.created_at
FROM tags t
LEFT JOIN tag_relationships tr ON tr.child_id = t.id
WHERE tr.parent_id IS NULL
ORDER BY t.sort_order ASC, t.name ASC`
	return r.scanTags(ctx, q)
}

// UpdateTagSortOrder updates only the sort_order field for a tag.
func (r *Repository) UpdateTagSortOrder(ctx context.Context, id int64, sortOrder int32) error {
	_, err := r.db.ExecContext(ctx, `UPDATE tags SET sort_order = ? WHERE id = ?`, sortOrder, id)
	return err
}

// scanTags is a helper that executes a query and scans the result rows into []models.Tag.
func (r *Repository) scanTags(ctx context.Context, q string, args ...interface{}) ([]models.Tag, error) {
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
			&t.ID, &t.Name, &t.Slug, &t.Description, &t.CustomUrl,
			&t.SortOrder, &t.PostCount, &t.CreatedAt,
		); err != nil {
			return nil, err
		}
		items = append(items, t)
	}
	return items, rows.Err()
}

// DropTagNameUnique rebuilds the tags table to remove the UNIQUE constraint
// from the name column, keeping only slug as unique.
// This allows a user tag (e.g. slug="root") to share a display name with a
// system tag (e.g. slug="_root", name="root").
// It is idempotent: recorded as "drop_tags_name_unique" in migration_history.
func (r *Repository) DropTagNameUnique(ctx context.Context) error {
	if _, err := r.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS migration_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name VARCHAR(255) NOT NULL UNIQUE,
			applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`); err != nil {
		return fmt.Errorf("create migration_history: %w", err)
	}

	var count int64
	if err := r.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM migration_history WHERE name = 'drop_tags_name_unique'`,
	).Scan(&count); err != nil {
		return fmt.Errorf("check migration_history: %w", err)
	}
	if count > 0 {
		return nil
	}

	// Confirm the UNIQUE constraint still exists before rebuilding.
	// SQLite encodes constraint info in the CREATE TABLE statement stored in sqlite_master.
	var ddl string
	_ = r.db.QueryRowContext(ctx,
		`SELECT sql FROM sqlite_master WHERE type='table' AND name='tags'`,
	).Scan(&ddl)

	if strings.Contains(ddl, "name VARCHAR(100) NOT NULL UNIQUE") ||
		strings.Contains(ddl, "name VARCHAR(100)  NOT NULL UNIQUE") {
		stmts := []string{
			"PRAGMA foreign_keys = OFF",
			`CREATE TABLE IF NOT EXISTS tags_new (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name VARCHAR(100) NOT NULL,
				slug VARCHAR(100) NOT NULL UNIQUE,
				description TEXT,
				custom_url VARCHAR(200),
				sort_order INTEGER,
				post_count INTEGER NOT NULL DEFAULT 0,
				created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
			)`,
			`INSERT INTO tags_new (id, name, slug, description, custom_url, sort_order, post_count, created_at)
			SELECT id, name, slug, description, custom_url, sort_order, post_count, created_at FROM tags`,
			`DROP TABLE tags`,
			`ALTER TABLE tags_new RENAME TO tags`,
			`CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name)`,
			`CREATE INDEX IF NOT EXISTS idx_tags_slug ON tags(slug)`,
			"PRAGMA foreign_keys = ON",
		}
		for _, stmt := range stmts {
			if _, err := r.db.ExecContext(ctx, stmt); err != nil {
				return fmt.Errorf("drop_tags_name_unique rebuild: %w", err)
			}
		}
	}

	if _, err := r.db.ExecContext(ctx,
		`INSERT INTO migration_history (name, applied_at) VALUES ('drop_tags_name_unique', CURRENT_TIMESTAMP)`,
	); err != nil {
		return fmt.Errorf("record drop_tags_name_unique: %w", err)
	}
	return nil
}
