package services

// The tag graph as a value: the snapshot type the rest of the app reads from,
// and the pure lookups over it. Split out of tag_service.go because nothing
// here touches TagService — the api package builds breadcrumbs, sibling lists
// and nav trees straight off a *TagGraph, so the type deserves a file that has
// no view of the service that produces it.

import (
	"sort"
	"strings"
	"time"

	"point-api/internal/models"
)

// TagGraph is an in-memory snapshot of the tag system, including hierarchy,
// visibility flags, and hierarchical post counts.
type TagGraph struct {
	ByID                map[int64]models.Tag
	BySlug              map[string]models.Tag
	Children            map[int64][]int64 // ordered by edge sort_order
	Parents             map[int64][]int64 // unordered
	EffectiveHidden     map[int64]bool    // BFS from hidden=1 tags
	EffectiveHidesPosts map[int64]bool    // BFS from hides_posts=1 tags
	HiddenVia           map[int64]int64   // tagID -> ancestorID that caused hiding
	CountsPublic        map[int64]int64   // recursive CTE: published only
	CountsAdmin         map[int64]int64   // recursive CTE: all posts
	NavTree             []NavTagNode      // tags with nav_order set
	YearTags            []models.Tag      // tags with kind='year'
	BuiltAt             time.Time
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

// GetDisplayPath returns the hierarchical path for a tag, e.g. "Travel › Portugal".
// If the tag has no parents, it returns an empty string.
// If it has multiple paths, it returns the first one found.
func (g *TagGraph) GetDisplayPath(id int64) string {
	var ancestors []string
	curr := id
	visited := map[int64]bool{id: true}
	for {
		pids := g.Parents[curr]
		if len(pids) == 0 {
			break
		}
		// Pick the first unvisited parent to avoid cycles (though graph should be a DAG)
		var next int64
		found := false
		for _, pid := range pids {
			if !visited[pid] {
				next = pid
				found = true
				break
			}
		}
		if !found {
			break
		}
		curr = next
		visited[curr] = true
		ancestors = append(ancestors, g.ByID[curr].Name)
	}

	// Reverse ancestors to get Root › ... › Parent
	for i, j := 0, len(ancestors)-1; i < j; i, j = i+1, j-1 {
		ancestors[i], ancestors[j] = ancestors[j], ancestors[i]
	}

	return strings.Join(ancestors, " › ")
}

func (g *TagGraph) GetSiblings(id int64) []models.Tag {
	pids := g.Parents[id]
	siblingMap := make(map[int64]bool)
	for _, pid := range pids {
		for _, cid := range g.Children[pid] {
			if cid != id {
				siblingMap[cid] = true
			}
		}
	}
	var siblings []models.Tag
	for sid := range siblingMap {
		siblings = append(siblings, g.ByID[sid])
	}
	sort.Slice(siblings, func(i, j int) bool {
		return siblings[i].Name < siblings[j].Name
	})
	return siblings
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
