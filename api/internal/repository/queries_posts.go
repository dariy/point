package repository

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"point-api/internal/models"
	"point-api/internal/utils"
)

// ListPosts returns all posts, with optional filters. Callers that only render
// list/grid cards leave IncludeContent false so the (potentially large) content
// body is not read; the derived media_url column covers the card preview. The
// offline snapshot sets IncludeContent=true to get full bodies.

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

	switch pType {
	case "page":
		where = append(where, "p.type = 'page'")
	case "post":
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

// SetPostMediaURL stores the denormalized list-preview URL for a post. An empty
// string is stored (not NULL) when the post has no media, so backfill treats it
// as "already computed".
func (r *sqliteRepository) SetPostMediaURL(ctx context.Context, postID int64, mediaURL string) error {
	_, err := r.db.ExecContext(ctx, `UPDATE posts SET media_url = ? WHERE id = ?`, mediaURL, postID)
	return err
}

// BackfillPostMediaURLs computes media_url for any rows where it is still NULL
// (existing posts predating the column). Runs once at startup after the column
// migration; subsequent writes keep it in sync via SetPostMediaURL.
func (r *sqliteRepository) BackfillPostMediaURLs(ctx context.Context) error {
	// Legacy/minimal schemas may predate thumbnail_path; select a literal in that
	// case so the backfill still runs (deriving media_url from content alone).
	thumbExpr := "thumbnail_path"
	if !r.postsHasColumn(ctx, "thumbnail_path") {
		thumbExpr = "'' AS thumbnail_path"
	}
	rows, err := r.db.QueryContext(ctx,
		fmt.Sprintf(`SELECT id, %s, content FROM posts WHERE media_url IS NULL`, thumbExpr))
	if err != nil {
		return err
	}
	type pending struct {
		id      int64
		thumb   sql.NullString
		content string
	}
	var todo []pending
	for rows.Next() {
		var p pending
		if err := rows.Scan(&p.id, &p.thumb, &p.content); err != nil {
			_ = rows.Close()
			return err
		}
		todo = append(todo, p)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	_ = rows.Close()

	for _, p := range todo {
		var tp string
		if p.thumb.Valid {
			tp = p.thumb.String
		}
		if _, err := r.db.ExecContext(ctx,
			`UPDATE posts SET media_url = ? WHERE id = ?`,
			utils.DeriveMediaURL(tp, p.content), p.id); err != nil {
			return err
		}
	}
	return nil
}

// postsHasColumn reports whether the posts table has the named column.
func (r *sqliteRepository) postsHasColumn(ctx context.Context, col string) bool {
	rows, err := r.db.QueryContext(ctx, `PRAGMA table_info(posts)`)
	if err != nil {
		return false
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var (
			cid     int
			name    string
			ctype   string
			notnull int
			dflt    sql.NullString
			pk      int
		)
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return false
		}
		if name == col {
			return true
		}
	}
	return false
}


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

// GetPostByPreviewToken looks up a post by its preview token.
func (r *sqliteRepository) GetPostByPreviewToken(ctx context.Context, token string) (models.Post, error) {
	const q = `
SELECT p.id, p.title, p.slug, p.content, p.excerpt, p.formatter, p.status,
       p.is_featured, p.view_count, p.published_at, p.created_at, p.updated_at,
       p.author_id, p.thumbnail_path, p.meta_description, p.preview_token,
       p.preview_expires_at, p.css
FROM posts p
WHERE p.preview_token = ? AND p.deleted_at IS NULL LIMIT 1`

	row := r.db.QueryRowContext(ctx, q, token)
	var i models.Post
	err := row.Scan(
		&i.ID, &i.Title, &i.Slug, &i.Content, &i.Excerpt, &i.Formatter,
		&i.Status, &i.IsFeatured, &i.ViewCount, &i.PublishedAt,
		&i.CreatedAt, &i.UpdatedAt, &i.AuthorID, &i.ThumbnailPath,
		&i.MetaDescription, &i.PreviewToken, &i.PreviewExpiresAt, &i.Css,
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
func (r *sqliteRepository) GetPostNavigation(ctx context.Context, postID int64, publicOnly bool) (prev, next *PostNavItem, err error) {
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
WHERE (%s) AND deleted_at IS NULL AND (published_at < ? OR (published_at = ? AND id < ?))
ORDER BY published_at DESC, id DESC LIMIT 1`, statusFilter)
	var p PostNavItem
	if err2 := r.db.QueryRowContext(ctx, qPrev, publishedAt, publishedAt, postID).Scan(&p.ID, &p.Title, &p.Slug); err2 == nil {
		prev = &p
	}

	qNext := fmt.Sprintf(`
SELECT id, title, slug FROM posts
WHERE (%s) AND deleted_at IS NULL AND (published_at > ? OR (published_at = ? AND id > ?))
ORDER BY published_at ASC, id ASC LIMIT 1`, statusFilter)
	var n PostNavItem
	if err2 := r.db.QueryRowContext(ctx, qNext, publishedAt, publishedAt, postID).Scan(&n.ID, &n.Title, &n.Slug); err2 == nil {
		next = &n
	}

	return prev, next, nil
}

// ReplacePostContentPath replaces all occurrences of oldPath with newPath in
// every post's content column, and also updates the thumbnail_path column.
// Returns the number of posts updated.
func (r *sqliteRepository) ReplacePostContentPath(ctx context.Context, oldPath, newPath string) (int64, error) {
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
func (r *sqliteRepository) UpdatePostThumbnailPath(ctx context.Context, oldPath, newPath string) (int64, error) {
	res, err := r.db.ExecContext(ctx,
		`UPDATE posts SET thumbnail_path = ? WHERE thumbnail_path = ?`,
		newPath, oldPath,
	)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
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
func (r *sqliteRepository) ListPublishedPostStubs(ctx context.Context) ([]PostStub, error) {
	const q = `
SELECT id, slug, published_at, created_at
FROM posts
WHERE LOWER(status) = 'published'
AND deleted_at IS NULL
AND id NOT IN (
    SELECT pt.post_id FROM post_tags pt
    WHERE pt.tag_id IN (
        WITH RECURSIVE h(id) AS (
            SELECT id FROM tags WHERE hides_posts = 1
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

// GraphPostNode is a lightweight post descriptor used to render posts as
// "shadow" nodes in the tags graph on /tags and the cloud on /atlas. The
// thumbnail/content fields back a single preview URL (see extractMediaURL) and
// are not serialized themselves.
type GraphPostNode struct {
	ID            int64          `json:"id"`
	Slug          string         `json:"slug"`
	Title         string         `json:"title"`
	ThumbnailPath sql.NullString `json:"-"`
	Content       string         `json:"-"`
}

// ListPostNodesForGraph returns the posts to render as nodes in the tags graph,
// including thumbnail_path + content so callers can derive a preview image URL.
// When publishedOnly is true, only published, non-hidden posts (excluding posts
// buried under a hides_posts tag, mirroring ListPublishedPostStubs) are
// returned; otherwise all non-deleted posts are returned. Newest first.
func (r *sqliteRepository) ListPostNodesForGraph(ctx context.Context, publishedOnly bool) ([]GraphPostNode, error) {
	var q string
	if publishedOnly {
		q = `
SELECT id, slug, title, thumbnail_path, content
FROM posts
WHERE LOWER(status) = 'published'
AND deleted_at IS NULL
AND id NOT IN (
    SELECT pt.post_id FROM post_tags pt
    WHERE pt.tag_id IN (
        WITH RECURSIVE h(id) AS (
            SELECT id FROM tags WHERE hides_posts = 1
            UNION
            SELECT tr.child_id FROM tag_relationships tr JOIN h ON tr.parent_id = h.id
        )
        SELECT id FROM h
    )
)
ORDER BY published_at DESC, created_at DESC`
	} else {
		q = `
SELECT id, slug, title, thumbnail_path, content
FROM posts
WHERE deleted_at IS NULL
ORDER BY published_at DESC, created_at DESC`
	}

	rows, err := r.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var nodes []GraphPostNode
	for rows.Next() {
		var n GraphPostNode
		if err := rows.Scan(&n.ID, &n.Slug, &n.Title, &n.ThumbnailPath, &n.Content); err != nil {
			return nil, err
		}
		nodes = append(nodes, n)
	}
	return nodes, rows.Err()
}

// GetPostsByTagIDs returns paginated posts that have at least one tag from the
// given set of tag IDs. The status filter mirrors CountPostsByTag / GetPostsByTag.
func (r *sqliteRepository) GetPostsByTagIDs(ctx context.Context, tagIDs []int64, publishedOnly bool, includeDrafts bool, includeHidden bool, limit, offset int64) ([]models.Post, error) {
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
		// Authenticated users see published + hidden, hides_posts exclusion not applied.
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
					SELECT id FROM tags WHERE hides_posts = 1
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
    SELECT id FROM tags WHERE hides_posts = 1
    UNION
    SELECT tr.child_id FROM tag_relationships tr JOIN ehp ON tr.parent_id = ehp.id
)
SELECT p.id, p.title, p.slug, p.content, p.excerpt, p.formatter, p.status,
       p.is_featured, p.view_count, p.published_at, p.created_at, p.updated_at,
       p.author_id, p.thumbnail_path, p.meta_description, p.preview_token, p.preview_expires_at, p.css
FROM posts p
WHERE p.deleted_at IS NULL
AND p.id IN (
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
			&i.AuthorID, &i.ThumbnailPath, &i.MetaDescription, &i.PreviewToken, &i.PreviewExpiresAt, &i.Css,
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
func (r *sqliteRepository) CountPostsByTagIDs(ctx context.Context, tagIDs []int64, publishedOnly bool, includeDrafts bool, includeHidden bool) (int64, error) {
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
					SELECT id FROM tags WHERE hides_posts = 1
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
    SELECT id FROM tags WHERE hides_posts = 1
    UNION
    SELECT tr.child_id FROM tag_relationships tr JOIN ehp ON tr.parent_id = ehp.id
)
SELECT COUNT(*) FROM posts p
WHERE p.deleted_at IS NULL
AND p.id IN (
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

// GetPostsByTagIDsInYearRange returns paginated posts that have at least one tag from the
// given set AND fall within [fromYear, toYear] via year tags.
func (r *sqliteRepository) GetPostsByTagIDsInYearRange(ctx context.Context, tagIDs []int64, fromYear, toYear int, publishedOnly bool, includeDrafts bool, includeHidden bool, limit, offset int64) ([]models.Post, error) {
	if len(tagIDs) == 0 {
		return []models.Post{}, nil
	}

	placeholders := ""
	args := make([]interface{}, 0, 2+len(tagIDs)+3)
	args = append(args, fromYear, toYear)
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
					SELECT id FROM tags WHERE hides_posts = 1
					UNION
					SELECT tr.child_id FROM tag_relationships tr JOIN h ON tr.parent_id = h.id
				)
				SELECT id FROM h
			)
		)`
	}

	bypassEHP := includeDrafts || includeHidden
	q := `
WITH _ytags AS (
    SELECT id FROM tags
    WHERE kind = 'year'
    AND CAST(slug AS INTEGER) BETWEEN ? AND ?
),
_yposts AS (
    SELECT DISTINCT pt.post_id FROM post_tags pt WHERE pt.tag_id IN (SELECT id FROM _ytags)
),
ehp(id) AS (
    SELECT id FROM tags WHERE hides_posts = 1
    UNION
    SELECT tr.child_id FROM tag_relationships tr JOIN ehp ON tr.parent_id = ehp.id
)
SELECT p.id, p.title, p.slug, p.content, p.excerpt, p.formatter, p.status,
       p.is_featured, p.view_count, p.published_at, p.created_at, p.updated_at,
       p.author_id, p.thumbnail_path, p.meta_description, p.preview_token, p.preview_expires_at, p.css
FROM posts p
WHERE p.deleted_at IS NULL
AND p.id IN (SELECT post_id FROM _yposts)
AND p.id IN (
    SELECT DISTINCT post_id FROM post_tags WHERE tag_id IN (` + placeholders + `)
)
AND (` + statusClause + `)
AND (? OR NOT EXISTS (
    SELECT 1 FROM post_tags pt2 WHERE pt2.post_id = p.id AND pt2.tag_id IN (SELECT id FROM ehp)
))
ORDER BY p.published_at DESC, p.created_at DESC
LIMIT ? OFFSET ?`
	args = append(args, bypassEHP, limit, offset)

	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var items []models.Post
	for rows.Next() {
		var i models.Post
		if err := rows.Scan(
			&i.ID, &i.Title, &i.Slug, &i.Content, &i.Excerpt, &i.Formatter, &i.Status,
			&i.IsFeatured, &i.ViewCount, &i.PublishedAt, &i.CreatedAt, &i.UpdatedAt,
			&i.AuthorID, &i.ThumbnailPath, &i.MetaDescription, &i.PreviewToken, &i.PreviewExpiresAt, &i.Css,
		); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

// CountPostsByTagIDsInYearRange counts posts in the tag set that fall within the year range.
func (r *sqliteRepository) CountPostsByTagIDsInYearRange(ctx context.Context, tagIDs []int64, fromYear, toYear int, publishedOnly bool, includeDrafts bool, includeHidden bool) (int64, error) {
	if len(tagIDs) == 0 {
		return 0, nil
	}

	placeholders := ""
	args := make([]interface{}, 0, 2+len(tagIDs)+1)
	args = append(args, fromYear, toYear)
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
					SELECT id FROM tags WHERE hides_posts = 1
					UNION
					SELECT tr.child_id FROM tag_relationships tr JOIN h ON tr.parent_id = h.id
				)
				SELECT id FROM h
			)
		)`
	}

	bypassEHP := includeDrafts || includeHidden
	q := `
WITH _ytags AS (
    SELECT id FROM tags
    WHERE kind = 'year'
    AND CAST(slug AS INTEGER) BETWEEN ? AND ?
),
_yposts AS (
    SELECT DISTINCT pt.post_id FROM post_tags pt WHERE pt.tag_id IN (SELECT id FROM _ytags)
),
ehp(id) AS (
    SELECT id FROM tags WHERE hides_posts = 1
    UNION
    SELECT tr.child_id FROM tag_relationships tr JOIN ehp ON tr.parent_id = ehp.id
)
SELECT COUNT(*) FROM posts p
WHERE p.deleted_at IS NULL
AND p.id IN (SELECT post_id FROM _yposts)
AND p.id IN (
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

// PostContentRow holds content fields needed for media visibility scans.
type PostContentRow struct {
	ID            int64
	Content       string
	ThumbnailPath string // empty string when NULL
	TagIDs        []int64
}

// GetAllPublishedPostContents returns id, content, and thumbnail_path for every
// published post, along with the IDs of its associated tags.
func (r *sqliteRepository) GetAllPublishedPostContents(ctx context.Context) ([]PostContentRow, error) {
	const q = `
SELECT p.id, p.content, COALESCE(p.thumbnail_path, '') as thumbnail_path
FROM posts p
WHERE LOWER(p.status) = 'published' AND p.deleted_at IS NULL`

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

// GetHierarchicalPostCounts returns a map of tagID → effective post count,
// where the count includes posts from all descendant tags (not just the tag itself).
// If publishedOnly is true, only published posts are counted (public context).
// If false, published + hidden posts are counted (admin context).
func (r *sqliteRepository) GetHierarchicalPostCounts(ctx context.Context, publishedOnly bool) (map[int64]int64, error) {
	// UNION (not UNION ALL) deduplicates (root_id, tag_id) pairs, preventing
	// infinite recursion if tag_relationships contains a cycle.
	const q = `
WITH RECURSIVE ehp(id) AS (
    SELECT id FROM tags WHERE hides_posts = 1
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
WHERE p.deleted_at IS NULL
AND (CASE WHEN ? THEN LOWER(p.status) = 'published'
           ELSE LOWER(p.status) IN ('published', 'hidden')
      END)

AND (CASE WHEN ? THEN p.id NOT IN (
    SELECT pt.post_id FROM post_tags pt
    WHERE pt.tag_id IN (
        WITH RECURSIVE h(id) AS (
            SELECT id FROM tags WHERE hides_posts = 1
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

// GetExistingInstagramIDs returns the subset of the supplied IDs that are
// already present in posts — matched against both instagram_id (import) and
// instagram_media_id (cross-posted from Point).  Idempotent-import callers
// should skip any IDs returned here.
func (r *sqliteRepository) GetExistingInstagramIDs(ctx context.Context, ids []string) ([]string, error) {
	if len(ids) == 0 {
		return nil, nil
	}

	// Build a VALUES list to use with IN.
	placeholders := make([]string, len(ids))
	args := make([]interface{}, len(ids))
	for i, id := range ids {
		placeholders[i] = "?"
		args[i] = id
	}
	inList := strings.Join(placeholders, ",")

	q := fmt.Sprintf(`
SELECT COALESCE(instagram_id, instagram_media_id)
FROM posts
WHERE deleted_at IS NULL
  AND (
    instagram_id      IN (%s)
    OR instagram_media_id IN (%s)
  )`, inList, inList)

	// Args need to be doubled: once for instagram_id IN, once for instagram_media_id IN.
	doubleArgs := append(args, args...)
	rows, err := r.db.QueryContext(ctx, q, doubleArgs...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var found []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		found = append(found, id)
	}
	return found, rows.Err()
}

// SetPostInstagramID stores the Instagram media ID on a post after import.
func (r *sqliteRepository) SetPostInstagramID(ctx context.Context, postID int64, instagramID string) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE posts SET instagram_id = ? WHERE id = ?`,
		instagramID, postID,
	)
	return err
}
