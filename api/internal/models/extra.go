package models

// TagLocation represents a tag's geographic coordinates.
// This is used for backward compatibility with existing code after folding
// the tag_locations table into the tags table.
type TagLocation struct {
	ID        int64   `json:"id"`
	TagID     int64   `json:"tag_id"`
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
}

// The four param structs below used to be generated: ListPosts, ListPostsByViews,
// CountPosts and DeleteSession were entries in sql/queries.sql, and the generated
// methods they belonged to were silently shadowed by hand-written methods of the
// same name on *sqliteRepository (a concrete method always wins over one promoted
// from an embedded field). The queries are gone from queries.sql now, so the
// repository owns those four outright — but the params stay in this package so
// every caller keeps saying models.ListPostsParams.
//
// IncludePages and IncludeContent were already hand-added to the generated
// structs, which is how the drift was found: `sqlc generate` kept deleting them.

// ListPostsParams filters repository.ListPosts. The three interface{} fields are
// the shapes sqlc emitted for `sqlc.arg(...)` used inside a CASE; the repository
// type-asserts them to bool.
type ListPostsParams struct {
	StatusFilter   interface{} `json:"status_filter"`
	Status         string      `json:"status"`
	FeaturedFilter interface{} `json:"featured_filter"`
	IncludeDrafts  interface{} `json:"include_drafts"`
	IncludeHidden  interface{} `json:"include_hidden"`
	Offset         int64       `json:"offset"`
	Limit          int64       `json:"limit"`
	// IncludePages, when true, keeps type=page rows in results (admin views).
	IncludePages bool `json:"include_pages"`
	// IncludeContent, when true, selects the full content body. List/grid views
	// leave it false (they use media_url); the offline snapshot sets it true.
	IncludeContent bool `json:"include_content"`
}

// ListPostsByViewsParams filters repository.ListPostsByViews.
type ListPostsByViewsParams struct {
	StatusFilter   interface{} `json:"status_filter"`
	Status         string      `json:"status"`
	FeaturedFilter interface{} `json:"featured_filter"`
	IncludeDrafts  interface{} `json:"include_drafts"`
	IncludeHidden  interface{} `json:"include_hidden"`
	Offset         int64       `json:"offset"`
	Limit          int64       `json:"limit"`
}

// CountPostsParams filters repository.CountPosts. It is ListPostsParams without
// the paging and content fields, and must stay in step with it.
type CountPostsParams struct {
	StatusFilter   interface{} `json:"status_filter"`
	Status         string      `json:"status"`
	FeaturedFilter interface{} `json:"featured_filter"`
	IncludeDrafts  interface{} `json:"include_drafts"`
	IncludeHidden  interface{} `json:"include_hidden"`
	// IncludePages, when true, keeps type=page rows in results (admin views).
	IncludePages bool `json:"include_pages"`
}

// DeleteSessionParams identifies the session repository.DeleteSession removes.
// The user ID is part of the key, not a filter: a session can only be deleted by
// the user who owns it.
type DeleteSessionParams struct {
	ID     int64 `json:"id"`
	UserID int64 `json:"user_id"`
}
