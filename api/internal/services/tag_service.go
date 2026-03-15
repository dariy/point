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

func (s *TagService) ListTags(ctx context.Context, includeEmpty, importantOnly, publicOnly bool) ([]models.Tag, error) {
	tags, err := s.repo.ListTags(ctx, models.ListTagsParams{
		IncludeEmptyFilter:  includeEmpty,
		ImportantOnlyFilter: importantOnly,
	})
	if err != nil {
		return nil, err
	}

	if !publicOnly {
		return tags, nil
	}

	effectivelyHidden, _ := s.EffectivelyHiddenIDs(ctx)
	result := make([]models.Tag, 0, len(tags))
	for _, t := range tags {
		if !effectivelyHidden[t.ID] {
			result = append(result, t)
		}
	}
	return result, nil
}

func (s *TagService) GetTagBySlug(ctx context.Context, slug string) (models.Tag, error) {
	return s.repo.GetTagBySlug(ctx, strings.ToLower(slug))
}

func (s *TagService) GetTagByID(ctx context.Context, id int64) (models.Tag, error) {
	return s.repo.GetTag(ctx, id)
}

func (s *TagService) GetTagDescendants(ctx context.Context, tagID int64) ([]models.Tag, error) {
	return s.repo.GetTagDescendants(ctx, tagID)
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

func (s *TagService) GetTagChildren(ctx context.Context, id int64, publicOnly bool) ([]models.Tag, error) {
	children, err := s.repo.GetTagChildren(ctx, id)
	if err != nil {
		return nil, err
	}

	if !publicOnly {
		return children, nil
	}

	effectivelyHidden, _ := s.EffectivelyHiddenIDs(ctx)
	result := make([]models.Tag, 0, len(children))
	for _, ch := range children {
		if !effectivelyHidden[ch.ID] {
			result = append(result, ch)
		}
	}
	return result, nil
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
	ID            int64   `json:"id"`
	Name          string  `json:"name"`
	Slug          string  `json:"slug"`
	Count         int64   `json:"count"`
	Weight        float64 `json:"weight"`
	IsHidden      bool    `json:"is_hidden"`
	IsHiddenPosts bool    `json:"is_hidden_posts"`
}

func (s *TagService) GetTagCloud(ctx context.Context, limit int, publicOnly bool) ([]TagCloudItem, error) {
	tags, err := s.repo.ListTags(ctx, models.ListTagsParams{
		IncludeEmptyFilter:  true, // include all; filter below by effective count
		ImportantOnlyFilter: true,
	})
	if err != nil {
		return nil, err
	}

	if len(tags) == 0 {
		return []TagCloudItem{}, nil
	}

	var candidates []models.Tag
	if publicOnly {
		effectivelyHidden, _ := s.EffectivelyHiddenIDs(ctx)
		for _, t := range tags {
			if !effectivelyHidden[t.ID] {
				candidates = append(candidates, t)
			}
		}
	} else {
		candidates = tags
	}

	if len(candidates) == 0 {
		return []TagCloudItem{}, nil
	}

	// Fetch hierarchical counts (includes descendant posts).
	effectiveCounts, _ := s.GetHierarchicalPostCounts(ctx, publicOnly)

	// Filter to tags with at least one effective post.
	var filtered []models.Tag
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
			ID:            t.ID,
			Name:          t.Name,
			Slug:          t.Slug,
			Count:         count,
			Weight:        weight,
			IsHidden:      t.IsHidden,
			IsHiddenPosts: t.IsHiddenPosts,
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
	TargetID *int64  // nil = move to end
	Position string  // "before" or "after"
	ParentID *int64  // nil = root level
}

// ReorderTag reorders a tag within its sibling group by updating sort_order values.
func (s *TagService) ReorderTag(ctx context.Context, p ReorderTagParams) error {
	if p.Position != "before" && p.Position != "after" {
		return fmt.Errorf("position must be 'before' or 'after'")
	}

	var siblings []models.Tag
	var err error
	if p.ParentID != nil {
		siblings, err = s.repo.GetChildrenOfTag(ctx, *p.ParentID)
	} else {
		siblings, err = s.repo.GetRootTags(ctx)
	}
	if err != nil {
		return err
	}

	// Find and remove the dragged tag.
	draggedIdx := -1
	for i, t := range siblings {
		if t.ID == p.ID {
			draggedIdx = i
			break
		}
	}
	if draggedIdx == -1 {
		return fmt.Errorf("tag %d not found among siblings", p.ID)
	}
	dragged := siblings[draggedIdx]
	siblings = append(siblings[:draggedIdx], siblings[draggedIdx+1:]...)

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
	ID            int64        `json:"id"`
	Name          string       `json:"name"`
	Slug          string       `json:"slug"`
	IsHidden      bool         `json:"is_hidden"`
	IsHiddenPosts bool         `json:"is_hidden_posts"`
	PostCount     int64        `json:"post_count"`
	IsRelated     bool         `json:"is_related"`
	Children      []NavTagNode `json:"children"`
}

// buildEffectivelyHiddenIDs computes the set of tag IDs that should not appear publicly.
// A tag is effectively hidden if:
//   - It is directly marked is_hidden=true, OR
//   - Any ancestor has both is_hidden=true AND is_hidden_posts=true
func buildEffectivelyHiddenIDs(allTags []models.Tag, relationships []repository.TagRelationship) map[int64]bool {
	childrenOf := make(map[int64][]int64, len(relationships))
	for _, rel := range relationships {
		childrenOf[rel.ParentID] = append(childrenOf[rel.ParentID], rel.ChildID)
	}

	hidden := make(map[int64]bool, len(allTags))
	queue := make([]int64, 0)
	for _, t := range allTags {
		if t.IsHidden {
			hidden[t.ID] = true
		}
		if t.IsHidden && t.IsHiddenPosts {
			queue = append(queue, t.ID)
		}
	}

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
// A tag effectively hides posts if it or any of its ancestors has is_hidden_posts=true.
func buildEffectivelyHiddenPostsTagIDs(allTags []models.Tag, relationships []repository.TagRelationship) map[int64]bool {
	childrenOf := make(map[int64][]int64, len(relationships))
	for _, rel := range relationships {
		childrenOf[rel.ParentID] = append(childrenOf[rel.ParentID], rel.ChildID)
	}

	hiddenPosts := make(map[int64]bool, len(allTags))
	queue := make([]int64, 0)
	for _, t := range allTags {
		if t.IsHiddenPosts {
			hiddenPosts[t.ID] = true
			queue = append(queue, t.ID)
		}
	}

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
	allTags, err := s.repo.ListTags(ctx, models.ListTagsParams{
		IncludeEmptyFilter:  true,
		ImportantOnlyFilter: false,
	})
	if err != nil {
		return nil, err
	}
	relationships, err := s.repo.GetAllTagRelationships(ctx)
	if err != nil {
		return nil, err
	}
	return buildEffectivelyHiddenPostsTagIDs(allTags, relationships), nil
}

// EffectivelyHiddenIDs returns the set of tag IDs that should not be shown publicly.
func (s *TagService) EffectivelyHiddenIDs(ctx context.Context) (map[int64]bool, error) {
	allTags, err := s.repo.ListTags(ctx, models.ListTagsParams{
		IncludeEmptyFilter:  true,
		ImportantOnlyFilter: false,
	})
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
// If rootID is nil, returns root-level tags (no parents) and their descendants (for homepage).
// If rootID is non-nil, returns children of that tag and their descendants (for tag pages).
// Hidden and empty tags are excluded.
func (s *TagService) GetHierarchicalNavTags(ctx context.Context, rootID *int64, publicOnly bool) ([]NavTagNode, error) {
	allTags, err := s.repo.ListTags(ctx, models.ListTagsParams{
		IncludeEmptyFilter:  true, // featured tags may have 0 posts but must still appear
		ImportantOnlyFilter: false,
	})
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

	var effectivelyHidden map[int64]bool
	if publicOnly {
		effectivelyHidden = buildEffectivelyHiddenIDs(allTags, relationships)
	}
	effectivelyHiddenPosts := buildEffectivelyHiddenPostsTagIDs(allTags, relationships)

	childrenOf := make(map[int64][]int64)
	parentsOf := make(map[int64][]int64)
	for _, rel := range relationships {
		childrenOf[rel.ParentID] = append(childrenOf[rel.ParentID], rel.ChildID)
		parentsOf[rel.ChildID] = append(parentsOf[rel.ChildID], rel.ParentID)
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

	var build func(id int64, visited map[int64]bool) NavTagNode
	build = func(id int64, visited map[int64]bool) NavTagNode {
		t := tagByID[id]
		node := NavTagNode{
			ID:            t.ID,
			Name:          t.Name,
			Slug:          t.Slug,
			IsHidden:      t.IsHidden,
			IsHiddenPosts: effectivelyHiddenPosts[t.ID],
			PostCount:     t.PostCount,
			IsRelated:     t.ShowRelatedTagsAsChildren,
			Children:      []NavTagNode{},
		}
		childIDs := childrenOf[id]
		sortedIDs := make([]int64, 0, len(childIDs))
		for _, cid := range childIDs {
			if ch, ok := tagByID[cid]; ok && (!publicOnly || !effectivelyHidden[cid]) && (ch.PostCount > 0 || ch.IsFeatured) && !visited[cid] {
				sortedIDs = append(sortedIDs, cid)
			}
		}
		sort.Slice(sortedIDs, func(i, j int) bool {
			return tagLess(tagByID[sortedIDs[i]], tagByID[sortedIDs[j]])
		})
		for _, cid := range sortedIDs {
			childVisited := make(map[int64]bool, len(visited)+1)
			for k := range visited {
				childVisited[k] = true
			}
			childVisited[cid] = true
			node.Children = append(node.Children, build(cid, childVisited))
		}
		return node
	}

	var rootIDs []int64
	if rootID == nil {
		for _, t := range allTags {
			if (publicOnly && effectivelyHidden[t.ID]) || (t.PostCount == 0 && !t.IsFeatured) {
				continue
			}
			if len(parentsOf[t.ID]) == 0 {
				rootIDs = append(rootIDs, t.ID)
			}
		}
	} else {
		for _, cid := range childrenOf[*rootID] {
			if ch, ok := tagByID[cid]; ok && (!publicOnly || !effectivelyHidden[cid]) && (ch.PostCount > 0 || ch.IsFeatured) {
				rootIDs = append(rootIDs, cid)
			}
		}
	}

	sort.Slice(rootIDs, func(i, j int) bool {
		return tagLess(tagByID[rootIDs[i]], tagByID[rootIDs[j]])
	})

	result := make([]NavTagNode, 0, len(rootIDs))
	for _, id := range rootIDs {
		result = append(result, build(id, map[int64]bool{id: true}))
	}
	return result, nil
}

func (s *TagService) GetPostsByTag(ctx context.Context, tagID int64, page, perPage int32, publicOnly bool, includeDrafts bool) ([]models.Post, int64, error) {
	// Collect the tag itself plus all descendants so that a parent tag page
	// (e.g. /tag/countries) shows posts from all nested sub-tags.
	descendants, _ := s.repo.GetTagDescendants(ctx, tagID)
	tagIDs := make([]int64, 0, 1+len(descendants))
	tagIDs = append(tagIDs, tagID)
	for _, d := range descendants {
		tagIDs = append(tagIDs, d.ID)
	}

	offset := (page - 1) * perPage
	posts, err := s.repo.GetPostsByTagIDs(ctx, tagIDs, publicOnly, includeDrafts, int64(perPage), int64(offset))
	if err != nil {
		return nil, 0, err
	}

	total, err := s.repo.CountPostsByTagIDs(ctx, tagIDs, publicOnly, includeDrafts)
	if err != nil {
		return nil, 0, err
	}

	return posts, total, nil
}
