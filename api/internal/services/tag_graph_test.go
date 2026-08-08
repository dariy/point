package services

// Unit tests for the TagService methods that read the graph and nothing else.
//
// They swap the service's cache for one whose build function returns a literal
// graph, so a test states the exact hierarchy it is about instead of building
// one through the repository — and the "cold cache failed to build" branch
// every one of these methods carries becomes a one-line stub rather than a
// dropped table. Methods that also touch the repository live in
// tag_domain_coverage_integration_test.go.

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"point-api/internal/models"
)

var errGraphBuild = errors.New("graph build failed")

// graphService returns a TagService whose cache always yields g. The nil
// repository is deliberate: any method under test here that reaches for it is
// in the wrong file.
func graphService(g *TagGraph) *TagService {
	s := NewTagService(nil)
	s.cache = newTagGraphCache(func(context.Context) (*TagGraph, error) { return g, nil })
	return s
}

// brokenGraphService returns a TagService whose graph never builds.
func brokenGraphService() *TagService {
	s := NewTagService(nil)
	s.cache = newTagGraphCache(func(context.Context) (*TagGraph, error) { return nil, errGraphBuild })
	return s
}

func tagNames(tags []models.Tag) []string {
	out := make([]string, 0, len(tags))
	for _, t := range tags {
		out = append(out, t.Name)
	}
	return out
}

// TestTagService_GraphReadsPropagateBuildFailure asserts that every read backed
// by the graph surfaces a failed build rather than quietly serving an empty
// snapshot — the failure mode that would turn a broken database into a site
// with no tags.
func TestTagService_GraphReadsPropagateBuildFailure(t *testing.T) {
	ctx := context.Background()

	tests := map[string]func(*TagService) error{
		"ListTags": func(s *TagService) error {
			_, err := s.ListTags(ctx, true, false)
			return err
		},
		"GetTagBySlug": func(s *TagService) error {
			_, err := s.GetTagBySlug(ctx, "x")
			return err
		},
		"GetTagByID": func(s *TagService) error {
			_, err := s.GetTagByID(ctx, 1)
			return err
		},
		"GetTagDescendants": func(s *TagService) error {
			_, err := s.GetTagDescendants(ctx, 1)
			return err
		},
		"GetTagAncestors": func(s *TagService) error {
			_, err := s.GetTagAncestors(ctx, 1)
			return err
		},
		"ExpandTagsWithAncestors": func(s *TagService) error {
			_, err := s.ExpandTagsWithAncestors(ctx, []int64{1})
			return err
		},
		"GetTagParents": func(s *TagService) error {
			_, err := s.GetTagParents(ctx, 1)
			return err
		},
		"GetTagChildren": func(s *TagService) error {
			_, err := s.GetTagChildren(ctx, 1, false, 0)
			return err
		},
		"GetTagSnapshot": func(s *TagService) error {
			_, err := s.GetTagSnapshot(ctx)
			return err
		},
		"GetHierarchicalNavTags": func(s *TagService) error {
			_, err := s.GetHierarchicalNavTags(ctx, nil, false, 0)
			return err
		},
		"MoveTag": func(s *TagService) error {
			return s.MoveTag(ctx, MoveTagParams{ID: 1, ParentID: 2})
		},
		"DeleteTag": func(s *TagService) error {
			return s.DeleteTag(ctx, 1)
		},
	}

	for name, call := range tests {
		t.Run(name, func(t *testing.T) {
			if err := call(brokenGraphService()); !errors.Is(err, errGraphBuild) {
				t.Errorf("%s on a failed graph build returned %v, want %v", name, err, errGraphBuild)
			}
		})
	}
}

func TestTagService_ListTags(t *testing.T) {
	tags := []models.Tag{
		{ID: 1, Name: "zeta", Slug: "zeta"},
		{ID: 2, Name: "alpha", Slug: "alpha"},
		{ID: 3, Name: "hidden", Slug: "hidden"},
		{ID: 4, Name: "empty", Slug: "empty"},
	}
	g := graphOf(tags, nil)
	g.EffectiveHidden[3] = true
	g.CountsPublic = map[int64]int64{1: 3, 2: 1, 3: 9, 4: 0}
	g.CountsAdmin = map[int64]int64{1: 3, 2: 1, 3: 9, 4: 0}
	s := graphService(g)
	ctx := context.Background()

	t.Run("public omits hidden and, unless includeEmpty, postless tags", func(t *testing.T) {
		got, err := s.ListTags(ctx, false, true)
		if err != nil {
			t.Fatalf("ListTags: %v", err)
		}
		if names := tagNames(got); !reflect.DeepEqual(names, []string{"alpha", "zeta"}) {
			t.Errorf("ListTags(includeEmpty=false, public) = %v, want [alpha zeta]", names)
		}
	})

	t.Run("public with includeEmpty keeps postless but still drops hidden", func(t *testing.T) {
		got, err := s.ListTags(ctx, true, true)
		if err != nil {
			t.Fatalf("ListTags: %v", err)
		}
		if names := tagNames(got); !reflect.DeepEqual(names, []string{"alpha", "empty", "zeta"}) {
			t.Errorf("ListTags(includeEmpty=true, public) = %v, want [alpha empty zeta]", names)
		}
	})

	t.Run("admin keeps hidden and filters on the admin counts", func(t *testing.T) {
		got, err := s.ListTags(ctx, false, false)
		if err != nil {
			t.Fatalf("ListTags: %v", err)
		}
		if names := tagNames(got); !reflect.DeepEqual(names, []string{"alpha", "hidden", "zeta"}) {
			t.Errorf("ListTags(includeEmpty=false, admin) = %v, want [alpha hidden zeta]", names)
		}
	})
}

func TestTagService_GetTagBySlugAndID(t *testing.T) {
	g := graphOf([]models.Tag{{ID: 7, Name: "Travel", Slug: "travel"}}, nil)
	s := graphService(g)
	ctx := context.Background()

	if tag, err := s.GetTagBySlug(ctx, "TRAVEL"); err != nil || tag.ID != 7 {
		t.Errorf("GetTagBySlug is expected to fold case: got (%+v, %v)", tag, err)
	}
	if _, err := s.GetTagBySlug(ctx, "nope"); !errors.Is(err, ErrTagNotFound) {
		t.Errorf("GetTagBySlug(unknown) = %v, want ErrTagNotFound", err)
	}
	if tag, err := s.GetTagByID(ctx, 7); err != nil || tag.Slug != "travel" {
		t.Errorf("GetTagByID = (%+v, %v)", tag, err)
	}
	if _, err := s.GetTagByID(ctx, 404); !errors.Is(err, ErrTagNotFound) {
		t.Errorf("GetTagByID(unknown) = %v, want ErrTagNotFound", err)
	}
}

// walkFixture is a diamond with a deeper tail, so the breadth-first walks have
// both a re-convergence to dedupe and more than one level to descend:
//
//	1 -> {2, 3}; 2 -> 4; 3 -> 4; 4 -> 5
func walkFixture() *TagGraph {
	tags := []models.Tag{
		{ID: 1, Name: "root", Slug: "root"},
		{ID: 2, Name: "beta", Slug: "beta"},
		{ID: 3, Name: "alpha", Slug: "alpha"},
		{ID: 4, Name: "shared", Slug: "shared"},
		{ID: 5, Name: "leaf", Slug: "leaf"},
	}
	return graphOf(tags, map[int64][]int64{1: {2, 3}, 2: {4}, 3: {4}, 4: {5}})
}

func TestTagService_GetTagDescendants_Walk(t *testing.T) {
	s := graphService(walkFixture())
	ctx := context.Background()

	got, err := s.GetTagDescendants(ctx, 1)
	if err != nil {
		t.Fatalf("GetTagDescendants: %v", err)
	}
	if names := tagNames(got); !reflect.DeepEqual(names, []string{"beta", "alpha", "shared", "leaf"}) {
		t.Errorf("GetTagDescendants(1) = %v, want breadth-first with shared visited once", names)
	}
	if got, err := s.GetTagDescendants(ctx, 5); err != nil || len(got) != 0 {
		t.Errorf("GetTagDescendants(leaf) = (%v, %v), want empty", tagNames(got), err)
	}
}

func TestTagService_GetTagAncestors(t *testing.T) {
	s := graphService(walkFixture())
	ctx := context.Background()

	got, err := s.GetTagAncestors(ctx, 5)
	if err != nil {
		t.Fatalf("GetTagAncestors: %v", err)
	}
	// 5 -> 4 -> {2,3} -> 1, and 1 is reached twice but recorded once.
	if names := tagNames(got); !reflect.DeepEqual(names, []string{"shared", "beta", "alpha", "root"}) {
		t.Errorf("GetTagAncestors(5) = %v, want [shared beta alpha root]", names)
	}
	if got, err := s.GetTagAncestors(ctx, 1); err != nil || len(got) != 0 {
		t.Errorf("GetTagAncestors(root) = (%v, %v), want empty", tagNames(got), err)
	}
}

func TestTagService_ExpandTagsWithAncestors(t *testing.T) {
	s := graphService(walkFixture())
	ctx := context.Background()

	// The duplicate seed must be collapsed before the walk starts, and the
	// result keeps the seeds themselves.
	got, err := s.ExpandTagsWithAncestors(ctx, []int64{5, 5, 3})
	if err != nil {
		t.Fatalf("ExpandTagsWithAncestors: %v", err)
	}
	if !reflect.DeepEqual(got, []int64{5, 3, 4, 1, 2}) {
		t.Errorf("ExpandTagsWithAncestors([5 5 3]) = %v, want [5 3 4 1 2]", got)
	}
	if got, err := s.ExpandTagsWithAncestors(ctx, nil); err != nil || len(got) != 0 {
		t.Errorf("ExpandTagsWithAncestors(nil) = (%v, %v), want empty", got, err)
	}
}

func TestTagService_GetTagParents(t *testing.T) {
	s := graphService(walkFixture())
	ctx := context.Background()

	got, err := s.GetTagParents(ctx, 4)
	if err != nil {
		t.Fatalf("GetTagParents: %v", err)
	}
	if names := tagNames(got); !reflect.DeepEqual(names, []string{"alpha", "beta"}) {
		t.Errorf("GetTagParents(4) = %v, want name-sorted [alpha beta]", names)
	}
	if got, err := s.GetTagParents(ctx, 1); err != nil || len(got) != 0 {
		t.Errorf("GetTagParents(root) = (%v, %v), want empty", tagNames(got), err)
	}
}

func TestTagService_GetTagChildren(t *testing.T) {
	tags := []models.Tag{
		{ID: 1, Name: "root", Slug: "root"},
		{ID: 2, Name: "zeta", Slug: "zeta"},
		{ID: 3, Name: "alpha", Slug: "alpha"},
		{ID: 4, Name: "hidden", Slug: "hidden"},
		{ID: 5, Name: "sparse", Slug: "sparse"},
	}
	g := graphOf(tags, map[int64][]int64{1: {2, 3, 4, 5}})
	g.EffectiveHidden[4] = true
	g.CountsPublic = map[int64]int64{2: 5, 3: 5, 4: 5, 5: 1}
	s := graphService(g)
	ctx := context.Background()

	t.Run("admin sees everything, name-sorted", func(t *testing.T) {
		got, err := s.GetTagChildren(ctx, 1, false, 0)
		if err != nil {
			t.Fatalf("GetTagChildren: %v", err)
		}
		if names := tagNames(got); !reflect.DeepEqual(names, []string{"alpha", "hidden", "sparse", "zeta"}) {
			t.Errorf("GetTagChildren(admin) = %v", names)
		}
	})

	t.Run("public drops hidden children", func(t *testing.T) {
		got, _ := s.GetTagChildren(ctx, 1, true, 0)
		if names := tagNames(got); !reflect.DeepEqual(names, []string{"alpha", "sparse", "zeta"}) {
			t.Errorf("GetTagChildren(public) = %v, want hidden dropped", names)
		}
	})

	t.Run("public with minPosts drops thin children too", func(t *testing.T) {
		got, _ := s.GetTagChildren(ctx, 1, true, 3)
		if names := tagNames(got); !reflect.DeepEqual(names, []string{"alpha", "zeta"}) {
			t.Errorf("GetTagChildren(public, minPosts=3) = %v, want sparse dropped", names)
		}
	})

	t.Run("minPosts is ignored for admin", func(t *testing.T) {
		got, _ := s.GetTagChildren(ctx, 1, false, 99)
		if len(got) != 4 {
			t.Errorf("GetTagChildren(admin, minPosts=99) returned %d, want all 4", len(got))
		}
	})
}

// navSubtreeFixture mirrors navFixture but gives D two children of its own, so
// the recursive sort inside build() has more than one element to order.
func navSubtreeFixture() *TagGraph {
	g := navFixture()
	g.ByID[30] = navTag(30, "d-second", -1)
	g.ByID[31] = navTag(31, "d-first", -1)
	g.Children[10] = []int64{30, 31}
	g.CountsPublic[30] = 1
	g.CountsPublic[31] = 1
	return g
}

func TestTagService_GetHierarchicalNavTags_Scoped(t *testing.T) {
	ctx := context.Background()

	t.Run("the public unfiltered call serves the prebuilt tree", func(t *testing.T) {
		g := navSubtreeFixture()
		g.NavTree = []NavTagNode{{ID: 999, Name: "prebuilt"}}
		got, err := graphService(g).GetHierarchicalNavTags(ctx, nil, true, 0)
		if err != nil {
			t.Fatalf("GetHierarchicalNavTags: %v", err)
		}
		if !reflect.DeepEqual(got, g.NavTree) {
			t.Errorf("GetHierarchicalNavTags(nil, true, 0) = %v, want the cached NavTree", nodeNames(got))
		}
	})

	t.Run("a threshold forces a rebuild rather than reusing the cached tree", func(t *testing.T) {
		g := navSubtreeFixture()
		g.NavTree = []NavTagNode{{ID: 999, Name: "prebuilt"}}
		got, err := graphService(g).GetHierarchicalNavTags(ctx, nil, true, 2)
		if err != nil {
			t.Fatalf("GetHierarchicalNavTags: %v", err)
		}
		if len(got) == 1 && got[0].Name == "prebuilt" {
			t.Fatal("minPosts was ignored: the cached NavTree was served")
		}
		if names := nodeNames(got); !reflect.DeepEqual(names, []string{"C", "D", "root1", "root2"}) {
			t.Errorf("rebuilt roots = %v", names)
		}
	})

	t.Run("admin unfiltered also rebuilds", func(t *testing.T) {
		g := navSubtreeFixture()
		g.NavTree = []NavTagNode{{ID: 999, Name: "prebuilt"}}
		got, _ := graphService(g).GetHierarchicalNavTags(ctx, nil, false, 0)
		if len(got) == 1 && got[0].Name == "prebuilt" {
			t.Fatal("admin call served the public NavTree")
		}
	})

	t.Run("a root scopes the tree to that tag's children", func(t *testing.T) {
		root := int64(2)
		got, err := graphService(navSubtreeFixture()).GetHierarchicalNavTags(ctx, &root, true, 0)
		if err != nil {
			t.Fatalf("GetHierarchicalNavTags: %v", err)
		}
		if names := nodeNames(got); !reflect.DeepEqual(names, []string{"C", "D", "A", "B"}) {
			t.Fatalf("scoped roots = %v, want root2's children in nav order", names)
		}
		if names := nodeNames(findNode(t, got, "D").Children); !reflect.DeepEqual(names, []string{"d-first", "d-second"}) {
			t.Errorf("D's children = %v, want name-sorted", names)
		}
	})

	t.Run("a scoped public tree drops hidden branches at every level", func(t *testing.T) {
		g := navSubtreeFixture()
		g.EffectiveHidden[11] = true // A, a direct child of the root
		g.EffectiveHidden[30] = true // d-second, one level down
		root := int64(2)

		got, _ := graphService(g).GetHierarchicalNavTags(ctx, &root, true, 0)
		if names := nodeNames(got); !reflect.DeepEqual(names, []string{"C", "D", "B"}) {
			t.Errorf("scoped roots = %v, want A dropped", names)
		}
		if names := nodeNames(findNode(t, got, "D").Children); !reflect.DeepEqual(names, []string{"d-first"}) {
			t.Errorf("D's children = %v, want d-second dropped", names)
		}
	})

	t.Run("a scoped admin tree keeps hidden branches", func(t *testing.T) {
		g := navSubtreeFixture()
		g.EffectiveHidden[11] = true
		root := int64(2)

		got, _ := graphService(g).GetHierarchicalNavTags(ctx, &root, false, 0)
		if names := nodeNames(got); !reflect.DeepEqual(names, []string{"C", "D", "A", "B"}) {
			t.Errorf("admin scoped roots = %v, want hidden A kept", names)
		}
	})

	t.Run("a scoped tree stops re-expanding a tag it has already visited", func(t *testing.T) {
		g := navSubtreeFixture()
		g.Children[13] = []int64{2} // C points back at the root being expanded
		root := int64(2)

		got, _ := graphService(g).GetHierarchicalNavTags(ctx, &root, true, 0)
		c := findNode(t, got, "C")
		// The scoped walk seeds visited with the child it starts from, not the
		// root, so root2 is expanded once more underneath C — but C itself is
		// now marked visited and the recursion terminates there.
		if len(c.Children) != 1 || c.Children[0].Name != "root2" {
			t.Fatalf("C's children = %v, want the single root2 node", nodeNames(c.Children))
		}
		if names := nodeNames(c.Children[0].Children); !reflect.DeepEqual(names, []string{"D", "A", "B"}) {
			t.Errorf("re-expanded root2 = %v, want C excluded as already visited", names)
		}
	})

	t.Run("minPosts raises the visibility threshold for scoped children", func(t *testing.T) {
		g := navSubtreeFixture()
		g.CountsPublic[11] = 1 // A: one post, below the threshold
		g.CountsPublic[12] = 5 // B: five posts
		root := int64(2)

		got, _ := graphService(g).GetHierarchicalNavTags(ctx, &root, true, 3)
		if names := nodeNames(got); !reflect.DeepEqual(names, []string{"C", "D", "B"}) {
			t.Errorf("scoped roots at minPosts=3 = %v, want A dropped", names)
		}
	})

	t.Run("distinct nav_order values order scoped siblings", func(t *testing.T) {
		g := navSubtreeFixture()
		g.ByID[13] = navTag(13, "C", 5) // C was tied with D at 1; now it sorts after
		root := int64(2)

		got, _ := graphService(g).GetHierarchicalNavTags(ctx, &root, true, 0)
		if names := nodeNames(got); !reflect.DeepEqual(names, []string{"D", "C", "A", "B"}) {
			t.Errorf("scoped roots = %v, want nav_order 1 before nav_order 5", names)
		}
	})

	t.Run("an unknown root yields an empty tree", func(t *testing.T) {
		root := int64(404)
		got, err := graphService(navSubtreeFixture()).GetHierarchicalNavTags(ctx, &root, true, 0)
		if err != nil || len(got) != 0 {
			t.Errorf("GetHierarchicalNavTags(unknown root) = (%v, %v), want empty", nodeNames(got), err)
		}
	})
}
