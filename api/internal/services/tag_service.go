package services

import (
	"context"
	"database/sql"
	"sort"
	"strings"

	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/utils"
)

type TagService struct {
	repo                repository.Repository
	nominatimBaseURL    string
	nominatimReverseURL string
	// cache owns the tag graph and its lock; see tag_graph_cache.go.
	cache *tagGraphCache
}

func NewTagService(repo repository.Repository) *TagService {
	s := &TagService{
		repo:                repo,
		nominatimBaseURL:    "https://nominatim.openstreetmap.org/search",
		nominatimReverseURL: "https://nominatim.openstreetmap.org/reverse",
	}
	s.cache = newTagGraphCache(s.buildGraph)
	return s
}

func (s *TagService) ListTags(ctx context.Context, includeEmpty, publicOnly bool) ([]models.Tag, error) {
	g, err := s.getGraph(ctx)
	if err != nil {
		return nil, err
	}

	result := make([]models.Tag, 0, len(g.ByID))
	for id, t := range g.ByID {
		if publicOnly {
			if g.EffectiveHidden[id] {
				continue
			}
			if !includeEmpty && g.CountsPublic[id] == 0 {
				continue
			}
		} else {
			if !includeEmpty && g.CountsAdmin[id] == 0 {
				continue
			}
		}
		result = append(result, t)
	}

	// Stable sort by name
	sort.Slice(result, func(i, j int) bool {
		return result[i].Name < result[j].Name
	})

	return result, nil
}

func (s *TagService) GetTagBySlug(ctx context.Context, slug string) (models.Tag, error) {
	g, err := s.getGraph(ctx)
	if err != nil {
		return models.Tag{}, err
	}

	tag, ok := g.BySlug[strings.ToLower(slug)]
	if !ok {
		return models.Tag{}, ErrTagNotFound
	}
	return tag, nil
}

func (s *TagService) GetTagByID(ctx context.Context, id int64) (models.Tag, error) {
	g, err := s.getGraph(ctx)
	if err != nil {
		return models.Tag{}, err
	}

	tag, ok := g.ByID[id]
	if !ok {
		return models.Tag{}, ErrTagNotFound
	}
	return tag, nil
}

func (s *TagService) MergeTags(ctx context.Context, winnerID, loserID int64) error {
	if err := s.repo.MergeTags(ctx, winnerID, loserID); err != nil {
		return err
	}
	s.Invalidate()
	return nil
}

type CreateTagParams struct {
	Name             string
	Slug             string
	Description      string
	Kind             string
	Hidden           bool
	HidesPosts       bool
	NavOrder         *int64
	InBreadcrumbs    bool
	ShowRelated      bool
	InAncestorFlyout bool
	Latitude         *float64
	Longitude        *float64
	ParentIDs        []int64
}

func (s *TagService) CreateTag(ctx context.Context, p CreateTagParams) (models.Tag, error) {
	if p.Slug == "" {
		p.Slug = utils.Slugify(p.Name)
	}

	if p.Kind == "" {
		p.Kind = "tag"
	}

	tag, err := s.repo.CreateTag(ctx, models.CreateTagParams{
		Name:             p.Name,
		Slug:             p.Slug,
		Description:      sql.NullString{String: p.Description, Valid: p.Description != ""},
		Kind:             p.Kind,
		Hidden:           p.Hidden,
		HidesPosts:       p.HidesPosts,
		NavOrder:         utils.ToNullInt64(p.NavOrder),
		InBreadcrumbs:    p.InBreadcrumbs,
		ShowRelated:      p.ShowRelated,
		InAncestorFlyout: p.InAncestorFlyout,
		Latitude:         utils.ToNullFloat64(p.Latitude),
		Longitude:        utils.ToNullFloat64(p.Longitude),
	})
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed: tags.slug") {
			return models.Tag{}, ErrTagSlugExists
		}
		return models.Tag{}, err
	}

	s.Invalidate()

	if err := s.SetTagParents(ctx, tag.ID, p.ParentIDs); err != nil {
		return models.Tag{}, err
	}

	return tag, nil
}

func (s *TagService) DeleteTag(ctx context.Context, id int64) error {
	_, err := s.GetTagByID(ctx, id)
	if err != nil {
		return err
	}
	if err := s.repo.DeleteTag(ctx, id); err != nil {
		return err
	}
	s.Invalidate()
	return nil
}

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

// Tag failures a caller can act on. Previously these were built here as
// echo.HTTPError values, which put HTTP status decisions in the service layer;
// the statuses they used are preserved by the kinds they now carry.
var (
	ErrTagNotFound   = kindSentinel(ErrNotFound, "tag not found")
	ErrTagSlugExists = kindSentinel(ErrConflict, "a tag with that slug already exists")
	ErrTagNotAChild  = kindSentinel(ErrUnprocessable, "tag is not a child of the given parent")
)

type UpdateTagParams struct {
	ID               int64
	Name             string
	Slug             string
	Description      string
	Kind             string
	Hidden           bool
	HidesPosts       bool
	NavOrder         *int64
	InBreadcrumbs    bool
	ShowRelated      bool
	InAncestorFlyout bool
	Latitude         *float64
	Longitude        *float64
}

func (s *TagService) UpdateTag(ctx context.Context, p UpdateTagParams) (models.Tag, error) {
	if p.Slug == "" {
		p.Slug = utils.Slugify(p.Name)
	}

	tag, err := s.repo.UpdateTag(ctx, models.UpdateTagParams{
		ID:               p.ID,
		Name:             p.Name,
		Slug:             p.Slug,
		Description:      sql.NullString{String: p.Description, Valid: p.Description != ""},
		Kind:             p.Kind,
		Hidden:           p.Hidden,
		HidesPosts:       p.HidesPosts,
		NavOrder:         utils.ToNullInt64(p.NavOrder),
		InBreadcrumbs:    p.InBreadcrumbs,
		ShowRelated:      p.ShowRelated,
		InAncestorFlyout: p.InAncestorFlyout,
		Latitude:         utils.ToNullFloat64(p.Latitude),
		Longitude:        utils.ToNullFloat64(p.Longitude),
	})
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed: tags.slug") {
			return models.Tag{}, ErrTagSlugExists
		}
		return models.Tag{}, err
	}
	s.Invalidate()
	return tag, nil
}

type TagCloudItem struct {
	ID     int64   `json:"id"`
	Name   string  `json:"name"`
	Slug   string  `json:"slug"`
	Count  int64   `json:"count"`
	Weight float64 `json:"weight"`
}

func (s *TagService) GetTagCloud(ctx context.Context, limit int, publicOnly bool, minPosts int64) ([]TagCloudItem, error) {
	tags, err := s.repo.ListTags(ctx, true)
	if err != nil {
		return nil, err
	}

	if len(tags) == 0 {
		return []TagCloudItem{}, nil
	}

	var candidates []models.Tag
	if publicOnly {
		g, err := s.getGraph(ctx)
		if err != nil {
			return nil, err
		}
		for _, t := range tags {
			if !g.EffectiveHidden[t.ID] {
				candidates = append(candidates, t)
			}
		}
	} else {
		candidates = append(candidates, tags...)
	}

	if len(candidates) == 0 {
		return []TagCloudItem{}, nil
	}

	// Fetch hierarchical counts (includes descendant posts).
	g, _ := s.getGraph(ctx)
	effectiveCounts := g.CountsAdmin
	if publicOnly {
		effectiveCounts = g.CountsPublic
	}

	var filtered []models.Tag
	threshold := minPosts
	if threshold == 0 {
		threshold = 1
	}
	for _, t := range candidates {
		if effectiveCounts[t.ID] >= threshold {
			filtered = append(filtered, t)
		}
	}

	if len(filtered) == 0 {
		return []TagCloudItem{}, nil
	}

	// Find max count for weight calculation.
	var maxCount int64
	for _, t := range filtered {
		if c := effectiveCounts[t.ID]; c > maxCount {
			maxCount = c
		}
	}

	// Limit
	if limit > 0 && len(filtered) > limit {
		filtered = filtered[:limit]
	}

	result := make([]TagCloudItem, len(filtered))
	for i, t := range filtered {
		count := effectiveCounts[t.ID]
		weight := 1.0
		if maxCount > 0 {
			weight = float64(count) / float64(maxCount)
		}
		result[i] = TagCloudItem{
			ID:     t.ID,
			Name:   t.Name,
			Slug:   t.Slug,
			Count:  count,
			Weight: weight,
		}
	}
	return result, nil
}

func (s *TagService) UpdateAllPostCounts(ctx context.Context) error {
	if err := s.repo.UpdateAllTagPostCounts(ctx); err != nil {
		return err
	}
	s.Invalidate()
	return nil
}

// GetHierarchicalPostCounts returns a map of tagID → effective post count
// including all descendant tags. publishedOnly=true for public, false for admin.
func (s *TagService) GetHierarchicalPostCounts(ctx context.Context, publishedOnly bool) (map[int64]int64, error) {
	return s.repo.GetHierarchicalPostCounts(ctx, publishedOnly)
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

// GetTagLocationsByTagIDs returns a map of tagID → TagLocation for the given IDs.
// Redundant declaration removed.

func (s *TagService) GetTagsByPostIDs(ctx context.Context, postIDs []int64) (map[int64][]repository.PostTagInfo, error) {
	return s.repo.GetTagsByPostIDs(ctx, postIDs)
}

func (s *TagService) GetPostsByTag(ctx context.Context, tagID int64, page, perPage int32, publicOnly bool, includeDrafts bool, yearFrom, yearTo int) ([]models.Post, int64, error) {
	// Collect the tag itself plus all descendants so that a parent tag page
	// (e.g. /tags/countries) shows posts from all nested sub-tags.
	descendants, _ := s.GetTagDescendants(ctx, tagID)
	tagIDs := make([]int64, 0, 1+len(descendants))
	tagIDs = append(tagIDs, tagID)
	for _, d := range descendants {
		tagIDs = append(tagIDs, d.ID)
	}

	includeHidden := !publicOnly
	offset := (page - 1) * perPage
	hasYearFilter := yearFrom > 0 && yearTo > 0 && yearFrom <= yearTo

	var posts []models.Post
	var total int64
	var err error
	if hasYearFilter {
		posts, err = s.repo.GetPostsByTagIDsInYearRange(ctx, tagIDs, yearFrom, yearTo, publicOnly, includeDrafts, includeHidden, int64(perPage), int64(offset))
		if err != nil {
			return nil, 0, err
		}
		total, err = s.repo.CountPostsByTagIDsInYearRange(ctx, tagIDs, yearFrom, yearTo, publicOnly, includeDrafts, includeHidden)
	} else {
		posts, err = s.repo.GetPostsByTagIDs(ctx, tagIDs, publicOnly, includeDrafts, includeHidden, int64(perPage), int64(offset))
		if err != nil {
			return nil, 0, err
		}
		total, err = s.repo.CountPostsByTagIDs(ctx, tagIDs, publicOnly, includeDrafts, includeHidden)
	}
	if err != nil {
		return nil, 0, err
	}

	return posts, total, nil
}

// SearchTags returns tags matching the query string.
func (s *TagService) SearchTags(ctx context.Context, query string, limit int) ([]models.Tag, error) {
	return s.repo.SearchTags(ctx, query, limit)
}
