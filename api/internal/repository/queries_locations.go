package repository

import (
	"context"
	"strings"

	"point-api/internal/models"
)

// UpsertTagLocation sets coordinates on the tag row directly.
func (r *sqliteRepository) UpsertTagLocation(ctx context.Context, tagID int64, lat, lon float64) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE tags SET latitude = ?, longitude = ? WHERE id = ?`,
		lat, lon, tagID)
	return err
}

// GetTagLocationsByTagIDs returns a map of tagID → TagLocation for the given IDs,
// reading latitude/longitude from the tags table directly.
func (r *sqliteRepository) GetTagLocationsByTagIDs(ctx context.Context, tagIDs []int64) (map[int64]models.TagLocation, error) {
	result := make(map[int64]models.TagLocation)
	if len(tagIDs) == 0 {
		return result, nil
	}

	args := make([]interface{}, len(tagIDs))
	placeholders := make([]string, len(tagIDs))
	for i, id := range tagIDs {
		args[i] = id
		placeholders[i] = "?"
	}

	q := `SELECT id, latitude, longitude FROM tags WHERE id IN (` +
		strings.Join(placeholders, ",") + `) AND latitude IS NOT NULL AND longitude IS NOT NULL`
	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = rows.Close()
	}()

	for rows.Next() {
		var tagID int64
		var lat, lon float64
		if err := rows.Scan(&tagID, &lat, &lon); err != nil {
			return nil, err
		}
		result[tagID] = models.TagLocation{
			ID:        tagID,
			TagID:     tagID,
			Latitude:  lat,
			Longitude: lon,
		}
	}
	return result, rows.Err()
}

// DeleteTagLocation clears coordinates from the tag row.
func (r *sqliteRepository) DeleteTagLocation(ctx context.Context, tagID int64) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE tags SET latitude = NULL, longitude = NULL WHERE id = ?`, tagID)
	return err
}
