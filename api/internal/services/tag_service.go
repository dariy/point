package services

// Tag CRUD and the service type the rest of the tag files hang off: create,
// read, update, delete, merge and search a tag's own record. The graph,
// hierarchy, locations, counts and geocoding groups that used to share this
// file live in tag_graph*.go, tag_hierarchy.go, tag_locations.go,
// tag_counts.go and tag_geocode.go.

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
	// pageCache is the rendered public page cache, dropped alongside the graph
	// on any tag write. Nil is valid and skips that.
	pageCache *CacheService
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

// WithCache attaches the public page cache invalidated on every tag write —
// see Invalidate.
func (s *TagService) WithCache(c *CacheService) *TagService {
	s.pageCache = c
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

// SearchTags returns tags matching the query string.
func (s *TagService) SearchTags(ctx context.Context, query string, limit int) ([]models.Tag, error) {
	return s.repo.SearchTags(ctx, query, limit)
}
