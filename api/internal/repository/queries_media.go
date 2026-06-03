package repository

import (
	"context"
	"strings"

	"point-api/internal/models"
)

// ListOrphanedMedia returns media records with no associated post (post_id IS NULL).
func (r *sqliteRepository) ListOrphanedMedia(ctx context.Context, limit, offset int64) ([]models.Medium, error) {
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
func (r *sqliteRepository) CountOrphanedMedia(ctx context.Context) (int64, error) {
	const q = `SELECT COUNT(*) FROM media WHERE post_id IS NULL`
	var count int64
	err := r.db.QueryRowContext(ctx, q).Scan(&count)
	return count, err
}

// BulkDeleteMediaByIDs deletes multiple media records by ID and returns the deleted ones
// so the caller can remove files from disk.
func (r *sqliteRepository) GetMediaByIDs(ctx context.Context, ids []int64) ([]models.Medium, error) {
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

func (r *sqliteRepository) DeleteMediaByIDs(ctx context.Context, ids []int64) error {
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

// GetOrphanedMediaIDs returns IDs of media that are not referenced in any post content.
// "Orphaned" here means post_id IS NULL.
func (r *sqliteRepository) ListOrphanedMediaByPage(ctx context.Context, limit, offset int64) ([]models.Medium, int64, error) {
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
func (r *sqliteRepository) ListMediaFolders(ctx context.Context, fileType string) ([]MediaFolder, error) {
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
func (r *sqliteRepository) ListMediaFiltered(ctx context.Context, fileType, folder string, limit, offset int64) ([]models.Medium, error) {
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
func (r *sqliteRepository) CountMediaFiltered(ctx context.Context, fileType, folder string) (int64, error) {
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

// GetMediaByPath returns the media record whose original_path matches exactly.
// The path should be in the stored format, e.g. "originals/2026/03/ts_file.jpg".
func (r *sqliteRepository) GetMediaByPath(ctx context.Context, originalPath string) (models.Medium, error) {
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
func (r *sqliteRepository) SetMediaPublic(ctx context.Context, mediaID int64, isPublic bool, postID *int64) error {
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

// GetAllMediaPaths returns all media records needed for a full visibility recalculation.
func (r *sqliteRepository) GetAllMediaPaths(ctx context.Context) ([]models.Medium, error) {
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

// GetMediaByPaths returns media records whose original_path is in the given
// list (DB format: "originals/YYYY/MM/file"). Order is not guaranteed.
// Returns an empty slice (not an error) when paths is empty.
func (r *sqliteRepository) GetMediaByPaths(ctx context.Context, paths []string) ([]models.Medium, error) {
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

// StorageStats holds aggregate storage info.
type StorageStats struct {
	TotalBytes int64 `json:"total_bytes"`
	TotalFiles int64 `json:"total_files"`
	ImageCount int64 `json:"image_count"`
	VideoCount int64 `json:"video_count"`
	AudioCount int64 `json:"audio_count"`
	OtherCount int64 `json:"other_count"`
}

// GetStorageStats returns aggregate statistics about media files.
func (r *sqliteRepository) GetStorageStats(ctx context.Context) (StorageStats, error) {
	const q = `
SELECT
  COALESCE(SUM(file_size), 0) as total_bytes,
  COUNT(*) as total_files,
  COALESCE(SUM(CASE WHEN file_type = 'image' THEN 1 ELSE 0 END), 0) as image_count,
  COALESCE(SUM(CASE WHEN file_type = 'video' THEN 1 ELSE 0 END), 0) as video_count,
  COALESCE(SUM(CASE WHEN file_type = 'audio' THEN 1 ELSE 0 END), 0) as audio_count,
  COALESCE(SUM(CASE WHEN file_type NOT IN ('image','video','audio') THEN 1 ELSE 0 END), 0) as other_count
FROM media`

	var st StorageStats
	err := r.db.QueryRowContext(ctx, q).Scan(
		&st.TotalBytes, &st.TotalFiles,
		&st.ImageCount, &st.VideoCount, &st.AudioCount, &st.OtherCount,
	)
	return st, err
}
