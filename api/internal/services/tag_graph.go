package services

// The service's handle on the tag graph: how it is built, dropped, and read.
// Split out of tag_service.go because these are the only methods that need to
// know the graph is cached at all — everything downstream just asks for a
// snapshot. buildGraph is the cache's build function (see tag_graph_cache.go);
// the reads below all go through getGraph so a request shares one snapshot
// instead of each caller rebuilding it.

import (
	"context"
	"sort"
	"time"

	"point-api/internal/models"
)

// Invalidate clears the cached tag graph, forcing a rebuild on the next read.
// Callers outside this package need it because mutating posts changes the
// hierarchical post counts the graph caches (see PostService.refreshTagCounts).
func (s *TagService) Invalidate() {
	s.cache.invalidate()
}

// getGraph returns the cached tag graph, building it on a cold cache.
func (s *TagService) getGraph(ctx context.Context) (*TagGraph, error) {
	return s.cache.get(ctx)
}

// buildGraph reads the tag system and assembles a fresh TagGraph. It is the
// cache's build function and must not be called directly — go through getGraph
// so the result is shared rather than rebuilt per caller.
func (s *TagService) buildGraph(ctx context.Context) (*TagGraph, error) {
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

	// 1. Effective visibility: hidden.
	// Hidden is NOT inherited by descendants — only tags explicitly marked
	// hidden are hidden. A useful child (e.g. "robot") stays visible even when
	// its parent (e.g. "stuff") is hidden.
	for _, t := range allTags {
		if t.Hidden {
			g.EffectiveHidden[t.ID] = true
			g.HiddenVia[t.ID] = t.ID
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

	return g, nil
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
