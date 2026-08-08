package services

// Tag locations: the single coordinate pair a place tag may carry. Split out
// of tag_service.go because it is a small self-contained store — one row per
// tag, written straight through to the repository — that only shares the
// TagService receiver with the rest of the tag system. The coordinates
// themselves are produced by tag_geocode.go or supplied by the caller.
//
// Every write invalidates the graph cache: the tag rows it snapshots carry
// latitude and longitude, so a location change makes the snapshot stale.

import (
	"context"

	"point-api/internal/models"
)

func (s *TagService) UpsertTagLocation(ctx context.Context, tagID int64, lat, lon float64) error {
	if err := s.repo.UpsertTagLocation(ctx, tagID, lat, lon); err != nil {
		return err
	}
	s.Invalidate()
	return nil
}

func (s *TagService) DeleteTagLocation(ctx context.Context, tagID int64) error {
	if err := s.repo.DeleteTagLocation(ctx, tagID); err != nil {
		return err
	}
	s.Invalidate()
	return nil
}

func (s *TagService) GetTagLocationsByTagIDs(ctx context.Context, tagIDs []int64) (map[int64]models.TagLocation, error) {
	return s.repo.GetTagLocationsByTagIDs(ctx, tagIDs)
}

// TagLocationInput represents a coordinate pair for create/update requests.
type TagLocationInput struct {
	Latitude  float64
	Longitude float64
}

// SetTagLocations replaces the location for a tag. Pass nil or empty slice to remove.
func (s *TagService) SetTagLocations(ctx context.Context, tagID int64, locs []TagLocationInput) error {
	_ = s.repo.DeleteTagLocation(ctx, tagID)
	if len(locs) == 0 {
		s.Invalidate()
		return nil
	}
	// Only store the first entry (UNIQUE constraint allows one per tag).
	if err := s.repo.UpsertTagLocation(ctx, tagID, locs[0].Latitude, locs[0].Longitude); err != nil {
		return err
	}
	s.Invalidate()
	return nil
}
