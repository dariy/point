package repository

import (
	"context"

	"point-api/internal/models"
)

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
