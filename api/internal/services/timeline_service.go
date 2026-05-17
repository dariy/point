package services

import (
	"context"
	"regexp"
	"sort"
	"strconv"

	"point-api/internal/repository"
)

var yearSlugRe = regexp.MustCompile(`^(\d{4})s?$`)

// TimelinePill represents a single date pill in the timeline control.
type TimelinePill struct {
	Slug      string `json:"slug"`
	Name      string `json:"name"`
	Year      int    `json:"year"`
	IsDecade  bool   `json:"is_decade"`
	PostCount int64  `json:"post_count"`
}

// TimelineExtent holds the min/max year of the timeline data.
type TimelineExtent struct {
	Min int `json:"min"`
	Max int `json:"max"`
}

// TimelinePayload is the API response shape for GET /api/timeline.
type TimelinePayload struct {
	Pills  []TimelinePill `json:"pills"`
	Extent TimelineExtent `json:"extent"`
}

// LocationLink is a location tag with its co-occurrence count.
type LocationLink struct {
	Slug      string `json:"slug"`
	Name      string `json:"name"`
	PostCount int    `json:"post_count"`
}

// TimelineService assembles timeline payload from repository data.
type TimelineService struct {
	repo *repository.Repository
}

// NewTimelineService creates a new TimelineService.
func NewTimelineService(repo *repository.Repository) *TimelineService {
	return &TimelineService{repo: repo}
}

// parseTimelineYear extracts a year integer and decade flag from a tag slug.
// Accepts "2024" (year) and "2020s" (decade). Returns ok=false for other slugs.
func parseTimelineYear(slug string) (year int, isDecade bool, ok bool) {
	m := yearSlugRe.FindStringSubmatch(slug)
	if m == nil {
		return 0, false, false
	}
	y, err := strconv.Atoi(m[1])
	if err != nil {
		return 0, false, false
	}
	return y, len(slug) > 4, true
}

// Timeline returns the timeline payload for the given context tag slug (or global if empty).
// Tags that cannot be parsed as a year or decade are omitted.
func (s *TimelineService) Timeline(ctx context.Context, contextTagSlug string) (*TimelinePayload, error) {
	var tags []repository.InTimelineTag
	var err error
	if contextTagSlug != "" {
		tags, err = s.repo.ListInTimelineDescendantsForTag(ctx, contextTagSlug)
	} else {
		tags, err = s.repo.ListInTimelineDescendants(ctx)
	}
	if err != nil {
		return nil, err
	}

	var pills []TimelinePill
	for _, t := range tags {
		year, isDecade, ok := parseTimelineYear(t.Slug)
		if !ok {
			continue
		}
		pills = append(pills, TimelinePill{
			Slug:      t.Slug,
			Name:      t.Name,
			Year:      year,
			IsDecade:  isDecade,
			PostCount: t.PostCount,
		})
	}

	sort.Slice(pills, func(i, j int) bool {
		return pills[i].Year < pills[j].Year
	})

	payload := &TimelinePayload{Pills: pills}
	if len(pills) > 0 {
		payload.Extent = TimelineExtent{Min: pills[0].Year, Max: pills[len(pills)-1].Year}
	}
	return payload, nil
}

// LocationsFor returns location tags co-occurring with the given date tag,
// optionally scoped to contextTagSlug, capped at limit.
func (s *TimelineService) LocationsFor(ctx context.Context, dateTagSlug, contextTagSlug string, limit int) ([]LocationLink, error) {
	locs, err := s.repo.GetLocationTagsCoOccurringWith(ctx, dateTagSlug, contextTagSlug, limit)
	if err != nil {
		return nil, err
	}
	result := make([]LocationLink, len(locs))
	for i, l := range locs {
		result[i] = LocationLink{Slug: l.Slug, Name: l.Name, PostCount: l.PostCount}
	}
	return result, nil
}
