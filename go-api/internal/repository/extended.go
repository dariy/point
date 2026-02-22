package repository

import (
	"context"
	"time"

	"point-api/internal/models"
)

// ListOrphanedMedia returns media records with no associated post (post_id IS NULL).
func (r *Repository) ListOrphanedMedia(ctx context.Context, limit, offset int64) ([]models.Medium, error) {
	const q = `
SELECT id, filename, original_path, thumbnail_path, file_type, mime_type,
       file_size, width, height, post_id, uploaded_at, checksum, alt_text, caption
FROM media
WHERE post_id IS NULL
ORDER BY uploaded_at DESC
LIMIT ? OFFSET ?`

	rows, err := r.db.QueryContext(ctx, q, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []models.Medium
	for rows.Next() {
		var m models.Medium
		if err := rows.Scan(
			&m.ID, &m.Filename, &m.OriginalPath, &m.ThumbnailPath,
			&m.FileType, &m.MimeType, &m.FileSize, &m.Width, &m.Height,
			&m.PostID, &m.UploadedAt, &m.Checksum, &m.AltText, &m.Caption,
		); err != nil {
			return nil, err
		}
		items = append(items, m)
	}
	return items, rows.Err()
}

// CountOrphanedMedia counts media with no associated post.
func (r *Repository) CountOrphanedMedia(ctx context.Context) (int64, error) {
	const q = `SELECT COUNT(*) FROM media WHERE post_id IS NULL`
	var count int64
	err := r.db.QueryRowContext(ctx, q).Scan(&count)
	return count, err
}

// BulkDeleteMediaByIDs deletes multiple media records by ID and returns the deleted ones
// so the caller can remove files from disk.
func (r *Repository) GetMediaByIDs(ctx context.Context, ids []int64) ([]models.Medium, error) {
	if len(ids) == 0 {
		return nil, nil
	}

	// Build placeholders
	const baseQ = `
SELECT id, filename, original_path, thumbnail_path, file_type, mime_type,
       file_size, width, height, post_id, uploaded_at, checksum, alt_text, caption
FROM media WHERE id IN (`

	args := make([]interface{}, len(ids))
	placeholders := ""
	for i, id := range ids {
		args[i] = id
		if i > 0 {
			placeholders += ","
		}
		placeholders += "?"
	}
	q := baseQ + placeholders + ")"

	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []models.Medium
	for rows.Next() {
		var m models.Medium
		if err := rows.Scan(
			&m.ID, &m.Filename, &m.OriginalPath, &m.ThumbnailPath,
			&m.FileType, &m.MimeType, &m.FileSize, &m.Width, &m.Height,
			&m.PostID, &m.UploadedAt, &m.Checksum, &m.AltText, &m.Caption,
		); err != nil {
			return nil, err
		}
		items = append(items, m)
	}
	return items, rows.Err()
}

func (r *Repository) DeleteMediaByIDs(ctx context.Context, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}

	args := make([]interface{}, len(ids))
	placeholders := ""
	for i, id := range ids {
		args[i] = id
		if i > 0 {
			placeholders += ","
		}
		placeholders += "?"
	}
	q := `DELETE FROM media WHERE id IN (` + placeholders + `)`
	_, err := r.db.ExecContext(ctx, q, args...)
	return err
}

// SystemStats holds aggregate statistics about the blog.
type SystemStats struct {
	PostCount       int64
	PublishedCount  int64
	DraftCount      int64
	TagCount        int64
	MediaCount      int64
	StorageBytes    int64
	UserCount       int64
	SessionCount    int64
}

func (r *Repository) GetSystemStats(ctx context.Context) (SystemStats, error) {
	var s SystemStats
	const q = `
SELECT
  (SELECT COUNT(*) FROM posts) AS post_count,
  (SELECT COUNT(*) FROM posts WHERE status = 'published') AS published_count,
  (SELECT COUNT(*) FROM posts WHERE status = 'draft') AS draft_count,
  (SELECT COUNT(*) FROM tags) AS tag_count,
  (SELECT COUNT(*) FROM media) AS media_count,
  (SELECT COALESCE(SUM(file_size), 0) FROM media) AS storage_bytes,
  (SELECT COUNT(*) FROM users) AS user_count,
  (SELECT COUNT(*) FROM sessions WHERE expires_at > ?) AS session_count
`
	err := r.db.QueryRowContext(ctx, q, time.Now()).Scan(
		&s.PostCount, &s.PublishedCount, &s.DraftCount,
		&s.TagCount, &s.MediaCount, &s.StorageBytes,
		&s.UserCount, &s.SessionCount,
	)
	return s, err
}

// GetPublishedPostsForFeed returns the N most recent published posts for RSS/sitemap.
func (r *Repository) GetPublishedPostsForFeed(ctx context.Context, limit int) ([]models.GetPostRow, error) {
	const q = `
SELECT p.id, p.title, p.slug, p.content, p.excerpt, p.formatter, p.status,
       p.is_featured, p.view_count, p.published_at, p.created_at, p.updated_at,
       p.author_id, p.thumbnail_path, p.meta_description, p.preview_token,
       p.preview_expires_at,
       u.username as author_username, u.display_name as author_display_name,
       u.avatar_path as author_avatar
FROM posts p
JOIN users u ON p.author_id = u.id
WHERE LOWER(p.status) = 'published'
ORDER BY p.published_at DESC, p.created_at DESC
LIMIT ?`

	rows, err := r.db.QueryContext(ctx, q, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []models.GetPostRow
	for rows.Next() {
		var i models.GetPostRow
		if err := rows.Scan(
			&i.ID, &i.Title, &i.Slug, &i.Content, &i.Excerpt, &i.Formatter,
			&i.Status, &i.IsFeatured, &i.ViewCount, &i.PublishedAt,
			&i.CreatedAt, &i.UpdatedAt, &i.AuthorID, &i.ThumbnailPath,
			&i.MetaDescription, &i.PreviewToken, &i.PreviewExpiresAt,
			&i.AuthorUsername, &i.AuthorDisplayName, &i.AuthorAvatar,
		); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

// GetPublishedPostsForSitemap returns all published post slugs and timestamps.
func (r *Repository) GetPublishedPostsForSitemap(ctx context.Context) ([]struct {
	Slug      string
	UpdatedAt time.Time
}, error) {
	const q = `
SELECT slug, COALESCE(updated_at, published_at, created_at) as updated_at
FROM posts
WHERE status = 'published'
ORDER BY published_at DESC, created_at DESC`

	rows, err := r.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []struct {
		Slug      string
		UpdatedAt time.Time
	}
	for rows.Next() {
		var item struct {
			Slug      string
			UpdatedAt time.Time
		}
		var updatedStr string
		if err := rows.Scan(&item.Slug, &updatedStr); err != nil {
			return nil, err
		}
		// Attempt to parse time
		t, err := time.Parse("2006-01-02 15:04:05", updatedStr)
		if err != nil {
			// Try alternative format
			t, err = time.Parse(time.RFC3339, updatedStr)
		}
		if err == nil {
			item.UpdatedAt = t
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// GetPublicTagsForSitemap returns non-hidden tags with posts for the sitemap.
func (r *Repository) GetPublicTagsForSitemap(ctx context.Context) ([]struct {
	Slug string
}, error) {
	const q = `
SELECT slug FROM tags
WHERE post_count > 0 AND is_hidden = 0
ORDER BY name ASC`

	rows, err := r.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []struct{ Slug string }
	for rows.Next() {
		var item struct{ Slug string }
		if err := rows.Scan(&item.Slug); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// GetPostByPreviewToken looks up a post by its preview token.
func (r *Repository) GetPostByPreviewToken(ctx context.Context, token string) (models.GetPostRow, error) {
	const q = `
SELECT p.id, p.title, p.slug, p.content, p.excerpt, p.formatter, p.status,
       p.is_featured, p.view_count, p.published_at, p.created_at, p.updated_at,
       p.author_id, p.thumbnail_path, p.meta_description, p.preview_token,
       p.preview_expires_at,
       u.username as author_username, u.display_name as author_display_name,
       u.avatar_path as author_avatar
FROM posts p
JOIN users u ON p.author_id = u.id
WHERE p.preview_token = ? LIMIT 1`

	row := r.db.QueryRowContext(ctx, q, token)
	var i models.GetPostRow
	err := row.Scan(
		&i.ID, &i.Title, &i.Slug, &i.Content, &i.Excerpt, &i.Formatter,
		&i.Status, &i.IsFeatured, &i.ViewCount, &i.PublishedAt,
		&i.CreatedAt, &i.UpdatedAt, &i.AuthorID, &i.ThumbnailPath,
		&i.MetaDescription, &i.PreviewToken, &i.PreviewExpiresAt,
		&i.AuthorUsername, &i.AuthorDisplayName, &i.AuthorAvatar,
	)
	return i, err
}

// PostNavItem holds minimal data for a navigation link (prev/next post).
type PostNavItem struct {
	ID    int64
	Title string
	Slug  string
}

// GetPostNavigation returns the previous and next published posts relative to
// the given post's published_at timestamp. Either pointer may be nil when there
// is no adjacent post.
func (r *Repository) GetPostNavigation(ctx context.Context, postID int64) (prev, next *PostNavItem, err error) {
	const qDate = `SELECT published_at FROM posts WHERE id = ? AND status = 'PUBLISHED' LIMIT 1`
	var publishedAt string
	if err = r.db.QueryRowContext(ctx, qDate, postID).Scan(&publishedAt); err != nil {
		return nil, nil, err
	}

	const qPrev = `
SELECT id, title, slug FROM posts
WHERE status = 'PUBLISHED' AND published_at < ? AND id != ?
ORDER BY published_at DESC LIMIT 1`
	var p PostNavItem
	if err2 := r.db.QueryRowContext(ctx, qPrev, publishedAt, postID).Scan(&p.ID, &p.Title, &p.Slug); err2 == nil {
		prev = &p
	}

	const qNext = `
SELECT id, title, slug FROM posts
WHERE status = 'PUBLISHED' AND published_at > ? AND id != ?
ORDER BY published_at ASC LIMIT 1`
	var n PostNavItem
	if err2 := r.db.QueryRowContext(ctx, qNext, publishedAt, postID).Scan(&n.ID, &n.Title, &n.Slug); err2 == nil {
		next = &n
	}

	return prev, next, nil
}

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
		// Take first parent (assume single-parent hierarchy)
		parent := parents[0]
		if visited[parent.ID] {
			break
		}
		visited[parent.ID] = true
		ancestors = append([]models.Tag{parent}, ancestors...)
		currentID = parent.ID
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

// TagRelationship represents a parent-child tag relationship pair.
type TagRelationship struct {
	ParentID int64
	ChildID  int64
}

// GetAllTagRelationships returns all (parent_id, child_id) pairs from tag_relationships.
func (r *Repository) GetAllTagRelationships(ctx context.Context) ([]TagRelationship, error) {
	const q = `SELECT parent_id, child_id FROM tag_relationships`
	rows, err := r.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
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

// GetOrphanedMediaIDs returns IDs of media that are not referenced in any post content.
// "Orphaned" here means post_id IS NULL.
func (r *Repository) ListOrphanedMediaByPage(ctx context.Context, limit, offset int64) ([]models.Medium, int64, error) {
	media, err := r.ListOrphanedMedia(ctx, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	count, err := r.CountOrphanedMedia(ctx)
	if err != nil {
		return nil, 0, err
	}
	return media, count, nil
}

// BackupDB creates a SQL dump of the SQLite database using backup API.
func (r *Repository) BackupDB(ctx context.Context, destPath string) error {
	_, err := r.db.ExecContext(ctx, "VACUUM INTO ?", destPath)
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
SELECT t.id, t.name, t.slug, t.description, t.custom_url, t.is_important,
       t.is_featured, t.is_hidden, t.is_hidden_posts, t.include_in_breadcrumbs,
       t.show_related_tags_as_children, t.sort_order, t.post_count, t.created_at
FROM tags t
LEFT JOIN tag_locations tl ON tl.tag_id = t.id
WHERE t.id IN (` + placeholders + `) AND tl.id IS NULL`

	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []models.Tag
	for rows.Next() {
		var t models.Tag
		if err := rows.Scan(
			&t.ID, &t.Name, &t.Slug, &t.Description, &t.CustomUrl,
			&t.IsImportant, &t.IsFeatured, &t.IsHidden, &t.IsHiddenPosts,
			&t.IncludeInBreadcrumbs, &t.ShowRelatedTagsAsChildren,
			&t.SortOrder, &t.PostCount, &t.CreatedAt,
		); err != nil {
			return nil, err
		}
		items = append(items, t)
	}
	return items, rows.Err()
}

// UpsertTagLocation inserts or replaces a coordinate record for a tag.
func (r *Repository) UpsertTagLocation(ctx context.Context, tagID int64, lat, lon float64) error {
	const q = `
INSERT INTO tag_locations (tag_id, latitude, longitude)
VALUES (?, ?, ?)
ON CONFLICT(tag_id) DO UPDATE SET latitude = excluded.latitude, longitude = excluded.longitude`
	_, err := r.db.ExecContext(ctx, q, tagID, lat, lon)
	return err
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
SELECT id, name, slug, description, custom_url, is_important, is_featured,
       is_hidden, is_hidden_posts, include_in_breadcrumbs,
       show_related_tags_as_children, sort_order, post_count, created_at
FROM tags WHERE lower(name) IN (` + placeholders + `)`

	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []models.Tag
	for rows.Next() {
		var t models.Tag
		if err := rows.Scan(
			&t.ID, &t.Name, &t.Slug, &t.Description, &t.CustomUrl,
			&t.IsImportant, &t.IsFeatured, &t.IsHidden, &t.IsHiddenPosts,
			&t.IncludeInBreadcrumbs, &t.ShowRelatedTagsAsChildren,
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
	defer rows.Close()

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

// GetYearTagsByLocationTagIDs returns a map of locationTagID → []PostTagInfo (years).
// A "year" tag is defined as a child of the provided yearParentID.
func (r *Repository) GetYearTagsByLocationTagIDs(ctx context.Context, locTagIDs []int64, yearParentID int64) (map[int64][]PostTagInfo, error) {
	result := make(map[int64][]PostTagInfo)
	if len(locTagIDs) == 0 {
		return result, nil
	}

	// First part: the location tag IDs
	args := make([]interface{}, len(locTagIDs))
	placeholders := ""
	for i, id := range locTagIDs {
		args[i] = id
		if i > 0 {
			placeholders += ","
		}
		placeholders += "?"
	}
	// Second part: the year parent ID
	args = append(args, yearParentID)

	q := `
SELECT DISTINCT pt1.tag_id as loc_tag_id, year_tag.id, year_tag.name, year_tag.slug
FROM post_tags AS pt1
JOIN post_tags AS pt2 ON pt1.post_id = pt2.post_id
JOIN tags AS year_tag ON pt2.tag_id = year_tag.id
JOIN tag_relationships AS tr ON year_tag.id = tr.child_id
WHERE pt1.tag_id IN (` + placeholders + `) AND tr.parent_id = ?
ORDER BY year_tag.name ASC`

	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var locTagID int64
		var tag PostTagInfo
		if err := rows.Scan(&locTagID, &tag.ID, &tag.Name, &tag.Slug); err != nil {
			return nil, err
		}
		result[locTagID] = append(result[locTagID], tag)
	}
	return result, rows.Err()
}

// GetTagLocationsByTagIDs fetches all tag_locations rows for the given tag IDs.
// Returns a map of tagID → TagLocation (one per tag due to UNIQUE constraint).
func (r *Repository) GetTagLocationsByTagIDs(ctx context.Context, tagIDs []int64) (map[int64]models.TagLocation, error) {
	result := make(map[int64]models.TagLocation)
	if len(tagIDs) == 0 {
		return result, nil
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

	q := `SELECT id, tag_id, latitude, longitude FROM tag_locations WHERE tag_id IN (` + placeholders + `)`
	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var loc models.TagLocation
		if err := rows.Scan(&loc.ID, &loc.TagID, &loc.Latitude, &loc.Longitude); err != nil {
			return nil, err
		}
		result[loc.TagID] = loc
	}
	return result, rows.Err()
}

// DeleteTagLocation removes the coordinate record for a tag (if any).
func (r *Repository) DeleteTagLocation(ctx context.Context, tagID int64) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM tag_locations WHERE tag_id = ?`, tagID)
	return err
}

// MigrationRecord holds a single row from migration_history.
type MigrationRecord struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	AppliedAt time.Time `json:"applied_at"`
}

// GetMigrations returns all rows from the migration_history table ordered by applied_at descending.
// Returns an empty slice if the table does not exist yet.
func (r *Repository) GetMigrations(ctx context.Context) ([]MigrationRecord, error) {
	const q = `SELECT id, name, applied_at FROM migration_history ORDER BY applied_at DESC`
	rows, err := r.db.QueryContext(ctx, q)
	if err != nil {
		// Table may not exist in older databases — return empty list rather than error.
		return []MigrationRecord{}, nil
	}
	defer rows.Close()

	var items []MigrationRecord
	for rows.Next() {
		var m MigrationRecord
		if err := rows.Scan(&m.ID, &m.Name, &m.AppliedAt); err != nil {
			return nil, err
		}
		items = append(items, m)
	}
	if items == nil {
		items = []MigrationRecord{}
	}
	return items, rows.Err()
}

