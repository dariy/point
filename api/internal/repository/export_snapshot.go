package repository

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// ExportSnapshot reads the content of a database snapshot (a VACUUM INTO copy)
// for the portable export. It opens the file read-only. The Each* methods
// stream rows to a callback, so a large site is never held in memory.
//
// The snapshot has one connection: a callback must not call another method of
// the same ExportSnapshot while a row stream is open.
type ExportSnapshot struct {
	db *sql.DB
}

// OpenExportSnapshot opens the snapshot file at path read-only.
func OpenExportSnapshot(path string) (*ExportSnapshot, error) {
	db, err := openSnapshot(path)
	if err != nil {
		return nil, err
	}
	return &ExportSnapshot{db: db}, nil
}

// Close closes the snapshot.
func (s *ExportSnapshot) Close() error { return s.db.Close() }

// ExportPost is one post or page that is not in the trash.
type ExportPost struct {
	ID              int64
	Title           string
	Slug            string
	Content         string
	Excerpt         sql.NullString
	Formatter       string
	Status          string
	Type            string
	IsFeatured      bool
	PublishedAt     sql.NullTime
	ScheduledAt     sql.NullTime
	CreatedAt       time.Time
	UpdatedAt       time.Time
	ThumbnailPath   sql.NullString
	MetaDescription sql.NullString
	Css             string
	ImmersiveMode   string
	// TagSlugs are the slugs of the post's tags, sorted.
	TagSlugs []string
}

// ExportMedia is one media file that is not in the trash.
type ExportMedia struct {
	ID               int64
	Filename         string
	OriginalPath     string
	FileType         string
	MimeType         string
	FileSize         int64
	Width            sql.NullInt64
	Height           sql.NullInt64
	UploadedAt       time.Time
	Checksum         string
	AltText          sql.NullString
	Caption          sql.NullString
	Metadata         sql.NullString
	OriginalMetadata sql.NullString
	IsPublic         bool
	// PostSlug is the slug of the post the file was uploaded to, if that post
	// is not in the trash.
	PostSlug sql.NullString
}

// ExportTagParent is one parent link of a tag.
type ExportTagParent struct {
	Slug      string
	SortOrder sql.NullInt64
}

// ExportTag is one tag with its parent links.
type ExportTag struct {
	ID               int64
	Name             string
	Slug             string
	Description      sql.NullString
	Kind             string
	Hidden           bool
	HidesPosts       bool
	NavOrder         sql.NullInt64
	InBreadcrumbs    bool
	ShowRelated      bool
	InAncestorFlyout bool
	Latitude         sql.NullFloat64
	Longitude        sql.NullFloat64
	CreatedAt        time.Time
	Parents          []ExportTagParent
}

// ExportCounts are the row counts of the content the export writes.
type ExportCounts struct {
	Posts int64 `json:"posts"`
	Pages int64 `json:"pages"`
	Media int64 `json:"media"`
	Tags  int64 `json:"tags"`
}

// Counts returns the number of live posts, pages and media rows, and of tags.
func (s *ExportSnapshot) Counts(ctx context.Context) (ExportCounts, error) {
	var c ExportCounts
	err := s.db.QueryRowContext(ctx, `SELECT
		(SELECT COUNT(*) FROM posts WHERE deleted_at IS NULL AND type != 'page'),
		(SELECT COUNT(*) FROM posts WHERE deleted_at IS NULL AND type = 'page'),
		(SELECT COUNT(*) FROM media WHERE deleted_at IS NULL),
		(SELECT COUNT(*) FROM tags)`).Scan(&c.Posts, &c.Pages, &c.Media, &c.Tags)
	return c, err
}

// tagSep separates tag slugs in a GROUP_CONCAT. A slug never holds it.
const tagSep = "\x1f"

// EachPost calls fn for each post and page that is not in the trash, in id
// order. An error from fn stops the stream and is returned.
func (s *ExportSnapshot) EachPost(ctx context.Context, fn func(ExportPost) error) error {
	rows, err := s.db.QueryContext(ctx, `SELECT p.id, p.title, p.slug, p.content, p.excerpt,
		p.formatter, p.status, p.type, p.is_featured, p.published_at, p.scheduled_at,
		p.created_at, p.updated_at, p.thumbnail_path, p.meta_description, p.css,
		p.immersive_mode,
		(SELECT GROUP_CONCAT(slug, char(31)) FROM (SELECT t.slug FROM post_tags pt
			JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = p.id ORDER BY t.slug))
		FROM posts p WHERE p.deleted_at IS NULL ORDER BY p.id`)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var p ExportPost
		var tags sql.NullString
		if err := rows.Scan(&p.ID, &p.Title, &p.Slug, &p.Content, &p.Excerpt,
			&p.Formatter, &p.Status, &p.Type, &p.IsFeatured, &p.PublishedAt, &p.ScheduledAt,
			&p.CreatedAt, &p.UpdatedAt, &p.ThumbnailPath, &p.MetaDescription, &p.Css,
			&p.ImmersiveMode, &tags); err != nil {
			return fmt.Errorf("scan post: %w", err)
		}
		p.TagSlugs = []string{}
		if tags.Valid && tags.String != "" {
			p.TagSlugs = strings.Split(tags.String, tagSep)
		}
		if err := fn(p); err != nil {
			return err
		}
	}
	return rows.Err()
}

// EachMedia calls fn for each media row that is not in the trash, in id
// order. An error from fn stops the stream and is returned.
func (s *ExportSnapshot) EachMedia(ctx context.Context, fn func(ExportMedia) error) error {
	rows, err := s.db.QueryContext(ctx, `SELECT m.id, m.filename, m.original_path, m.file_type,
		m.mime_type, m.file_size, m.width, m.height, m.uploaded_at, m.checksum, m.alt_text,
		m.caption, m.metadata, m.original_metadata, m.is_public, p.slug
		FROM media m LEFT JOIN posts p ON p.id = m.post_id AND p.deleted_at IS NULL
		WHERE m.deleted_at IS NULL ORDER BY m.id`)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var m ExportMedia
		if err := rows.Scan(&m.ID, &m.Filename, &m.OriginalPath, &m.FileType,
			&m.MimeType, &m.FileSize, &m.Width, &m.Height, &m.UploadedAt, &m.Checksum, &m.AltText,
			&m.Caption, &m.Metadata, &m.OriginalMetadata, &m.IsPublic, &m.PostSlug); err != nil {
			return fmt.Errorf("scan media: %w", err)
		}
		if err := fn(m); err != nil {
			return err
		}
	}
	return rows.Err()
}

// MediaPaths returns the original_path of each media row that is not in the
// trash. The set holds only strings, so it stays small next to the files.
func (s *ExportSnapshot) MediaPaths(ctx context.Context) (map[string]bool, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT original_path FROM media WHERE deleted_at IS NULL`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	paths := map[string]bool{}
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		paths[p] = true
	}
	return paths, rows.Err()
}

// Tags returns all tags in slug order, each with its parent links. The tag
// table is small, so the result is a slice.
func (s *ExportSnapshot) Tags(ctx context.Context) ([]ExportTag, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, slug, description, kind, hidden,
		hides_posts, nav_order, in_breadcrumbs, show_related, in_ancestor_flyout, latitude,
		longitude, created_at FROM tags ORDER BY slug`)
	if err != nil {
		return nil, err
	}
	var tags []ExportTag
	index := map[int64]int{}
	for rows.Next() {
		var t ExportTag
		if err := rows.Scan(&t.ID, &t.Name, &t.Slug, &t.Description, &t.Kind, &t.Hidden,
			&t.HidesPosts, &t.NavOrder, &t.InBreadcrumbs, &t.ShowRelated, &t.InAncestorFlyout,
			&t.Latitude, &t.Longitude, &t.CreatedAt); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("scan tag: %w", err)
		}
		t.Parents = []ExportTagParent{}
		index[t.ID] = len(tags)
		tags = append(tags, t)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rel, err := s.db.QueryContext(ctx, `SELECT r.child_id, p.slug, r.sort_order
		FROM tag_relationships r JOIN tags p ON p.id = r.parent_id
		ORDER BY r.child_id, r.sort_order, p.slug`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rel.Close() }()
	for rel.Next() {
		var childID int64
		var parent ExportTagParent
		if err := rel.Scan(&childID, &parent.Slug, &parent.SortOrder); err != nil {
			return nil, fmt.Errorf("scan tag relationship: %w", err)
		}
		if i, ok := index[childID]; ok {
			tags[i].Parents = append(tags[i].Parents, parent)
		}
	}
	return tags, rel.Err()
}
