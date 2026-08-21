//go:build !unit

package pageview

import (
	"context"
	"errors"
	"reflect"
	"sort"
	"testing"
	"time"

	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/services"
)

// These are the rules a reader's experience of the site is actually made of:
// what a draft, a hidden tag, a hides_posts subtree and a scheduled post do to
// a feed. They used to be reachable only through an HTTP handler, which is why
// they went largely untested; here they are exercised against the builder and a
// real database, one rule per test.

type harness struct {
	builder  *Builder
	repo     repository.Repository
	posts    *services.PostService
	tags     *services.TagService
	settings *services.SettingsService
	userID   int64
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatalf("open test repository: %v", err)
	}
	t.Cleanup(func() { _ = repo.Close() })

	settings := services.NewSettingsService(repo)
	tags := services.NewTagService(repo)
	posts := services.NewPostService(repo, nil, nil, nil, "")
	media := services.NewMediaService(repo, &config.Config{StoragePath: t.TempDir()}, settings, tags)

	if _, err := repo.DB().Exec(`INSERT INTO users (id,username,email,password_hash,display_name) VALUES (1,'u','u@t.com','h','U')`); err != nil {
		t.Fatalf("insert user: %v", err)
	}

	return &harness{
		builder:  New(repo, posts, tags, media),
		repo:     repo,
		posts:    posts,
		tags:     tags,
		settings: settings,
		userID:   1,
	}
}

func (h *harness) set(t *testing.T, key, value string) {
	t.Helper()
	if err := h.settings.SetSetting(context.Background(), key, value, "string"); err != nil {
		t.Fatalf("SetSetting(%s): %v", key, err)
	}
}

func (h *harness) settingsMap(t *testing.T) map[string]string {
	t.Helper()
	all, err := h.settings.GetAllSettings(context.Background())
	if err != nil {
		t.Fatalf("GetAllSettings: %v", err)
	}
	return all
}

func (h *harness) tag(t *testing.T, p services.CreateTagParams) models.Tag {
	t.Helper()
	tag, err := h.tags.CreateTag(context.Background(), p)
	if err != nil {
		t.Fatalf("CreateTag(%s): %v", p.Name, err)
	}
	return tag
}

func (h *harness) post(t *testing.T, p services.CreatePostParams) models.Post {
	t.Helper()
	p.AuthorID = h.userID
	post, _, err := h.posts.CreatePost(context.Background(), p)
	if err != nil {
		t.Fatalf("CreatePost(%s): %v", p.Title, err)
	}
	return post
}

// titles is what a view actually offered the reader, in order.
func titles(entries []PostEntry) []string {
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		out = append(out, e.Post.Title)
	}
	return out
}

// requireTitles asserts which posts a view offered, ignoring their order: the
// feed is ordered by published_at, and a fixture built in one go can land two
// posts in the same second. What each of these tests is about is which posts
// survived the visibility filter, not which came first.
func requireTitles(t *testing.T, got []PostEntry, want ...string) {
	t.Helper()
	have := append([]string(nil), titles(got)...)
	sort.Strings(have)
	sorted := append([]string(nil), want...)
	sort.Strings(sorted)
	if !reflect.DeepEqual(have, sorted) {
		t.Fatalf("posts = %v, want %v (any order)", titles(got), want)
	}
}

func TestHomeView_DraftsAreInvisibleToEveryone(t *testing.T) {
	h := newHarness(t)
	h.post(t, services.CreatePostParams{Title: "Live", Status: "published"})
	h.post(t, services.CreatePostParams{Title: "Unfinished", Status: "draft"})

	settings := h.settingsMap(t)
	for _, publicOnly := range []bool{true, false} {
		view, err := h.builder.BuildHomeView(context.Background(), settings, FeedParams{
			PublicOnly: publicOnly, Page: 1, PerPage: 10,
		})
		if err != nil {
			t.Fatalf("BuildHomeView(publicOnly=%v): %v", publicOnly, err)
		}
		// A draft is not a hidden post — it is an unfinished one, and the feed
		// is not where the owner goes to find it.
		requireTitles(t, view.Posts, "Live")
	}
}

func TestHomeView_HidesPostsSubtreeIsPublicOnly(t *testing.T) {
	h := newHarness(t)
	vault := h.tag(t, services.CreateTagParams{Name: "Vault", Slug: "vault", HidesPosts: true})
	// A child of the vault hides its posts too: hides_posts is inherited.
	h.tag(t, services.CreateTagParams{Name: "Ledger", Slug: "ledger", ParentIDs: []int64{vault.ID}})

	h.post(t, services.CreatePostParams{Title: "Public", Status: "published"})
	h.post(t, services.CreatePostParams{Title: "Vaulted", Status: "published", Tags: []string{"Vault"}})
	h.post(t, services.CreatePostParams{Title: "Ledgered", Status: "published", Tags: []string{"Ledger"}})

	settings := h.settingsMap(t)
	ctx := context.Background()

	public, err := h.builder.BuildHomeView(ctx, settings, FeedParams{PublicOnly: true, Page: 1, PerPage: 10})
	if err != nil {
		t.Fatalf("public: %v", err)
	}
	requireTitles(t, public.Posts, "Public")

	owner, err := h.builder.BuildHomeView(ctx, settings, FeedParams{Page: 1, PerPage: 10})
	if err != nil {
		t.Fatalf("owner: %v", err)
	}
	requireTitles(t, owner.Posts, "Ledgered", "Vaulted", "Public")
	if !owner.Visibility.EffectiveHiddenPosts[vault.ID] {
		t.Error("the owner's view must know which tags hide posts, so it can mark them")
	}
}

func TestHomeView_ScheduledQueueOpensLeftOfPageOne(t *testing.T) {
	h := newHarness(t)
	h.set(t, "posts_per_page", "2")
	h.post(t, services.CreatePostParams{Title: "Live 1", Status: "published"})
	h.post(t, services.CreatePostParams{Title: "Live 2", Status: "published"})

	// Three queued at 2 per page fills two future pages: 0 and -1.
	base := time.Now().Add(24 * time.Hour)
	for i, title := range []string{"Soon 1", "Soon 2", "Soon 3"} {
		at := base.Add(time.Duration(i) * time.Hour)
		h.post(t, services.CreatePostParams{Title: title, Status: "scheduled", ScheduledAt: &at})
	}

	settings := h.settingsMap(t)
	ctx := context.Background()

	t.Run("the public never sees the queue", func(t *testing.T) {
		view, err := h.builder.BuildHomeView(ctx, settings, FeedParams{
			PublicOnly: true, Page: 1, PerPage: 2, RawPage: 0, RawPageOK: true,
		})
		if err != nil {
			t.Fatalf("BuildHomeView: %v", err)
		}
		if view.Pagination.MinPage != 1 || view.Pagination.Scheduled {
			t.Fatalf("public pagination = %+v, want the feed to start at page 1", view.Pagination)
		}
		requireTitles(t, view.Posts, "Live 2", "Live 1")
	})

	t.Run("the owner's feed extends left", func(t *testing.T) {
		view, err := h.builder.BuildHomeView(ctx, settings, FeedParams{Page: 1, PerPage: 2})
		if err != nil {
			t.Fatalf("BuildHomeView: %v", err)
		}
		if view.Pagination.MinPage != -1 {
			t.Errorf("min_page = %d, want -1 (three queued at 2 per page)", view.Pagination.MinPage)
		}
		if view.Pagination.Scheduled {
			t.Error("page 1 is the published half, not the queue")
		}
	})

	t.Run("page 0 serves the queue while the paginator still describes the feed", func(t *testing.T) {
		view, err := h.builder.BuildHomeView(ctx, settings, FeedParams{
			Page: 1, PerPage: 2, RawPage: 0, RawPageOK: true,
		})
		if err != nil {
			t.Fatalf("BuildHomeView: %v", err)
		}
		if !view.Pagination.Scheduled || view.Pagination.Page != 0 {
			t.Fatalf("pagination = %+v, want page 0 of the queue", view.Pagination)
		}
		// Total counts the published half: swiping right has to land on page 1
		// knowing how many pages follow it.
		if view.Pagination.Total != 2 {
			t.Errorf("total = %d, want the 2 published posts", view.Pagination.Total)
		}
		requireTitles(t, view.Posts, "Soon 1", "Soon 2")
	})

	t.Run("a page past the end of the queue clamps to its last", func(t *testing.T) {
		view, err := h.builder.BuildHomeView(ctx, settings, FeedParams{
			Page: 1, PerPage: 2, RawPage: -99, RawPageOK: true,
		})
		if err != nil {
			t.Fatalf("BuildHomeView: %v", err)
		}
		if view.Pagination.Page != -1 {
			t.Errorf("page = %d, want the last queue page (-1)", view.Pagination.Page)
		}
	})
}

func TestHomeView_PinnedPageStandsInForTheFeed(t *testing.T) {
	h := newHarness(t)
	h.post(t, services.CreatePostParams{Title: "Live", Status: "published"})
	h.post(t, services.CreatePostParams{
		Title: "Welcome", Slug: "welcome", Status: "published", Type: "page",
		Content: "Hello.",
	})
	h.set(t, "home_page_post_id", "welcome")
	settings := h.settingsMap(t)
	ctx := context.Background()

	view, err := h.builder.BuildHomeView(ctx, settings, FeedParams{PublicOnly: true, Page: 1, PerPage: 10})
	if err != nil {
		t.Fatalf("BuildHomeView: %v", err)
	}
	if view.CustomPage == nil {
		t.Fatal("page 1 should serve the pinned page")
	}
	if view.CustomPage.Post.Slug != "welcome" || view.CustomPage.ContentHTML == "" {
		t.Errorf("pinned page = %+v", view.CustomPage)
	}
	if len(view.Posts) != 0 {
		t.Error("the pinned page replaces the feed; it does not head it")
	}

	// Past page 1 the reader has navigated away from it and wants the posts.
	page2, err := h.builder.BuildHomeView(ctx, settings, FeedParams{PublicOnly: true, Page: 2, PerPage: 10})
	if err != nil {
		t.Fatalf("BuildHomeView(page 2): %v", err)
	}
	if page2.CustomPage != nil {
		t.Error("page 2 should be the ordinary feed")
	}

	// So has a reader who has scoped the feed to a timeline range.
	scoped, err := h.builder.BuildHomeView(ctx, settings, FeedParams{
		PublicOnly: true, Page: 1, PerPage: 10, YearFrom: 2024, YearTo: 2024,
	})
	if err != nil {
		t.Fatalf("BuildHomeView(scoped): %v", err)
	}
	if scoped.CustomPage != nil {
		t.Error("a filtered feed should not be replaced by the pinned page")
	}
}

func TestHomeView_NavIsSentOnceAndOnlyOnTheFirstUnfilteredPage(t *testing.T) {
	h := newHarness(t)
	h.set(t, "posts_per_page", "1")
	h.tag(t, services.CreateTagParams{Name: "Nature", Slug: "nature"})
	h.post(t, services.CreatePostParams{Title: "One", Status: "published", Tags: []string{"Nature"}})
	h.post(t, services.CreatePostParams{Title: "Two", Status: "published", Tags: []string{"Nature"}})
	settings := h.settingsMap(t)
	ctx := context.Background()

	first, err := h.builder.BuildHomeView(ctx, settings, FeedParams{PublicOnly: true, Page: 1, PerPage: 1})
	if err != nil {
		t.Fatalf("page 1: %v", err)
	}
	if first.Nav == nil || len(first.Nav.TagCloud) == 0 {
		t.Fatal("page 1 should carry the tag cloud and menu")
	}

	second, err := h.builder.BuildHomeView(ctx, settings, FeedParams{PublicOnly: true, Page: 2, PerPage: 1})
	if err != nil {
		t.Fatalf("page 2: %v", err)
	}
	if second.Nav != nil {
		t.Error("later pages should skip the page-independent furniture")
	}
}

func TestTagView_HiddenTagIsNotVisibleToThePublic(t *testing.T) {
	h := newHarness(t)
	h.tag(t, services.CreateTagParams{Name: "Quiet", Slug: "quiet", Hidden: true})
	settings := h.settingsMap(t)
	ctx := context.Background()

	if _, err := h.builder.BuildTagView(ctx, settings, TagParams{
		FeedParams: FeedParams{PublicOnly: true, Page: 1, PerPage: 10},
		Slug:       "quiet",
	}); !errors.Is(err, ErrNotVisible) {
		t.Fatalf("public: err = %v, want ErrNotVisible", err)
	}

	view, err := h.builder.BuildTagView(ctx, settings, TagParams{
		FeedParams: FeedParams{Page: 1, PerPage: 10},
		Slug:       "quiet",
	})
	if err != nil {
		t.Fatalf("owner: %v", err)
	}
	if !view.Visibility.EffectiveHidden[view.Tag.ID] {
		t.Error("the owner's view should mark the tag as hidden")
	}
}

func TestTagView_MinTagPostsThresholdHidesThinTags(t *testing.T) {
	h := newHarness(t)
	h.set(t, "min_tag_posts_to_show", "2")
	h.tag(t, services.CreateTagParams{Name: "Sparse", Slug: "sparse"})
	h.post(t, services.CreatePostParams{Title: "Only", Status: "published", Tags: []string{"Sparse"}})
	settings := h.settingsMap(t)
	ctx := context.Background()

	if _, err := h.builder.BuildTagView(ctx, settings, TagParams{
		FeedParams: FeedParams{PublicOnly: true, Page: 1, PerPage: 10},
		Slug:       "sparse",
	}); !errors.Is(err, ErrNotVisible) {
		t.Fatalf("public: err = %v, want ErrNotVisible", err)
	}
	if _, err := h.builder.BuildTagView(ctx, settings, TagParams{
		FeedParams: FeedParams{Page: 1, PerPage: 10},
		Slug:       "sparse",
	}); err != nil {
		t.Fatalf("owner should still reach it: %v", err)
	}
}

func TestTagView_BreadcrumbsFollowTheNavigatedBranch(t *testing.T) {
	h := newHarness(t)
	country := h.tag(t, services.CreateTagParams{Name: "Country", Slug: "country", InBreadcrumbs: true})
	france := h.tag(t, services.CreateTagParams{
		Name: "France", Slug: "france", InBreadcrumbs: true, ParentIDs: []int64{country.ID},
	})
	botany := h.tag(t, services.CreateTagParams{Name: "Botany", Slug: "botany", InBreadcrumbs: true})
	// Paris is reachable two ways, which is the whole reason `path` exists.
	h.tag(t, services.CreateTagParams{Name: "Paris", Slug: "paris", ParentIDs: []int64{france.ID, botany.ID}})
	h.post(t, services.CreatePostParams{Title: "Trip", Status: "published", Tags: []string{"Paris"}})

	settings := h.settingsMap(t)
	ctx := context.Background()
	crumbSlugs := func(v *TagView) []string {
		out := make([]string, 0, len(v.Breadcrumbs))
		for _, c := range v.Breadcrumbs {
			out = append(out, c.Tag.Slug)
		}
		return out
	}

	geo, err := h.builder.BuildTagView(ctx, settings, TagParams{
		FeedParams: FeedParams{PublicOnly: true, Page: 1, PerPage: 10},
		Slug:       "paris",
		Path:       []string{"country", "france"},
	})
	if err != nil {
		t.Fatalf("geo branch: %v", err)
	}
	if got := crumbSlugs(geo); len(got) != 2 || got[0] != "country" || got[1] != "france" {
		t.Fatalf("breadcrumbs = %v, want the navigated geo branch", got)
	}
	if geo.Breadcrumbs[1].Href != "/tags/france?path=country" {
		t.Errorf("crumb href = %q, want its own truncated path", geo.Breadcrumbs[1].Href)
	}

	// The other branch of the DAG produces a different trail for the same tag.
	bot, err := h.builder.BuildTagView(ctx, settings, TagParams{
		FeedParams: FeedParams{PublicOnly: true, Page: 1, PerPage: 10},
		Slug:       "paris",
		Path:       []string{"botany"},
	})
	if err != nil {
		t.Fatalf("botany branch: %v", err)
	}
	if got := crumbSlugs(bot); len(got) != 1 || got[0] != "botany" {
		t.Fatalf("breadcrumbs = %v, want the navigated botany branch", got)
	}

	// A path that is not a real chain falls back to the computed ancestors
	// rather than showing the reader a trail that does not exist.
	broken, err := h.builder.BuildTagView(ctx, settings, TagParams{
		FeedParams: FeedParams{PublicOnly: true, Page: 1, PerPage: 10},
		Slug:       "paris",
		Path:       []string{"botany", "country"},
	})
	if err != nil {
		t.Fatalf("broken path: %v", err)
	}
	for _, c := range broken.Breadcrumbs {
		if c.Href != "" {
			t.Errorf("a fallback trail should carry no explicit hrefs, got %q", c.Href)
		}
	}
}

func TestGraphView_HiddenTagsAndTheirEdgesAreOmittedForThePublic(t *testing.T) {
	h := newHarness(t)
	h.set(t, "tags_visibility", "all")
	h.set(t, "plugin.tags-graph.enabled", "true")
	h.set(t, "plugin.tags-atlas.enabled", "false")
	h.set(t, "plugin.tags-map.enabled", "false")

	open := h.tag(t, services.CreateTagParams{Name: "Open", Slug: "open"})
	h.tag(t, services.CreateTagParams{Name: "Quiet", Slug: "quiet", Hidden: true, ParentIDs: []int64{open.ID}})
	h.post(t, services.CreatePostParams{Title: "Seen", Status: "published", Tags: []string{"Open"}})
	h.post(t, services.CreatePostParams{Title: "Unseen", Status: "published", Tags: []string{"Quiet"}})

	settings := h.settingsMap(t)
	ctx := context.Background()

	public, err := h.builder.BuildGraphView(ctx, settings, GraphParams{PublicOnly: true, IncludePosts: true})
	if err != nil {
		t.Fatalf("public: %v", err)
	}
	for _, tag := range public.Tags {
		if tag.Slug == "quiet" {
			t.Error("a hidden tag should not be in the public graph")
		}
	}
	if len(public.HierarchyEdges) != 0 {
		t.Error("an edge touching an omitted tag should be dropped with it")
	}
	// A post left connected to nothing visible is an orphan, not a floating node.
	for _, p := range public.Posts {
		if p.Title == "Unseen" {
			t.Error("a post whose only tag is hidden should drop out of the public graph")
		}
	}

	owner, err := h.builder.BuildGraphView(ctx, settings, GraphParams{IncludePosts: true})
	if err != nil {
		t.Fatalf("owner: %v", err)
	}
	var marked bool
	for _, tag := range owner.Tags {
		if tag.Slug == "quiet" {
			marked = tag.IsHidden
		}
	}
	if !marked {
		t.Error("the owner sees the hidden tag, marked as hidden")
	}
	if len(owner.HierarchyEdges) != 1 {
		t.Errorf("owner hierarchy edges = %d, want 1", len(owner.HierarchyEdges))
	}
}

func TestGraphView_ModuleGateIsEnforced(t *testing.T) {
	h := newHarness(t)
	h.set(t, "plugin.tags-graph.enabled", "false")
	h.set(t, "plugin.tags-atlas.enabled", "false")
	h.set(t, "plugin.tags-map.enabled", "false")
	settings := h.settingsMap(t)

	if _, err := h.builder.BuildGraphView(context.Background(), settings, GraphParams{}); !errors.Is(err, ErrNotVisible) {
		t.Fatalf("err = %v, want ErrNotVisible when no viz is enabled", err)
	}
	if _, err := h.builder.BuildMapView(context.Background(), settings, MapParams{}); !errors.Is(err, ErrNotVisible) {
		t.Fatalf("err = %v, want ErrNotVisible when the map plugin is off", err)
	}
}

func TestMapView_MarkersAreTypedAndScopedToTheViewer(t *testing.T) {
	h := newHarness(t)
	h.set(t, "tags_visibility", "all")
	h.set(t, "plugin.tags-map.enabled", "true")
	h.set(t, "plugin.tags-graph.enabled", "false")
	h.set(t, "plugin.tags-atlas.enabled", "false")

	coord := func(v float64) *float64 { return &v }
	countries := h.tag(t, services.CreateTagParams{Name: "Countries", Slug: "countries"})
	france := h.tag(t, services.CreateTagParams{
		Name: "France", Slug: "france", Kind: "geo",
		Latitude: coord(46.6), Longitude: coord(2.2), ParentIDs: []int64{countries.ID},
	})
	h.tag(t, services.CreateTagParams{
		Name: "Quiet Place", Slug: "quiet-place", Kind: "geo", Hidden: true,
		Latitude: coord(1), Longitude: coord(1), ParentIDs: []int64{france.ID},
	})
	h.post(t, services.CreatePostParams{Title: "Trip", Status: "published", Tags: []string{"France"}})
	h.post(t, services.CreatePostParams{Title: "Secret", Status: "published", Tags: []string{"Quiet Place"}})

	settings := h.settingsMap(t)
	ctx := context.Background()

	public, err := h.builder.BuildMapView(ctx, settings, MapParams{PublicOnly: true})
	if err != nil {
		t.Fatalf("public: %v", err)
	}
	slugs := map[string]MapPlace{}
	for _, p := range public.Places {
		slugs[p.Slug] = p
	}
	if _, ok := slugs["quiet-place"]; ok {
		t.Error("a hidden place should not be on the public map")
	}
	fr, ok := slugs["france"]
	if !ok {
		t.Fatal("france should be on the public map")
	}
	if fr.Type != "country" {
		t.Errorf("france type = %q, want country (it hangs off the Countries tag)", fr.Type)
	}

	owner, err := h.builder.BuildMapView(ctx, settings, MapParams{})
	if err != nil {
		t.Fatalf("owner: %v", err)
	}
	var found bool
	for _, p := range owner.Places {
		if p.Slug == "quiet-place" {
			found, _ = true, p
			if !p.IsHidden {
				t.Error("the owner's hidden marker should say so")
			}
		}
	}
	if !found {
		t.Error("the owner should see the hidden place")
	}
}

func TestCloudView_CentreMustBeVisibleToTheViewer(t *testing.T) {
	h := newHarness(t)
	h.set(t, "tags_visibility", "all")
	h.set(t, "plugin.tags-graph.enabled", "true")
	h.set(t, "plugin.tags-atlas.enabled", "false")
	h.set(t, "plugin.tags-map.enabled", "false")

	quiet := h.tag(t, services.CreateTagParams{Name: "Quiet", Slug: "quiet", Hidden: true})
	h.post(t, services.CreatePostParams{Title: "Unseen", Status: "published", Tags: []string{"Quiet"}})
	settings := h.settingsMap(t)
	ctx := context.Background()

	if _, err := h.builder.BuildCloudView(ctx, settings, CloudParams{PublicOnly: true, TagID: quiet.ID}); !errors.Is(err, ErrNotVisible) {
		t.Fatalf("public: err = %v, want ErrNotVisible", err)
	}
	if _, err := h.builder.BuildCloudView(ctx, settings, CloudParams{TagID: quiet.ID}); err != nil {
		t.Fatalf("owner: %v", err)
	}
	if _, err := h.builder.BuildCloudView(ctx, settings, CloudParams{TagID: 9999}); !errors.Is(err, ErrNotVisible) {
		t.Fatalf("unknown tag: err = %v, want ErrNotVisible", err)
	}
}

func TestCloudView_OwnerOnlyPostsAreMarkedWithTheirStatus(t *testing.T) {
	h := newHarness(t)
	h.set(t, "tags_visibility", "all")
	h.set(t, "plugin.tags-graph.enabled", "true")
	h.set(t, "plugin.tags-atlas.enabled", "false")
	h.set(t, "plugin.tags-map.enabled", "false")

	place := h.tag(t, services.CreateTagParams{Name: "Place", Slug: "place", Kind: "geo"})
	h.post(t, services.CreatePostParams{Title: "Live", Status: "published", Tags: []string{"Place"}})
	soon := time.Now().Add(24 * time.Hour)
	h.post(t, services.CreatePostParams{Title: "Soon", Status: "scheduled", Tags: []string{"Place"}, ScheduledAt: &soon})

	settings := h.settingsMap(t)
	ctx := context.Background()

	owner, err := h.builder.BuildCloudView(ctx, settings, CloudParams{TagID: place.ID})
	if err != nil {
		t.Fatalf("owner: %v", err)
	}
	statuses := map[string]string{}
	for _, p := range owner.Posts {
		statuses[p.Title] = p.Status
	}
	if statuses["Soon"] != "scheduled" {
		t.Errorf("a scheduled chip should carry its status, got %q", statuses["Soon"])
	}
	// A published post is not marked: the marking is there to explain the ones
	// that vanish when revelio goes off.
	if statuses["Live"] != "" {
		t.Errorf("a published chip should carry no status, got %q", statuses["Live"])
	}

	public, err := h.builder.BuildCloudView(ctx, settings, CloudParams{PublicOnly: true, TagID: place.ID})
	if err != nil {
		t.Fatalf("public: %v", err)
	}
	for _, p := range public.Posts {
		if p.Title == "Soon" {
			t.Error("a guest is never sent a scheduled post in the first place")
		}
	}
}

func TestDirectoryView_ExcludesHiddenTagsAndSortsByName(t *testing.T) {
	h := newHarness(t)
	h.tag(t, services.CreateTagParams{Name: "Zebra", Slug: "zebra"})
	h.tag(t, services.CreateTagParams{Name: "Apple", Slug: "apple"})
	h.tag(t, services.CreateTagParams{Name: "Quiet", Slug: "quiet", Hidden: true})
	settings := h.settingsMap(t)
	ctx := context.Background()

	public, err := h.builder.BuildDirectoryView(ctx, settings, DirectoryParams{PublicOnly: true})
	if err != nil {
		t.Fatalf("public: %v", err)
	}
	var names []string
	for _, entry := range public.Tags {
		names = append(names, entry.Tag.Name)
	}
	if len(names) != 2 || names[0] != "Apple" || names[1] != "Zebra" {
		t.Fatalf("directory = %v, want [Apple Zebra]", names)
	}

	owner, err := h.builder.BuildDirectoryView(ctx, settings, DirectoryParams{})
	if err != nil {
		t.Fatalf("owner: %v", err)
	}
	if len(owner.Tags) != 3 {
		t.Errorf("owner directory has %d tags, want 3", len(owner.Tags))
	}
}

func TestExpandPostTagsWithAncestors(t *testing.T) {
	h := newHarness(t)
	nature := h.tag(t, services.CreateTagParams{Name: "Nature", Slug: "nature"})
	botany := h.tag(t, services.CreateTagParams{Name: "Botany", Slug: "botany", ParentIDs: []int64{nature.ID}})
	h.tag(t, services.CreateTagParams{Name: "Quiet", Slug: "quiet", Hidden: true, ParentIDs: []int64{nature.ID}})
	ctx := context.Background()

	in := map[int64][]repository.PostTagInfo{
		1: {{ID: botany.ID, Name: "Botany", Slug: "botany"}, {ID: nature.ID, Name: "Nature", Slug: "nature"}},
	}
	got := h.builder.ExpandPostTagsWithAncestors(ctx, in, true)

	// A post tagged with both a tag and its parent carries both as its own: the
	// parent must not be demoted to "inherited" by the ancestor walk.
	var sawOwnNature bool
	for _, tag := range got[1] {
		if tag.Slug == "nature" && !tag.Inherited {
			sawOwnNature = true
		}
		if tag.Slug == "quiet" {
			t.Error("a hidden tag should never be added to a public post's tag strip")
		}
	}
	if !sawOwnNature {
		t.Error("nature was tagged directly and must stay a direct tag")
	}
}
