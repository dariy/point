package repository

import (
	"context"
	"fmt"
	"strings"
)

// MapYearRangeTag pairs a location tag ID with its post count scoped to a year range.
type MapYearRangeTag struct {
	TagID     int64 `json:"tag_id"`
	PostCount int64 `json:"post_count"`
}

// ListMapTagsForYearRange returns location tags (tags with coordinates set)
// whose posts intersect with posts tagged by any year tag (kind='year') whose
// parsed year falls in [fromYear, toYear]. PostCount reflects the scoped count.
func (r *sqliteRepository) ListMapTagsForYearRange(ctx context.Context, fromYear, toYear int) ([]MapYearRangeTag, error) {
	const q = `
WITH date_tag_ids AS (
    SELECT id FROM tags
    WHERE kind = 'year'
    AND CAST(slug AS INTEGER) BETWEEN ? AND ?
),
filtered_posts AS (
    SELECT DISTINCT pt.post_id
    FROM post_tags pt
    WHERE pt.tag_id IN (SELECT id FROM date_tag_ids)
)
SELECT t.id, COUNT(DISTINCT pt2.post_id) AS scoped_count
FROM tags t
JOIN post_tags pt2 ON pt2.tag_id = t.id
WHERE t.latitude IS NOT NULL AND t.longitude IS NOT NULL
AND pt2.post_id IN (SELECT post_id FROM filtered_posts)
GROUP BY t.id
ORDER BY scoped_count DESC`

	rows, err := r.db.QueryContext(ctx, q, fromYear, toYear)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var results []MapYearRangeTag
	for rows.Next() {
		var m MapYearRangeTag
		if err := rows.Scan(&m.TagID, &m.PostCount); err != nil {
			return nil, err
		}
		results = append(results, m)
	}
	return results, rows.Err()
}

// InTimelineTag is a lightweight descriptor for a year tag.
type InTimelineTag struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Slug      string `json:"slug"`
	PostCount int64  `json:"post_count"`
}

// ListInTimelineDescendants returns all tags with kind='year', ordered by slug ascending.
func (r *sqliteRepository) ListInTimelineDescendants(ctx context.Context) ([]InTimelineTag, error) {
	const q = `
SELECT id, name, slug, post_count
FROM tags
WHERE kind = 'year'
ORDER BY slug ASC`

	rows, err := r.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var tags []InTimelineTag
	for rows.Next() {
		var t InTimelineTag
		if err := rows.Scan(&t.ID, &t.Name, &t.Slug, &t.PostCount); err != nil {
			return nil, err
		}
		tags = append(tags, t)
	}
	return tags, rows.Err()
}

// ListInTimelineDescendantsForTag returns year tags that co-occur with contextTagSlug.
func (r *sqliteRepository) ListInTimelineDescendantsForTag(ctx context.Context, contextTagSlug string) ([]InTimelineTag, error) {
	const q = `
SELECT t.id, t.name, t.slug, t.post_count
FROM tags t
WHERE t.kind = 'year'
AND t.id IN (
    SELECT pt.tag_id FROM post_tags pt
    WHERE pt.post_id IN (
        SELECT pt2.post_id FROM post_tags pt2
        JOIN tags ct ON ct.id = pt2.tag_id
        WHERE ct.slug = ?
    )
)
ORDER BY t.slug ASC`

	rows, err := r.db.QueryContext(ctx, q, contextTagSlug)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var tags []InTimelineTag
	for rows.Next() {
		var t InTimelineTag
		if err := rows.Scan(&t.ID, &t.Name, &t.Slug, &t.PostCount); err != nil {
			return nil, err
		}
		tags = append(tags, t)
	}
	return tags, rows.Err()
}

// LocationTagCoOccurrence is a location tag paired with its co-occurrence count
// for a specific date tag query.
type LocationTagCoOccurrence struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Slug      string `json:"slug"`
	PostCount int    `json:"post_count"`
}

// GetLocationTagsCoOccurringWith returns location tags (tags with coordinates set)
// that share at least one post with dateTagSlug. If contextTagSlug is non-empty, only
// posts also tagged with contextTagSlug are considered. Results are ordered by
// co-occurrence count desc and capped at limit.
func (r *sqliteRepository) GetLocationTagsCoOccurringWith(ctx context.Context, dateTagSlug, contextTagSlug string, limit int) ([]LocationTagCoOccurrence, error) {
	contextJoin := ""
	args := []interface{}{dateTagSlug}
	if contextTagSlug != "" {
		contextJoin = `
		AND pt.post_id IN (
			SELECT pt_ctx.post_id FROM post_tags pt_ctx
			JOIN tags t_ctx ON t_ctx.id = pt_ctx.tag_id
			WHERE t_ctx.slug = ?
		)`
		args = append(args, contextTagSlug)
	}
	args = append(args, limit)

	q := fmt.Sprintf(`
SELECT t.id, t.name, t.slug, COUNT(*) AS co_count
FROM tags t
JOIN post_tags pt ON pt.tag_id = t.id
WHERE t.latitude IS NOT NULL AND t.longitude IS NOT NULL
AND pt.post_id IN (
    SELECT pt2.post_id FROM post_tags pt2
    JOIN tags dt ON dt.id = pt2.tag_id
    WHERE dt.slug = ?
)%s
GROUP BY t.id
ORDER BY co_count DESC
LIMIT ?`, contextJoin)

	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var results []LocationTagCoOccurrence
	for rows.Next() {
		var lc LocationTagCoOccurrence
		if err := rows.Scan(&lc.ID, &lc.Name, &lc.Slug, &lc.PostCount); err != nil {
			return nil, err
		}
		results = append(results, lc)
	}
	return results, rows.Err()
}

// GetYearTagsByLocationTagIDs returns a map of locationTagID → []PostTagInfo (year tags).
// Uses kind='year' to identify year tags.
func (r *sqliteRepository) GetYearTagsByLocationTagIDs(ctx context.Context, locTagIDs []int64) (map[int64][]PostTagInfo, error) {
	result := make(map[int64][]PostTagInfo)
	if len(locTagIDs) == 0 {
		return result, nil
	}

	args := make([]interface{}, len(locTagIDs))
	placeholders := make([]string, len(locTagIDs))
	for i, id := range locTagIDs {
		args[i] = id
		placeholders[i] = "?"
	}

	q := `
SELECT DISTINCT pt1.tag_id as loc_tag_id, year_tag.id, year_tag.name, year_tag.slug
FROM post_tags AS pt1
JOIN post_tags AS pt2 ON pt1.post_id = pt2.post_id
JOIN tags AS year_tag ON pt2.tag_id = year_tag.id
WHERE pt1.tag_id IN (` + strings.Join(placeholders, ",") + `) AND year_tag.kind = 'year'
ORDER BY year_tag.slug ASC`

	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = rows.Close()
	}()

	for rows.Next() {
		var locTagID int64
		var tag PostTagInfo
		if err := rows.Scan(&locTagID, &tag.ID, &tag.Name, &tag.Slug); err != nil {
			return nil, err
		}
		result[locTagID] = append(result[locTagID], tag)
	}
	return result, rows.Err()
}
