package services

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/utils"

	"github.com/labstack/echo/v4"
)

type TagService struct {
	repo             *repository.Repository
	nominatimBaseURL string
}

func NewTagService(repo *repository.Repository) *TagService {
	return &TagService{
		repo:             repo,
		nominatimBaseURL: "https://nominatim.openstreetmap.org/search",
	}
}

func (s *TagService) ListTags(ctx context.Context, includeEmpty, publicOnly bool) ([]models.Tag, error) {
	tags, err := s.repo.ListTags(ctx, includeEmpty)
	if err != nil {
		return nil, err
	}

	if !publicOnly {
		return tags, nil
	}

	effectivelyHidden, _ := s.EffectivelyHiddenIDs(ctx)
	result := make([]models.Tag, 0, len(tags))
	for _, t := range tags {
		if !strings.HasPrefix(t.Slug, "_") && !effectivelyHidden[t.ID] {
			result = append(result, t)
		}
	}
	return result, nil
}

func (s *TagService) GetTagBySlug(ctx context.Context, slug string) (models.Tag, error) {
	if strings.HasPrefix(slug, "_") {
		return models.Tag{}, echo.NewHTTPError(http.StatusNotFound, "tag not found")
	}
	return s.repo.GetTagBySlug(ctx, strings.ToLower(slug))
}

func (s *TagService) GetTagByID(ctx context.Context, id int64) (models.Tag, error) {
	tag, err := s.repo.GetTag(ctx, id)
	if err != nil {
		return models.Tag{}, err
	}
	if strings.HasPrefix(tag.Slug, "_") {
		return models.Tag{}, echo.NewHTTPError(http.StatusNotFound, "tag not found")
	}
	return tag, nil
}

func (s *TagService) GetTagDescendants(ctx context.Context, tagID int64) ([]models.Tag, error) {
	return s.repo.GetTagDescendants(ctx, tagID)
}

type CreateTagParams struct {
	Name        string
	Slug        string
	Description string
	CustomURL   string
	SortOrder   *int32
	ParentIDs   []int64
}

func (s *TagService) CreateTag(ctx context.Context, p CreateTagParams) (models.Tag, error) {
	if p.Slug == "" {
		p.Slug = utils.Slugify(p.Name)
	}

	if strings.HasPrefix(p.Slug, "_") {
		return models.Tag{}, echo.NewHTTPError(http.StatusBadRequest, "tag slug cannot start with '_'")
	}

	var sortOrder sql.NullInt64
	if p.SortOrder != nil {
		sortOrder = sql.NullInt64{Int64: int64(*p.SortOrder), Valid: true}
	}

	tag, err := s.repo.CreateTag(ctx, models.CreateTagParams{
		Name:        p.Name,
		Slug:        p.Slug,
		Description: sql.NullString{String: p.Description, Valid: p.Description != ""},
		CustomUrl:   sql.NullString{String: p.CustomURL, Valid: p.CustomURL != ""},
		SortOrder:   sortOrder,
	})
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed: tags.slug") {
			return models.Tag{}, echo.NewHTTPError(http.StatusConflict, "a tag with that slug already exists")
		}
		return models.Tag{}, err
	}

	if err := s.SetTagParents(ctx, tag.ID, p.ParentIDs); err != nil {
		return models.Tag{}, err
	}

	return tag, nil
}

func (s *TagService) DeleteTag(ctx context.Context, id int64) error {
	tag, err := s.repo.GetTag(ctx, id)
	if err != nil {
		return err
	}
	if strings.HasPrefix(tag.Slug, "_") {
		return echo.NewHTTPError(http.StatusForbidden, "system tags cannot be deleted")
	}
	return s.repo.DeleteTag(ctx, id)
}

func (s *TagService) GetTagParents(ctx context.Context, id int64) ([]models.Tag, error) {
	return s.repo.GetTagParents(ctx, id)
}

func (s *TagService) GetTagChildren(ctx context.Context, id int64, publicOnly bool, minPosts int64) ([]models.Tag, error) {
	children, err := s.repo.GetTagChildren(ctx, id)
	if err != nil {
		return nil, err
	}

	if !publicOnly {
		return children, nil
	}

	excludeIDs, _ := s.PublicHiddenTagIDs(ctx, minPosts)

	result := make([]models.Tag, 0, len(children))
	for _, ch := range children {
		if !excludeIDs[ch.ID] {
			result = append(result, ch)
		}
	}
	return result, nil
}

// SetTagParents replaces all parent relationships for a tag.
func (s *TagService) SetTagParents(ctx context.Context, tagID int64, parentIDs []int64) error {
	// System tags have fixed parents and cannot be re-parented.
	tag, err := s.repo.GetTag(ctx, tagID)
	if err != nil {
		return err
	}
	if strings.HasPrefix(tag.Slug, "_") {
		return echo.NewHTTPError(http.StatusForbidden, "cannot re-parent system tags")
	}

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

	// If no parents were set, auto-assign _pending as parent.
	if len(parentIDs) == 0 {
		pending, err := s.repo.GetTagBySlug(ctx, "_pending")
		if err == nil {
			_ = s.repo.AddTagRelationship(ctx, models.AddTagRelationshipParams{
				ParentID: pending.ID,
				ChildID:  tagID,
			})
		}
	}

	return nil
}

// SetTagChildren replaces all child relationships for a tag.
func (s *TagService) SetTagChildren(ctx context.Context, tagID int64, childIDs []int64) error {
	// Reject if any child is a system tag (system tags cannot be children of user tags).
	for _, childID := range childIDs {
		child, err := s.repo.GetTag(ctx, childID)
		if err != nil {
			return err
		}
		if strings.HasPrefix(child.Slug, "_") {
			return echo.NewHTTPError(http.StatusForbidden, "system tags cannot be children of user tags")
		}
	}

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
	ID          int64
	Name        string
	Slug        string
	Description string
	CustomURL   string
	SortOrder   *int32
}

func (s *TagService) UpdateTag(ctx context.Context, p UpdateTagParams) (models.Tag, error) {
	if p.Slug == "" {
		p.Slug = utils.Slugify(p.Name)
	}

	if strings.HasPrefix(p.Slug, "_") {
		return models.Tag{}, echo.NewHTTPError(http.StatusBadRequest, "tag slug cannot start with '_'")
	}

	existing, err := s.repo.GetTag(ctx, p.ID)
	if err != nil {
		return models.Tag{}, err
	}
	if strings.HasPrefix(existing.Slug, "_") {
		// System tags: preserve name and slug; other fields (description, etc.) may change.
		p.Name = existing.Name
		p.Slug = existing.Slug
	}

	var sortOrder sql.NullInt64
	if p.SortOrder != nil {
		sortOrder = sql.NullInt64{Int64: int64(*p.SortOrder), Valid: true}
	}

	tag, err := s.repo.UpdateTag(ctx, models.UpdateTagParams{
		ID:          p.ID,
		Name:        p.Name,
		Slug:        p.Slug,
		Description: sql.NullString{String: p.Description, Valid: p.Description != ""},
		CustomUrl:   sql.NullString{String: p.CustomURL, Valid: p.CustomURL != ""},
		SortOrder:   sortOrder,
	})
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed: tags.slug") {
			return models.Tag{}, echo.NewHTTPError(http.StatusConflict, "a tag with that slug already exists")
		}
		return models.Tag{}, err
	}
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
		excludeIDs, _ := s.PublicHiddenTagIDs(ctx, minPosts)
		for _, t := range tags {
			if !strings.HasPrefix(t.Slug, "_") && !excludeIDs[t.ID] {
				candidates = append(candidates, t)
			}
		}
	} else {
		for _, t := range tags {
			if !strings.HasPrefix(t.Slug, "_") {
				candidates = append(candidates, t)
			}
		}
	}

	if len(candidates) == 0 {
		return []TagCloudItem{}, nil
	}

	// Fetch hierarchical counts (includes descendant posts).
	effectiveCounts, _ := s.GetHierarchicalPostCounts(ctx, publicOnly)

	var filtered []models.Tag
	// Even for non-public, we might want to filter tags with 0 posts.
	// But candidates already excludes system tags.
	for _, t := range candidates {
		if effectiveCounts[t.ID] > 0 {
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
	return s.repo.UpdateAllTagPostCounts(ctx)
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
		return nil
	}
	// Only store the first entry (UNIQUE constraint allows one per tag).
	return s.repo.UpsertTagLocation(ctx, tagID, locs[0].Latitude, locs[0].Longitude)
}

// GetTagLocationsByTagIDs returns a map of tagID → TagLocation for the given IDs.
func (s *TagService) GetTagLocationsByTagIDs(ctx context.Context, tagIDs []int64) (map[int64]models.TagLocation, error) {
	return s.repo.GetTagLocationsByTagIDs(ctx, tagIDs)
}

func (s *TagService) GetTagsByPostIDs(ctx context.Context, postIDs []int64) (map[int64][]repository.PostTagInfo, error) {
	return s.repo.GetTagsByPostIDs(ctx, postIDs)
}

// ReorderTagParams describes a drag-and-drop reorder request.
type ReorderTagParams struct {
	ID       int64
	TargetID *int64 // nil = move to end
	Position string // "before" or "after"
	ParentID *int64 // nil = root level
}

// ReorderTag reorders a tag within its sibling group by updating sort_order values.
func (s *TagService) ReorderTag(ctx context.Context, p ReorderTagParams) error {
	if p.Position != "before" && p.Position != "after" {
		return fmt.Errorf("position must be 'before' or 'after'")
	}

	dragged, err := s.repo.GetTag(ctx, p.ID)
	if err != nil {
		return fmt.Errorf("tag %q not found", p.ID)
	}

	var siblings []models.Tag
	if p.ParentID != nil {
		siblings, err = s.repo.GetChildrenOfTag(ctx, *p.ParentID)
	} else {
		siblings, err = s.repo.GetRootTags(ctx)
	}
	if err != nil {
		return err
	}

	// Find and remove the dragged tag from siblings (may not be present on cross-hierarchy move).
	draggedIdx := -1
	for i, t := range siblings {
		if t.ID == p.ID {
			draggedIdx = i
			break
		}
	}
	if draggedIdx != -1 {
		siblings = append(siblings[:draggedIdx], siblings[draggedIdx+1:]...)
	} else {
		// Cross-hierarchy move: reparent the dragged tag to the target parent.
		var newParents []int64
		if p.ParentID != nil {
			newParents = []int64{*p.ParentID}
		}
		if err := s.SetTagParents(ctx, p.ID, newParents); err != nil {
			return fmt.Errorf("reparent tag %q: %w", dragged.Slug, err)
		}
	}

	// Find insert position relative to target.
	insertAt := len(siblings)
	if p.TargetID != nil {
		for i, t := range siblings {
			if t.ID == *p.TargetID {
				if p.Position == "before" {
					insertAt = i
				} else {
					insertAt = i + 1
				}
				break
			}
		}
	}

	// Insert dragged at the new position.
	siblings = append(siblings, models.Tag{})
	copy(siblings[insertAt+1:], siblings[insertAt:])
	siblings[insertAt] = dragged

	// Assign sort_orders 10, 20, 30, ...
	for i, t := range siblings {
		if err := s.repo.UpdateTagSortOrder(ctx, t.ID, int32((i+1)*10)); err != nil {
			return err
		}
	}
	return nil
}

// GeocodeTag looks up coordinates for a tag by name via Nominatim and stores them.
func (s *TagService) GeocodeTag(ctx context.Context, id int64) (float64, float64, error) {
	tag, err := s.repo.GetTag(ctx, id)
	if err != nil {
		return 0, 0, err
	}

	params := url.Values{
		"q":      {tag.Name},
		"format": {"json"},
		"limit":  {"1"},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		s.nominatimBaseURL+"?"+params.Encode(), nil)
	if err != nil {
		return 0, 0, err
	}
	req.Header.Set("User-Agent", "Point/1.0.0")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return 0, 0, err
	}
	defer func() {
		_ = resp.Body.Close()
	}()
	body, _ := io.ReadAll(resp.Body)

	var results []struct {
		Lat string `json:"lat"`
		Lon string `json:"lon"`
	}
	if err := json.Unmarshal(body, &results); err != nil || len(results) == 0 {
		return 0, 0, fmt.Errorf("no geocoding results for %q", tag.Name)
	}

	var lat, lon float64
	_, _ = fmt.Sscanf(results[0].Lat, "%f", &lat)
	_, _ = fmt.Sscanf(results[0].Lon, "%f", &lon)

	if err := s.repo.UpsertTagLocation(ctx, id, lat, lon); err != nil {
		return 0, 0, err
	}
	return lat, lon, nil
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
			s.nominatimBaseURL+"?"+params.Encode(), nil)
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
		_ = resp.Body.Close()

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
		_, _ = fmt.Sscanf(results[0].Lat, "%f", &lat)
		_, _ = fmt.Sscanf(results[0].Lon, "%f", &lon)

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

// NavTagNode is a tag node in the public navigation hierarchy with nested children.
type NavTagNode struct {
	ID              int64        `json:"id"`
	Name            string       `json:"name"`
	Slug            string       `json:"slug"`
	URL             string       `json:"url,omitempty"`
	PostCount       int64        `json:"post_count"`
	IsRelated       bool         `json:"is_related"`
	ShowInAncestors bool         `json:"show_in_ancestors"`
	Children        []NavTagNode `json:"children"`
}

// buildEffectivelyHiddenIDs computes the set of tag IDs that should not appear publicly.
// Seeds from direct children of the _hidden system tag, then propagates to all descendants.
func buildEffectivelyHiddenIDs(allTags []models.Tag, relationships []repository.TagRelationship) map[int64]bool {
	childrenOf := make(map[int64][]int64, len(relationships))
	for _, rel := range relationships {
		childrenOf[rel.ParentID] = append(childrenOf[rel.ParentID], rel.ChildID)
	}

	// Find the _hidden system tag.
	var hiddenSystemID int64
	for _, t := range allTags {
		if t.Slug == "_hidden" {
			hiddenSystemID = t.ID
			break
		}
	}

	hidden := make(map[int64]bool, len(allTags))
	queue := make([]int64, 0)

	// Seed with direct children of _hidden.
	if hiddenSystemID != 0 {
		for _, childID := range childrenOf[hiddenSystemID] {
			hidden[childID] = true
			queue = append(queue, childID)
		}
	}

	// BFS to propagate through descendants.
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, childID := range childrenOf[cur] {
			if !hidden[childID] {
				hidden[childID] = true
				queue = append(queue, childID)
			}
		}
	}
	return hidden
}

// buildEffectivelyHiddenPostsTagIDs computes the set of tag IDs whose posts should be hidden.
// Seeds from direct children of the _hide_posts system tag, then propagates to all descendants.
func buildEffectivelyHiddenPostsTagIDs(allTags []models.Tag, relationships []repository.TagRelationship) map[int64]bool {
	childrenOf := make(map[int64][]int64, len(relationships))
	for _, rel := range relationships {
		childrenOf[rel.ParentID] = append(childrenOf[rel.ParentID], rel.ChildID)
	}

	// Find the _hide_posts system tag.
	var hidePostsSystemID int64
	for _, t := range allTags {
		if t.Slug == "_hide_posts" {
			hidePostsSystemID = t.ID
			break
		}
	}

	hiddenPosts := make(map[int64]bool, len(allTags))
	queue := make([]int64, 0)

	// Seed with direct children of _hide_posts.
	if hidePostsSystemID != 0 {
		for _, childID := range childrenOf[hidePostsSystemID] {
			hiddenPosts[childID] = true
			queue = append(queue, childID)
		}
	}

	// BFS to propagate through descendants.
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, childID := range childrenOf[cur] {
			if !hiddenPosts[childID] {
				hiddenPosts[childID] = true
				queue = append(queue, childID)
			}
		}
	}
	return hiddenPosts
}

// EffectivelyHiddenPostsTagIDs returns the set of tag IDs that effectively hide their posts.
func (s *TagService) EffectivelyHiddenPostsTagIDs(ctx context.Context) (map[int64]bool, error) {
	allTags, err := s.repo.ListTags(ctx, true)
	if err != nil {
		return nil, err
	}
	relationships, err := s.repo.GetAllTagRelationships(ctx)
	if err != nil {
		return nil, err
	}
	return buildEffectivelyHiddenPostsTagIDs(allTags, relationships), nil
}

// WithRelatedIDs returns the set of tag IDs that are direct children of _with_related.
func (s *TagService) WithRelatedIDs(ctx context.Context) (map[int64]bool, error) {
	allTags, err := s.repo.ListTags(ctx, true)
	if err != nil {
		return nil, err
	}
	relationships, err := s.repo.GetAllTagRelationships(ctx)
	if err != nil {
		return nil, err
	}
	var withRelatedSystemID int64
	for _, t := range allTags {
		if t.Slug == "_with_related" {
			withRelatedSystemID = t.ID
			break
		}
	}
	if withRelatedSystemID == 0 {
		return map[int64]bool{}, nil
	}
	result := make(map[int64]bool)
	for _, rel := range relationships {
		if rel.ParentID == withRelatedSystemID {
			result[rel.ChildID] = true
		}
	}
	return result, nil
}

// InBreadcrumbsIDs returns the set of tag IDs that are direct children of _is_in_breadcrumbs.
func (s *TagService) InBreadcrumbsIDs(ctx context.Context) (map[int64]bool, error) {
	allTags, err := s.repo.ListTags(ctx, true)
	if err != nil {
		return nil, err
	}
	relationships, err := s.repo.GetAllTagRelationships(ctx)
	if err != nil {
		return nil, err
	}

	var breadcrumbsSystemID int64
	for _, t := range allTags {
		if t.Slug == "_is_in_breadcrumbs" {
			breadcrumbsSystemID = t.ID
			break
		}
	}
	if breadcrumbsSystemID == 0 {
		return map[int64]bool{}, nil
	}

	result := make(map[int64]bool)
	for _, rel := range relationships {
		if rel.ParentID == breadcrumbsSystemID {
			result[rel.ChildID] = true
		}
	}
	return result, nil
}

// PageTagIDs returns the set of tag IDs that are descendants of the _page system tag.
// These tags should be excluded from post grids.
func (s *TagService) PageTagIDs(ctx context.Context) (map[int64]bool, error) {
	allTags, err := s.repo.ListTags(ctx, true)
	if err != nil {
		return nil, err
	}
	relationships, err := s.repo.GetAllTagRelationships(ctx)
	if err != nil {
		return nil, err
	}

	childrenOf := make(map[int64][]int64, len(relationships))
	for _, rel := range relationships {
		childrenOf[rel.ParentID] = append(childrenOf[rel.ParentID], rel.ChildID)
	}

	var pageSystemID int64
	for _, t := range allTags {
		if t.Slug == "_page" {
			pageSystemID = t.ID
			break
		}
	}

	result := make(map[int64]bool)
	if pageSystemID == 0 {
		return result, nil
	}

	result[pageSystemID] = true
	queue := []int64{pageSystemID}
	// We include the tag itself if it's considered a system tag that shouldn't show in grids.
	// But usually we only want to hide descendants.
	// The user said "descenders of _page".

	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, childID := range childrenOf[cur] {
			if !result[childID] {
				result[childID] = true
				queue = append(queue, childID)
			}
		}
	}

	return result, nil
}

// PublicHiddenTagIDs returns the set of tag IDs that should be hidden from public view.
// This includes:
// 1. Descendants of the _hidden system tag (effectively hidden).
// 2. Descendants of the _page system tag (excluded from grids).
// 3. Tags with post counts below the minPosts threshold.
func (s *TagService) PublicHiddenTagIDs(ctx context.Context, minPosts int64) (map[int64]bool, error) {
	allTags, err := s.repo.ListTags(ctx, true)
	if err != nil {
		return nil, err
	}
	relationships, err := s.repo.GetAllTagRelationships(ctx)
	if err != nil {
		return nil, err
	}

	childrenOf := make(map[int64][]int64, len(relationships))
	for _, rel := range relationships {
		childrenOf[rel.ParentID] = append(childrenOf[rel.ParentID], rel.ChildID)
	}

	var hiddenSystemID, pageSystemID int64
	for _, t := range allTags {
		switch t.Slug {
		case "_hidden":
			hiddenSystemID = t.ID
		case "_page":
			pageSystemID = t.ID
		}
	}

	result := make(map[int64]bool)
	queue := make([]int64, 0)

	// Seed with _hidden and _page if they exist.
	if hiddenSystemID != 0 {
		result[hiddenSystemID] = true
		queue = append(queue, hiddenSystemID)
	}
	if pageSystemID != 0 {
		result[pageSystemID] = true
		queue = append(queue, pageSystemID)
	}

	// BFS to find all descendants.
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, childID := range childrenOf[cur] {
			if !result[childID] {
				result[childID] = true
				queue = append(queue, childID)
			}
		}
	}

	// Add tags below threshold.
	if minPosts > 0 {
		effectiveCounts, _ := s.GetHierarchicalPostCounts(ctx, true)
		for _, t := range allTags {
			if !result[t.ID] && effectiveCounts[t.ID] < minPosts {
				result[t.ID] = true
			}
		}
	}

	return result, nil
}

// EffectivelyHiddenIDs returns the set of tag IDs that should not be shown publicly.
func (s *TagService) EffectivelyHiddenIDs(ctx context.Context) (map[int64]bool, error) {
	allTags, err := s.repo.ListTags(ctx, true)
	if err != nil {
		return nil, err
	}
	relationships, err := s.repo.GetAllTagRelationships(ctx)
	if err != nil {
		return nil, err
	}
	return buildEffectivelyHiddenIDs(allTags, relationships), nil
}

// GetHierarchicalNavTags builds a recursive tag tree for the public navigation bar.
// If rootID is nil, returns direct children of the _root system tag and their descendants.
// If rootID is non-nil, returns children of that tag and their descendants (for tag pages).
// System tags (slug starting with "_") and hidden/empty tags are excluded from output.
func (s *TagService) GetHierarchicalNavTags(ctx context.Context, rootID *int64, publicOnly bool, minPosts int64) ([]NavTagNode, error) {
	allTags, err := s.repo.ListTags(ctx, true)
	if err != nil {
		return nil, err
	}

	tagByID := make(map[int64]models.Tag, len(allTags))
	for _, t := range allTags {
		tagByID[t.ID] = t
	}

	relationships, err := s.repo.GetAllTagRelationships(ctx)
	if err != nil {
		return nil, err
	}

	var excludeIDs map[int64]bool
	if publicOnly {
		excludeIDs, _ = s.PublicHiddenTagIDs(ctx, minPosts)
	}

	childrenOf := make(map[int64][]int64)
	for _, rel := range relationships {
		childrenOf[rel.ParentID] = append(childrenOf[rel.ParentID], rel.ChildID)
	}

	// Fetch hierarchical counts for filtering.
	effectiveCounts, _ := s.GetHierarchicalPostCounts(ctx, publicOnly)

	// ... [rest of variable setup stays same]
	// Find system tag IDs for _root, _with_related, and _no_ancestors.
	var rootSystemID, withRelatedID, noAncestorsID int64
	for _, t := range allTags {
		switch t.Slug {
		case "_root":
			rootSystemID = t.ID
		case "_with_related":
			withRelatedID = t.ID
		case "_no_ancestors":
			noAncestorsID = t.ID
		}
	}

	// Build set of _with_related children for IsRelated determination.
	withRelatedChildren := make(map[int64]bool)
	if withRelatedID != 0 {
		for _, cid := range childrenOf[withRelatedID] {
			withRelatedChildren[cid] = true
		}
	}

	// Build set of _no_ancestors children — these tags are hidden from the ancestor flyout.
	noAncestorsChildren := make(map[int64]bool)
	if noAncestorsID != 0 {
		for _, cid := range childrenOf[noAncestorsID] {
			noAncestorsChildren[cid] = true
		}
	}

	tagLess := func(a, b models.Tag) bool {
		if a.SortOrder.Valid && b.SortOrder.Valid {
			if a.SortOrder.Int64 != b.SortOrder.Int64 {
				return a.SortOrder.Int64 < b.SortOrder.Int64
			}
		} else if a.SortOrder.Valid {
			return true
		} else if b.SortOrder.Valid {
			return false
		}
		return a.Name < b.Name
	}

	var build func(id int64, visited map[int64]bool) (NavTagNode, bool)
	build = func(id int64, visited map[int64]bool) (NavTagNode, bool) {
		t := tagByID[id]
		node := NavTagNode{
			ID:              t.ID,
			Name:            t.Name,
			Slug:            t.Slug,
			PostCount:       effectiveCounts[t.ID],
			IsRelated:       withRelatedChildren[t.ID],
			ShowInAncestors: !noAncestorsChildren[t.ID],
			Children:        []NavTagNode{},
		}

		childIDs := childrenOf[id]
		sortedIDs := make([]int64, 0, len(childIDs))
		for _, cid := range childIDs {
			ch, ok := tagByID[cid]
			if !ok {
				continue
			}
			// Skip system tags in the output tree.
			if strings.HasPrefix(ch.Slug, "_") {
				continue
			}
			if publicOnly && excludeIDs[cid] {
				continue
			}
			if visited[cid] {
				continue
			}
			sortedIDs = append(sortedIDs, cid)
		}
		sort.Slice(sortedIDs, func(i, j int) bool {
			return tagLess(tagByID[sortedIDs[i]], tagByID[sortedIDs[j]])
		})

		hasVisibleChildren := false
		for _, cid := range sortedIDs {
			childVisited := make(map[int64]bool, len(visited)+1)
			for k := range visited {
				childVisited[k] = true
			}
			childVisited[cid] = true
			childNode, visible := build(cid, childVisited)
			if visible {
				node.Children = append(node.Children, childNode)
				hasVisibleChildren = true
			}
		}

		// A node is visible if its count >= threshold, or it has visible children,
		// or it is a "related" entry (special handling for nav context).
		isVisible := node.IsRelated || hasVisibleChildren
		if !isVisible {
			threshold := int64(1)
			if publicOnly && minPosts > 0 {
				threshold = minPosts
			}
			isVisible = node.PostCount >= threshold
		}

		return node, isVisible
	}

	var navRootIDs []int64
	if rootID == nil {
		// Use direct children of _root system tag as nav roots.
		if rootSystemID != 0 {
			navRootIDs = childrenOf[rootSystemID]
		}
	} else {
		navRootIDs = childrenOf[*rootID]
	}

	sort.Slice(navRootIDs, func(i, j int) bool {
		return tagLess(tagByID[navRootIDs[i]], tagByID[navRootIDs[j]])
	})

	result := make([]NavTagNode, 0, len(navRootIDs))
	for _, id := range navRootIDs {
		ch, ok := tagByID[id]
		if !ok || strings.HasPrefix(ch.Slug, "_") {
			continue
		}
		if publicOnly && excludeIDs[id] {
			continue
		}
		node, visible := build(id, map[int64]bool{id: true})
		if visible {
			result = append(result, node)
		}
	}
	return result, nil
}

func (s *TagService) GetPostsByTag(ctx context.Context, tagID int64, page, perPage int32, publicOnly bool, includeDrafts bool, yearFrom, yearTo int) ([]models.Post, int64, error) {
	// Collect the tag itself plus all descendants so that a parent tag page
	// (e.g. /tags/countries) shows posts from all nested sub-tags.
	descendants, _ := s.repo.GetTagDescendants(ctx, tagID)
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
