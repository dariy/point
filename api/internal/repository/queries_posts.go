package repository

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode"

	"point-api/internal/models"
	"point-api/internal/utils"
)

// The public visibility rule has two halves: a status filter, and the exclusion
// of every post carried by a tag with hides_posts = 1 — or by any descendant of
// such a tag. The second half used to be pasted into each of the fifteen
// queries that needed it, and GetPostNavigation was written without it, so the
// prev/next chain offered posts the post-detail endpoint then refused with a
// 404. It is spelled out here and nowhere else now: as a predicate for queries
// that test it once, and as a named CTE for queries that read the hidden set
// from more than one place. The two differ only in the name the recursion
// recurses into — keep them in step.

// hidesPostsPredicate is the exclusion minus the column it tests, so the two
// bindings below can share one copy of it. Everything here stays a constant:
// the queries that embed it are constant SQL, which is both what the SQL
// injection linter checks for and true — no caller value reaches this text.
const hidesPostsPredicate = ` NOT IN (
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

// hidesPostsExcludeP is the predicate for queries that alias posts as p;
// hidesPostsExcludeID for those that select from posts unaliased.
const (
	hidesPostsExcludeP  = "p.id" + hidesPostsPredicate
	hidesPostsExcludeID = "id" + hidesPostsPredicate
)

// Newest first is the order every list of posts is read in, and it has to be a
// total one. published_at and created_at both store whole seconds, so an import
// — or any two posts published in the same second — leaves ties for the query
// planner to break however the index it chose happens to run, which is not a
// decision it makes consistently across two queries or two releases. Under
// LIMIT/OFFSET an unstable tie is not merely cosmetic: the same post can appear
// on two pages, or on neither. id settles it, descending like the rest, and
// idx_posts_live carries all three columns so the sort still costs nothing.
const (
	orderNewestFirstP  = "ORDER BY p.published_at DESC, p.created_at DESC, p.id DESC"
	orderNewestFirstID = "ORDER BY published_at DESC, created_at DESC, id DESC"
)

// hidesPostsCTE is the same rule as a named CTE, for queries that reference the
// hidden set from more than one place or already open a WITH chain. Prefix it
// with "WITH RECURSIVE " to start a chain, or join it to an existing one with a
// comma; read the result back as (SELECT id FROM ehp).
const hidesPostsCTE = `ehp(id) AS (
    SELECT id FROM tags WHERE hides_posts = 1
    UNION
    SELECT tr.child_id FROM tag_relationships tr JOIN ehp ON tr.parent_id = ehp.id
)`

// Search reads the text of a post from the posts_fts index (sql/schema.sql) and
// the text of its tags from the tags table. The two halves are split because
// they are different sizes: post bodies are the reason search used to read the
// whole table off disk, while tags are few enough that a substring LIKE over
// them costs nothing and is worth keeping — a tag search still finds "ountain"
// inside "mountain", where the full-text half no longer does.
//
// Both halves produce post ids and are unioned into a single `p.id IN (...)`,
// which is the shape that matters: written as `MATCH ... OR EXISTS (...)` the
// planner cannot drive posts from either half — the correlated EXISTS has to be
// evaluated per row, so it scans the table and the index buys nothing. One id
// set leaves it a primary-key seek.
//
// Measured at 20k posts of ~400 words, timing the pair of queries the admin
// search page always runs together (a page of results and its total):
//
//	term matching 1 post      485ms -> 1.6ms
//	term matching 2000 posts  209ms -> 9.5ms
//	term matching every post  106ms -> 90ms
//
// The last row is the one to know about. A term in every post is the case an
// inverted index cannot help with — the id set is the whole table, and it has
// to be materialised and sorted, where the old LIKE could walk idx_posts_live
// in feed order and stop at the first LIMIT rows. Its page alone got slower
// (0.4ms -> 41ms); it only comes out ahead because the count beside it no
// longer scans. Nothing about a search box makes that the common case.
const searchTagIDs = `SELECT pt.post_id FROM post_tags pt
            JOIN tags t ON t.id = pt.tag_id
            WHERE LOWER(t.name) LIKE '%' || LOWER(?) || '%'
               OR LOWER(t.slug) LIKE '%' || LOWER(?) || '%'`

const searchTagsOnly = `p.id IN (
        ` + searchTagIDs + `
    )`

const searchFullTextAndTags = `p.id IN (
        SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?
        UNION
        ` + searchTagIDs + `
    )`

// ftsMatchQuery turns whatever is in the search box into an FTS5 MATCH
// expression. FTS5's query language is not free text: a bare `"`, `*`, `OR` or
// `NEAR` typed by a user is an operator or a syntax error, and a syntax error
// comes back as a failed query rather than an empty result page. So none of the
// input is passed through as syntax. The string is split on the rule unicode61
// tokenizes by — a token is a run of letters and digits, everything else
// separates — and each token is re-emitted inside double quotes, where FTS5
// reads it as a literal. Quoting needs no escaping as a result: a token that
// survived the split cannot contain a quote.
//
// Every token gets a trailing `*`. The admin search box searches as you type,
// so the last word is usually half-written, and tokens combine under FTS5's
// implicit AND — "cold mou" finds a post about a cold mountain. What this does
// not do, and the LIKE scan it replaces did, is match inside a word: "ountain"
// no longer finds "mountain". That is the part of a substring scan an inverted
// index cannot give back, and the tag half above still covers it for tags.
//
// Returns "" when the input holds no tokens at all, which the caller reads as
// "no full-text arm" — an empty MATCH is itself a syntax error.
func ftsMatchQuery(search string) string {
	tokens := strings.FieldsFunc(search, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	var b strings.Builder
	for i, tok := range tokens {
		if i > 0 {
			b.WriteByte(' ')
		}
		b.WriteByte('"')
		b.WriteString(tok)
		b.WriteString(`"*`)
	}
	return b.String()
}

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
		where = append(where, hidesPostsExcludeP)
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
		// A search string with no word characters in it at all ("!!!") has no
		// MATCH expression to make, and an empty MATCH is a syntax error, so
		// the full-text arm is left out entirely in that case.
		if match := ftsMatchQuery(search); match != "" {
			where = append(where, searchFullTextAndTags)
			args = append(args, match, search, search)
		} else {
			where = append(where, searchTagsOnly)
			args = append(args, search, search)
		}
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

	q, args := buildPostsQuery(selectClause, orderNewestFirstP, "LIMIT ? OFFSET ?", pType, statusBool, arg.Status, featuredBool, draftsBool, hiddenBool, "", "", 0, 0)
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

// scheduledQueueWhere is what makes a row part of the publishing queue, shared
// by the reads below so a tag-scoped queue can never disagree with the whole
// one about what is in it.
const scheduledQueueWhere = `
WHERE p.deleted_at IS NULL
  AND p.type != 'page'
  AND LOWER(p.status) = 'scheduled'`

// scheduledQueueTagFilter narrows the queue to posts carrying one of tagIDs,
// returning the WHERE fragment and the values it binds. A tag page passes the
// tag plus its descendants — the same set its published list is drawn from.
func scheduledQueueTagFilter(tagIDs []int64) (string, []interface{}) {
	placeholders := make([]string, len(tagIDs))
	args := make([]interface{}, len(tagIDs))
	for i, id := range tagIDs {
		placeholders[i] = "?"
		args[i] = id
	}
	return `
  AND p.id IN (SELECT DISTINCT post_id FROM post_tags WHERE tag_id IN (` +
		strings.Join(placeholders, ",") + `))`, args
}

// listScheduledPosts runs the queue read with an optional extra WHERE fragment
// (constant SQL; every value is bound through args).
//
// Ordering is the point: the feed shows these on its "future" pages (the
// non-positive page numbers), so the post that is about to go live must be the
// one nearest the newest published post. A scheduled row with no scheduled_at
// cannot happen through the API, but sorts last rather than first if it does.
func (r *sqliteRepository) listScheduledPosts(ctx context.Context, filter string, args []interface{}, limit, offset int64) ([]models.Post, error) {
	//nolint:gosec // G202: constant clause fragments only, values are bound
	q := `
SELECT p.id, p.title, p.slug, '' AS content, p.excerpt, p.formatter, p.status, p.type, p.is_featured,
       p.view_count, p.published_at, p.scheduled_at, p.created_at, p.updated_at, p.author_id,
       p.thumbnail_path, p.media_url, p.meta_description, p.preview_token, p.preview_expires_at, p.css
FROM posts p` + scheduledQueueWhere + filter + `
ORDER BY p.scheduled_at IS NULL, p.scheduled_at ASC, p.created_at ASC
LIMIT ? OFFSET ?`

	rows, err := r.db.QueryContext(ctx, q, append(append([]interface{}{}, args...), limit, offset)...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var items []models.Post
	for rows.Next() {
		var i models.Post
		if err := rows.Scan(
			&i.ID, &i.Title, &i.Slug, &i.Content, &i.Excerpt, &i.Formatter,
			&i.Status, &i.Type, &i.IsFeatured, &i.ViewCount, &i.PublishedAt, &i.ScheduledAt,
			&i.CreatedAt, &i.UpdatedAt, &i.AuthorID, &i.ThumbnailPath, &i.MediaURL,
			&i.MetaDescription, &i.PreviewToken, &i.PreviewExpiresAt, &i.Css,
		); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

// countScheduledPosts counts the posts listScheduledPosts pages through, under
// the same optional filter.
func (r *sqliteRepository) countScheduledPosts(ctx context.Context, filter string, args []interface{}) (int64, error) {
	//nolint:gosec // G202: constant clause fragments only, values are bound
	q := `SELECT COUNT(*) FROM posts p` + scheduledQueueWhere + filter
	var count int64
	err := r.db.QueryRowContext(ctx, q, args...).Scan(&count)
	return count, err
}

// ListScheduledPosts returns the posts waiting to be published, soonest first —
// the home feed's queue.
func (r *sqliteRepository) ListScheduledPosts(ctx context.Context, limit, offset int64) ([]models.Post, error) {
	return r.listScheduledPosts(ctx, "", nil, limit, offset)
}

// CountScheduledPosts counts the posts ListScheduledPosts pages through.
func (r *sqliteRepository) CountScheduledPosts(ctx context.Context) (int64, error) {
	return r.countScheduledPosts(ctx, "", nil)
}

// ListScheduledPostsByTagIDs is ListScheduledPosts narrowed to one tag page's
// queue: the posts waiting to be published that carry one of these tags.
func (r *sqliteRepository) ListScheduledPostsByTagIDs(ctx context.Context, tagIDs []int64, limit, offset int64) ([]models.Post, error) {
	if len(tagIDs) == 0 {
		return []models.Post{}, nil
	}
	filter, args := scheduledQueueTagFilter(tagIDs)
	return r.listScheduledPosts(ctx, filter, args, limit, offset)
}

// CountScheduledPostsByTagIDs counts the posts ListScheduledPostsByTagIDs pages
// through — how far left of page 1 that tag's feed reaches.
func (r *sqliteRepository) CountScheduledPostsByTagIDs(ctx context.Context, tagIDs []int64) (int64, error) {
	if len(tagIDs) == 0 {
		return 0, nil
	}
	filter, args := scheduledQueueTagFilter(tagIDs)
	return r.countScheduledPosts(ctx, filter, args)
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
	// A truncated iteration would report the column as absent, silently
	// downgrading callers to the legacy-schema path. Still returns false —
	// there is no error to return through this signature — but says so.
	if err := rows.Err(); err != nil {
		slog.Warn("postsHasColumn: table_info iteration failed; assuming column absent",
			"column", col, "error", err)
		return false
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

	q, args := buildPostsQuery(selectClause, orderNewestFirstP, "LIMIT ? OFFSET ?", pType, statusBool, arg.Status, featuredBool, draftsBool, hiddenBool, "", "", fromYear, toYear)
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

	q, args := buildPostsQuery(selectClause, orderNewestFirstP, "LIMIT ? OFFSET ?", pType, statusFilter, status, featuredFilter, includeDrafts, includeHidden, tag, search, 0, 0)
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
func (r *sqliteRepository) GetPostNavigation(ctx context.Context, postID int64, publicOnly bool, tag string) (prev, next *PostNavItem, err error) {
	const qDate = `SELECT CAST(published_at AS TEXT) FROM posts WHERE id = ? LIMIT 1`
	var anchor sql.NullString
	if err = r.db.QueryRowContext(ctx, qDate, postID).Scan(&anchor); err != nil {
		return nil, nil, err
	}
	// A post that has never been published — a draft, or one waiting in the
	// scheduled queue — has no position in the sequence these queries walk, so
	// it has no neighbours. Scanning the NULL into a plain string failed the
	// whole request instead, which is a 500 on the navigation endpoint for
	// every scheduled post.
	if !anchor.Valid {
		return nil, nil, nil
	}
	publishedAt := anchor.String

	// Public visibility is a status filter *and* the hides-posts exclusion; the
	// list queries apply both, so navigation has to as well. Without the second
	// half the chain steps onto a published-but-tag-hidden post, and the detail
	// endpoint — which does apply the full rule — answers 404.
	visibility := "LOWER(status) = 'published' AND " + hidesPostsExcludeID
	if !publicOnly {
		visibility = "LOWER(status) IN ('published', 'hidden')"
	}

	// Optional tag scope: restrict adjacency to posts under the given tag (and
	// its descendants), so navigation stays within a tag collection and spans
	// every page of it — mirroring the tag feed's descendant-tree filter.
	tagClause := ""
	if tag != "" {
		tagClause = `
AND id IN (
    SELECT pt.post_id FROM post_tags pt
    WHERE pt.tag_id IN (
        WITH RECURSIVE tree(id) AS (
            SELECT id FROM tags WHERE slug = LOWER(?)
            UNION
            SELECT tr.child_id FROM tag_relationships tr JOIN tree ON tr.parent_id = tree.id
        )
        SELECT id FROM tree
    )
)`
	}

	qPrev := fmt.Sprintf(`
SELECT id, title, slug FROM posts
WHERE (%s) AND deleted_at IS NULL AND type != 'page' AND (published_at < ? OR (published_at = ? AND id < ?))%s
ORDER BY published_at DESC, id DESC LIMIT 1`, visibility, tagClause)
	prevArgs := []interface{}{publishedAt, publishedAt, postID}
	if tag != "" {
		prevArgs = append(prevArgs, tag)
	}
	var p PostNavItem
	if err2 := r.db.QueryRowContext(ctx, qPrev, prevArgs...).Scan(&p.ID, &p.Title, &p.Slug); err2 == nil {
		prev = &p
	}

	qNext := fmt.Sprintf(`
SELECT id, title, slug FROM posts
WHERE (%s) AND deleted_at IS NULL AND type != 'page' AND (published_at > ? OR (published_at = ? AND id > ?))%s
ORDER BY published_at ASC, id ASC LIMIT 1`, visibility, tagClause)
	nextArgs := []interface{}{publishedAt, publishedAt, postID}
	if tag != "" {
		nextArgs = append(nextArgs, tag)
	}
	var n PostNavItem
	if err2 := r.db.QueryRowContext(ctx, qNext, nextArgs...).Scan(&n.ID, &n.Title, &n.Slug); err2 == nil {
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
	// Only id + slug are consumed by the sole caller (GetPostPage); ordering is
	// done in SQL. Selecting the timestamp columns and scanning them into
	// time.Time fails under the sqlite driver, which hands back the stored
	// "YYYY-MM-DD HH:MM:SS" values as strings — so we don't read them at all.
	const q = `
SELECT id, slug
FROM posts
WHERE LOWER(status) = 'published'
AND deleted_at IS NULL
AND type != 'page'
AND ` + hidesPostsExcludeID + `
` + orderNewestFirstID

	rows, err := r.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var stubs []PostStub
	for rows.Next() {
		var s PostStub
		if err := rows.Scan(&s.ID, &s.Slug); err != nil {
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
AND ` + hidesPostsExcludeID + `
` + orderNewestFirstID
	} else {
		q = `
SELECT id, slug, title, thumbnail_path, content
FROM posts
WHERE deleted_at IS NULL
` + orderNewestFirstID
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
		statusClause += " AND " + hidesPostsExcludeP
	}

	bypassEHP := includeDrafts || includeHidden
	// The interpolated fragments are the constant clauses built above; every
	// caller-supplied value is a bound argument.
	//nolint:gosec // G202: constant clause fragments only, values are bound
	q := `
WITH RECURSIVE ` + hidesPostsCTE + `
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
` + orderNewestFirstP + `
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
		statusClause += " AND " + hidesPostsExcludeP
	}

	bypassEHP := includeDrafts || includeHidden
	q := `
WITH RECURSIVE ` + hidesPostsCTE + `
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
		statusClause += " AND " + hidesPostsExcludeP
	}

	bypassEHP := includeDrafts || includeHidden
	// As above: constant clause fragments, bound values.
	//nolint:gosec // G202: constant clause fragments only, values are bound
	q := `
WITH _ytags AS (
    SELECT id FROM tags
    WHERE kind = 'year'
    AND CAST(slug AS INTEGER) BETWEEN ? AND ?
),
_yposts AS (
    SELECT DISTINCT pt.post_id FROM post_tags pt WHERE pt.tag_id IN (SELECT id FROM _ytags)
),
` + hidesPostsCTE + `
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
` + orderNewestFirstP + `
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
		statusClause += " AND " + hidesPostsExcludeP
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
` + hidesPostsCTE + `
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

// PostLinkAuditRow is a lightweight post row for the internal-link audit:
// enough to decide public reachability (status + tags) and to extract
// outgoing /posts/<slug> links from content.
type PostLinkAuditRow struct {
	ID      int64
	Slug    string
	Title   string
	Status  string
	Content string
	TagIDs  []int64
}

// ListPostLinkAuditRows returns id, slug, title, status, content, and tag IDs
// for every non-deleted post (all statuses, pages included).
func (r *sqliteRepository) ListPostLinkAuditRows(ctx context.Context) ([]PostLinkAuditRow, error) {
	const q = `
SELECT p.id, p.slug, p.title, LOWER(p.status), p.content
FROM posts p
WHERE p.deleted_at IS NULL`

	rows, err := r.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var items []PostLinkAuditRow
	idIndex := make(map[int64]int)
	for rows.Next() {
		var row PostLinkAuditRow
		if err := rows.Scan(&row.ID, &row.Slug, &row.Title, &row.Status, &row.Content); err != nil {
			return nil, err
		}
		idIndex[row.ID] = len(items)
		items = append(items, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return items, nil
	}

	postIDs := make([]interface{}, len(items))
	placeholders := ""
	for i, item := range items {
		postIDs[i] = item.ID
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
	defer func() { _ = tagRows.Close() }()
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

// hierarchicalPostCountsQuery builds the tagID → effective post count roll-up,
// where a tag's count includes the posts of all its descendant tags.
//
// When yearScoped is true the counted set is narrowed to posts carrying a year
// tag (kind='year') whose parsed slug falls inside a range; the range bounds are
// the last two placeholders, after the two publishedOnly ones.
func hierarchicalPostCountsQuery(yearScoped bool) string {
	// UNION (not UNION ALL) deduplicates (root_id, tag_id) pairs, preventing
	// infinite recursion if tag_relationships contains a cycle.
	q := `
WITH RECURSIVE ` + hidesPostsCTE + `,
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
           ELSE LOWER(p.status) IN ('published', 'hidden', 'scheduled')
      END)

AND (CASE WHEN ? THEN ` + hidesPostsExcludeP + ` ELSE 1=1 END)`

	if yearScoped {
		q += `
AND p.id IN (
    SELECT pty.post_id FROM post_tags pty
    JOIN tags yt ON yt.id = pty.tag_id
    WHERE yt.kind = 'year' AND CAST(yt.slug AS INTEGER) BETWEEN ? AND ?
)`
	}

	return q + `
GROUP BY d.root_id`
}

// scanTagCounts drains a (tagID, count) result set into a map.
func scanTagCounts(rows *sql.Rows) (map[int64]int64, error) {
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

// GetHierarchicalPostCounts returns a map of tagID → effective post count,
// where the count includes posts from all descendant tags (not just the tag itself).
// If publishedOnly is true, only published posts are counted (public context).
// If false, published + hidden + scheduled posts are counted (admin context) —
// a scheduled post is already written and tagged, so leaving it out made the
// badge in /light/tags disagree with the tag's own post list.
func (r *sqliteRepository) GetHierarchicalPostCounts(ctx context.Context, publishedOnly bool) (map[int64]int64, error) {
	rows, err := r.db.QueryContext(ctx, hierarchicalPostCountsQuery(false), publishedOnly, publishedOnly)
	if err != nil {
		return nil, err
	}
	return scanTagCounts(rows)
}

// GetHierarchicalPostCountsInYearRange is GetHierarchicalPostCounts narrowed to
// the posts a timeline range covers — those carrying a year tag in
// [fromYear, toYear]. Tags with nothing left in range are absent from the map
// (rather than present with a zero), so callers can filter on presence.
//
// The roll-up matters here: geo tags are commonly attached to a post's city
// only, so a country's count — and its very presence — comes entirely from its
// descendants.
func (r *sqliteRepository) GetHierarchicalPostCountsInYearRange(ctx context.Context, publishedOnly bool, fromYear, toYear int) (map[int64]int64, error) {
	rows, err := r.db.QueryContext(ctx, hierarchicalPostCountsQuery(true), publishedOnly, publishedOnly, fromYear, toYear)
	if err != nil {
		return nil, err
	}
	return scanTagCounts(rows)
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

	// inList is a generated "?,?,?" list; every id is bound.
	//nolint:gosec // G201: placeholders only, values are bound
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
