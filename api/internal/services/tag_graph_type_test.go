package services

// Unit tests for the TagGraph value type. Everything here is pure — a graph is
// a literal, no repository and no database — so these pin the exact traversal,
// ordering and visibility rules the rest of the tag system reads off a
// snapshot. See tag_graph_test.go for the TagService methods that wrap them.

import (
	"database/sql"
	"reflect"
	"sort"
	"testing"

	"point-api/internal/models"
)

// navTag builds a tag with an explicit nav_order; navOrder < 0 means NULL.
func navTag(id int64, name string, navOrder int64) models.Tag {
	t := models.Tag{ID: id, Name: name, Slug: name}
	if navOrder >= 0 {
		t.NavOrder = sql.NullInt64{Int64: navOrder, Valid: true}
	}
	return t
}

// graphOf indexes tags by ID and slug and wires the parent side of every edge
// from the supplied children map, so tests only declare the hierarchy once.
func graphOf(tags []models.Tag, children map[int64][]int64) *TagGraph {
	g := &TagGraph{
		ByID:                make(map[int64]models.Tag, len(tags)),
		BySlug:              make(map[string]models.Tag, len(tags)),
		Children:            children,
		Parents:             make(map[int64][]int64),
		EffectiveHidden:     make(map[int64]bool),
		EffectiveHidesPosts: make(map[int64]bool),
		HiddenVia:           make(map[int64]int64),
		CountsPublic:        make(map[int64]int64),
		CountsAdmin:         make(map[int64]int64),
	}
	for _, t := range tags {
		g.ByID[t.ID] = t
		g.BySlug[t.Slug] = t
	}
	if g.Children == nil {
		g.Children = map[int64][]int64{}
	}
	// Walk the parents in ID order rather than map order: several of the graph
	// walks return results in Parents-slice order, so ranging the map directly
	// would make those tests depend on Go's randomised map iteration.
	pids := make([]int64, 0, len(g.Children))
	for pid := range g.Children {
		pids = append(pids, pid)
	}
	sort.Slice(pids, func(i, j int) bool { return pids[i] < pids[j] })
	for _, pid := range pids {
		for _, cid := range g.Children[pid] {
			g.Parents[cid] = append(g.Parents[cid], pid)
		}
	}
	return g
}

func TestTagGraph_PublicHiddenTagIDs(t *testing.T) {
	g := graphOf([]models.Tag{navTag(1, "a", -1), navTag(2, "b", -1), navTag(3, "c", -1)}, nil)
	g.EffectiveHidden[1] = true
	g.EffectiveHidden[2] = false
	g.CountsPublic = map[int64]int64{1: 0, 2: 5, 3: 2}

	t.Run("minPosts zero copies effective hidden verbatim", func(t *testing.T) {
		got := g.PublicHiddenTagIDs(0)
		if !reflect.DeepEqual(got, map[int64]bool{1: true, 2: false}) {
			t.Fatalf("PublicHiddenTagIDs(0) = %v", got)
		}
		// The copy must be independent of the graph.
		got[99] = true
		if g.EffectiveHidden[99] {
			t.Error("PublicHiddenTagIDs returned an aliased map")
		}
	})

	t.Run("minPosts hides tags under the threshold", func(t *testing.T) {
		got := g.PublicHiddenTagIDs(3)
		// 2 has 5 posts and stays visible; 3 has 2 posts and is now hidden;
		// 1 was already hidden and its true is not overwritten.
		if !reflect.DeepEqual(got, map[int64]bool{1: true, 2: false, 3: true}) {
			t.Fatalf("PublicHiddenTagIDs(3) = %v", got)
		}
	})

	t.Run("PageTagIDs is the zero-threshold form", func(t *testing.T) {
		if !reflect.DeepEqual(g.PageTagIDs(), g.PublicHiddenTagIDs(0)) {
			t.Error("PageTagIDs diverged from PublicHiddenTagIDs(0)")
		}
	})
}

func TestTagGraph_WithRelatedAndBreadcrumbIDs(t *testing.T) {
	tags := []models.Tag{
		{ID: 1, Name: "related", Slug: "related", ShowRelated: true},
		{ID: 2, Name: "crumb", Slug: "crumb", InBreadcrumbs: true},
		{ID: 3, Name: "plain", Slug: "plain"},
	}
	g := graphOf(tags, nil)

	if got := g.WithRelatedIDs(); !reflect.DeepEqual(got, map[int64]bool{1: true}) {
		t.Errorf("WithRelatedIDs() = %v", got)
	}
	if got := g.InBreadcrumbsIDs(); !reflect.DeepEqual(got, map[int64]bool{2: true}) {
		t.Errorf("InBreadcrumbsIDs() = %v", got)
	}
}

func TestTagGraph_GetDisplayPath(t *testing.T) {
	tests := []struct {
		name     string
		children map[int64][]int64
		id       int64
		want     string
	}{
		{
			name:     "no parents yields empty path",
			children: map[int64][]int64{},
			id:       3,
			want:     "",
		},
		{
			name:     "chain is rendered root first",
			children: map[int64][]int64{1: {2}, 2: {3}},
			id:       3,
			want:     "root › mid",
		},
		{
			name:     "single parent yields one segment",
			children: map[int64][]int64{1: {3}},
			id:       3,
			want:     "root",
		},
	}

	names := map[int64]string{1: "root", 2: "mid", 3: "leaf"}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			tags := make([]models.Tag, 0, len(names))
			for id, n := range names {
				tags = append(tags, models.Tag{ID: id, Name: n, Slug: n})
			}
			g := graphOf(tags, tc.children)
			if got := g.GetDisplayPath(tc.id); got != tc.want {
				t.Errorf("GetDisplayPath(%d) = %q, want %q", tc.id, got, tc.want)
			}
		})
	}

	t.Run("cycle terminates instead of looping", func(t *testing.T) {
		tags := []models.Tag{
			{ID: 1, Name: "a", Slug: "a"},
			{ID: 2, Name: "b", Slug: "b"},
		}
		// 1 -> 2 -> 1: walking up from 2 reaches 1, whose only parent (2) is
		// already visited, so the walk stops rather than spinning.
		g := graphOf(tags, map[int64][]int64{1: {2}, 2: {1}})
		if got := g.GetDisplayPath(2); got != "a" {
			t.Errorf("GetDisplayPath on a cycle = %q, want %q", got, "a")
		}
	})

	t.Run("multi-parent follows the first unvisited parent", func(t *testing.T) {
		tags := []models.Tag{
			{ID: 1, Name: "first", Slug: "first"},
			{ID: 2, Name: "second", Slug: "second"},
			{ID: 3, Name: "leaf", Slug: "leaf"},
		}
		g := graphOf(tags, nil)
		g.Parents[3] = []int64{1, 2}
		if got := g.GetDisplayPath(3); got != "first" {
			t.Errorf("GetDisplayPath = %q, want %q", got, "first")
		}
	})
}

func TestTagGraph_GetSiblings(t *testing.T) {
	tags := []models.Tag{
		{ID: 1, Name: "parentA", Slug: "parent-a"},
		{ID: 2, Name: "parentB", Slug: "parent-b"},
		{ID: 3, Name: "self", Slug: "self"},
		{ID: 4, Name: "zed", Slug: "zed"},
		{ID: 5, Name: "alpha", Slug: "alpha"},
	}
	// 3 sits under both parents; 4 shares parentA, 5 shares parentB, and 4 is
	// also under parentB so the dedup through siblingMap is exercised.
	g := graphOf(tags, map[int64][]int64{1: {3, 4}, 2: {3, 4, 5}})

	got := g.GetSiblings(3)
	want := []string{"alpha", "zed"}
	if len(got) != len(want) {
		t.Fatalf("GetSiblings returned %d tags, want %d: %+v", len(got), len(want), got)
	}
	for i, n := range want {
		if got[i].Name != n {
			t.Errorf("GetSiblings[%d] = %q, want %q (result must be name-sorted)", i, got[i].Name, n)
		}
	}

	if s := g.GetSiblings(1); s != nil {
		t.Errorf("GetSiblings on a root tag = %+v, want nil", s)
	}
}

func TestTagGraph_GetDescendantIDs(t *testing.T) {
	tags := []models.Tag{
		{ID: 1, Slug: "root"}, {ID: 2, Slug: "a"}, {ID: 3, Slug: "b"},
		{ID: 4, Slug: "shared"}, {ID: 5, Slug: "deep"},
	}
	// Diamond: 1 -> {2,3}, both -> 4, 4 -> 5. 4 must appear once.
	g := graphOf(tags, map[int64][]int64{1: {2, 3}, 2: {4}, 3: {4}, 4: {5}})

	got := g.GetDescendantIDs(1)
	if !reflect.DeepEqual(got, []int64{2, 3, 4, 5}) {
		t.Errorf("GetDescendantIDs(1) = %v, want breadth-first [2 3 4 5] with no repeats", got)
	}
	if got := g.GetDescendantIDs(5); len(got) != 0 {
		t.Errorf("GetDescendantIDs(leaf) = %v, want empty", got)
	}
	if got := g.GetDescendantIDs(404); len(got) != 0 {
		t.Errorf("GetDescendantIDs(unknown) = %v, want empty", got)
	}
}

// navFixture is the shared shape for the two nav-tree builders: a child list
// ordered so that insertion sort has to compare every combination of set and
// unset nav_order.
//
//	root2 (nav 2) -> [D(nav 1), A(-), B(-), C(nav 1)]
//	root1 (nav 1) -> [E(-)]
//
// Note that a nav tree's roots are *every* tag carrying nav_order, not just the
// parentless ones — so C and D surface both as children of root2 and as roots
// in their own right. The top level is therefore [C D root1 root2]: the three
// nav_order=1 tags by name, then nav_order=2.
func navFixture() *TagGraph {
	tags := []models.Tag{
		navTag(1, "root1", 1),
		navTag(2, "root2", 2),
		navTag(10, "D", 1),
		navTag(11, "A", -1),
		navTag(12, "B", -1),
		navTag(13, "C", 1),
		navTag(20, "E", -1),
	}
	g := graphOf(tags, map[int64][]int64{
		2: {10, 11, 12, 13},
		1: {20},
	})
	// Every leaf carries a post so the default visibility threshold is met.
	for _, id := range []int64{10, 11, 12, 13, 20} {
		g.CountsPublic[id] = 1
	}
	return g
}

func nodeNames(nodes []NavTagNode) []string {
	out := make([]string, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, n.Name)
	}
	return out
}

// findNode returns the named top-level node, failing the test if it is absent.
func findNode(t *testing.T, nodes []NavTagNode, name string) NavTagNode {
	t.Helper()
	for _, n := range nodes {
		if n.Name == name {
			return n
		}
	}
	t.Fatalf("node %q missing from %v", name, nodeNames(nodes))
	return NavTagNode{}
}

func TestTagGraph_BuildNavTree(t *testing.T) {
	t.Run("orders roots and children by nav_order then name", func(t *testing.T) {
		g := navFixture()
		got := g.buildNavTree(0)

		if names := nodeNames(got); !reflect.DeepEqual(names, []string{"C", "D", "root1", "root2"}) {
			t.Fatalf("nav roots = %v, want [C D root1 root2]", names)
		}
		// Within root2: nav_order 1 tags first (C before D on the name
		// tiebreak), then the unordered ones by name.
		if names := nodeNames(findNode(t, got, "root2").Children); !reflect.DeepEqual(names, []string{"C", "D", "A", "B"}) {
			t.Errorf("root2 children = %v, want [C D A B]", names)
		}
	})

	t.Run("skips hidden, dangling and already-visited children", func(t *testing.T) {
		g := navFixture()
		g.EffectiveHidden[11] = true              // A is hidden
		g.Children[2] = append(g.Children[2], 99) // 99 is not in ByID
		g.Children[13] = []int64{2}               // C points back at its own root

		root2 := findNode(t, g.buildNavTree(0), "root2")
		if names := nodeNames(root2.Children); !reflect.DeepEqual(names, []string{"C", "D", "B"}) {
			t.Fatalf("root2 children = %v, want hidden A and dangling 99 dropped", names)
		}
		if c := findNode(t, root2.Children, "C"); len(c.Children) != 0 {
			t.Errorf("C recursed back into its visited ancestor: %+v", c.Children)
		}
	})

	t.Run("hidden nav roots are dropped", func(t *testing.T) {
		g := navFixture()
		g.EffectiveHidden[1] = true
		if names := nodeNames(g.buildNavTree(0)); !reflect.DeepEqual(names, []string{"C", "D", "root2"}) {
			t.Errorf("nav roots = %v, want root1 dropped", names)
		}
	})

	t.Run("a childless empty root is still visible via nav_order", func(t *testing.T) {
		g := navFixture()
		g.CountsPublic = map[int64]int64{}
		g.Children = map[int64][]int64{}
		if names := nodeNames(g.buildNavTree(0)); !reflect.DeepEqual(names, []string{"C", "D", "root1", "root2"}) {
			t.Errorf("nav roots = %v, want all kept because nav_order is set", names)
		}
	})

	t.Run("minPosts raises the threshold for children without nav_order", func(t *testing.T) {
		g := navFixture()
		g.CountsPublic[11] = 1 // A: one post
		g.CountsPublic[12] = 5 // B: five posts

		root2 := findNode(t, g.buildNavTree(3), "root2")
		if names := nodeNames(root2.Children); !reflect.DeepEqual(names, []string{"C", "D", "B"}) {
			t.Errorf("root2 children at minPosts=3 = %v, want A (1 post) dropped", names)
		}
	})

	t.Run("a related child is visible with no posts and lifts its parent", func(t *testing.T) {
		tags := []models.Tag{
			navTag(1, "root", 1),
			{ID: 2, Name: "plain", Slug: "plain"},
			{ID: 3, Name: "related", Slug: "related", ShowRelated: true, InAncestorFlyout: true},
		}
		g := graphOf(tags, map[int64][]int64{1: {2}, 2: {3}})

		got := g.buildNavTree(0)
		if len(got) != 1 || len(got[0].Children) != 1 {
			t.Fatalf("nav tree = %+v, want root -> plain", got)
		}
		plain := got[0].Children[0]
		if plain.Name != "plain" {
			t.Fatalf("expected the postless parent to be lifted by its child, got %q", plain.Name)
		}
		if len(plain.Children) != 1 || !plain.Children[0].IsRelated || !plain.Children[0].ShowInAncestors {
			t.Errorf("related child not carried through: %+v", plain.Children)
		}
	})
}
