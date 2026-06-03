package repository

import (
	"context"
	"time"
)

// SystemStats holds aggregate statistics about the blog.
type SystemStats struct {
	PostCount      int64
	PublishedCount int64
	DraftCount     int64
	TagCount       int64
	MediaCount     int64
	StorageBytes   int64
	UserCount      int64
	SessionCount   int64
}

func (r *Repository) GetSystemStats(ctx context.Context) (SystemStats, error) {
	var s SystemStats
	const q = `
SELECT
  (SELECT COUNT(*) FROM posts WHERE deleted_at IS NULL) AS post_count,
  (SELECT COUNT(*) FROM posts WHERE LOWER(status) = 'published' AND deleted_at IS NULL) AS published_count,
  (SELECT COUNT(*) FROM posts WHERE LOWER(status) = 'draft' AND deleted_at IS NULL) AS draft_count,
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

// BackupDB creates a SQL dump of the SQLite database using backup API.
func (r *Repository) BackupDB(ctx context.Context, destPath string) error {
	_, err := r.db.ExecContext(ctx, "VACUUM INTO ?", destPath)
	return err
}
