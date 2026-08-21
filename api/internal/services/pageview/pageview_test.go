package pageview

import (
	"database/sql"
	"reflect"
	"testing"

	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/services"
)

func TestResolveScheduledPage(t *testing.T) {
	t.Run("empty queue keeps the feed starting at page 1", func(t *testing.T) {
		page, minPage := resolveScheduledPage(FeedParams{Page: 1, PerPage: 10}, 0)
		if page != 1 || minPage != 1 {
			t.Fatalf("page=%d minPage=%d, want 1/1", page, minPage)
		}
	})

	t.Run("a queue extends the feed left by one page per per_page posts", func(t *testing.T) {
		// 25 queued at 10 per page needs three pages: 0, -1 and -2.
		_, minPage := resolveScheduledPage(FeedParams{Page: 1, PerPage: 10}, 25)
		if minPage != -2 {
			t.Fatalf("minPage=%d, want -2", minPage)
		}
	})

	t.Run("a requested queue page is served", func(t *testing.T) {
		page, minPage := resolveScheduledPage(FeedParams{Page: 1, PerPage: 10, RawPage: -1, RawPageOK: true}, 25)
		if page != -1 || minPage != -2 {
			t.Fatalf("page=%d minPage=%d, want -1/-2", page, minPage)
		}
	})

	t.Run("a page past the end of the queue clamps to its last", func(t *testing.T) {
		page, _ := resolveScheduledPage(FeedParams{Page: 1, PerPage: 10, RawPage: -99, RawPageOK: true}, 25)
		if page != -2 {
			t.Fatalf("page=%d, want -2 (clamped)", page)
		}
	})

	t.Run("a positive page is left alone", func(t *testing.T) {
		page, _ := resolveScheduledPage(FeedParams{Page: 3, PerPage: 10, RawPage: 3, RawPageOK: true}, 25)
		if page != 3 {
			t.Fatalf("page=%d, want 3", page)
		}
	})

	t.Run("an unparseable page falls back to the clamped one", func(t *testing.T) {
		page, _ := resolveScheduledPage(FeedParams{Page: 1, PerPage: 10}, 25)
		if page != 1 {
			t.Fatalf("page=%d, want 1", page)
		}
	})
}

func TestPageCount(t *testing.T) {
	for _, tc := range []struct {
		total   int64
		perPage int32
		want    int
	}{
		{0, 10, 1}, // an empty feed is still "page 1 of 1"
		{1, 10, 1},
		{10, 10, 1},
		{11, 10, 2},
		{25, 10, 3},
	} {
		if got := pageCount(tc.total, tc.perPage); got != tc.want {
			t.Errorf("pageCount(%d, %d) = %d, want %d", tc.total, tc.perPage, got, tc.want)
		}
	}
}

func TestFeedParamsHasYearFilter(t *testing.T) {
	for _, tc := range []struct {
		name string
		p    FeedParams
		want bool
	}{
		{"a real range", FeedParams{YearFrom: 2020, YearTo: 2024}, true},
		{"a single year", FeedParams{YearFrom: 2024, YearTo: 2024}, true},
		{"no range at all", FeedParams{}, false},
		{"only one end", FeedParams{YearFrom: 2024}, false},
		{"reversed, so widened to everything", FeedParams{YearFrom: 2024, YearTo: 2020}, false},
		{"negative, so widened to everything", FeedParams{YearFrom: -1, YearTo: 2024}, false},
	} {
		if got := tc.p.HasYearFilter(); got != tc.want {
			t.Errorf("%s: HasYearFilter() = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestPublicSettingsShipsOnlyTheAllowlist(t *testing.T) {
	got := PublicSettings(map[string]string{
		"blog_title":      "Fixture",
		"tags_visibility": "all",
		"smtp_password":   "hunter2",
		"admin_email":     "owner@example.com",
	})
	want := map[string]string{"blog_title": "Fixture", "tags_visibility": "all"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("PublicSettings() = %v, want %v", got, want)
	}
}

func TestSettingHelpers(t *testing.T) {
	settings := map[string]string{"present": "v", "empty": ""}
	if got := SettingOr(settings, "present", "fallback"); got != "v" {
		t.Errorf("SettingOr(present) = %q", got)
	}
	// An empty value is not a value: it means "unset" everywhere in this table.
	if got := SettingOr(settings, "empty", "fallback"); got != "fallback" {
		t.Errorf("SettingOr(empty) = %q, want the fallback", got)
	}
	if got := SettingOr(settings, "missing", "fallback"); got != "fallback" {
		t.Errorf("SettingOr(missing) = %q", got)
	}

	if got := MinTagPostsSetting(map[string]string{"min_tag_posts_to_show": "3"}); got != 3 {
		t.Errorf("MinTagPostsSetting = %d, want 3", got)
	}
	if got := MinTagPostsSetting(map[string]string{}); got != 0 {
		t.Errorf("MinTagPostsSetting(unset) = %d, want 0", got)
	}
	if got := MinTagPostsSetting(map[string]string{"min_tag_posts_to_show": "-5"}); got != 0 {
		t.Errorf("MinTagPostsSetting(negative) = %d, want 0", got)
	}

	if got := AtlasPostLimitSetting(map[string]string{}); got != AtlasCloudLimit {
		t.Errorf("AtlasPostLimitSetting(unset) = %d, want %d", got, AtlasCloudLimit)
	}
	if got := AtlasPostLimitSetting(map[string]string{"atlas_post_limit": "500"}); got != 100 {
		t.Errorf("AtlasPostLimitSetting(500) = %d, want the 100 clamp", got)
	}
	if got := AtlasPostLimitSetting(map[string]string{"atlas_post_limit": "junk"}); got != AtlasCloudLimit {
		t.Errorf("AtlasPostLimitSetting(junk) = %d, want the default", got)
	}
}

func TestTagsModuleAccessible(t *testing.T) {
	// The tags-route slot takes a single claimant, and the peers carry their own
	// defaults, so a test that wants the graph active has to say so about all
	// three.
	graphOn := map[string]string{
		"plugin.tags-graph.enabled": "true",
		"plugin.tags-atlas.enabled": "false",
		"plugin.tags-map.enabled":   "false",
	}
	graphOnPublic := map[string]string{"tags_visibility": "all"}
	for k, v := range graphOn {
		graphOnPublic[k] = v
	}
	nothingOn := map[string]string{
		"plugin.tags-graph.enabled": "false",
		"plugin.tags-atlas.enabled": "false",
		"plugin.tags-map.enabled":   "false",
	}

	for _, tc := range []struct {
		name       string
		settings   map[string]string
		want       []string
		publicOnly bool
		accessible bool
	}{
		{"no viz enabled hides it from the owner too", nothingOn, []string{"tags-graph"}, false, false},
		{"the owner sees an enabled viz whatever tags_visibility says", graphOn, []string{"tags-graph"}, false, true},
		{"the public does not, by default", graphOn, []string{"tags-graph"}, true, false},
		{"the public does when tags_visibility is all", graphOnPublic, []string{"tags-graph"}, true, true},
		{"an endpoint that cannot render the active viz declines", graphOn, []string{"tags-map"}, false, false},
		{"an endpoint backing either viz accepts", graphOn, []string{"tags-atlas", "tags-graph"}, false, true},
	} {
		if got := TagsModuleAccessible(tc.settings, tc.want, tc.publicOnly); got != tc.accessible {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.accessible)
		}
	}
}

func TestSplitPathParam(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want []string
	}{
		{"", nil},
		{"country", []string{"country"}},
		{"country/france", []string{"country", "france"}},
		{"/country//france/", []string{"country", "france"}},
		{"  ", nil},
	} {
		got := SplitPathParam(tc.in)
		if len(got) != len(tc.want) {
			t.Errorf("SplitPathParam(%q) = %v, want %v", tc.in, got, tc.want)
			continue
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Errorf("SplitPathParam(%q) = %v, want %v", tc.in, got, tc.want)
				break
			}
		}
	}
}

func TestTagPathHref(t *testing.T) {
	if got := tagPathHref("paris", nil); got != "/tags/paris" {
		t.Errorf("no prefix: %q", got)
	}
	if got := tagPathHref("paris", []string{"country", "france"}); got != "/tags/paris?path=country/france" {
		t.Errorf("with prefix: %q", got)
	}
}

// snapshot builds a tag graph by hand: country → france → paris, with paris also
// reachable under botany, so the DAG has two routes to the same tag.
func snapshot() *services.TagGraph {
	tag := func(id int64, slug string) models.Tag {
		return models.Tag{ID: id, Name: slug, Slug: slug}
	}
	g := &services.TagGraph{
		ByID:   map[int64]models.Tag{1: tag(1, "country"), 2: tag(2, "france"), 3: tag(3, "paris"), 4: tag(4, "botany")},
		BySlug: map[string]models.Tag{},
		Children: map[int64][]int64{
			1: {2},
			2: {3},
			4: {3},
		},
		Parents:             map[int64][]int64{2: {1}, 3: {2, 4}},
		EffectiveHidden:     map[int64]bool{},
		EffectiveHidesPosts: map[int64]bool{},
		CountsPublic:        map[int64]int64{},
		CountsAdmin:         map[int64]int64{},
	}
	for _, t := range g.ByID {
		g.BySlug[t.Slug] = t
	}
	return g
}

func TestResolveBreadcrumbPath(t *testing.T) {
	g := snapshot()
	paris := g.ByID[3]

	t.Run("a real chain ending at a parent is honoured", func(t *testing.T) {
		got, ok := resolveBreadcrumbPath(g, []string{"country", "france"}, paris)
		if !ok || len(got) != 2 || got[0].Slug != "country" || got[1].Slug != "france" {
			t.Fatalf("got %v ok=%v", got, ok)
		}
	})
	t.Run("the other branch of the DAG is honoured too", func(t *testing.T) {
		got, ok := resolveBreadcrumbPath(g, []string{"botany"}, paris)
		if !ok || len(got) != 1 || got[0].Slug != "botany" {
			t.Fatalf("got %v ok=%v", got, ok)
		}
	})
	t.Run("a broken link in the chain is rejected", func(t *testing.T) {
		if _, ok := resolveBreadcrumbPath(g, []string{"country", "botany"}, paris); ok {
			t.Error("country → botany is not an edge; should not resolve")
		}
	})
	t.Run("a chain not ending at a parent is rejected", func(t *testing.T) {
		if _, ok := resolveBreadcrumbPath(g, []string{"country"}, paris); ok {
			t.Error("country is a grandparent, not a parent; should not resolve")
		}
	})
	t.Run("an unknown slug is rejected", func(t *testing.T) {
		if _, ok := resolveBreadcrumbPath(g, []string{"atlantis"}, paris); ok {
			t.Error("unknown slug should not resolve")
		}
	})
	t.Run("no path and no snapshot fall back", func(t *testing.T) {
		if _, ok := resolveBreadcrumbPath(g, nil, paris); ok {
			t.Error("empty path should not resolve")
		}
		if _, ok := resolveBreadcrumbPath(nil, []string{"country"}, paris); ok {
			t.Error("nil snapshot should not resolve")
		}
	})
}

func TestPostInYearRange(t *testing.T) {
	year := func(slug string) repository.PostTagInfo {
		return repository.PostTagInfo{Kind: "year", Slug: slug}
	}
	place := repository.PostTagInfo{Kind: "geo", Slug: "paris"}

	if !postInYearRange([]repository.PostTagInfo{place, year("2024")}, 2020, 2024) {
		t.Error("a post carrying an in-range year tag is in range")
	}
	if postInYearRange([]repository.PostTagInfo{year("2019")}, 2020, 2024) {
		t.Error("an out-of-range year tag is not in range")
	}
	// A post with no year tag has no place on a timeline, so it is outside
	// every range rather than inside all of them.
	if postInYearRange([]repository.PostTagInfo{place}, 2020, 2024) {
		t.Error("a post with no year tag should be outside every range")
	}
	if postInYearRange([]repository.PostTagInfo{{Kind: "year", Slug: "not-a-year"}}, 2020, 2024) {
		t.Error("an unparseable year tag should not match")
	}
}

func TestVisibilityFrom(t *testing.T) {
	g := snapshot()
	g.EffectiveHidden[3] = true
	g.EffectiveHidesPosts[4] = true

	t.Run("the public gets an exclusion set", func(t *testing.T) {
		v := visibilityFrom(g, 0, true)
		if !v.ExcludeTagIDs[3] {
			t.Error("a hidden tag should be excluded from public responses")
		}
	})
	t.Run("the owner gets none", func(t *testing.T) {
		v := visibilityFrom(g, 0, false)
		if v.ExcludeTagIDs != nil {
			t.Error("the owner is shown everything; the exclusion set should stay nil")
		}
		if !v.EffectiveHidden[3] || !v.EffectiveHiddenPosts[4] {
			t.Error("the owner still needs to know which tags are hidden, to mark them")
		}
	})
	t.Run("a missing snapshot reads as nothing hidden", func(t *testing.T) {
		v := visibilityFrom(nil, 0, true)
		if v.ExcludeTagIDs[3] || v.EffectiveHidden[3] || v.EffectiveHiddenPosts[4] {
			t.Error("nil maps should answer false, not panic or hide everything")
		}
	})
	t.Run("min_tag_posts_to_show excludes thin tags from the public", func(t *testing.T) {
		g.CountsPublic[2] = 1
		v := visibilityFrom(g, 3, true)
		if !v.ExcludeTagIDs[2] {
			t.Error("a tag under the threshold should be excluded")
		}
	})
}

func TestFloatPtr(t *testing.T) {
	if floatPtr(sql.NullFloat64{}) != nil {
		t.Error("an unset coordinate should be omitted, not zero")
	}
	if got := floatPtr(sql.NullFloat64{Float64: 48.85, Valid: true}); got == nil || *got != 48.85 {
		t.Errorf("floatPtr = %v, want 48.85", got)
	}
}

func TestAtlasThumbURL(t *testing.T) {
	// The server cannot resize media it does not host.
	if got := atlasThumbURL("https://cdn.example.com/a.jpg", "7"); got != "https://cdn.example.com/a.jpg" {
		t.Errorf("external URL rewritten: %q", got)
	}
	if got := atlasThumbURL("/photo.jpg", "7"); got != "/photo.jpg?s=256&v=7" {
		t.Errorf("local path = %q, want the atlas variant", got)
	}
	// A stored path carrying the legacy `?thumb` still lands on the ladder.
	if got := atlasThumbURL("/photo.jpg?thumb", "7"); got != "/photo.jpg?s=256&v=7" {
		t.Errorf("legacy query = %q, want the atlas variant", got)
	}
}

func TestCategoryDescendants(t *testing.T) {
	g := snapshot()
	// Rename tag 1 so it reads as the site's "country" category tag.
	g.ByID[1] = models.Tag{ID: 1, Name: "Countries", Slug: "country"}

	countries, cities := categoryDescendants(g)
	if !countries[2] {
		t.Error("france is a direct child of the countries category")
	}
	if !countries[3] {
		t.Error("paris is a descendant of the countries category")
	}
	if countries[1] {
		t.Error("the category tag itself is not one of its own descendants")
	}
	if len(cities) != 0 {
		t.Errorf("no city category exists in this graph; got %v", cities)
	}
}
