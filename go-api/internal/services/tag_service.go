package services

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/utils"
)


type TagService struct {
	repo *repository.Repository
}

func NewTagService(repo *repository.Repository) *TagService {
	return &TagService{repo: repo}
}

func (s *TagService) ListTags(ctx context.Context, includeEmpty, importantOnly bool) ([]models.Tag, error) {
	return s.repo.ListTags(ctx, models.ListTagsParams{
		IncludeEmptyFilter:  includeEmpty,
		ImportantOnlyFilter: importantOnly,
	})
}

func (s *TagService) GetTagBySlug(ctx context.Context, slug string) (models.Tag, error) {
	return s.repo.GetTagBySlug(ctx, slug)
}

func (s *TagService) GetTagByID(ctx context.Context, id int64) (models.Tag, error) {
	return s.repo.GetTag(ctx, id)
}

type CreateTagParams struct {
	Name                       string
	Slug                       string
	Description                string
	CustomURL                  string
	IsImportant                bool
	IsFeatured                 bool
	IsHidden                   bool
	IsHiddenPosts              bool
	IncludeInBreadcrumbs       bool
	ShowRelatedTagsAsChildren  bool
	SortOrder                  *int32
}

func (s *TagService) CreateTag(ctx context.Context, p CreateTagParams) (models.Tag, error) {
	if p.Slug == "" {
		p.Slug = utils.Slugify(p.Name)
	}

	var sortOrder sql.NullInt64
	if p.SortOrder != nil {
		sortOrder = sql.NullInt64{Int64: int64(*p.SortOrder), Valid: true}
	}

	return s.repo.CreateTag(ctx, models.CreateTagParams{
		Name:                      p.Name,
		Slug:                      p.Slug,
		Description:               sql.NullString{String: p.Description, Valid: p.Description != ""},
		CustomUrl:                 sql.NullString{String: p.CustomURL, Valid: p.CustomURL != ""},
		IsImportant:               p.IsImportant,
		IsFeatured:                p.IsFeatured,
		IsHidden:                  p.IsHidden,
		IsHiddenPosts:             p.IsHiddenPosts,
		IncludeInBreadcrumbs:      p.IncludeInBreadcrumbs,
		ShowRelatedTagsAsChildren: p.ShowRelatedTagsAsChildren,
		SortOrder:                 sortOrder,
	})
}

func (s *TagService) DeleteTag(ctx context.Context, id int64) error {
	return s.repo.DeleteTag(ctx, id)
}

func (s *TagService) GetTagParents(ctx context.Context, id int64) ([]models.Tag, error) {
	return s.repo.GetTagParents(ctx, id)
}

func (s *TagService) GetTagChildren(ctx context.Context, id int64) ([]models.Tag, error) {
	return s.repo.GetTagChildren(ctx, id)
}

// SetTagParents replaces all parent relationships for a tag.
func (s *TagService) SetTagParents(ctx context.Context, tagID int64, parentIDs []int64) error {
	if err := s.repo.ClearTagParents(ctx, tagID); err != nil {
		return err
	}
	for _, parentID := range parentIDs {
		if err := s.repo.AddTagRelationship(ctx, models.AddTagRelationshipParams{
			ParentID: parentID,
			ChildID:  tagID,
		}); err != nil {
			return err
		}
	}
	return nil
}

// SetTagChildren replaces all child relationships for a tag.
func (s *TagService) SetTagChildren(ctx context.Context, tagID int64, childIDs []int64) error {
	if err := s.repo.ClearTagChildren(ctx, tagID); err != nil {
		return err
	}
	for _, childID := range childIDs {
		if err := s.repo.AddTagRelationship(ctx, models.AddTagRelationshipParams{
			ParentID: tagID,
			ChildID:  childID,
		}); err != nil {
			return err
		}
	}
	return nil
}

// GetAllTagRelationships returns all parent-child tag pairs.
func (s *TagService) GetAllTagRelationships(ctx context.Context) ([]repository.TagRelationship, error) {
	return s.repo.GetAllTagRelationships(ctx)
}

type UpdateTagParams struct {
	ID                        int64
	Name                      string
	Slug                      string
	Description               string
	CustomURL                 string
	IsImportant               bool
	IsFeatured                bool
	IsHidden                  bool
	IsHiddenPosts             bool
	IncludeInBreadcrumbs      bool
	ShowRelatedTagsAsChildren bool
	SortOrder                 *int32
}

func (s *TagService) UpdateTag(ctx context.Context, p UpdateTagParams) (models.Tag, error) {
	if p.Slug == "" {
		p.Slug = utils.Slugify(p.Name)
	}

	var sortOrder sql.NullInt64
	if p.SortOrder != nil {
		sortOrder = sql.NullInt64{Int64: int64(*p.SortOrder), Valid: true}
	}

	return s.repo.UpdateTag(ctx, models.UpdateTagParams{
		ID:                        p.ID,
		Name:                      p.Name,
		Slug:                      p.Slug,
		Description:               sql.NullString{String: p.Description, Valid: p.Description != ""},
		CustomUrl:                 sql.NullString{String: p.CustomURL, Valid: p.CustomURL != ""},
		IsImportant:               p.IsImportant,
		IsFeatured:                p.IsFeatured,
		IsHidden:                  p.IsHidden,
		IsHiddenPosts:             p.IsHiddenPosts,
		IncludeInBreadcrumbs:      p.IncludeInBreadcrumbs,
		ShowRelatedTagsAsChildren: p.ShowRelatedTagsAsChildren,
		SortOrder:                 sortOrder,
	})
}

type TagCloudItem struct {
	ID     int64   `json:"id"`
	Name   string  `json:"name"`
	Slug   string  `json:"slug"`
	Count  int64   `json:"count"`
	Weight float64 `json:"weight"`
}

func (s *TagService) GetTagCloud(ctx context.Context, limit int) ([]TagCloudItem, error) {
	tags, err := s.repo.ListTags(ctx, models.ListTagsParams{
		IncludeEmptyFilter:  false,
		ImportantOnlyFilter: false,
	})
	if err != nil {
		return nil, err
	}

	if len(tags) == 0 {
		return []TagCloudItem{}, nil
	}

	// Find max count for weight calculation
	var maxCount int64
	for _, t := range tags {
		if t.PostCount > maxCount {
			maxCount = t.PostCount
		}
	}

	// Limit
	if limit > 0 && len(tags) > limit {
		tags = tags[:limit]
	}

	result := make([]TagCloudItem, len(tags))
	for i, t := range tags {
		weight := 1.0
		if maxCount > 0 {
			weight = float64(t.PostCount) / float64(maxCount)
		}
		result[i] = TagCloudItem{
			ID:     t.ID,
			Name:   t.Name,
			Slug:   t.Slug,
			Count:  t.PostCount,
			Weight: weight,
		}
	}
	return result, nil
}

func (s *TagService) UpdateAllPostCounts(ctx context.Context) error {
	return s.repo.UpdateAllTagPostCounts(ctx)
}

// UpdateMissingCoords geocodes city/country descendant tags that have no coordinates.
// Uses the Nominatim OpenStreetMap API (1 req/sec rate limit).
func (s *TagService) UpdateMissingCoords(ctx context.Context) (map[string]interface{}, error) {
	// Find base category tags
	baseTags, err := s.repo.FindTagsByNames(ctx, []string{"city", "cities", "country", "countries"})
	if err != nil {
		return nil, err
	}
	if len(baseTags) == 0 {
		return map[string]interface{}{
			"status":        "success",
			"updated_count": 0,
			"message":       "No base tags (city/country) found.",
		}, nil
	}

	// Collect all descendant IDs (excluding the base tags themselves)
	baseIDs := map[int64]bool{}
	for _, bt := range baseTags {
		baseIDs[bt.ID] = true
	}

	allDescendantIDs := map[int64]bool{}
	for _, bt := range baseTags {
		descendants, err := s.repo.GetTagDescendants(ctx, bt.ID)
		if err != nil {
			continue
		}
		for _, d := range descendants {
			if !baseIDs[d.ID] {
				allDescendantIDs[d.ID] = true
			}
		}
	}

	if len(allDescendantIDs) == 0 {
		return map[string]interface{}{
			"status":        "success",
			"updated_count": 0,
			"message":       "No sub-tags found for city/country.",
		}, nil
	}

	ids := make([]int64, 0, len(allDescendantIDs))
	for id := range allDescendantIDs {
		ids = append(ids, id)
	}

	// Filter to those without coordinates
	tagsToGeocode, err := s.repo.GetTagsWithoutLocation(ctx, ids)
	if err != nil {
		return nil, err
	}
	if len(tagsToGeocode) == 0 {
		return map[string]interface{}{
			"status":        "success",
			"updated_count": 0,
			"message":       "All city/country tags already have coordinates.",
		}, nil
	}

	client := &http.Client{Timeout: 10 * time.Second}
	updatedCount := 0
	var errors []string

	for _, tag := range tagsToGeocode {
		params := url.Values{
			"q":      {tag.Name},
			"format": {"json"},
			"limit":  {"1"},
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet,
			"https://nominatim.openstreetmap.org/search?"+params.Encode(), nil)
		if err != nil {
			errors = append(errors, fmt.Sprintf("build request for %s: %v", tag.Name, err))
			continue
		}
		req.Header.Set("User-Agent", "Point/1.0.0")

		resp, err := client.Do(req)
		if err != nil {
			errors = append(errors, fmt.Sprintf("geocode %s: %v", tag.Name, err))
			time.Sleep(1100 * time.Millisecond)
			continue
		}

		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		var results []struct {
			Lat string `json:"lat"`
			Lon string `json:"lon"`
		}
		if err := json.Unmarshal(body, &results); err != nil || len(results) == 0 {
			errors = append(errors, fmt.Sprintf("no results for %s", tag.Name))
			time.Sleep(1100 * time.Millisecond)
			continue
		}

		var lat, lon float64
		fmt.Sscanf(results[0].Lat, "%f", &lat)
		fmt.Sscanf(results[0].Lon, "%f", &lon)

		if err := s.repo.UpsertTagLocation(ctx, tag.ID, lat, lon); err != nil {
			errors = append(errors, fmt.Sprintf("save %s: %v", tag.Name, err))
		} else {
			updatedCount++
		}

		// Respect Nominatim rate limit: max 1 request per second
		time.Sleep(1100 * time.Millisecond)
	}

	result := map[string]interface{}{
		"status":        "success",
		"updated_count": updatedCount,
		"message":       fmt.Sprintf("Updated coordinates for %d tags.", updatedCount),
	}
	if len(errors) > 0 {
		result["errors"] = errors
	}
	return result, nil
}

func (s *TagService) GetPostsByTag(ctx context.Context, tagID int64, page, perPage int32, publishedOnly bool) ([]models.GetPostsByTagRow, int64, error) {
	offset := (page - 1) * perPage
	posts, err := s.repo.GetPostsByTag(ctx, models.GetPostsByTagParams{
		TagID:               tagID,
		PublishedOnlyFilter: publishedOnly,
		Limit:               int64(perPage),
		Offset:              int64(offset),
	})
	if err != nil {
		return nil, 0, err
	}

	if posts == nil {
		posts = []models.GetPostsByTagRow{}
	}

	total, err := s.repo.CountPostsByTag(ctx, models.CountPostsByTagParams{
		TagID:               tagID,
		PublishedOnlyFilter: publishedOnly,
	})
	if err != nil {
		return nil, 0, err
	}

	return posts, total, nil
}
