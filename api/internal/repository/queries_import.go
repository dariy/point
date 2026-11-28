package repository

import (
	"context"
	"database/sql"
	"time"
)

// The portable import (services.ImportService) creates posts and media with
// the normal services, then sets the fields of the archive that those services
// do not take: the dates and the stored metadata.

// importTimeLayout is the text form of CURRENT_TIMESTAMP, so an imported date
// sorts and compares like a date that SQLite wrote. It keeps the fraction of a
// second when the archive has one (uploaded_at has one), so the order of two
// uploads in the same second stays.
const importTimeLayout = "2006-01-02 15:04:05.999999999"

func importTime(t time.Time) string { return t.UTC().Format(importTimeLayout) }

// CountContentRows returns the number of post rows and media rows, the trash
// included. The import goes only into an instance where both are zero.
func (r *sqliteRepository) CountContentRows(ctx context.Context) (posts, media int64, err error) {
	err = r.db.QueryRowContext(ctx, `SELECT (SELECT COUNT(*) FROM posts), (SELECT COUNT(*) FROM media)`).
		Scan(&posts, &media)
	return posts, media, err
}

// SetPostTimestamps sets created_at, updated_at and published_at of post id.
// An invalid publishedAt sets NULL.
func (r *sqliteRepository) SetPostTimestamps(ctx context.Context, id int64, createdAt, updatedAt time.Time, publishedAt sql.NullTime) error {
	var pub sql.NullString
	if publishedAt.Valid {
		pub = sql.NullString{String: importTime(publishedAt.Time), Valid: true}
	}
	_, err := r.db.ExecContext(ctx, `UPDATE posts SET created_at = ?, updated_at = ?, published_at = ? WHERE id = ?`,
		importTime(createdAt), importTime(updatedAt), pub, id)
	return err
}

// SetImportedMediaFields sets the post link, the upload date and the two
// metadata columns of media row id.
func (r *sqliteRepository) SetImportedMediaFields(ctx context.Context, id int64, postID sql.NullInt64, uploadedAt time.Time, metadata, originalMetadata sql.NullString) error {
	_, err := r.db.ExecContext(ctx, `UPDATE media SET post_id = ?, uploaded_at = ?, metadata = ?, original_metadata = ? WHERE id = ?`,
		postID, importTime(uploadedAt), metadata, originalMetadata, id)
	return err
}
