package repository

import (
	"context"
	"fmt"
	"strings"
	"time"

	"point-api/internal/models"
)

// ListPostsWithSearch returns posts filtered by a search term (case-insensitive)
// matched against title, post slug, content, and associated tag names/slugs,
// in addition to the standard status / featured / visibility filters.

// ListPosts returns all posts, with optional filters.
func (r *Repository) ListPosts(ctx context.Context, arg models.ListPostsParams) ([]models.Post, error) {
	const q = `
SELECT p.id, p.title, p.slug, p.content, p.excerpt, p.formatter, p.status, p.is_featured,
       p.view_count, p.published_at, p.created_at, p.updated_at, p.author_id,
       p.thumbnail_path, p.meta_description, p.preview_token, p.preview_expires_at
FROM posts p
WHERE
    (CASE WHEN ? THEN LOWER(p.status) = LOWER(?) ELSE 1=1 END)
    AND (CASE WHEN ? THEN p.is_featured = 1 ELSE 1=1 END)
    AND (CASE
        WHEN ? THEN 1=1
        WHEN ? THEN LOWER(p.status) IN ('published', 'hidden')
        ELSE LOWER(p.status) = 'published'
    END)
    AND (CASE WHEN ? THEN 1=1 WHEN ? THEN 1=1 ELSE p.id NOT IN (
        SELECT pt.post_id FROM post_tags pt
        WHERE pt.tag_id IN (
            WITH RECURSIVE h(id) AS (
                SELECT child_id AS id FROM tag_relationships WHERE parent_id = (SELECT id FROM tags WHERE slug = '_hide_posts')
                UNION
                SELECT tr.child_id FROM tag_relationships tr JOIN h ON tr.parent_id = h.id
            )
            SELECT id FROM h
        )
    ) END)
ORDER BY p.published_at DESC, p.created_at DESC
LIMIT ? OFFSET ?`

	rows, err := r.db.QueryContext(ctx, q,
		arg.StatusFilter, arg.Status, arg.FeaturedFilter, arg.IncludeDrafts, arg.IncludeHidden,
		arg.IncludeDrafts, arg.IncludeHidden,
		arg.Limit, arg.Offset)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = rows.Close()
	}()

	var items []models.Post
	for rows.Next() {
		var i models.Post
		if err := rows.Scan(
			&i.ID, &i.Title, &i.Slug, &i.Content, &i.Excerpt, &i.Formatter,
			&i.Status, &i.IsFeatured, &i.ViewCount, &i.PublishedAt,
			&i.CreatedAt, &i.UpdatedAt, &i.AuthorID, &i.ThumbnailPath,
			&i.MetaDescription, &i.PreviewToken, &i.PreviewExpiresAt,
		); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

// CountPosts counts posts with optional filters.
func (r *Repository) CountPosts(ctx context.Context, arg models.CountPostsParams) (int64, error) {
	const q = `
SELECT COUNT(*) FROM posts p
WHERE
    (CASE WHEN ? THEN LOWER(p.status) = LOWER(?) ELSE 1=1 END)
    AND (CASE WHEN ? THEN p.is_featured = 1 ELSE 1=1 END)
    AND (CASE
        WHEN ? THEN 1=1
        WHEN ? THEN LOWER(p.status) IN ('published', 'hidden')
        ELSE LOWER(p.status) = 'published'
    END)
    AND (CASE WHEN ? THEN 1=1 WHEN ? THEN 1=1 ELSE p.id NOT IN (
        SELECT pt.post_id FROM post_tags pt
        WHERE pt.tag_id IN (
            WITH RECURSIVE h(id) AS (
                SELECT child_id AS id FROM tag_relationships WHERE parent_id = (SELECT id FROM tags WHERE slug = '_hide_posts')
                UNION
                SELECT tr.child_id FROM tag_relationships tr JOIN h ON tr.parent_id = h.id
            )
            SELECT id FROM h
        )
    ) END)`

	var count int64
	err := r.db.QueryRowContext(ctx, q,
		arg.StatusFilter, arg.Status, arg.FeaturedFilter, arg.IncludeDrafts, arg.IncludeHidden,
		arg.IncludeDrafts, arg.IncludeHidden,
	).Scan(&count)
	return count, err
}

func (r *Repository) ListPostsWithSearch(ctx context.Context, statusFilter bool, status string, featuredFilter bool, includeDrafts bool, includeHidden bool, search string, limit, offset int64) ([]models.Post, error) {
	const q = `
WITH RECURSIVE ehp(id) AS (
    SELECT child_id AS id FROM tag_relationships WHERE parent_id = (SELECT id FROM tags WHERE slug = '_hide_posts')
    UNION
    SELECT tr.child_id FROM tag_relationships tr JOIN ehp ON tr.parent_id = ehp.id
)
SELECT p.id, p.title, p.slug, p.content, p.excerpt, p.formatter, p.status, p.is_featured,
       p.view_count, p.published_at, p.created_at, p.updated_at, p.author_id,
       p.thumbnail_path, p.meta_description, p.preview_token, p.preview_expires_at
FROM posts p
WHERE
    (CASE WHEN ? THEN LOWER(p.status) = LOWER(?) ELSE 1=1 END)
    AND (CASE WHEN ? THEN p.is_featured = 1 ELSE 1=1 END)
    AND (CASE
        WHEN ? THEN 1=1
        WHEN ? THEN LOWER(p.status) IN ('published', 'hidden')
        ELSE LOWER(p.status) = 'published'
    END)

    AND (CASE WHEN ? THEN 1=1 WHEN ? THEN 1=1 ELSE p.id NOT IN (
        SELECT pt.post_id FROM post_tags pt
        WHERE pt.tag_id IN (
            WITH RECURSIVE h(id) AS (
                SELECT child_id AS id FROM tag_relationships WHERE parent_id = (SELECT id FROM tags WHERE slug = '_hide_posts')
                UNION
                SELECT tr.child_id FROM tag_relationships tr JOIN h ON tr.parent_id = h.id
            )
            SELECT id FROM h
        )
    ) END)
    AND (
        LOWER(p.title)   LIKE '%' || LOWER(?) || '%'
        OR LOWER(p.slug)    LIKE '%' || LOWER(?) || '%'
        OR LOWER(p.content) LIKE '%' || LOWER(?) || '%'
        OR EXISTS (
            SELECT 1 FROM post_tags pt
            JOIN tags t ON t.id = pt.tag_id
            WHERE pt.post_id = p.id
              AND (LOWER(t.name) LIKE '%' || LOWER(?) || '%'
                   OR LOWER(t.slug) LIKE '%' || LOWER(?) || '%')
        )
    )
ORDER BY p.published_at DESC, p.created_at DESC
LIMIT ? OFFSET ?`

	rows, err := r.db.QueryContext(ctx, q,
		statusFilter, status, featuredFilter, includeDrafts, includeHidden, includeDrafts, includeHidden,
		search, search, search, search, search,
		limit, offset)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = rows.Close()
	}()

	var items []models.Post
	for rows.Next() {
		var i models.Post
		if err := rows.Scan(
			&i.ID, &i.Title, &i.Slug, &i.Content, &i.Excerpt, &i.Formatter,
			&i.Status, &i.IsFeatured, &i.ViewCount, &i.PublishedAt,
			&i.CreatedAt, &i.UpdatedAt, &i.AuthorID, &i.ThumbnailPath,
			&i.MetaDescription, &i.PreviewToken, &i.PreviewExpiresAt,
		); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

// CountPostsWithSearch counts posts matched by the extended search (title, slug,
// content, tag name, tag slug).
func (r *Repository) CountPostsWithSearch(ctx context.Context, statusFilter bool, status string, featuredFilter bool, includeDrafts bool, includeHidden bool, search string) (int64, error) {
	const q = `
WITH RECURSIVE ehp(id) AS (
    SELECT child_id AS id FROM tag_relationships WHERE parent_id = (SELECT id FROM tags WHERE slug = '_hide_posts')
    UNION
    SELECT tr.child_id FROM tag_relationships tr JOIN ehp ON tr.parent_id = ehp.id
)
SELECT COUNT(*) FROM posts p
WHERE
    (CASE WHEN ? THEN LOWER(p.status) = LOWER(?) ELSE 1=1 END)
    AND (CASE WHEN ? THEN p.is_featured = 1 ELSE 1=1 END)
    AND (CASE
        WHEN ? THEN 1=1
        WHEN ? THEN LOWER(p.status) IN ('published', 'hidden')
        ELSE LOWER(p.status) = 'published'
    END)

    AND (CASE WHEN ? THEN 1=1 WHEN ? THEN 1=1 ELSE p.id NOT IN (
        SELECT pt.post_id FROM post_tags pt
        WHERE pt.tag_id IN (
            WITH RECURSIVE h(id) AS (
                SELECT child_id AS id FROM tag_relationships WHERE parent_id = (SELECT id FROM tags WHERE slug = '_hide_posts')
                UNION
                SELECT tr.child_id FROM tag_relationships tr JOIN h ON tr.parent_id = h.id
            )
            SELECT id FROM h
        )
    ) END)
    AND (
        LOWER(p.title)   LIKE '%' || LOWER(?) || '%'
        OR LOWER(p.slug)    LIKE '%' || LOWER(?) || '%'
        OR LOWER(p.content) LIKE '%' || LOWER(?) || '%'
        OR EXISTS (
            SELECT 1 FROM post_tags pt
            JOIN tags t ON t.id = pt.tag_id
            WHERE pt.post_id = p.id
              AND (LOWER(t.name) LIKE '%' || LOWER(?) || '%'
                   OR LOWER(t.slug) LIKE '%' || LOWER(?) || '%')
        )
    )`

	var count int64
	err := r.db.QueryRowContext(ctx, q,
		statusFilter, status, featuredFilter, includeDrafts, includeHidden, includeDrafts, includeHidden,
		search, search, search, search, search,
	).Scan(&count)
	return count, err
}

// ListOrphanedMedia returns media records with no associated post (post_id IS NULL).
func (r *Repository) ListOrphanedMedia(ctx context.Context, limit, offset int64) ([]models.Medium, error) {
	const q = `
SELECT id, filename, original_path, thumbnail_path, file_type, mime_type,
       file_size, width, height, post_id, uploaded_at, checksum, alt_text, caption, is_public
FROM media
WHERE post_id IS NULL
ORDER BY uploaded_at DESC
LIMIT ? OFFSET ?`

	rows, err := r.db.QueryContext(ctx, q, limit, offset)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = rows.Close()
	}()

	var items []models.Medium
	for rows.Next() {
		var m models.Medium
		if err := rows.Scan(
			&m.ID, &m.Filename, &m.OriginalPath, &m.ThumbnailPath,
			&m.FileType, &m.MimeType, &m.FileSize, &m.Width, &m.Height,
			&m.PostID, &m.UploadedAt, &m.Checksum, &m.AltText, &m.Caption, &m.IsPublic,
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
       file_size, width, height, post_id, uploaded_at, checksum, alt_text, caption, is_public
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
	defer func() {
		_ = rows.Close()
	}()

	var items []models.Medium
	for rows.Next() {
		var m models.Medium
		if err := rows.Scan(
			&m.ID, &m.Filename, &m.OriginalPath, &m.ThumbnailPath,
			&m.FileType, &m.MimeType, &m.FileSize, &m.Width, &m.Height,
			&m.PostID, &m.UploadedAt, &m.Checksum, &m.AltText, &m.Caption, &m.IsPublic,
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
  (SELECT COUNT(*) FROM posts WHERE LOWER(status) = 'published') AS published_count,
  (SELECT COUNT(*) FROM posts WHERE LOWER(status) = 'draft') AS draft_count,
  (SELECT COUNT(*) FROM tags) AS tag_count,
  (SELECT COUNT(*) FROM media) AS media_count,
  (SELECT COALESCE(SUM(file_size), 0) FROM media) AS storage_bytes,
  (SELECT COUNT(*) FROM users) AS user_count,
  (SELECT COUNT(*) FROM sessions WHERE expires_at > ?) AS session_count
`
	err := r.db.QueryRowContext(ctx, q, time.Now().UTC().Round(0)).Scan(
		&s.PostCount, &s.PublishedCount, &s.DraftCount,
		&s.TagCount, &s.MediaCount, &s.StorageBytes,
		&s.UserCount, &s.SessionCount,
	)
	return s, err
}

// GetPublishedPostsForFeed returns the N most recent published posts for RSS/sitemap.
func (r *Repository) GetPublishedPostsForFeed(ctx context.Context, limit int) ([]models.Post, error) {
	const q = `
SELECT p.id, p.title, p.slug, p.content, p.excerpt, p.formatter, p.status,
       p.is_featured, p.view_count, p.published_at, p.created_at, p.updated_at,
       p.author_id, p.thumbnail_path, p.meta_description, p.preview_token,
       p.preview_expires_at
FROM posts p
WHERE LOWER(p.status) = 'published'
AND p.id NOT IN (
    SELECT pt.post_id FROM post_tags pt 
    WHERE pt.tag_id IN (
        WITH RECURSIVE h(id) AS (
            SELECT child_id AS id FROM tag_relationships WHERE parent_id = (SELECT id FROM tags WHERE slug = '_hide_posts')
            UNION
            SELECT tr.child_id FROM tag_relationships tr JOIN h ON tr.parent_id = h.id
        )
        SELECT id FROM h
    )
)
ORDER BY p.published_at DESC, p.created_at DESC
LIMIT ?`

	rows, err := r.db.QueryContext(ctx, q, limit)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = rows.Close()
	}()

	var items []models.Post
	for rows.Next() {
		var i models.Post
		if err := rows.Scan(
			&i.ID, &i.Title, &i.Slug, &i.Content, &i.Excerpt, &i.Formatter,
			&i.Status, &i.IsFeatured, &i.ViewCount, &i.PublishedAt,
			&i.CreatedAt, &i.UpdatedAt, &i.AuthorID, &i.ThumbnailPath,
			&i.MetaDescription, &i.PreviewToken, &i.PreviewExpiresAt,
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
WHERE LOWER(status) = 'published'
AND id NOT IN (
    SELECT pt.post_id FROM post_tags pt 
    WHERE pt.tag_id IN (
        WITH RECURSIVE h(id) AS (
            SELECT child_id AS id FROM tag_relationships WHERE parent_id = (SELECT id FROM tags WHERE slug = '_hide_posts')
            UNION
            SELECT tr.child_id FROM tag_relationships tr JOIN h ON tr.parent_id = h.id
        )
        SELECT id FROM h
    )
)
ORDER BY published_at DESC, created_at DESC`

	rows, err := r.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = rows.Close()
	}()

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
	ID   int64
	Slug string
}, error) {
	const q = `
SELECT id, slug FROM tags
WHERE post_count > 0 AND slug NOT LIKE '\_%%' ESCAPE '\' AND id NOT IN (SELECT tr.child_id FROM tag_relationships tr JOIN tags t ON t.id = tr.parent_id WHERE t.slug = '_hidden')
ORDER BY name ASC`

	rows, err := r.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = rows.Close()
	}()

	var items []struct {
		ID   int64
		Slug string
	}
	for rows.Next() {
		var item struct {
			ID   int64
			Slug string
		}
		if err := rows.Scan(&item.ID, &item.Slug); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// GetPostByPreviewToken looks up a post by its preview token.
func (r *Repository) GetPostByPreviewToken(ctx context.Context, token string) (models.Post, error) {
	const q = `
SELECT p.id, p.title, p.slug, p.content, p.excerpt, p.formatter, p.status,
       p.is_featured, p.view_count, p.published_at, p.created_at, p.updated_at,
       p.author_id, p.thumbnail_path, p.meta_description, p.preview_token,
       p.preview_expires_at
FROM posts p
WHERE p.preview_token = ? LIMIT 1`

	row := r.db.QueryRowContext(ctx, q, token)
	var i models.Post
	err := row.Scan(
		&i.ID, &i.Title, &i.Slug, &i.Content, &i.Excerpt, &i.Formatter,
		&i.Status, &i.IsFeatured, &i.ViewCount, &i.PublishedAt,
		&i.CreatedAt, &i.UpdatedAt, &i.AuthorID, &i.ThumbnailPath,
		&i.MetaDescription, &i.PreviewToken, &i.PreviewExpiresAt,
	)
	return i, err
}

// PostNavItem holds minimal data for a navigation link (prev/next post).
type PostNavItem struct {
	ID    int64
	Title string
	Slug  string
}

// GetPostNavigation returns the previous and next posts relative to
// the given post's published_at timestamp. Either pointer may be nil when there
// is no adjacent post.
func (r *Repository) GetPostNavigation(ctx context.Context, postID int64, publicOnly bool) (prev, next *PostNavItem, err error) {
	const qDate = `SELECT CAST(published_at AS TEXT) FROM posts WHERE id = ? LIMIT 1`
	var publishedAt string
	if err = r.db.QueryRowContext(ctx, qDate, postID).Scan(&publishedAt); err != nil {
		return nil, nil, err
	}

	statusFilter := "LOWER(status) = 'published'"
	if !publicOnly {
		statusFilter = "LOWER(status) IN ('published', 'hidden')"
	}

	qPrev := fmt.Sprintf(`
SELECT id, title, slug FROM posts
WHERE (%s) AND (published_at < ? OR (published_at = ? AND id < ?))
ORDER BY published_at DESC, id DESC LIMIT 1`, statusFilter)
	var p PostNavItem
	if err2 := r.db.QueryRowContext(ctx, qPrev, publishedAt, publishedAt, postID).Scan(&p.ID, &p.Title, &p.Slug); err2 == nil {
		prev = &p
	}

	qNext := fmt.Sprintf(`
SELECT id, title, slug FROM posts
WHERE (%s) AND (published_at > ? OR (published_at = ? AND id > ?))
ORDER BY published_at ASC, id ASC LIMIT 1`, statusFilter)
	var n PostNavItem
	if err2 := r.db.QueryRowContext(ctx, qNext, publishedAt, publishedAt, postID).Scan(&n.ID, &n.Title, &n.Slug); err2 == nil {
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
WHERE pt.post_id IN (
    SELECT pt2.post_id FROM post_tags pt2
    JOIN posts p2 ON pt2.post_id = p2.id
    WHERE pt2.tag_id = ? %s
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

// MediaFolder represents a year/month folder in the media library.
type MediaFolder struct {
	Year  string
	Month string
}

// ListMediaFolders returns distinct YYYY/MM folder combinations from the media table,
// filtered by file_type if provided, ordered newest first.
func (r *Repository) ListMediaFolders(ctx context.Context, fileType string) ([]MediaFolder, error) {
	const q = `
SELECT DISTINCT
    substr(original_path, 11, 4) as year,
    substr(original_path, 16, 2) as month
FROM media
WHERE original_path LIKE 'originals/____/__/%'
  AND (? = '' OR LOWER(file_type) = LOWER(?))
ORDER BY year DESC, month DESC`

	rows, err := r.db.QueryContext(ctx, q, fileType, fileType)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = rows.Close()
	}()

	var folders []MediaFolder
	for rows.Next() {
		var f MediaFolder
		if err := rows.Scan(&f.Year, &f.Month); err != nil {
			return nil, err
		}
		folders = append(folders, f)
	}
	return folders, rows.Err()
}

// ListMediaFiltered lists media with optional file_type and/or folder (YYYY/MM) filters.
func (r *Repository) ListMediaFiltered(ctx context.Context, fileType, folder string, limit, offset int64) ([]models.Medium, error) {
	folderPrefix := ""
	if folder != "" {
		folderPrefix = "originals/" + folder + "/"
	}
	const q = `
SELECT id, filename, original_path, thumbnail_path, file_type, mime_type,
       file_size, width, height, post_id, uploaded_at, checksum, alt_text, caption, is_public, metadata
FROM media
WHERE (? = '' OR LOWER(file_type) = LOWER(?))
  AND (? = '' OR original_path LIKE ? || '%')
ORDER BY uploaded_at DESC
LIMIT ? OFFSET ?`

	rows, err := r.db.QueryContext(ctx, q, fileType, fileType, folderPrefix, folderPrefix, limit, offset)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = rows.Close()
	}()

	var items []models.Medium
	for rows.Next() {
		var m models.Medium
		if err := rows.Scan(
			&m.ID, &m.Filename, &m.OriginalPath, &m.ThumbnailPath,
			&m.FileType, &m.MimeType, &m.FileSize, &m.Width, &m.Height,
			&m.PostID, &m.UploadedAt, &m.Checksum, &m.AltText, &m.Caption, &m.IsPublic, &m.Metadata,
		); err != nil {
			return nil, err
		}
		items = append(items, m)
	}
	return items, rows.Err()
}

// CountMediaFiltered counts media with optional file_type and/or folder filters.
func (r *Repository) CountMediaFiltered(ctx context.Context, fileType, folder string) (int64, error) {
	folderPrefix := ""
	if folder != "" {
		folderPrefix = "originals/" + folder + "/"
	}
	const q = `
SELECT COUNT(*) FROM media
WHERE (? = '' OR LOWER(file_type) = LOWER(?))
  AND (? = '' OR original_path LIKE ? || '%')`

	var count int64
	err := r.db.QueryRowContext(ctx, q, fileType, fileType, folderPrefix, folderPrefix).Scan(&count)
	return count, err
}

// BackupDB creates a SQL dump of the SQLite database using backup API.
func (r *Repository) BackupDB(ctx context.Context, destPath string) error {
	_, err := r.db.ExecContext(ctx, "VACUUM INTO ?", destPath)
	return err
}

// ReplacePostContentPath replaces all occurrences of oldPath with newPath in
// every post's content column, and also updates the thumbnail_path column.
// Returns the number of posts updated.
func (r *Repository) ReplacePostContentPath(ctx context.Context, oldPath, newPath string) (int64, error) {
	// Handle content replacement and thumbnail_path replacement in one transaction
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()

	// Update content
	res1, err := tx.ExecContext(ctx,
		`UPDATE posts SET content = REPLACE(content, ?, ?) WHERE content LIKE '%' || ? || '%'`,
		oldPath, newPath, oldPath,
	)
	if err != nil {
		return 0, err
	}

	// Update thumbnail_path (exact match)
	res2, err := tx.ExecContext(ctx,
		`UPDATE posts SET thumbnail_path = ? WHERE thumbnail_path = ?`,
		newPath, oldPath,
	)
	if err != nil {
		return 0, err
	}

	// Also handle thumbnail_path with ?thumb suffix
	oldThumb := oldPath + "?thumb"
	newThumb := newPath + "?thumb"
	res3, err := tx.ExecContext(ctx,
		`UPDATE posts SET thumbnail_path = ? WHERE thumbnail_path = ?`,
		newThumb, oldThumb,
	)
	if err != nil {
		return 0, err
	}

	if err := tx.Commit(); err != nil {
		return 0, err
	}

	n1, _ := res1.RowsAffected()
	n2, _ := res2.RowsAffected()
	n3, _ := res3.RowsAffected()

	// Return total affected (might count same post multiple times if both changed, but that's okay for return value)
	return n1 + n2 + n3, nil
}

// UpdatePostThumbnailPath updates the thumbnail_path column for all posts
// currently using oldPath to newPath. Returns number of posts updated.
func (r *Repository) UpdatePostThumbnailPath(ctx context.Context, oldPath, newPath string) (int64, error) {
	res, err := r.db.ExecContext(ctx,
		`UPDATE posts SET thumbnail_path = ? WHERE thumbnail_path = ?`,
		newPath, oldPath,
	)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
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

// UpsertTagLocation inserts or updates a coordinate record for a tag.
// Uses UPDATE-then-INSERT to avoid dependency on a named UNIQUE constraint.
func (r *Repository) UpsertTagLocation(ctx context.Context, tagID int64, lat, lon float64) error {
	res, err := r.db.ExecContext(ctx,
		`UPDATE tag_locations SET latitude = ?, longitude = ? WHERE tag_id = ?`,
		lat, lon, tagID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		_, err = r.db.ExecContext(ctx,
			`INSERT INTO tag_locations (tag_id, latitude, longitude) VALUES (?, ?, ?)`,
			tagID, lat, lon)
	}
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

// PostStub is a lightweight post descriptor used for position/page lookups.
type PostStub struct {
	ID          int64
	Slug        string
	PublishedAt time.Time
	CreatedAt   time.Time
}

// ListPublishedPostStubs returns id, slug, published_at for all published,
// non-hidden posts, ordered newest first. Does not include content.
func (r *Repository) ListPublishedPostStubs(ctx context.Context) ([]PostStub, error) {
	const q = `
SELECT id, slug, published_at, created_at
FROM posts
WHERE LOWER(status) = 'published'
AND id NOT IN (
    SELECT pt.post_id FROM post_tags pt 
    WHERE pt.tag_id IN (
        WITH RECURSIVE h(id) AS (
            SELECT child_id AS id FROM tag_relationships WHERE parent_id = (SELECT id FROM tags WHERE slug = '_hide_posts')
            UNION
            SELECT tr.child_id FROM tag_relationships tr JOIN h ON tr.parent_id = h.id
        )
        SELECT id FROM h
    )
)
ORDER BY published_at DESC, created_at DESC`

	rows, err := r.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var stubs []PostStub
	for rows.Next() {
		var s PostStub
		if err := rows.Scan(&s.ID, &s.Slug, &s.PublishedAt, &s.CreatedAt); err != nil {
			return nil, err
		}
		stubs = append(stubs, s)
	}
	return stubs, rows.Err()
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
	defer func() {
		_ = rows.Close()
	}()

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
	defer func() {
		_ = rows.Close()
	}()

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

func (r *Repository) GetMigrations(ctx context.Context) ([]MigrationRecord, error) {
	const q = `SELECT id, name, applied_at FROM migration_history ORDER BY applied_at DESC`
	rows, err := r.db.QueryContext(ctx, q)
	if err != nil {
		// Table may not exist in older databases — return empty list rather than error.
		return []MigrationRecord{}, nil
	}
	defer func() {
		_ = rows.Close()
	}()

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

// GetPostsByTagIDs returns paginated posts that have at least one tag from the
// given set of tag IDs. The status filter mirrors CountPostsByTag / GetPostsByTag.
func (r *Repository) GetPostsByTagIDs(ctx context.Context, tagIDs []int64, publishedOnly bool, includeDrafts bool, includeHidden bool, limit, offset int64) ([]models.Post, error) {
	if len(tagIDs) == 0 {
		return []models.Post{}, nil
	}

	placeholders := ""
	args := make([]interface{}, 0, len(tagIDs)+3)
	for i, id := range tagIDs {
		if i > 0 {
			placeholders += ","
		}
		placeholders += "?"
		args = append(args, id)
	}

var statusClause string
	if includeDrafts {
		statusClause = "1=1"
	} else if includeHidden {
		// Authenticated users see published + hidden, _hide_posts exclusion not applied.
		statusClause = "LOWER(p.status) IN ('published', 'hidden')"
	} else {
		if publishedOnly {
			statusClause = "LOWER(p.status) = 'published'"
		} else {
			statusClause = "LOWER(p.status) IN ('published', 'hidden')"
		}
		statusClause += ` AND p.id NOT IN (
			SELECT pt.post_id FROM post_tags pt
			WHERE pt.tag_id IN (
				WITH RECURSIVE h(id) AS (
					SELECT child_id AS id FROM tag_relationships WHERE parent_id = (SELECT id FROM tags WHERE slug = '_hide_posts')
					UNION
					SELECT tr.child_id FROM tag_relationships tr JOIN h ON tr.parent_id = h.id
				)
				SELECT id FROM h
			)
		)`
	}

	bypassEHP := includeDrafts || includeHidden
	q := `
WITH RECURSIVE ehp(id) AS (
    SELECT child_id AS id FROM tag_relationships WHERE parent_id = (SELECT id FROM tags WHERE slug = '_hide_posts')
    UNION
    SELECT tr.child_id FROM tag_relationships tr JOIN ehp ON tr.parent_id = ehp.id
)
SELECT p.id, p.title, p.slug, p.content, p.excerpt, p.formatter, p.status,
       p.is_featured, p.view_count, p.published_at, p.created_at, p.updated_at,
       p.author_id, p.thumbnail_path, p.meta_description, p.preview_token, p.preview_expires_at
FROM posts p
WHERE p.id IN (
    SELECT DISTINCT post_id FROM post_tags WHERE tag_id IN (` + placeholders + `)
)
AND (` + statusClause + `)
AND (? OR NOT EXISTS (
    SELECT 1 FROM post_tags pt2 WHERE pt2.post_id = p.id AND pt2.tag_id IN (SELECT id FROM ehp)
))
ORDER BY p.published_at DESC, p.created_at DESC
LIMIT ? OFFSET ?`
	// bypassEHP controls the EHP visibility check, then limit and offset
	args = append(args, bypassEHP, limit, offset)

	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = rows.Close()
	}()

	var items []models.Post
	for rows.Next() {
		var i models.Post
		if err := rows.Scan(
			&i.ID, &i.Title, &i.Slug, &i.Content, &i.Excerpt, &i.Formatter, &i.Status,
			&i.IsFeatured, &i.ViewCount, &i.PublishedAt, &i.CreatedAt, &i.UpdatedAt,
			&i.AuthorID, &i.ThumbnailPath, &i.MetaDescription, &i.PreviewToken, &i.PreviewExpiresAt,
		); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	if items == nil {
		items = []models.Post{}
	}
	return items, rows.Err()
}

// CountPostsByTagIDs returns the total number of distinct posts that have at
// least one tag from the given set of tag IDs.
func (r *Repository) CountPostsByTagIDs(ctx context.Context, tagIDs []int64, publishedOnly bool, includeDrafts bool, includeHidden bool) (int64, error) {
	if len(tagIDs) == 0 {
		return 0, nil
	}

	placeholders := ""
	args := make([]interface{}, 0, len(tagIDs)+1)
	for i, id := range tagIDs {
		if i > 0 {
			placeholders += ","
		}
		placeholders += "?"
		args = append(args, id)
	}


	var statusClause string
	if includeDrafts {
		statusClause = "1=1"
	} else if includeHidden {
		statusClause = "LOWER(p.status) IN ('published', 'hidden')"
	} else {
		if publishedOnly {
			statusClause = "LOWER(p.status) = 'published'"
		} else {
			statusClause = "LOWER(p.status) IN ('published', 'hidden')"
		}
		statusClause += ` AND p.id NOT IN (
			SELECT pt.post_id FROM post_tags pt
			WHERE pt.tag_id IN (
				WITH RECURSIVE h(id) AS (
					SELECT child_id AS id FROM tag_relationships WHERE parent_id = (SELECT id FROM tags WHERE slug = '_hide_posts')
					UNION
					SELECT tr.child_id FROM tag_relationships tr JOIN h ON tr.parent_id = h.id
				)
				SELECT id FROM h
			)
		)`
	}

	bypassEHP := includeDrafts || includeHidden
	q := `
WITH RECURSIVE ehp(id) AS (
    SELECT child_id AS id FROM tag_relationships WHERE parent_id = (SELECT id FROM tags WHERE slug = '_hide_posts')
    UNION
    SELECT tr.child_id FROM tag_relationships tr JOIN ehp ON tr.parent_id = ehp.id
)
SELECT COUNT(*) FROM posts p
WHERE p.id IN (
    SELECT DISTINCT post_id FROM post_tags WHERE tag_id IN (` + placeholders + `)
)
AND (` + statusClause + `)
AND (? OR NOT EXISTS (
    SELECT 1 FROM post_tags pt2 WHERE pt2.post_id = p.id AND pt2.tag_id IN (SELECT id FROM ehp)
))`
	args = append(args, bypassEHP)

	var count int64
	err := r.db.QueryRowContext(ctx, q, args...).Scan(&count)
	return count, err
}

// GetMediaByPath returns the media record whose original_path matches exactly.
// The path should be in the stored format, e.g. "originals/2026/03/ts_file.jpg".
func (r *Repository) GetMediaByPath(ctx context.Context, originalPath string) (models.Medium, error) {
	const q = `
SELECT id, filename, original_path, thumbnail_path, file_type, mime_type,
       file_size, width, height, post_id, uploaded_at, checksum, alt_text, caption, is_public
FROM media WHERE original_path = ? LIMIT 1`
	var m models.Medium
	err := r.db.QueryRowContext(ctx, q, originalPath).Scan(
		&m.ID, &m.Filename, &m.OriginalPath, &m.ThumbnailPath,
		&m.FileType, &m.MimeType, &m.FileSize, &m.Width, &m.Height,
		&m.PostID, &m.UploadedAt, &m.Checksum, &m.AltText, &m.Caption, &m.IsPublic,
	)
	return m, err
}

// SetMediaPublic updates is_public for a media record and appends an audit row
// to media_visibility_log. postID may be nil.
func (r *Repository) SetMediaPublic(ctx context.Context, mediaID int64, isPublic bool, postID *int64) error {
	isPublicInt := 0
	if isPublic {
		isPublicInt = 1
	}
	_, err := r.db.ExecContext(ctx,
		`UPDATE media SET is_public = ? WHERE id = ?`, isPublicInt, mediaID)
	if err != nil {
		return err
	}
	var pid interface{}
	if postID != nil {
		pid = *postID
	}
	_, err = r.db.ExecContext(ctx,
		`INSERT INTO media_visibility_log (media_id, is_public, post_id) VALUES (?, ?, ?)`,
		mediaID, isPublicInt, pid)
	return err
}

// PostContentRow holds content fields needed for media visibility scans.
type PostContentRow struct {
	ID            int64
	Content       string
	ThumbnailPath string // empty string when NULL
	TagIDs        []int64
}

// GetAllPublishedPostContents returns id, content, and thumbnail_path for every
// published post, along with the IDs of its associated tags.
func (r *Repository) GetAllPublishedPostContents(ctx context.Context) ([]PostContentRow, error) {
	const q = `
SELECT p.id, p.content, COALESCE(p.thumbnail_path, '') as thumbnail_path
FROM posts p
WHERE LOWER(p.status) = 'published'`

	rows, err := r.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = rows.Close()
	}()

	var items []PostContentRow
	for rows.Next() {
		var row PostContentRow
		if err := rows.Scan(&row.ID, &row.Content, &row.ThumbnailPath); err != nil {
			return nil, err
		}
		items = append(items, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if len(items) == 0 {
		return items, nil
	}

	// Fetch tag IDs for all fetched posts in a single query.
	postIDs := make([]interface{}, len(items))
	idIndex := make(map[int64]int, len(items))
	placeholders := ""
	for i, item := range items {
		postIDs[i] = item.ID
		idIndex[item.ID] = i
		if i > 0 {
			placeholders += ","
		}
		placeholders += "?"
	}

	tagRows, err := r.db.QueryContext(ctx,
		`SELECT post_id, tag_id FROM post_tags WHERE post_id IN (`+placeholders+`)`, postIDs...)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = tagRows.Close()
	}()
	for tagRows.Next() {
		var postID, tagID int64
		if err := tagRows.Scan(&postID, &tagID); err != nil {
			return nil, err
		}
		if idx, ok := idIndex[postID]; ok {
			items[idx].TagIDs = append(items[idx].TagIDs, tagID)
		}
	}
	return items, tagRows.Err()
}

// GetAllMediaPaths returns all media records needed for a full visibility recalculation.
func (r *Repository) GetAllMediaPaths(ctx context.Context) ([]models.Medium, error) {
	const q = `
SELECT id, filename, original_path, thumbnail_path, file_type, mime_type,
       file_size, width, height, post_id, uploaded_at, checksum, alt_text, caption, is_public
FROM media ORDER BY id`
	rows, err := r.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = rows.Close()
	}()
	var items []models.Medium
	for rows.Next() {
		var m models.Medium
		if err := rows.Scan(
			&m.ID, &m.Filename, &m.OriginalPath, &m.ThumbnailPath,
			&m.FileType, &m.MimeType, &m.FileSize, &m.Width, &m.Height,
			&m.PostID, &m.UploadedAt, &m.Checksum, &m.AltText, &m.Caption, &m.IsPublic,
		); err != nil {
			return nil, err
		}
		items = append(items, m)
	}
	return items, rows.Err()
}

// GetHierarchicalPostCounts returns a map of tagID → effective post count,
// where the count includes posts from all descendant tags (not just the tag itself).
// If publishedOnly is true, only published posts are counted (public context).
// If false, published + hidden posts are counted (admin context).
func (r *Repository) GetHierarchicalPostCounts(ctx context.Context, publishedOnly bool) (map[int64]int64, error) {
	// UNION (not UNION ALL) deduplicates (root_id, tag_id) pairs, preventing
	// infinite recursion if tag_relationships contains a cycle.
	const q = `
WITH RECURSIVE ehp(id) AS (
    SELECT child_id AS id FROM tag_relationships WHERE parent_id = (SELECT id FROM tags WHERE slug = '_hide_posts')
    UNION
    SELECT tr.child_id FROM tag_relationships tr JOIN ehp ON tr.parent_id = ehp.id
),
descendants(root_id, tag_id) AS (
    SELECT id, id FROM tags
    UNION
    SELECT d.root_id, tr.child_id
    FROM descendants d
    JOIN tag_relationships tr ON d.tag_id = tr.parent_id
)
SELECT d.root_id, COUNT(DISTINCT pt.post_id)
FROM descendants d
JOIN post_tags pt ON pt.tag_id = d.tag_id
JOIN posts p ON pt.post_id = p.id
WHERE (CASE WHEN ? THEN LOWER(p.status) = 'published'
           ELSE LOWER(p.status) IN ('published', 'hidden')
      END)

AND (CASE WHEN ? THEN p.id NOT IN (
    SELECT pt.post_id FROM post_tags pt 
    WHERE pt.tag_id IN (
        WITH RECURSIVE h(id) AS (
            SELECT child_id AS id FROM tag_relationships WHERE parent_id = (SELECT id FROM tags WHERE slug = '_hide_posts')
            UNION
            SELECT tr.child_id FROM tag_relationships tr JOIN h ON tr.parent_id = h.id
        )
        SELECT id FROM h
    )
) ELSE 1=1 END)
GROUP BY d.root_id`

	rows, err := r.db.QueryContext(ctx, q, publishedOnly, publishedOnly)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = rows.Close()
	}()

	result := make(map[int64]int64)
	for rows.Next() {
		var tagID, count int64
		if err := rows.Scan(&tagID, &count); err != nil {
			return nil, err
		}
		result[tagID] = count
	}
	return result, rows.Err()
}

// ApplyMigration executes raw SQL and records it in migration_history.
// It is idempotent: if the migration name already exists it is skipped.
func (r *Repository) ApplyMigration(ctx context.Context, name, sql string) error {
	if _, err := r.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS migration_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name VARCHAR(255) NOT NULL UNIQUE,
			applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`); err != nil {
		return fmt.Errorf("failed to create migration_history table: %w", err)
	}

	var count int64
	if err := r.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM migration_history WHERE name = ?`, name,
	).Scan(&count); err != nil {
		return fmt.Errorf("failed to check migration history for %q: %w", name, err)
	}
	if count > 0 {
		return nil
	}
	if _, err := r.db.ExecContext(ctx, sql); err != nil {
		errMsg := err.Error()
		// Treat "already exists" errors as no-ops: the migration's intent is already
		// satisfied (e.g. a column added by schema.sql that a migration also adds).
		// Record it in history so we stop retrying on every startup.
		if !strings.Contains(errMsg, "already exists") && !strings.Contains(errMsg, "duplicate column") {
			return fmt.Errorf("migration %s: %w", name, err)
		}
	}
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO migration_history (name) VALUES (?)`, name)
	if err != nil {
		return fmt.Errorf("failed to record migration %q in history: %w", name, err)
	}
	return nil
}

// MigrateFlagsToSystemTags is an idempotent migration that seeds system tags and
// migrates the old boolean flag columns (is_featured, is_hidden, is_hidden_posts,
// include_in_breadcrumbs, show_related_tags_as_children) into tag_relationships.
// It records "system_tags_phase_a" in migration_history when complete.
func (r *Repository) MigrateFlagsToSystemTags(ctx context.Context) error {
	// Ensure migration_history table exists.
	if _, err := r.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS migration_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name VARCHAR(255) NOT NULL UNIQUE,
			applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`); err != nil {
		return fmt.Errorf("create migration_history: %w", err)
	}

	// Check if already applied.
	var count int64
	if err := r.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM migration_history WHERE name = 'system_tags_phase_a'`,
	).Scan(&count); err != nil {
		return fmt.Errorf("check migration_history: %w", err)
	}
	if count > 0 {
		return nil
	}

	// Check if is_featured column still exists.
	rows, err := r.db.QueryContext(ctx, "SELECT name FROM pragma_table_info('tags') WHERE name = 'is_featured'")
	if err != nil {
		return fmt.Errorf("pragma table_info: %w", err)
	}
	columnExists := rows.Next()
	_ = rows.Close()

	if columnExists {
		// Seed system tags (old schema still has boolean columns).
		if _, err := r.db.ExecContext(ctx, `
			INSERT OR IGNORE INTO tags (name, slug, is_important, is_featured, is_hidden, is_hidden_posts, include_in_breadcrumbs, show_related_tags_as_children, sort_order, post_count, created_at) VALUES
				('_system',            '_system',            0, 0, 0, 0, 0, 0, NULL, 0, CURRENT_TIMESTAMP),
				('_root',              '_root',              0, 0, 0, 0, 0, 0, NULL, 0, CURRENT_TIMESTAMP),
				('_hidden',            '_hidden',            0, 0, 0, 0, 0, 0, NULL, 0, CURRENT_TIMESTAMP),
				('_hide_posts',        '_hide_posts',        0, 0, 0, 0, 0, 0, NULL, 0, CURRENT_TIMESTAMP),
				('_is_in_breadcrumbs', '_is_in_breadcrumbs', 0, 0, 0, 0, 0, 0, NULL, 0, CURRENT_TIMESTAMP),
				('_with_related',      '_with_related',      0, 0, 0, 0, 0, 0, NULL, 0, CURRENT_TIMESTAMP),
				('_pending',           '_pending',           0, 0, 0, 0, 0, 0, NULL, 0, CURRENT_TIMESTAMP)
		`); err != nil {
			return fmt.Errorf("seed system tags: %w", err)
		}

		// Seed system tag relationships (all 6 are children of _system).
		if _, err := r.db.ExecContext(ctx, `
			INSERT OR IGNORE INTO tag_relationships (parent_id, child_id)
			SELECT s.id, c.id FROM tags s, tags c
			WHERE s.slug = '_system' AND c.slug IN ('_root', '_hidden', '_hide_posts', '_is_in_breadcrumbs', '_with_related', '_pending')
		`); err != nil {
			return fmt.Errorf("seed system tag relationships: %w", err)
		}

		// Migrate flag data to relationships.
		flagMigrations := []struct {
			parentSlug string
			condition  string
		}{
			{"_root", "is_featured = 1 AND slug NOT LIKE '\\_%%' ESCAPE '\\'"},
			{"_hidden", "is_hidden = 1 AND slug NOT LIKE '\\_%%' ESCAPE '\\'"},
			{"_hide_posts", "is_hidden_posts = 1 AND slug NOT LIKE '\\_%%' ESCAPE '\\'"},
			{"_is_in_breadcrumbs", "include_in_breadcrumbs = 1 AND slug NOT LIKE '\\_%%' ESCAPE '\\'"},
			{"_with_related", "show_related_tags_as_children = 1 AND slug NOT LIKE '\\_%%' ESCAPE '\\'"},
		}
		for _, fm := range flagMigrations {
			q := fmt.Sprintf(`
				INSERT OR IGNORE INTO tag_relationships (parent_id, child_id)
				SELECT (SELECT id FROM tags WHERE slug = '%s'), id FROM tags WHERE %s`,
				fm.parentSlug, fm.condition)
			if _, err := r.db.ExecContext(ctx, q); err != nil {
				return fmt.Errorf("migrate flag to %s: %w", fm.parentSlug, err)
			}
		}

		// Assign _pending to orphaned non-system tags.
		if _, err := r.db.ExecContext(ctx, `
			INSERT OR IGNORE INTO tag_relationships (parent_id, child_id)
			SELECT (SELECT id FROM tags WHERE slug = '_pending'), t.id
			FROM tags t
			WHERE t.slug NOT LIKE '\_%%' ESCAPE '\'
			AND NOT EXISTS (SELECT 1 FROM tag_relationships tr WHERE tr.child_id = t.id)
		`); err != nil {
			return fmt.Errorf("assign _pending to orphans: %w", err)
		}
	}

	// Record migration.
	if _, err := r.db.ExecContext(ctx,
		`INSERT INTO migration_history (name) VALUES ('system_tags_phase_a')`,
	); err != nil {
		return fmt.Errorf("record system_tags_phase_a: %w", err)
	}
	return nil
}

// RebuildTagsTableDropBooleans drops the 6 boolean columns from the tags table via
// a table rebuild (SQLite does not support DROP COLUMN in older versions).
// It is idempotent: it checks for "system_tags_phase_b" in migration_history first.
func (r *Repository) RebuildTagsTableDropBooleans(ctx context.Context) error {
	// Ensure migration_history table exists.
	if _, err := r.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS migration_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name VARCHAR(255) NOT NULL UNIQUE,
			applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`); err != nil {
		return fmt.Errorf("create migration_history: %w", err)
	}

	// Check if already applied.
	var count int64
	if err := r.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM migration_history WHERE name = 'system_tags_phase_b'`,
	).Scan(&count); err != nil {
		return fmt.Errorf("check migration_history: %w", err)
	}
	if count > 0 {
		return nil
	}

	// Check if is_featured column still exists.
	rows, err := r.db.QueryContext(ctx, "SELECT name FROM pragma_table_info('tags') WHERE name = 'is_featured'")
	if err != nil {
		return fmt.Errorf("pragma table_info: %w", err)
	}
	columnExists := rows.Next()
	_ = rows.Close()

	if columnExists {
		stmts := []string{
			"PRAGMA foreign_keys = OFF",
			`CREATE TABLE IF NOT EXISTS tags_new (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name VARCHAR(100) NOT NULL UNIQUE,
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
				return fmt.Errorf("rebuild tags: %w", err)
			}
		}
	}

	// Record migration.
	if _, err := r.db.ExecContext(ctx,
		`INSERT INTO migration_history (name) VALUES ('system_tags_phase_b')`,
	); err != nil {
		return fmt.Errorf("record system_tags_phase_b: %w", err)
	}
	return nil
}

// EnsurePendingSystemTag is an idempotent migration that guarantees the _pending
// system tag exists with slug="_pending". It handles the case where a regular tag
// was previously created with name="_pending" but slug="pending" (via Slugify),
// which caused the system tag INSERT OR IGNORE to silently fail.
func (r *Repository) EnsurePendingSystemTag(ctx context.Context) error {
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
		`SELECT COUNT(*) FROM migration_history WHERE name = 'ensure_pending_system_tag'`,
	).Scan(&count); err != nil {
		return fmt.Errorf("check migration_history: %w", err)
	}
	if count > 0 {
		return nil
	}

	// Rename any tag with name='_pending' but wrong slug (e.g. 'pending').
	// This clears the UNIQUE name constraint so the correct system tag can be inserted.
	if _, err := r.db.ExecContext(ctx,
		`UPDATE tags SET name = slug WHERE name = '_pending' AND slug != '_pending'`,
	); err != nil {
		return fmt.Errorf("rename conflicting _pending tag: %w", err)
	}

	// Create the _pending system tag if it doesn't exist yet.
	if _, err := r.db.ExecContext(ctx,
		`INSERT OR IGNORE INTO tags (name, slug, sort_order, post_count, created_at)
		 VALUES ('_pending', '_pending', NULL, 0, CURRENT_TIMESTAMP)`,
	); err != nil {
		return fmt.Errorf("create _pending system tag: %w", err)
	}

	// Make _pending a child of _system (no-op if _system doesn't exist or already linked).
	if _, err := r.db.ExecContext(ctx,
		`INSERT OR IGNORE INTO tag_relationships (parent_id, child_id)
		 SELECT s.id, c.id FROM tags s, tags c
		 WHERE s.slug = '_system' AND c.slug = '_pending'`,
	); err != nil {
		return fmt.Errorf("link _pending to _system: %w", err)
	}

	if _, err := r.db.ExecContext(ctx,
		`INSERT INTO migration_history (name) VALUES ('ensure_pending_system_tag')`,
	); err != nil {
		return fmt.Errorf("record ensure_pending_system_tag: %w", err)
	}
	return nil
}

// DeleteSession removes a session and returns an error if not found.
func (r *Repository) DeleteSession(ctx context.Context, arg models.DeleteSessionParams) error {
	res, err := r.db.ExecContext(ctx, `DELETE FROM sessions WHERE id = ? AND user_id = ?`, arg.ID, arg.UserID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("session not found")
	}
	return nil
}

// GetMediaByPaths returns media records whose original_path is in the given
// list (DB format: "originals/YYYY/MM/file"). Order is not guaranteed.
// Returns an empty slice (not an error) when paths is empty.
func (r *Repository) GetMediaByPaths(ctx context.Context, paths []string) ([]models.Medium, error) {
	if len(paths) == 0 {
		return nil, nil
	}
	placeholders := strings.Repeat("?,", len(paths))
	placeholders = placeholders[:len(placeholders)-1]
	q := `SELECT id, filename, original_path, thumbnail_path, file_type, mime_type,
		file_size, width, height, post_id, uploaded_at, checksum, alt_text, caption,
		is_public, metadata FROM media WHERE original_path IN (` + placeholders + `)`
	args := make([]interface{}, len(paths))
	for i, p := range paths {
		args[i] = p
	}
	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var items []models.Medium
	for rows.Next() {
		var m models.Medium
		if err := rows.Scan(
			&m.ID, &m.Filename, &m.OriginalPath, &m.ThumbnailPath,
			&m.FileType, &m.MimeType, &m.FileSize, &m.Width, &m.Height,
			&m.PostID, &m.UploadedAt, &m.Checksum, &m.AltText, &m.Caption,
			&m.IsPublic, &m.Metadata,
		); err != nil {
			return nil, err
		}
		items = append(items, m)
	}
	return items, rows.Err()
}

