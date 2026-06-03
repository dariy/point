package repository

import (
	"context"
	"time"

	"point-api/internal/models"
)

// GetPublishedPostsForFeed returns the N most recent published posts for RSS/sitemap.
func (r *sqliteRepository) GetPublishedPostsForFeed(ctx context.Context, limit int) ([]models.Post, error) {
	const q = `
SELECT p.id, p.title, p.slug, p.content, p.excerpt, p.formatter, p.status,
       p.is_featured, p.view_count, p.published_at, p.created_at, p.updated_at,
       p.author_id, p.thumbnail_path, p.meta_description, p.preview_token,
       p.preview_expires_at, p.css
FROM posts p
WHERE LOWER(p.status) = 'published'
AND p.deleted_at IS NULL
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
			&i.MetaDescription, &i.PreviewToken, &i.PreviewExpiresAt, &i.Css,
		); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

// GetPublishedPostsForSitemap returns all published post slugs and timestamps.
func (r *sqliteRepository) GetPublishedPostsForSitemap(ctx context.Context) ([]struct {
	Slug      string
	UpdatedAt time.Time
}, error) {
	const q = `
SELECT slug, COALESCE(updated_at, published_at, created_at) as updated_at
FROM posts
WHERE LOWER(status) = 'published'
AND deleted_at IS NULL
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
func (r *sqliteRepository) GetPublicTagsForSitemap(ctx context.Context) ([]struct {
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
