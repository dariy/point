import re
import os

path = "internal/repository/queries_posts.go"
with open(path, "r") as f:
    content = f.read()

# We will replace ListPosts, CountPosts, ListPostsWithSearch, CountPostsWithSearch, ListPostsInYearRange, CountPostsInYearRange
# And we will append buildPostsQuery and ListPostsByViews

replacement = """
func buildPostsQuery(
	selectClause string,
	orderByClause string,
	limitOffsetClause string,
	pType string, // "all", "page", "post"
	statusFilter bool, status string,
	featuredFilter bool,
	includeDrafts bool, includeHidden bool,
	tag string, search string,
	fromYear, toYear int,
) (string, []interface{}) {
	var where []string
	var args []interface{}

	where = append(where, "p.deleted_at IS NULL")

	if pType == "page" {
		where = append(where, "p.type = 'page'")
	} else if pType == "post" {
		where = append(where, "p.type != 'page'")
	}

	if statusFilter {
		where = append(where, "LOWER(p.status) = LOWER(?)")
		args = append(args, status)
	}

	if featuredFilter {
		where = append(where, "p.is_featured = 1")
	}

	if includeDrafts {
		// no status restriction
	} else if includeHidden {
		where = append(where, "LOWER(p.status) IN ('published', 'hidden')")
	} else {
		where = append(where, "LOWER(p.status) = 'published'")
	}

	bypassEHP := includeDrafts || includeHidden
	if !bypassEHP {
		where = append(where, `p.id NOT IN (
        SELECT pt.post_id FROM post_tags pt
        WHERE pt.tag_id IN (
            WITH RECURSIVE h(id) AS (
                SELECT id FROM tags WHERE hides_posts = 1
                UNION
                SELECT tr.child_id FROM tag_relationships tr JOIN h ON tr.parent_id = h.id
            )
            SELECT id FROM h
        )
    )`)
	}

	if tag != "" {
		where = append(where, `p.id IN (
            SELECT pt.post_id FROM post_tags pt
            WHERE pt.tag_id IN (
                WITH RECURSIVE tree(id) AS (
                    SELECT id FROM tags WHERE slug = LOWER(?)
                    UNION
                    SELECT tr.child_id FROM tag_relationships tr JOIN tree ON tr.parent_id = tree.id
                )
                SELECT id FROM tree
            )
        )`)
		args = append(args, tag)
	}

	if search != "" {
		where = append(where, `(
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
    )`)
		args = append(args, search, search, search, search, search)
	}

	if fromYear > 0 && toYear > 0 {
		where = append(where, `p.id IN (
        SELECT DISTINCT pt.post_id FROM post_tags pt
        WHERE pt.tag_id IN (
            SELECT id FROM tags
            WHERE kind = 'year' AND CAST(slug AS INTEGER) BETWEEN ? AND ?
        )
    )`)
		args = append(args, fromYear, toYear)
	}

	q := selectClause + "\nWHERE " + strings.Join(where, "\n    AND ")
	if orderByClause != "" {
		q += "\n" + orderByClause
	}
	if limitOffsetClause != "" {
		q += "\n" + limitOffsetClause
	}

	return q, args
}

// ListPosts returns all posts, with optional filters. Callers that only render
// list/grid cards leave IncludeContent false so the (potentially large) content
// body is not read; the derived media_url column covers the card preview. The
// offline snapshot sets IncludeContent=true to get full bodies.
func (r *sqliteRepository) ListPosts(ctx context.Context, arg models.ListPostsParams) ([]models.Post, error) {
	contentCol := "'' AS content"
	if arg.IncludeContent {
		contentCol = "p.content"
	}
	selectClause := fmt.Sprintf(`SELECT p.id, p.title, p.slug, %s, p.excerpt, p.formatter, p.status, p.type, p.is_featured,
       p.view_count, p.published_at, p.created_at, p.updated_at, p.author_id,
       p.thumbnail_path, p.media_url, p.meta_description, p.preview_token, p.preview_expires_at, p.css
FROM posts p`, contentCol)
	
	pType := "post"
	if arg.IncludePages {
		pType = "all"
	}
	
	statusBool, _ := arg.StatusFilter.(bool)
	featuredBool, _ := arg.FeaturedFilter.(bool)
	draftsBool, _ := arg.IncludeDrafts.(bool)
	hiddenBool, _ := arg.IncludeHidden.(bool)

	q, args := buildPostsQuery(selectClause, "ORDER BY p.published_at DESC, p.created_at DESC", "LIMIT ? OFFSET ?", pType, statusBool, arg.Status, featuredBool, draftsBool, hiddenBool, "", "", 0, 0)
	args = append(args, arg.Limit, arg.Offset)

	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var items []models.Post
	for rows.Next() {
		var i models.Post
		if err := rows.Scan(
			&i.ID, &i.Title, &i.Slug, &i.Content, &i.Excerpt, &i.Formatter,
			&i.Status, &i.Type, &i.IsFeatured, &i.ViewCount, &i.PublishedAt,
			&i.CreatedAt, &i.UpdatedAt, &i.AuthorID, &i.ThumbnailPath, &i.MediaURL,
			&i.MetaDescription, &i.PreviewToken, &i.PreviewExpiresAt, &i.Css,
		); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

func (r *sqliteRepository) ListPostsByViews(ctx context.Context, arg models.ListPostsByViewsParams) ([]models.Post, error) {
	selectClause := `SELECT p.id, p.title, p.slug, p.content, p.excerpt, p.formatter, p.status, p.type, p.is_featured,
       p.view_count, p.published_at, p.created_at, p.updated_at, p.author_id,
       p.thumbnail_path, p.media_url, p.meta_description, p.preview_token, p.preview_expires_at, p.css
FROM posts p`
	
	statusBool, _ := arg.StatusFilter.(bool)
	featuredBool, _ := arg.FeaturedFilter.(bool)
	draftsBool, _ := arg.IncludeDrafts.(bool)
	hiddenBool, _ := arg.IncludeHidden.(bool)

	q, args := buildPostsQuery(selectClause, "ORDER BY p.view_count DESC, p.published_at DESC", "LIMIT ? OFFSET ?", "post", statusBool, arg.Status, featuredBool, draftsBool, hiddenBool, "", "", 0, 0)
	args = append(args, arg.Limit, arg.Offset)

	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var items []models.Post
	for rows.Next() {
		var i models.Post
		if err := rows.Scan(
			&i.ID, &i.Title, &i.Slug, &i.Content, &i.Excerpt, &i.Formatter,
			&i.Status, &i.Type, &i.IsFeatured, &i.ViewCount, &i.PublishedAt,
			&i.CreatedAt, &i.UpdatedAt, &i.AuthorID, &i.ThumbnailPath, &i.MediaURL,
			&i.MetaDescription, &i.PreviewToken, &i.PreviewExpiresAt, &i.Css,
		); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

// CountPosts counts posts with optional filters.
func (r *sqliteRepository) CountPosts(ctx context.Context, arg models.CountPostsParams) (int64, error) {
	pType := "post"
	if arg.IncludePages {
		pType = "all"
	}
	statusBool, _ := arg.StatusFilter.(bool)
	featuredBool, _ := arg.FeaturedFilter.(bool)
	draftsBool, _ := arg.IncludeDrafts.(bool)
	hiddenBool, _ := arg.IncludeHidden.(bool)

	q, args := buildPostsQuery("SELECT COUNT(*) FROM posts p", "", "", pType, statusBool, arg.Status, featuredBool, draftsBool, hiddenBool, "", "", 0, 0)
	
	var count int64
	err := r.db.QueryRowContext(ctx, q, args...).Scan(&count)
	return count, err
}
"""

content = re.sub(r'func \(r \*sqliteRepository\) ListPosts\(ctx context.Context, arg models.ListPostsParams\) \(\[\]models.Post, error\) \{.*?\n\}\n\n// CountPosts counts posts with optional filters.\nfunc \(r \*sqliteRepository\) CountPosts\(ctx context.Context, arg models.CountPostsParams\) \(int64, error\) \{.*?\n\}\n', replacement, content, flags=re.DOTALL)

replacement2 = """
// ListPostsInYearRange returns posts that carry a year tag (kind='year') whose
// parsed year (CAST(slug AS INTEGER)) falls in [fromYear, toYear].
func (r *sqliteRepository) ListPostsInYearRange(ctx context.Context, fromYear, toYear int, arg models.ListPostsParams) ([]models.Post, error) {
	selectClause := `SELECT p.id, p.title, p.slug, '' AS content, p.excerpt, p.formatter, p.status, p.type, p.is_featured,
       p.view_count, p.published_at, p.created_at, p.updated_at, p.author_id,
       p.thumbnail_path, p.media_url, p.meta_description, p.preview_token, p.preview_expires_at, p.css
FROM posts p`
	
	pType := "post"
	if arg.IncludePages {
		pType = "all"
	}
	statusBool, _ := arg.StatusFilter.(bool)
	featuredBool, _ := arg.FeaturedFilter.(bool)
	draftsBool, _ := arg.IncludeDrafts.(bool)
	hiddenBool, _ := arg.IncludeHidden.(bool)

	q, args := buildPostsQuery(selectClause, "ORDER BY p.published_at DESC, p.created_at DESC", "LIMIT ? OFFSET ?", pType, statusBool, arg.Status, featuredBool, draftsBool, hiddenBool, "", "", fromYear, toYear)
	args = append(args, arg.Limit, arg.Offset)

	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var items []models.Post
	for rows.Next() {
		var i models.Post
		if err := rows.Scan(
			&i.ID, &i.Title, &i.Slug, &i.Content, &i.Excerpt, &i.Formatter,
			&i.Status, &i.Type, &i.IsFeatured, &i.ViewCount, &i.PublishedAt,
			&i.CreatedAt, &i.UpdatedAt, &i.AuthorID, &i.ThumbnailPath, &i.MediaURL,
			&i.MetaDescription, &i.PreviewToken, &i.PreviewExpiresAt, &i.Css,
		); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

// CountPostsInYearRange counts posts matching the year range and standard filters.
func (r *sqliteRepository) CountPostsInYearRange(ctx context.Context, fromYear, toYear int, arg models.CountPostsParams) (int64, error) {
	pType := "post"
	if arg.IncludePages {
		pType = "all"
	}
	statusBool, _ := arg.StatusFilter.(bool)
	featuredBool, _ := arg.FeaturedFilter.(bool)
	draftsBool, _ := arg.IncludeDrafts.(bool)
	hiddenBool, _ := arg.IncludeHidden.(bool)

	q, args := buildPostsQuery("SELECT COUNT(*) FROM posts p", "", "", pType, statusBool, arg.Status, featuredBool, draftsBool, hiddenBool, "", "", fromYear, toYear)
	
	var count int64
	err := r.db.QueryRowContext(ctx, q, args...).Scan(&count)
	return count, err
}

func (r *sqliteRepository) ListPostsWithSearch(ctx context.Context, statusFilter bool, status string, featuredFilter bool, includeDrafts bool, includeHidden bool, search string, tag string, onlyPages bool, limit, offset int64) ([]models.Post, error) {
	selectClause := `SELECT p.id, p.title, p.slug, '' AS content, p.excerpt, p.formatter, p.status, p.type, p.is_featured,
       p.view_count, p.published_at, p.created_at, p.updated_at, p.author_id,
       p.thumbnail_path, p.media_url, p.meta_description, p.preview_token, p.preview_expires_at, p.css
FROM posts p`
	
	pType := "post"
	if onlyPages {
		pType = "page"
	}

	q, args := buildPostsQuery(selectClause, "ORDER BY p.published_at DESC, p.created_at DESC", "LIMIT ? OFFSET ?", pType, statusFilter, status, featuredFilter, includeDrafts, includeHidden, tag, search, 0, 0)
	args = append(args, limit, offset)

	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var items []models.Post
	for rows.Next() {
		var i models.Post
		if err := rows.Scan(
			&i.ID, &i.Title, &i.Slug, &i.Content, &i.Excerpt, &i.Formatter,
			&i.Status, &i.Type, &i.IsFeatured, &i.ViewCount, &i.PublishedAt,
			&i.CreatedAt, &i.UpdatedAt, &i.AuthorID, &i.ThumbnailPath, &i.MediaURL,
			&i.MetaDescription, &i.PreviewToken, &i.PreviewExpiresAt, &i.Css,
		); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

// CountPostsWithSearch counts posts matched by the extended search (title, slug,
// content, tag name, tag slug).
func (r *sqliteRepository) CountPostsWithSearch(ctx context.Context, statusFilter bool, status string, featuredFilter bool, includeDrafts bool, includeHidden bool, search string, tag string, onlyPages bool) (int64, error) {
	pType := "post"
	if onlyPages {
		pType = "page"
	}

	q, args := buildPostsQuery("SELECT COUNT(*) FROM posts p", "", "", pType, statusFilter, status, featuredFilter, includeDrafts, includeHidden, tag, search, 0, 0)

	var count int64
	err := r.db.QueryRowContext(ctx, q, args...).Scan(&count)
	return count, err
}
"""

content = re.sub(r'// ListPostsInYearRange returns posts that carry a year tag.*?func \(r \*sqliteRepository\) CountPostsWithSearch\(ctx context.Context.*?return count, err\n\}\n', replacement2, content, flags=re.DOTALL)

with open(path, "w") as f:
    f.write(content)

