package api

// Unit tests for the visibility rules and payload shaping the tag handlers
// share. These run straight off a hand-built TagGraph — no DB, no HTTP — so
// the rules can be pinned one case at a time; the handler tests in
// tags_test.go and tags_threshold_test.go cover them end to end.

import (
	"testing"

	"point-api/internal/models"
	"point-api/internal/services"
)

// viewFixture is a two-level graph: "Europe" with children "Paris" (3 public
// posts) and "Hidden Spot" (effectively hidden, 5 public posts).
func viewFixture() *services.TagGraph {
	europe := models.Tag{ID: 1, Name: "Europe", Slug: "europe"}
	paris := models.Tag{ID: 2, Name: "Paris", Slug: "paris"}
	secret := models.Tag{ID: 3, Name: "Hidden Spot", Slug: "hidden-spot", Hidden: true}

	return &services.TagGraph{
		ByID: map[int64]models.Tag{1: europe, 2: paris, 3: secret},
		BySlug: map[string]models.Tag{
			"europe": europe, "paris": paris, "hidden-spot": secret,
		},
		Children:            map[int64][]int64{1: {2, 3}},
		Parents:             map[int64][]int64{2: {1}, 3: {1}},
		EffectiveHidden:     map[int64]bool{3: true},
		EffectiveHidesPosts: map[int64]bool{},
		HiddenVia:           map[int64]int64{3: 3},
		CountsPublic:        map[int64]int64{1: 8, 2: 3, 3: 5},
		CountsAdmin:         map[int64]int64{1: 11, 2: 4, 3: 7},
	}
}

func TestTagView_HiddenAndCount(t *testing.T) {
	g := viewFixture()

	tests := []struct {
		name       string
		publicOnly bool
		minPosts   int64
		id         int64
		wantHidden bool
		wantCount  int64
	}{
		{"admin sees a hidden tag", false, 0, 3, false, 7},
		{"guest does not see a hidden tag", true, 0, 3, true, 5},
		{"guest sees a normal tag", true, 0, 2, false, 3},
		{"threshold hides a thin tag from guests", true, 4, 2, true, 3},
		{"threshold spares a tag that meets it", true, 3, 2, false, 3},
		{"threshold does not apply to admins", false, 4, 2, false, 4},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			v := tagView{g: g, publicOnly: tc.publicOnly, minPosts: tc.minPosts}
			if got := v.hidden(tc.id); got != tc.wantHidden {
				t.Errorf("hidden(%d) = %v, want %v", tc.id, got, tc.wantHidden)
			}
			if got := v.count(tc.id); got != tc.wantCount {
				t.Errorf("count(%d) = %d, want %d", tc.id, got, tc.wantCount)
			}
		})
	}
}

func TestTagView_Excluded(t *testing.T) {
	g := viewFixture()

	if got := (tagView{g: g}).excluded(); len(got) != 0 {
		t.Errorf("admin exclusion set = %v, want empty", got)
	}

	guest := tagView{g: g, publicOnly: true}.excluded()
	if !guest[3] {
		t.Error("guest exclusion set should contain the hidden tag")
	}
	if guest[2] {
		t.Error("guest exclusion set should not contain a visible tag")
	}

	thin := tagView{g: g, publicOnly: true, minPosts: 4}.excluded()
	if !thin[2] {
		t.Error("tags below the threshold should be excluded for guests")
	}
	if thin[1] {
		t.Error("a tag above the threshold should stay included")
	}
}

func TestTagView_NamePath(t *testing.T) {
	g := viewFixture()

	admin := tagView{g: g}
	if got, want := admin.namePath(g.ByID[1]), "Europe · 11"; got != want {
		t.Errorf("root name_path = %q, want %q", got, want)
	}
	if got, want := admin.namePath(g.ByID[2]), "Paris — Europe · 4"; got != want {
		t.Errorf("child name_path = %q, want %q", got, want)
	}

	guest := tagView{g: g, publicOnly: true}
	if got, want := guest.namePath(g.ByID[2]), "Paris — Europe · 3"; got != want {
		t.Errorf("guest name_path = %q, want %q", got, want)
	}
}

func TestTagView_ListItem(t *testing.T) {
	g := viewFixture()

	admin := tagView{g: g}.listItem(g.ByID[3], nil)
	if admin["hidden_via"] != int64(3) {
		t.Errorf("admin list item hidden_via = %v, want 3", admin["hidden_via"])
	}
	if admin["effective_hidden"] != true {
		t.Error("admin list item should report effective_hidden")
	}
	if locs, ok := admin["locations"].([]map[string]interface{}); !ok || len(locs) != 0 {
		t.Errorf("locations for a tag with none = %v, want []", admin["locations"])
	}

	guest := tagView{g: g, publicOnly: true}.listItem(g.ByID[3], nil)
	if _, ok := guest["hidden_via"]; ok {
		t.Error("hidden_via is an editor affordance and must not leak to guests")
	}

	parent := tagView{g: g}.listItem(g.ByID[1], nil)
	children, ok := parent["children"].([]map[string]interface{})
	if !ok || len(children) != 2 {
		t.Fatalf("children = %v, want 2 stubs", parent["children"])
	}
	if children[0]["slug"] != "paris" {
		t.Errorf("child stub = %v, want the paris stub", children[0])
	}
}

func TestTagView_FullResponse(t *testing.T) {
	g := viewFixture()

	// Siblings of Paris: the hidden tag under the same parent.
	admin := tagView{g: g}.fullResponse(g.ByID[2], nil)
	siblings, ok := admin["siblings"].([]map[string]interface{})
	if !ok || len(siblings) != 1 {
		t.Fatalf("admin siblings = %v, want the hidden sibling", admin["siblings"])
	}

	guest := tagView{g: g, publicOnly: true}.fullResponse(g.ByID[2], nil)
	if s, _ := guest["siblings"].([]map[string]interface{}); len(s) != 0 {
		t.Errorf("guest siblings = %v, want none (the only sibling is hidden)", s)
	}
	if guest["post_count"] != int64(3) {
		t.Errorf("guest post_count = %v, want the public count 3", guest["post_count"])
	}

	// The parent's children list is filtered through the exclusion set.
	parent := tagView{g: g, publicOnly: true}.fullResponse(g.ByID[1], nil)
	children, _ := parent["children"].([]map[string]interface{})
	if len(children) != 1 || children[0]["slug"] != "paris" {
		t.Errorf("guest children = %v, want only paris", children)
	}
}
