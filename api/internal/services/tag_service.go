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
	"sync"
	"time"

	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/utils"

	"github.com/labstack/echo/v4"
)

type TagService struct {
	repo             repository.Repository
	nominatimBaseURL string
	mu               sync.RWMutex
	graph            *TagGraph
}

// TagGraph is an in-memory snapshot of the tag system, including hierarchy,
// visibility flags, and hierarchical post counts.
type TagGraph struct {
	ByID                map[int64]models.Tag
	BySlug              map[string]models.Tag
	Children            map[int64][]int64          // ordered by edge sort_order
	Parents             map[int64][]int64           // unordered
	EffectiveHidden     map[int64]bool             // BFS from hidden=1 tags
	EffectiveHidesPosts map[int64]bool             // BFS from hides_posts=1 tags
	HiddenVia           map[int64]int64            // tagID -> ancestorID that caused hiding
	CountsPublic        map[int64]int64            // recursive CTE: published only
	CountsAdmin         map[int64]int64            // recursive CTE: all posts
	NavTree             []NavTagNode               // tags with nav_order set
	YearTags            []models.Tag               // tags with kind='year'
	BuiltAt             time.Time
}

func NewTagService(repo repository.Repository) *TagService {
	return &TagService{
		repo:             repo,
		nominatimBaseURL: "https://nominatim.openstreetmap.org/search",
	}
}

// Invalidate clears the cached tag graph, forcing a rebuild on the next read.
func (s *TagService) Invalidate() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.graph = nil
}

func (s *TagService) getGraph(ctx context.Context) (*TagGraph, error) {
	s.mu.RLock()
	if s.graph != nil {
		g := s.graph
		s.mu.RUnlock()
		return g, nil
	}
	s.mu.RUnlock()

	s.mu.Lock()
	defer s.mu.Unlock()

	// Double-check after acquiring write lock
	if s.graph != nil {
		return s.graph, nil
	}

	allTags, err := s.repo.ListTags(ctx, true)
	if err != nil {
		return nil, err
	}

	relationships, err := s.repo.GetAllTagRelationships(ctx)
	if err != nil {
		return nil, err
	}

	// Build the graph
	g := &TagGraph{
		ByID:                make(map[int64]models.Tag, len(allTags)),
		BySlug:              make(map[string]models.Tag, len(allTags)),
		Children:            make(map[int64][]int64),
		Parents:             make(map[int64][]int64),
		EffectiveHidden:     make(map[int64]bool),
		EffectiveHidesPosts: make(map[int64]bool),
		HiddenVia:           make(map[int64]int64),
		BuiltAt:             time.Now(),
	}

	for _, t := range allTags {
		g.ByID[t.ID] = t
		g.BySlug[t.Slug] = t
		if t.Kind == "year" {
			g.YearTags = append(g.YearTags, t)
		}
	}

	// Sort year tags
	sort.Slice(g.YearTags, func(i, j int) bool {
		return g.YearTags[i].Slug < g.YearTags[j].Slug
	})

	for _, rel := range relationships {
		g.Children[rel.ParentID] = append(g.Children[rel.ParentID], rel.ChildID)
		g.Parents[rel.ChildID] = append(g.Parents[rel.ChildID], rel.ParentID)
	}

	// 1. Effective visibility: hidden
	hiddenQueue := make([]int64, 0)
	for _, t := range allTags {
		if t.Hidden {
			g.EffectiveHidden[t.ID] = true
			g.HiddenVia[t.ID] = t.ID
			hiddenQueue = append(hiddenQueue, t.ID)
		}
	}
	for len(hiddenQueue) > 0 {
		cur := hiddenQueue[0]
		hiddenQueue = hiddenQueue[1:]
		via := g.HiddenVia[cur]
		for _, childID := range g.Children[cur] {
			if !g.EffectiveHidden[childID] {
				g.EffectiveHidden[childID] = true
				g.HiddenVia[childID] = via
				hiddenQueue = append(hiddenQueue, childID)
			}
		}
	}

	// 2. Effective visibility: hides_posts
	hidesPostsQueue := make([]int64, 0)
	for _, t := range allTags {
		if t.HidesPosts {
			g.EffectiveHidesPosts[t.ID] = true
			hidesPostsQueue = append(hidesPostsQueue, t.ID)
		}
	}
	for len(hidesPostsQueue) > 0 {
		cur := hidesPostsQueue[0]
		hidesPostsQueue = hidesPostsQueue[1:]
		for _, childID := range g.Children[cur] {
			if !g.EffectiveHidesPosts[childID] {
				g.EffectiveHidesPosts[childID] = true
				hidesPostsQueue = append(hidesPostsQueue, childID)
			}
		}
	}

	// 3. Counts
	g.CountsPublic, _ = s.repo.GetHierarchicalPostCounts(ctx, true)
	g.CountsAdmin, _ = s.repo.GetHierarchicalPostCounts(ctx, false)

	// 4. Nav Tree (requires CountsPublic)
	// We'll build this on demand or here? Proposal says it's a field in TagGraph.
	// Since buildNavTree is complex and depends on publicOnly/minPosts, 
	// maybe we store a version with minPosts=0 and filter it later,
	// or just build it here with default settings.
	// The proposal says: navTree []NavTagNode (from nav_order tags).
	// Let's use a helper that doesn't depend on TagService state.
	g.NavTree = g.buildNavTree(0)

	s.graph = g
	return g, nil
}

func (g *TagGraph) PublicHiddenTagIDs(minPosts int64) map[int64]bool {
	result := make(map[int64]bool, len(g.EffectiveHidden))
	for k, v := range g.EffectiveHidden {
		result[k] = v
	}

	if minPosts > 0 {
		for id, count := range g.CountsPublic {
			if !result[id] && count < minPosts {
				result[id] = true
			}
		}
	}

	return result
}

func (g *TagGraph) WithRelatedIDs() map[int64]bool {
	result := make(map[int64]bool)
	for id, t := range g.ByID {
		if t.ShowRelated {
			result[id] = true
		}
	}
	return result
}

func (g *TagGraph) InBreadcrumbsIDs() map[int64]bool {
	result := make(map[int64]bool)
	for id, t := range g.ByID {
		if t.InBreadcrumbs {
			result[id] = true
		}
	}
	return result
}

func (g *TagGraph) PageTagIDs() map[int64]bool {
	return g.PublicHiddenTagIDs(0)
}

func (g *TagGraph) GetDescendantIDs(tagID int64) []int64 {
	result := make([]int64, 0)
	visited := map[int64]bool{tagID: true}
	queue := []int64{tagID}

	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]

		for _, childID := range g.Children[cur] {
			if !visited[childID] {
				visited[childID] = true
				result = append(result, childID)
				queue = append(queue, childID)
			}
		}
	}
	return result
}

func (g *TagGraph) buildNavTree(minPosts int64) []NavTagNode {
	tagLess := func(a, b models.Tag) bool {
		if a.NavOrder.Valid && b.NavOrder.Valid {
			if a.NavOrder.Int64 != b.NavOrder.Int64 {
				return a.NavOrder.Int64 < b.NavOrder.Int64
			}
		} else if a.NavOrder.Valid {
			return true
		} else if b.NavOrder.Valid {
			return false
		}
		return a.Name < b.Name
	}

	var build func(id int64, visited map[int64]bool) (NavTagNode, bool)
	build = func(id int64, visited map[int64]bool) (NavTagNode, bool) {
		t := g.ByID[id]
		node := NavTagNode{
			ID:              t.ID,
			Name:            t.Name,
			Slug:            t.Slug,
			PostCount:       g.CountsPublic[t.ID],
			IsRelated:       t.ShowRelated,
			ShowInAncestors: t.InAncestorFlyout,
			Children:        []NavTagNode{},
		}

		childIDs := g.Children[id]
		sortedIDs := make([]int64, 0, len(childIDs))
		for _, cid := range childIDs {
			_, ok := g.ByID[cid]
			if !ok {
				continue
			}
			if g.EffectiveHidden[cid] {
				continue
			}
			if visited[cid] {
				continue
			}
			sortedIDs = append(sortedIDs, cid)
		}
		sort.Slice(sortedIDs, func(i, j int) bool {
			return tagLess(g.ByID[sortedIDs[i]], g.ByID[sortedIDs[j]])
		})

		hasVisibleChildren := false
		for _, cid := range sortedIDs {
			childVisited := make(map[int64]bool, len(visited)+1)
			for k, v := range visited {
				childVisited[k] = v
			}
			childVisited[cid] = true
			childNode, visible := build(cid, childVisited)
			if visible {
				node.Children = append(node.Children, childNode)
				hasVisibleChildren = true
			}
		}

		isVisible := node.IsRelated || hasVisibleChildren || t.NavOrder.Valid
		if !isVisible {
			threshold := int64(1)
			if minPosts > threshold {
				threshold = minPosts
			}
			isVisible = node.PostCount >= threshold
		}

		return node, isVisible
	}

	var navRootIDs []int64
	for id, t := range g.ByID {
		if t.NavOrder.Valid && !g.EffectiveHidden[id] {
			navRootIDs = append(navRootIDs, id)
		}
	}

	sort.Slice(navRootIDs, func(i, j int) bool {
		return tagLess(g.ByID[navRootIDs[i]], g.ByID[navRootIDs[j]])
	})

	result := make([]NavTagNode, 0, len(navRootIDs))
	for _, id := range navRootIDs {
		node, visible := build(id, map[int64]bool{id: true})
		if visible {
			result = append(result, node)
		}
	}
	return result
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
		return models.Tag{}, echo.NewHTTPError(http.StatusNotFound, "tag not found")
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
		return models.Tag{}, echo.NewHTTPError(http.StatusNotFound, "tag not found")
	}
	return tag, nil
}

func (s *TagService) GetTagDescendants(ctx context.Context, tagID int64) ([]models.Tag, error) {
	g, err := s.getGraph(ctx)
	if err != nil {
		return nil, err
	}

	result := make([]models.Tag, 0)
	visited := map[int64]bool{tagID: true}
	queue := []int64{tagID}

	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]

		for _, childID := range g.Children[cur] {
			if !visited[childID] {
				visited[childID] = true
				result = append(result, g.ByID[childID])
				queue = append(queue, childID)
			}
		}
	}
	return result, nil
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
			return models.Tag{}, echo.NewHTTPError(http.StatusConflict, "a tag with that slug already exists")
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

func (s *TagService) GetTagAncestors(ctx context.Context, tagID int64) ([]models.Tag, error) {
	g, err := s.getGraph(ctx)
	if err != nil {
		return nil, err
	}

	result := make([]models.Tag, 0)
	visited := map[int64]bool{tagID: true}
	queue := []int64{tagID}

	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]

		for _, parentID := range g.Parents[cur] {
			if !visited[parentID] {
				visited[parentID] = true
				result = append(result, g.ByID[parentID])
				queue = append(queue, parentID)
			}
		}
	}
	return result, nil
}

// ExpandTagsWithAncestors takes a slice of tag IDs and returns those IDs plus all their ancestor IDs.
func (s *TagService) ExpandTagsWithAncestors(ctx context.Context, tagIDs []int64) ([]int64, error) {
	g, err := s.getGraph(ctx)
	if err != nil {
		return nil, err
	}

	seen := make(map[int64]bool)
	queue := make([]int64, 0, len(tagIDs))
	for _, id := range tagIDs {
		if !seen[id] {
			seen[id] = true
			queue = append(queue, id)
		}
	}

	result := make([]int64, 0, len(tagIDs))
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		result = append(result, cur)

		for _, pid := range g.Parents[cur] {
			if !seen[pid] {
				seen[pid] = true
				queue = append(queue, pid)
			}
		}
	}
	return result, nil
}


func (s *TagService) GetTagParents(ctx context.Context, id int64) ([]models.Tag, error) {
	g, err := s.getGraph(ctx)
	if err != nil {
		return nil, err
	}

	parentIDs := g.Parents[id]
	result := make([]models.Tag, 0, len(parentIDs))
	for _, pid := range parentIDs {
		result = append(result, g.ByID[pid])
	}

	sort.Slice(result, func(i, j int) bool {
		return result[i].Name < result[j].Name
	})

	return result, nil
}

func (s *TagService) GetTagChildren(ctx context.Context, id int64, publicOnly bool, minPosts int64) ([]models.Tag, error) {
	g, err := s.getGraph(ctx)
	if err != nil {
		return nil, err
	}

	childIDs := g.Children[id]
	result := make([]models.Tag, 0, len(childIDs))
	for _, cid := range childIDs {
		if publicOnly {
			if g.EffectiveHidden[cid] {
				continue
			}
			if minPosts > 0 && g.CountsPublic[cid] < minPosts {
				continue
			}
		}
		result = append(result, g.ByID[cid])
	}

	sort.Slice(result, func(i, j int) bool {
		return result[i].Name < result[j].Name
	})

	return result, nil
}

// AddTagRelationship adds a parent-child relationship between two tags with cycle detection.
func (s *TagService) AddTagRelationship(ctx context.Context, parentID, childID int64) error {
	// Check for cycles: if parentID is already a descendant of childID, adding parentID -> childID creates a cycle.
	path, err := s.detectCycle(ctx, childID, parentID)
	if err != nil {
		return err
	}
	if path != nil {
		return echo.NewHTTPError(http.StatusConflict, fmt.Sprintf("Cycle detected: %s", strings.Join(path, " -> ")))
	}

	if err := s.repo.AddTagRelationship(ctx, models.AddTagRelationshipParams{
		ParentID: parentID,
		ChildID:  childID,
	}); err != nil {
		return err
	}
	s.Invalidate()
	return nil
}

func (s *TagService) detectCycle(ctx context.Context, startID, targetID int64) ([]string, error) {
	type node struct {
		id   int64
		path []string
	}

	startTag, err := s.repo.GetTag(ctx, startID)
	if err != nil {
		return nil, err
	}

	queue := []node{{id: startID, path: []string{startTag.Slug}}}
	visited := map[int64]bool{startID: true}

	for len(queue) > 0 {
		curr := queue[0]
		queue = queue[1:]

		if curr.id == targetID {
			targetTag, _ := s.repo.GetTag(ctx, targetID)
			fullPath := append([]string{targetTag.Slug}, curr.path...)
			return fullPath, nil
		}

		children, err := s.repo.GetTagChildren(ctx, curr.id)
		if err != nil {
			return nil, err
		}

		for _, child := range children {
			if !visited[child.ID] {
				visited[child.ID] = true
				newPath := append([]string{}, curr.path...)
				newPath = append(newPath, child.Slug)
				queue = append(queue, node{id: child.ID, path: newPath})
			}
		}
	}

	return nil, nil
}

// SetTagParents replaces all parent relationships for a tag.
func (s *TagService) SetTagParents(ctx context.Context, tagID int64, parentIDs []int64) error {
	if err := s.repo.ClearTagParents(ctx, tagID); err != nil {
		return err
	}
	for _, parentID := range parentIDs {
		if err := s.AddTagRelationship(ctx, parentID, tagID); err != nil {
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
		if err := s.AddTagRelationship(ctx, tagID, childID); err != nil {
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
			return models.Tag{}, echo.NewHTTPError(http.StatusConflict, "a tag with that slug already exists")
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
		for _, t := range tags {
			candidates = append(candidates, t)
		}
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
		return fmt.Errorf("tag %d not found", p.ID)
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
	s.Invalidate()
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
	s.Invalidate()
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

	if updatedCount > 0 {
		s.Invalidate()
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

// GetTagSnapshot returns the current TagGraph snapshot.
func (s *TagService) GetTagSnapshot(ctx context.Context) (*TagGraph, error) {
	return s.getGraph(ctx)
}

// GetHierarchicalNavTags builds a recursive tag tree for the public navigation bar.
func (s *TagService) GetHierarchicalNavTags(ctx context.Context, rootID *int64, publicOnly bool, minPosts int64) ([]NavTagNode, error) {
	g, err := s.getGraph(ctx)
	if err != nil {
		return nil, err
	}

	if rootID == nil && publicOnly && minPosts == 0 {
		return g.NavTree, nil
	}

	if rootID == nil {
		return g.buildNavTree(minPosts), nil
	}

	tagLess := func(a, b models.Tag) bool {
		if a.NavOrder.Valid && b.NavOrder.Valid {
			if a.NavOrder.Int64 != b.NavOrder.Int64 {
				return a.NavOrder.Int64 < b.NavOrder.Int64
			}
		} else if a.NavOrder.Valid {
			return true
		} else if b.NavOrder.Valid {
			return false
		}
		return a.Name < b.Name
	}

	var build func(id int64, visited map[int64]bool) (NavTagNode, bool)
	build = func(id int64, visited map[int64]bool) (NavTagNode, bool) {
		t := g.ByID[id]
		node := NavTagNode{
			ID:              t.ID,
			Name:            t.Name,
			Slug:            t.Slug,
			PostCount:       g.CountsPublic[t.ID],
			IsRelated:       t.ShowRelated,
			ShowInAncestors: t.InAncestorFlyout,
			Children:        []NavTagNode{},
		}

		childIDs := g.Children[id]
		sortedIDs := make([]int64, 0, len(childIDs))
		for _, cid := range childIDs {
			if publicOnly && g.EffectiveHidden[cid] {
				continue
			}
			if visited[cid] {
				continue
			}
			sortedIDs = append(sortedIDs, cid)
		}
		sort.Slice(sortedIDs, func(i, j int) bool {
			return tagLess(g.ByID[sortedIDs[i]], g.ByID[sortedIDs[j]])
		})

		hasVisibleChildren := false
		for _, cid := range sortedIDs {
			childVisited := make(map[int64]bool, len(visited)+1)
			for k, v := range visited {
				childVisited[k] = v
			}
			childVisited[cid] = true
			childNode, visible := build(cid, childVisited)
			if visible {
				node.Children = append(node.Children, childNode)
				hasVisibleChildren = true
			}
		}

		isVisible := node.IsRelated || hasVisibleChildren || t.NavOrder.Valid
		if !isVisible {
			threshold := int64(1)
			if publicOnly && minPosts > 0 {
				threshold = minPosts
			}
			isVisible = node.PostCount >= threshold
		}

		return node, isVisible
	}

	navRootIDs := g.Children[*rootID]
	sort.Slice(navRootIDs, func(i, j int) bool {
		return tagLess(g.ByID[navRootIDs[i]], g.ByID[navRootIDs[j]])
	})

	result := make([]NavTagNode, 0, len(navRootIDs))
	for _, id := range navRootIDs {
		if publicOnly && g.EffectiveHidden[id] {
			continue
		}
		node, visible := build(id, map[int64]bool{id: true})
		if visible {
			result = append(result, node)
		}
	}
	return result, nil
}


