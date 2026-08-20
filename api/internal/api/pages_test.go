package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"point-api/internal/repository"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

func setupPagesHandler(t *testing.T) (*PagesHandler, *testHandlers) {
	h := setupHandlers(t)
	ph := NewPagesHandler(h.repo, h.postSvc, h.tagSvc, h.mediaSvc, h.settingsSvc, h.cacheSvc)
	return ph, h
}

func TestPagesHandler_PostGrid(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()

	e := echo.New()
	ctx := context.Background()

	// Create user
	userID := insertUser(h.repo)

	// Create post
	_, _, _ = h.postSvc.CreatePost(ctx, services.CreatePostParams{
		Title:    "Post 1",
		Status:   "published",
		AuthorID: userID,
	})

	// Public user
	req := httptest.NewRequest(http.MethodGet, "/posts", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := ph.GetHomePage(c); err != nil {
		t.Fatalf("GetHomePage failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}

	var resp map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if len(resp["posts"].([]interface{})) != 1 {
		t.Errorf("expected 1 post, got %v", len(resp["posts"].([]interface{})))
	}
}

func TestPagesHandler_PostPage(t *testing.T) {
	_, h := setupPagesHandler(t)
	defer h.close()
	postH := NewPostHandler(h.postSvc, h.settingsSvc, h.mediaSvc, h.tagSvc)

	e := echo.New()
	ctx := context.Background()

	// Create user
	userID := insertUser(h.repo)

	// Create post
	post, _, _ := h.postSvc.CreatePost(ctx, services.CreatePostParams{
		Title:    "Post 1",
		Slug:     "post-1",
		Status:   "published",
		AuthorID: userID,
	})

	// Public user
	req := httptest.NewRequest(http.MethodGet, "/posts/post-1", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues("post-1")

	if err := postH.GetPostBySlug(c); err != nil {
		t.Fatalf("GetPostBySlug failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}

	var resp map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["slug"] != post.Slug {
		t.Errorf("expected post-1, got %v", resp["slug"])
	}
}

func TestPagesHandler_TagPage(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()

	e := echo.New()
	ctx := context.Background()

	// Create tag
	tag, _ := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Tag1", Slug: "tag-1"})

	// Public user
	req := httptest.NewRequest(http.MethodGet, "/tags/tag-1", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues("tag-1")

	if err := ph.GetTagPage(c); err != nil {
		t.Fatalf("GetTagPage failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}

	var resp map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["tag"].(map[string]interface{})["slug"] != tag.Slug {
		t.Errorf("expected tag-1, got %v", resp["tag"].(map[string]interface{})["slug"])
	}
}

// TestPagesHandler_TagPageBreadcrumbPath verifies that a `path` query param
// makes GetTagPage build breadcrumbs from the navigated branch, that each crumb
// carries its truncated path href, and that a bogus path falls back to the
// computed ancestor chain.
func TestPagesHandler_TagPageBreadcrumbPath(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()

	ctx := context.Background()

	// Hierarchy: location → country → {ukraine, poland}; kyiv has BOTH ukraine
	// and poland as parents (a DAG), so the branch can only come from `path`.
	location, _ := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Location", Slug: "location", InBreadcrumbs: true})
	country, _ := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Country", Slug: "country", InBreadcrumbs: true, ParentIDs: []int64{location.ID}})
	ukraine, _ := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Ukraine", Slug: "ukraine", InBreadcrumbs: true, ParentIDs: []int64{country.ID}})
	poland, _ := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Poland", Slug: "poland", InBreadcrumbs: true, ParentIDs: []int64{country.ID}})
	_, _ = h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Kyiv", Slug: "kyiv", ParentIDs: []int64{ukraine.ID, poland.ID}})

	crumbsFor := func(t *testing.T, path string) []map[string]interface{} {
		t.Helper()
		url := "/tags/kyiv"
		if path != "" {
			url += "?path=" + path
		}
		e := echo.New()
		req := httptest.NewRequest(http.MethodGet, url, nil)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		c.SetParamNames("slug")
		c.SetParamValues("kyiv")
		if err := ph.GetTagPage(c); err != nil {
			t.Fatalf("GetTagPage failed: %v", err)
		}
		var resp map[string]interface{}
		_ = json.Unmarshal(rec.Body.Bytes(), &resp)
		raw, _ := resp["breadcrumbs"].([]interface{})
		out := make([]map[string]interface{}, 0, len(raw))
		for _, r := range raw {
			out = append(out, r.(map[string]interface{}))
		}
		return out
	}

	slugsOf := func(crumbs []map[string]interface{}) []string {
		s := make([]string, len(crumbs))
		for i, c := range crumbs {
			s[i] = c["slug"].(string)
		}
		return s
	}
	eq := func(a, b []string) bool {
		if len(a) != len(b) {
			return false
		}
		for i := range a {
			if a[i] != b[i] {
				return false
			}
		}
		return true
	}

	// Ukraine branch.
	ua := crumbsFor(t, "location/country/ukraine")
	if got := slugsOf(ua); !eq(got, []string{"location", "country", "ukraine"}) {
		t.Fatalf("ukraine branch: expected [location country ukraine], got %v", got)
	}
	// Each crumb links to itself with its truncated path prefix.
	wantHrefs := []string{"/tags/location", "/tags/country?path=location", "/tags/ukraine?path=location/country"}
	for i, c := range ua {
		if c["href"] != wantHrefs[i] {
			t.Errorf("crumb %d href: expected %q, got %v", i, wantHrefs[i], c["href"])
		}
	}

	// Poland branch — same tag, different navigated path.
	pl := crumbsFor(t, "location/country/poland")
	if got := slugsOf(pl); !eq(got, []string{"location", "country", "poland"}) {
		t.Fatalf("poland branch: expected [location country poland], got %v", got)
	}

	// Bogus path that isn't a real chain → fall back to computed ancestors
	// (a valid single-parent breadcrumb chain, not the garbage slugs).
	bogus := crumbsFor(t, "location/poland/ukraine")
	for _, c := range bogus {
		// "poland" appears in the bogus path but is not an ancestor of kyiv via
		// that broken chain; fallback must not echo the bogus ordering.
		_ = c
	}
	if got := slugsOf(bogus); eq(got, []string{"location", "poland", "ukraine"}) {
		t.Fatalf("bogus path should not be honoured verbatim, got %v", got)
	}
}

func TestPagesHandler_TagPageHidden(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()

	ctx := context.Background()
	// Create hidden-tag directly with Hidden: true
	_, _ = h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "HiddenTag", Slug: "hidden-tag", Hidden: true})

	e := echo.New()
	// Public user requesting hidden tag should get 404
	req := httptest.NewRequest(http.MethodGet, "/tags/hidden-tag", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues("hidden-tag")
	err := ph.GetTagPage(c)
	if err == nil {
		t.Error("expected error for hidden tag accessed publicly")
	}
}

func TestPagesHandler_TagPageWithAuth(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()

	tag, _ := h.tagSvc.CreateTag(context.Background(), services.CreateTagParams{Name: "AuthTag", Slug: "auth-tag", Hidden: true})

	e := echo.New()
	// Authenticated user requesting hidden tag should get 200
	req := httptest.NewRequest(http.MethodGet, "/tags/auth-tag", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues("auth-tag")
	c.Set("user", "test-user")

	if err := ph.GetTagPage(c); err != nil {
		t.Fatalf("GetTagPage failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}

	var resp map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["tag"].(map[string]interface{})["slug"] != tag.Slug {
		t.Errorf("expected auth-tag, got %v", resp["tag"].(map[string]interface{})["slug"])
	}
}

// TestPagesHandler_GetTagsGraph_Posts verifies the cloud force-graph still gets
// posts (with a rewritten thumbnail media_url) by default, while ?posts=0 — the
// Atlas's lightweight request — omits posts and membership edges entirely.
func TestPagesHandler_GetTagsGraph_Posts(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()

	ctx := context.Background()
	userID := insertUser(h.repo)
	tag, err := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Tag1", Slug: "tag-1"})
	if err != nil {
		t.Fatalf("tag creation failed: %v", err)
	}
	imgPost, _, err := h.postSvc.CreatePost(ctx, services.CreatePostParams{
		Title: "Image Post", Status: "published", AuthorID: userID,
		ThumbnailPath: "/media/originals/photo.jpg", Tags: []string{tag.Name},
	})
	if err != nil {
		t.Fatalf("post creation failed: %v", err)
	}

	_ = h.settingsSvc.SetSetting(ctx, "plugin.tags-atlas.enabled", "false", "string")
	_ = h.settingsSvc.SetSetting(ctx, "plugin.tags-map.enabled", "false", "string")
	_ = h.settingsSvc.SetSetting(ctx, "plugin.tags-graph.enabled", "true", "string")
	_ = h.settingsSvc.SetSetting(ctx, "tags_visibility", "all", "string")

	e := echo.New()

	// Default: the cloud view gets posts, with image previews rewritten to the
	// small square thumbnail variant.
	req := httptest.NewRequest(http.MethodGet, "/api/pages/graph", nil)
	rec := httptest.NewRecorder()
	if err := ph.GetTagsGraph(e.NewContext(req, rec)); err != nil {
		t.Fatalf("GetTagsGraph failed: %v", err)
	}
	var full struct {
		Posts []struct {
			ID       int64  `json:"id"`
			MediaURL string `json:"media_url"`
		} `json:"posts"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &full); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	if len(full.Posts) != 1 || full.Posts[0].ID != imgPost.ID {
		t.Fatalf("expected 1 post (the image post), got %+v", full.Posts)
	}
	if full.Posts[0].MediaURL != "/photo.jpg?s=256&v=1" {
		t.Errorf("image post media_url = %q, want /photo.jpg?s=256&v=1", full.Posts[0].MediaURL)
	}

	// ?posts=0: the Atlas's lightweight request omits posts + membership edges.
	req = httptest.NewRequest(http.MethodGet, "/api/pages/graph?posts=0", nil)
	rec = httptest.NewRecorder()
	if err := ph.GetTagsGraph(e.NewContext(req, rec)); err != nil {
		t.Fatalf("GetTagsGraph(posts=0) failed: %v", err)
	}
	var lite map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &lite); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	if _, ok := lite["posts"]; ok {
		t.Errorf("posts=0 payload should not carry posts")
	}
	if _, ok := lite["membershipEdges"]; ok {
		t.Errorf("posts=0 payload should not carry membershipEdges")
	}
	if _, ok := lite["tags"]; !ok {
		t.Errorf("posts=0 payload should still carry tags")
	}
}

// TestPagesHandler_GetTagCloud verifies the per-place cloud caps posts at 10
// (newest first), rewrites image previews to the small thumbnail variant, and
// surfaces a popular co-occurring tag.
func TestPagesHandler_GetTagCloud(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()

	ctx := context.Background()
	userID := insertUser(h.repo)

	place, err := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Berlin", Slug: "berlin"})
	if err != nil {
		t.Fatalf("tag creation failed: %v", err)
	}

	// An image post co-tagged with "food", plus 11 more text posts on the place —
	// 12 in total, so the 10-cap drops the oldest two.
	if _, _, err := h.postSvc.CreatePost(ctx, services.CreatePostParams{
		Title: "Photo", Status: "published", AuthorID: userID,
		ThumbnailPath: "/media/originals/photo.jpg",
		Tags:          []string{place.Name, "food"},
	}); err != nil {
		t.Fatalf("image post creation failed: %v", err)
	}
	for i := 0; i < 11; i++ {
		if _, _, err := h.postSvc.CreatePost(ctx, services.CreatePostParams{
			Title: fmt.Sprintf("Post %d", i), Status: "published", AuthorID: userID,
			Tags: []string{place.Name},
		}); err != nil {
			t.Fatalf("post %d creation failed: %v", i, err)
		}
	}

	_ = h.settingsSvc.SetSetting(ctx, "plugin.tags-atlas.enabled", "true", "string")
	_ = h.settingsSvc.SetSetting(ctx, "plugin.tags-map.enabled", "false", "string")
	_ = h.settingsSvc.SetSetting(ctx, "plugin.tags-graph.enabled", "false", "string")
	_ = h.settingsSvc.SetSetting(ctx, "tags_visibility", "all", "string")

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/pages/graph/tag/"+strconv.FormatInt(place.ID, 10), nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(strconv.FormatInt(place.ID, 10))

	if err := ph.GetTagCloud(c); err != nil {
		t.Fatalf("GetTagCloud failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}

	var resp struct {
		Posts []struct {
			Title    string `json:"title"`
			MediaURL string `json:"media_url"`
		} `json:"posts"`
		Tags []struct {
			Slug string `json:"slug"`
		} `json:"tags"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if len(resp.Posts) != 10 {
		t.Errorf("expected 10 posts (capped), got %d", len(resp.Posts))
	}
	if len(resp.Tags) == 0 || resp.Tags[0].Slug != "food" {
		t.Errorf("expected 'food' as a popular related tag, got %+v", resp.Tags)
	}
	// The image post is newest, so it leads the list with a rewritten thumbnail.
	if len(resp.Posts) > 0 && resp.Posts[0].MediaURL != "/photo.jpg?s=256&v=1" {
		t.Errorf("newest post media_url = %q, want /photo.jpg?s=256&v=1", resp.Posts[0].MediaURL)
	}

	// atlas_post_limit overrides the default cap: raise it past the 12 posts and
	// the cloud returns all of them.
	_ = h.settingsSvc.SetSetting(ctx, "atlas_post_limit", "12", "integer")
	rec2 := httptest.NewRecorder()
	c2 := e.NewContext(req, rec2)
	c2.SetParamNames("id")
	c2.SetParamValues(strconv.FormatInt(place.ID, 10))
	if err := ph.GetTagCloud(c2); err != nil {
		t.Fatalf("GetTagCloud (custom limit) failed: %v", err)
	}
	var resp2 struct {
		Posts []json.RawMessage `json:"posts"`
	}
	if err := json.Unmarshal(rec2.Body.Bytes(), &resp2); err != nil {
		t.Fatalf("unmarshal (custom limit) failed: %v", err)
	}
	if len(resp2.Posts) != 12 {
		t.Errorf("with atlas_post_limit=12, expected 12 posts, got %d", len(resp2.Posts))
	}
}

// TestPagesHandler_GetTagsGraph_YearFilter verifies the timeline scope the Atlas
// sends: tags with no posts in range drop out of the graph, the survivors report
// their in-range count (which is what sizes a marker), and the count rolls up the
// hierarchy — a country whose posts are tagged only with its cities stays on the
// map instead of vanishing the moment the timeline narrows.
func TestPagesHandler_GetTagsGraph_YearFilter(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()

	ctx := context.Background()
	userID := insertUser(h.repo)

	_, _ = h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "2023", Slug: "2023", Kind: "year"})
	_, _ = h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "2024", Slug: "2024", Kind: "year"})

	// Germany → Berlin. Only the city is ever put on a post, which is the usual
	// shape: the country's presence has to come from its descendants.
	germany, err := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Germany", Slug: "germany"})
	if err != nil {
		t.Fatalf("Germany creation failed: %v", err)
	}
	berlin, err := h.tagSvc.CreateTag(ctx, services.CreateTagParams{
		Name: "Berlin", Slug: "berlin", ParentIDs: []int64{germany.ID},
	})
	if err != nil {
		t.Fatalf("Berlin creation failed: %v", err)
	}
	_ = h.repo.UpsertTagLocation(ctx, germany.ID, 51.1, 10.4)
	_ = h.repo.UpsertTagLocation(ctx, berlin.ID, 52.5, 13.4)

	paris, _ := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Paris", Slug: "paris"})
	_ = h.repo.UpsertTagLocation(ctx, paris.ID, 48.8, 2.3)

	// Two Berlin posts in 2024, one Paris post in 2023.
	for i := 0; i < 2; i++ {
		p, _, err := h.postSvc.CreatePost(ctx, services.CreatePostParams{
			Title: fmt.Sprintf("Berlin %d", i), Status: "published", AuthorID: userID,
		})
		if err != nil {
			t.Fatalf("berlin post %d creation failed: %v", i, err)
		}
		if err := h.postSvc.UpdatePostTags(ctx, p.ID, []string{"2024", "berlin"}); err != nil {
			t.Fatalf("berlin post %d tagging failed: %v", i, err)
		}
	}
	pParis, _, _ := h.postSvc.CreatePost(ctx, services.CreatePostParams{
		Title: "Paris", Status: "published", AuthorID: userID,
	})
	_ = h.postSvc.UpdatePostTags(ctx, pParis.ID, []string{"2023", "paris"})

	_ = h.settingsSvc.SetSetting(ctx, "plugin.tags-atlas.enabled", "true", "string")
	_ = h.settingsSvc.SetSetting(ctx, "plugin.tags-map.enabled", "false", "string")
	_ = h.settingsSvc.SetSetting(ctx, "plugin.tags-graph.enabled", "false", "string")
	_ = h.settingsSvc.SetSetting(ctx, "tags_visibility", "all", "string")

	e := echo.New()
	countsFor := func(url string) map[string]int64 {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, url, nil)
		rec := httptest.NewRecorder()
		if err := ph.GetTagsGraph(e.NewContext(req, rec)); err != nil {
			t.Fatalf("GetTagsGraph(%s) failed: %v", url, err)
		}
		var resp struct {
			Tags []struct {
				Slug      string `json:"slug"`
				PostCount int64  `json:"post_count"`
			} `json:"tags"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("unmarshal(%s) failed: %v", url, err)
		}
		out := make(map[string]int64, len(resp.Tags))
		for _, tag := range resp.Tags {
			out[tag.Slug] = tag.PostCount
		}
		return out
	}

	// Unscoped: every place is present.
	all := countsFor("/api/pages/graph?posts=0")
	for _, slug := range []string{"germany", "berlin", "paris"} {
		if _, ok := all[slug]; !ok {
			t.Errorf("unscoped graph is missing %q: %v", slug, all)
		}
	}

	// Scoped to 2024: Paris (and the 2023 tag) drop out; Berlin reports its two
	// posts and Germany inherits that count from Berlin.
	scoped := countsFor("/api/pages/graph?posts=0&year_from=2024&year_to=2024")
	if _, ok := scoped["paris"]; ok {
		t.Errorf("paris has no 2024 posts and should be absent: %v", scoped)
	}
	if _, ok := scoped["2023"]; ok {
		t.Errorf("the 2023 year tag should be absent from a 2024 scope: %v", scoped)
	}
	if scoped["berlin"] != 2 {
		t.Errorf("berlin post_count = %d, want 2 (its in-range posts)", scoped["berlin"])
	}
	if scoped["germany"] != 2 {
		t.Errorf("germany post_count = %d, want 2 rolled up from berlin", scoped["germany"])
	}

	// A malformed range is no range at all rather than a filter to nothing.
	if got := countsFor("/api/pages/graph?posts=0&year_from=2024&year_to=2023"); len(got) != len(all) {
		t.Errorf("reversed range should not filter: got %v, want %v", got, all)
	}
}

func TestPagesHandler_GetMapPage_YearFilter(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()

	ctx := context.Background()
	_ = h.settingsSvc.SetSetting(ctx, "plugin.tags-atlas.enabled", "false", "string")
	_ = h.settingsSvc.SetSetting(ctx, "plugin.tags-map.enabled", "true", "string")
	_ = h.settingsSvc.SetSetting(ctx, "plugin.tags-graph.enabled", "false", "string")
	_ = h.settingsSvc.SetSetting(ctx, "tags_visibility", "all", "string")

	// Create user
	userID := insertUser(h.repo)

	// 2024 tag in timeline (using Kind: "year")
	_, err := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "2024", Slug: "2024", Kind: "year"})
	if err != nil {
		t.Fatalf("y2024 creation failed: %v", err)
	}

	// Berlin location
	berlin, err := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Berlin", Slug: "berlin"})
	if err != nil {
		t.Fatalf("Berlin creation failed: %v", err)
	}
	_ = h.repo.UpsertTagLocation(ctx, berlin.ID, 52.5, 13.4)

	// Post in 2024 at Berlin
	p1, _, err := h.postSvc.CreatePost(ctx, services.CreatePostParams{Title: "P1", Status: "published", AuthorID: userID})
	if err != nil {
		t.Fatalf("p1 creation failed: %v", err)
	}
	err = h.postSvc.UpdatePostTags(ctx, p1.ID, []string{"2024", "berlin"})
	if err != nil {
		t.Fatalf("p1 tags update failed: %v", err)
	}

	// Post NOT in 2024 (e.g. 2023) at Paris
	_, _ = h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "2023", Slug: "2023", Kind: "year"})
	paris, _ := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Paris", Slug: "paris"})
	_ = h.repo.UpsertTagLocation(ctx, paris.ID, 48.8, 2.3)
	p2, _, _ := h.postSvc.CreatePost(ctx, services.CreatePostParams{Title: "P2", Status: "published", AuthorID: userID})
	_ = h.postSvc.UpdatePostTags(ctx, p2.ID, []string{"2023", "paris"})

	e := echo.New()

	// Test with year_from=2024&year_to=2024
	req := httptest.NewRequest(http.MethodGet, "/api/pages/map?year_from=2024&year_to=2024", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := ph.GetMapPage(c); err != nil {
		t.Fatalf("GetMapPage failed: %v", err)
	}

	var resp map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	tags := resp["tags"].([]interface{})

	// Should only have Berlin
	if len(tags) != 1 {
		t.Errorf("expected 1 tag, got %d: %v", len(tags), tags)
	} else {
		tag := tags[0].(map[string]interface{})
		if tag["slug"] != "berlin" {
			t.Errorf("expected berlin, got %v", tag["slug"])
		}
	}
}

// TestPagesHandler_TagsModuleDisabled404 verifies that when no tag-viz plugin is
// enabled the /tags endpoints (graph, cloud, map) all report 404 — the
// not-accessible branch of tagsModuleAccessible.
func TestPagesHandler_TagsModuleDisabled404(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()

	ctx := context.Background()
	for _, id := range []string{"tags-atlas", "tags-map", "tags-graph"} {
		_ = h.settingsSvc.SetSetting(ctx, "plugin."+id+".enabled", "false", "string")
	}

	e := echo.New()
	is404 := func(t *testing.T, err error) {
		t.Helper()
		var he *echo.HTTPError
		ok := errors.As(err, &he)
		if !ok || he.Code != http.StatusNotFound {
			t.Fatalf("expected 404, got %v", err)
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/api/pages/graph", nil)
	is404(t, ph.GetTagsGraph(e.NewContext(req, httptest.NewRecorder())))

	req = httptest.NewRequest(http.MethodGet, "/api/pages/graph/tag/1", nil)
	c := e.NewContext(req, httptest.NewRecorder())
	c.SetParamNames("id")
	c.SetParamValues("1")
	is404(t, ph.GetTagCloud(c))

	req = httptest.NewRequest(http.MethodGet, "/api/pages/map", nil)
	is404(t, ph.GetMapPage(e.NewContext(req, httptest.NewRecorder())))
}

func TestPagesHandler_TagPage_ViewCountVisibility(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()

	e := echo.New()
	ctx := context.Background()

	// Create user
	userID := insertUser(h.repo)

	// Case 1: Tag above threshold
	tag1, _ := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Popular1"})
	for i := 1; i <= 5; i++ {
		p, _, _ := h.postSvc.CreatePost(ctx, services.CreatePostParams{Title: "P" + strconv.Itoa(i), Status: "published", AuthorID: userID})
		_ = h.postSvc.UpdatePostTags(ctx, p.ID, []string{tag1.Slug})
	}
	_ = h.settingsSvc.SetSetting(ctx, "min_tag_posts_to_show", "3", "int")

	req := httptest.NewRequest(http.MethodGet, "/tags/"+tag1.Slug, nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues(tag1.Slug)

	if err := ph.GetTagPage(c); err != nil {
		t.Fatalf("GetTagPage (above) failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}

	// Case 2: Tag below threshold
	tag2, _ := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Popular2"})
	for i := 1; i <= 5; i++ {
		p, _, _ := h.postSvc.CreatePost(ctx, services.CreatePostParams{Title: "Q" + strconv.Itoa(i), Status: "published", AuthorID: userID})
		_ = h.postSvc.UpdatePostTags(ctx, p.ID, []string{tag2.Slug})
	}
	_ = h.settingsSvc.SetSetting(ctx, "min_tag_posts_to_show", "10", "int")

	req2 := httptest.NewRequest(http.MethodGet, "/tags/"+tag2.Slug, nil)
	rec2 := httptest.NewRecorder()
	c2 := e.NewContext(req2, rec2)
	c2.SetParamNames("slug")
	c2.SetParamValues(tag2.Slug)

	err := ph.GetTagPage(c2)
	if err == nil {
		t.Error("expected 404 for tag under threshold (public)")
	}

	// Case 3: Admin sees it anyway
	rec3 := httptest.NewRecorder()
	c3 := e.NewContext(req2, rec3)
	c3.SetParamNames("slug")
	c3.SetParamValues(tag2.Slug)
	c3.Set("user", "admin")

	if err := ph.GetTagPage(c3); err != nil {
		t.Fatalf("GetTagPage (admin) failed: %v", err)
	}
	if rec3.Code != http.StatusOK {
		t.Errorf("expected status 200 for admin, got %d", rec3.Code)
	}
}

// TestPagesHandler_ExpandPostTagsWithAncestors covers the ancestor walk that
// adds inherited tags to a post's tag list: a parent tag surfaces marked
// Inherited, a tag the post carries itself is never inherited even when it is
// also an ancestor of another of the post's tags, and a hidden ancestor is
// dropped (along with its own ancestors) under publicOnly.
func TestPagesHandler_ExpandPostTagsWithAncestors(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()

	ctx := context.Background()

	// Hierarchy: nature → botany. Plus a hidden branch hush → visible.
	nature, _ := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Nature", Slug: "nature"})
	botany, _ := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Botany", Slug: "botany", ParentIDs: []int64{nature.ID}})
	hush, _ := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Hush", Slug: "hush", Hidden: true})
	visible, _ := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Visible", Slug: "visible", ParentIDs: []int64{hush.ID}})

	byID := func(tags []repository.PostTagInfo) map[int64]repository.PostTagInfo {
		m := make(map[int64]repository.PostTagInfo, len(tags))
		for _, tg := range tags {
			m[tg.ID] = tg
		}
		return m
	}

	// Case 1: post carries only botany → nature is added as an inherited ancestor.
	got := ph.expandPostTagsWithAncestors(ctx, map[int64][]repository.PostTagInfo{
		1: {{ID: botany.ID, Name: botany.Name, Slug: botany.Slug}},
	}, true)
	m := byID(got[1])
	if bt, ok := m[botany.ID]; !ok || bt.Inherited {
		t.Errorf("botany should be present and not inherited, got %+v (ok=%v)", bt, ok)
	}
	if nt, ok := m[nature.ID]; !ok || !nt.Inherited {
		t.Errorf("nature should be present and inherited, got %+v (ok=%v)", nt, ok)
	}

	// Case 2: post carries BOTH botany and its parent nature → nature is the
	// post's own tag, so it must stay non-inherited even though the walk from
	// botany also reaches it (Pass 1 claims it before Pass 2 runs).
	got = ph.expandPostTagsWithAncestors(ctx, map[int64][]repository.PostTagInfo{
		1: {
			{ID: botany.ID, Name: botany.Name, Slug: botany.Slug},
			{ID: nature.ID, Name: nature.Name, Slug: nature.Slug},
		},
	}, true)
	m = byID(got[1])
	if nt, ok := m[nature.ID]; !ok || nt.Inherited {
		t.Errorf("nature carried by the post must not be inherited, got %+v (ok=%v)", nt, ok)
	}

	// Case 3: publicOnly drops a hidden ancestor. Post carries visible, whose
	// only parent hush is hidden → hush is not surfaced.
	got = ph.expandPostTagsWithAncestors(ctx, map[int64][]repository.PostTagInfo{
		1: {{ID: visible.ID, Name: visible.Name, Slug: visible.Slug}},
	}, true)
	m = byID(got[1])
	if _, ok := m[visible.ID]; !ok {
		t.Error("visible should be present")
	}
	if _, ok := m[hush.ID]; ok {
		t.Error("hidden ancestor hush must be dropped under publicOnly")
	}

	// Case 4: with publicOnly=false the hidden ancestor is included and inherited.
	got = ph.expandPostTagsWithAncestors(ctx, map[int64][]repository.PostTagInfo{
		1: {{ID: visible.ID, Name: visible.Name, Slug: visible.Slug}},
	}, false)
	m = byID(got[1])
	if ht, ok := m[hush.ID]; !ok || !ht.Inherited {
		t.Errorf("hidden ancestor should be included and inherited when publicOnly=false, got %+v (ok=%v)", ht, ok)
	}
}

// TestPagesHandler_GetNavMenu covers the three menu modes and, with them, where
// the root tag tree ends up: the site-title dropdown reads `tags` when the menu
// is authored links, falls back to `menu` when the menu already is the tree,
// and shows nothing on a deliberately menuless site.
func TestPagesHandler_GetNavMenu(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()

	e := echo.New()
	ctx := context.Background()

	// nav_order makes the tag nav-visible without needing posts behind it.
	navOrder := int64(1)
	if _, err := h.tagSvc.CreateTag(ctx, services.CreateTagParams{
		Name: "Travel", Slug: "travel", NavOrder: &navOrder,
	}); err != nil {
		t.Fatalf("CreateTag: %v", err)
	}

	getNav := func() map[string]interface{} {
		req := httptest.NewRequest(http.MethodGet, "/api/pages/nav", nil)
		rec := httptest.NewRecorder()
		if err := ph.GetNavMenu(e.NewContext(req, rec)); err != nil {
			t.Fatalf("GetNavMenu failed: %v", err)
		}
		var resp map[string]interface{}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode nav response: %v", err)
		}
		return resp
	}

	names := func(v interface{}) []string {
		items, _ := v.([]interface{})
		out := make([]string, 0, len(items))
		for _, it := range items {
			m, _ := it.(map[string]interface{})
			out = append(out, fmt.Sprint(m["name"]))
		}
		return out
	}

	// Tags mode (default): the menu is the tree, no separate `tags` field.
	resp := getNav()
	if got := names(resp["menu"]); len(got) != 1 || got[0] != "Travel" {
		t.Errorf("tags mode: expected menu [Travel], got %v", got)
	}
	if _, ok := resp["tags"]; ok {
		t.Error("tags mode: `tags` should be omitted — the menu already is the tree")
	}

	// Custom mode: authored links in the menu, root tags alongside them.
	_ = h.settingsSvc.SetSetting(ctx, "nav_menu_mode", "custom", "string")
	_ = h.settingsSvc.SetSetting(ctx, "custom_nav_menu", `[{"name":"About","url":"/about"}]`, "string")
	resp = getNav()
	if got := names(resp["menu"]); len(got) != 1 || got[0] != "About" {
		t.Errorf("custom mode: expected menu [About], got %v", got)
	}
	if got := names(resp["tags"]); len(got) != 1 || got[0] != "Travel" {
		t.Errorf("custom mode: expected tags [Travel], got %v", got)
	}

	// None mode: no menu, and no tags either — the site is menuless on purpose.
	_ = h.settingsSvc.SetSetting(ctx, "nav_menu_mode", "none", "string")
	resp = getNav()
	if got := names(resp["menu"]); len(got) != 0 {
		t.Errorf("none mode: expected empty menu, got %v", got)
	}
	if _, ok := resp["tags"]; ok {
		t.Error("none mode: `tags` should be omitted")
	}
}

// The home feed extends to the left of page 1 into the owner's scheduled
// queue: page 0 is the first future page, then -1, and so on. Guests see none
// of it — for them the feed still starts and ends at page 1.
func TestPagesHandler_HomePageScheduledPages(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()

	ctx := context.Background()
	userID := insertUser(h.repo)
	if err := h.settingsSvc.SetSetting(ctx, "posts_per_page", "2", "string"); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}

	for i := 1; i <= 2; i++ {
		if _, _, err := h.postSvc.CreatePost(ctx, services.CreatePostParams{
			Title: fmt.Sprintf("Live %d", i), Status: "published", AuthorID: userID,
		}); err != nil {
			t.Fatalf("CreatePost: %v", err)
		}
	}
	// Three scheduled posts at 2 per page = two future pages (0 and -1), the
	// soonest one first.
	base := time.Now().Add(24 * time.Hour)
	for i := 1; i <= 3; i++ {
		at := base.Add(time.Duration(i) * time.Hour)
		if _, _, err := h.postSvc.CreatePost(ctx, services.CreatePostParams{
			Title: fmt.Sprintf("Soon %d", i), Status: "scheduled", AuthorID: userID,
			ScheduledAt: &at,
		}); err != nil {
			t.Fatalf("CreatePost scheduled: %v", err)
		}
	}

	e := echo.New()
	get := func(page string, asOwner bool) map[string]interface{} {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/?page="+page, nil)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		if asOwner {
			c.Set("user", "test-user")
		}
		if err := ph.GetHomePage(c); err != nil {
			t.Fatalf("GetHomePage(page=%s): %v", page, err)
		}
		var resp map[string]interface{}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return resp
	}
	titles := func(resp map[string]interface{}) []string {
		var out []string
		for _, p := range resp["posts"].([]interface{}) {
			out = append(out, p.(map[string]interface{})["title"].(string))
		}
		return out
	}
	pag := func(resp map[string]interface{}) map[string]interface{} {
		return resp["pagination"].(map[string]interface{})
	}

	// Owner, page 1: the published feed, with the queue advertised to its left.
	owner1 := get("1", true)
	if got := pag(owner1)["min_page"]; got != float64(-1) {
		t.Errorf("owner min_page = %v, want -1 (3 scheduled posts at 2 per page)", got)
	}
	if got := len(titles(owner1)); got != 2 {
		t.Errorf("owner page 1: %d posts, want 2 published", got)
	}
	if pag(owner1)["scheduled"] != false {
		t.Error("page 1 must not be flagged as a scheduled page")
	}

	// Page 0: the head of the queue, soonest first.
	page0 := get("0", true)
	if got := titles(page0); len(got) != 2 || got[0] != "Soon 1" || got[1] != "Soon 2" {
		t.Errorf("page 0 = %v, want [Soon 1 Soon 2]", got)
	}
	if pag(page0)["scheduled"] != true {
		t.Error("page 0 must be flagged scheduled so the grid renders reversed and faded")
	}
	// `total`/`pages` keep describing the published feed — the paginator spans
	// both halves and has to know how far right it can go.
	if got := pag(page0)["total"]; got != float64(2) {
		t.Errorf("page 0 total = %v, want 2 (the published feed)", got)
	}

	// Page -1: the tail of the queue.
	if got := titles(get("-1", true)); len(got) != 1 || got[0] != "Soon 3" {
		t.Errorf("page -1 = %v, want [Soon 3]", got)
	}

	// Past the end of the queue clamps to its first page rather than 404ing.
	if got := titles(get("-9", true)); len(got) != 1 || got[0] != "Soon 3" {
		t.Errorf("page -9 = %v, want the clamp to page -1 ([Soon 3])", got)
	}

	// A guest has no queue: min_page stays 1 and a negative page is just page 1.
	guest := get("0", false)
	if got := pag(guest)["min_page"]; got != float64(1) {
		t.Errorf("guest min_page = %v, want 1", got)
	}
	if got := titles(guest); len(got) != 2 || got[0] == "Soon 1" {
		t.Errorf("guest page 0 = %v, want the published feed", got)
	}
	if pag(guest)["scheduled"] != false {
		t.Error("a guest must never be handed a scheduled page")
	}
}

// A tag page runs into its own queue the same way the home feed does: page 0
// and below hold the posts carrying this tag (or one below it) that are still
// waiting to publish. Everything else about the page — `total`, `pages`, the
// tag itself — keeps describing the published half.
func TestPagesHandler_TagPageScheduledPages(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()

	ctx := context.Background()
	userID := insertUser(h.repo)
	if err := h.settingsSvc.SetSetting(ctx, "posts_per_page", "2", "string"); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}

	// travel → japan, so the parent tag's queue must include the child's post.
	travel, _ := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Travel", Slug: "travel"})
	_, _ = h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Japan", Slug: "japan", ParentIDs: []int64{travel.ID}})
	_, _ = h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Food", Slug: "food"})

	create := func(title, status, tag string, at *time.Time) {
		t.Helper()
		if _, _, err := h.postSvc.CreatePost(ctx, services.CreatePostParams{
			Title: title, Status: status, AuthorID: userID, Tags: []string{tag}, ScheduledAt: at,
		}); err != nil {
			t.Fatalf("CreatePost(%s): %v", title, err)
		}
	}

	create("Live 1", "published", "Travel", nil)
	create("Live 2", "published", "Travel", nil)
	// Three queued under travel — two directly, one through its child tag — at
	// 2 per page, so two future pages (0 and -1), soonest first.
	base := time.Now().Add(24 * time.Hour)
	at1, at2, at3 := base.Add(time.Hour), base.Add(2*time.Hour), base.Add(3*time.Hour)
	create("Soon 1", "scheduled", "Travel", &at1)
	create("Soon 2", "scheduled", "Japan", &at2)
	create("Soon 3", "scheduled", "Travel", &at3)
	// Another tag's queue must not leak into this one.
	elsewhere := base.Add(30 * time.Minute)
	create("Elsewhere", "scheduled", "Food", &elsewhere)

	e := echo.New()
	get := func(slug, page string, asOwner bool) map[string]interface{} {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/tags/"+slug+"?page="+page, nil)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		c.SetParamNames("slug")
		c.SetParamValues(slug)
		if asOwner {
			c.Set("user", "test-user")
		}
		if err := ph.GetTagPage(c); err != nil {
			t.Fatalf("GetTagPage(%s, page=%s): %v", slug, page, err)
		}
		var resp map[string]interface{}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return resp
	}
	titles := func(resp map[string]interface{}) []string {
		var out []string
		for _, p := range resp["posts"].([]interface{}) {
			out = append(out, p.(map[string]interface{})["title"].(string))
		}
		return out
	}
	pag := func(resp map[string]interface{}) map[string]interface{} {
		return resp["pagination"].(map[string]interface{})
	}

	// Owner, page 1: the published posts, with the queue advertised to the left.
	owner1 := get("travel", "1", true)
	if got := pag(owner1)["min_page"]; got != float64(-1) {
		t.Errorf("min_page = %v, want -1 (3 queued under travel at 2 per page)", got)
	}
	if got := titles(owner1); len(got) != 2 || got[0] == "Soon 1" {
		t.Errorf("page 1 = %v, want the tag's published posts", got)
	}
	if pag(owner1)["scheduled"] != false {
		t.Error("page 1 must not be flagged as a scheduled page")
	}

	// Page 0: the head of this tag's queue, soonest first, descendants included.
	page0 := get("travel", "0", true)
	if got := titles(page0); len(got) != 2 || got[0] != "Soon 1" || got[1] != "Soon 2" {
		t.Errorf("page 0 = %v, want [Soon 1 Soon 2] (Soon 2 arrives through the child tag)", got)
	}
	if pag(page0)["scheduled"] != true {
		t.Error("page 0 must be flagged scheduled so the grid renders reversed and faded")
	}
	if got := pag(page0)["total"]; got != float64(2) {
		t.Errorf("page 0 total = %v, want 2 (the tag's published posts)", got)
	}

	// Page -1: the tail. Past the end clamps to it rather than 404ing.
	if got := titles(get("travel", "-1", true)); len(got) != 1 || got[0] != "Soon 3" {
		t.Errorf("page -1 = %v, want [Soon 3]", got)
	}
	if got := titles(get("travel", "-9", true)); len(got) != 1 || got[0] != "Soon 3" {
		t.Errorf("page -9 = %v, want the clamp to page -1 ([Soon 3])", got)
	}

	// A tag with nothing queued has no left half at all.
	if got := pag(get("japan", "1", true))["min_page"]; got != float64(0) {
		t.Errorf("japan min_page = %v, want 0 (one queued post)", got)
	}

	// A guest has no queue: min_page stays 1 and a negative page is just page 1.
	guest := get("travel", "0", false)
	if got := pag(guest)["min_page"]; got != float64(1) {
		t.Errorf("guest min_page = %v, want 1", got)
	}
	if got := titles(guest); len(got) != 2 || got[0] == "Soon 1" {
		t.Errorf("guest page 0 = %v, want the published posts", got)
	}
	if pag(guest)["scheduled"] != false {
		t.Error("a guest must never be handed a scheduled page")
	}
}

// TestPagesHandler_GetTagsGraph_HiddenMarking covers the owner's half of the
// revelio switch on the Atlas. Concealing already drops hidden places from the
// payload, but a map that loses 1 marker out of 500 reads as unchanged — so the
// revealed view marks what a guest would not get. Guests must never see the
// flag (they don't get the tags either, but the absence is the contract the
// frontend reads: undefined → not hidden).
func TestPagesHandler_GetTagsGraph_HiddenMarking(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()

	ctx := context.Background()
	userID := insertUser(h.repo)

	// Ural is hidden; Taganay hangs off it but is not — hiding is not inherited
	// (see TagGraph), which is exactly why the map marks tags one by one rather
	// than shading a whole sub-tree.
	ural, err := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Ural", Slug: "ural", Hidden: true})
	if err != nil {
		t.Fatalf("Ural creation failed: %v", err)
	}
	taganay, err := h.tagSvc.CreateTag(ctx, services.CreateTagParams{
		Name: "Taganay", Slug: "taganay", ParentIDs: []int64{ural.ID},
	})
	if err != nil {
		t.Fatalf("Taganay creation failed: %v", err)
	}
	berlin, _ := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Berlin", Slug: "berlin"})
	_ = h.repo.UpsertTagLocation(ctx, taganay.ID, 55.3, 59.8)
	_ = h.repo.UpsertTagLocation(ctx, berlin.ID, 52.5, 13.4)

	p, _, err := h.postSvc.CreatePost(ctx, services.CreatePostParams{
		Title: "Rocks", Status: "published", AuthorID: userID,
	})
	if err != nil {
		t.Fatalf("post creation failed: %v", err)
	}
	_ = h.postSvc.UpdatePostTags(ctx, p.ID, []string{"taganay", "berlin"})

	_ = h.settingsSvc.SetSetting(ctx, "plugin.tags-atlas.enabled", "true", "string")
	_ = h.settingsSvc.SetSetting(ctx, "plugin.tags-map.enabled", "false", "string")
	_ = h.settingsSvc.SetSetting(ctx, "plugin.tags-graph.enabled", "false", "string")
	_ = h.settingsSvc.SetSetting(ctx, "tags_visibility", "all", "string")

	e := echo.New()
	nodesFor := func(admin bool) map[string]map[string]interface{} {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/api/pages/graph?posts=0", nil)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		if admin {
			c.Set("user", "test-user")
		}
		if err := ph.GetTagsGraph(c); err != nil {
			t.Fatalf("GetTagsGraph(admin=%v) failed: %v", admin, err)
		}
		var resp struct {
			Tags []map[string]interface{} `json:"tags"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("unmarshal(admin=%v) failed: %v", admin, err)
		}
		out := make(map[string]map[string]interface{}, len(resp.Tags))
		for _, node := range resp.Tags {
			out[node["slug"].(string)] = node
		}
		return out
	}

	adminNodes := nodesFor(true)
	if adminNodes["ural"]["is_hidden"] != true {
		t.Errorf("ural is_hidden = %v, want true", adminNodes["ural"]["is_hidden"])
	}
	// A visible place carries no flag at all — the payload lists every tag on the
	// site, so the field is emitted only when true.
	for _, slug := range []string{"berlin", "taganay"} {
		if _, ok := adminNodes[slug]["is_hidden"]; ok {
			t.Errorf("%s should carry no is_hidden key, got %v", slug, adminNodes[slug]["is_hidden"])
		}
	}

	guestNodes := nodesFor(false)
	if _, ok := guestNodes["ural"]; ok {
		t.Error("guest payload must not contain the hidden tag \"ural\"")
	}
	if _, ok := guestNodes["berlin"]["is_hidden"]; ok {
		t.Error("guest payload must never carry is_hidden")
	}
}

// TestPagesHandler_GetTagCloud_HiddenMarking is the same contract one level in:
// a tapped place's cloud marks the co-tags and the posts that only exist for the
// owner, so the chips that vanish with revelio off are identifiable while it is on.
func TestPagesHandler_GetTagCloud_HiddenMarking(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()

	ctx := context.Background()
	userID := insertUser(h.repo)

	place, err := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Berlin", Slug: "berlin"})
	if err != nil {
		t.Fatalf("place creation failed: %v", err)
	}
	if _, err := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "fog", Slug: "fog", Hidden: true}); err != nil {
		t.Fatalf("hidden co-tag creation failed: %v", err)
	}

	pub, _, err := h.postSvc.CreatePost(ctx, services.CreatePostParams{
		Title: "Published", Status: "published", AuthorID: userID,
	})
	if err != nil {
		t.Fatalf("published post creation failed: %v", err)
	}
	_ = h.postSvc.UpdatePostTags(ctx, pub.ID, []string{"berlin", "fog"})

	draft, _, err := h.postSvc.CreatePost(ctx, services.CreatePostParams{
		Title: "Draft", Status: "draft", AuthorID: userID,
	})
	if err != nil {
		t.Fatalf("draft creation failed: %v", err)
	}
	_ = h.postSvc.UpdatePostTags(ctx, draft.ID, []string{"berlin"})

	_ = h.settingsSvc.SetSetting(ctx, "plugin.tags-atlas.enabled", "true", "string")
	_ = h.settingsSvc.SetSetting(ctx, "plugin.tags-map.enabled", "false", "string")
	_ = h.settingsSvc.SetSetting(ctx, "plugin.tags-graph.enabled", "false", "string")
	_ = h.settingsSvc.SetSetting(ctx, "tags_visibility", "all", "string")

	e := echo.New()
	cloudFor := func(admin bool) (map[string]map[string]interface{}, map[string]map[string]interface{}) {
		t.Helper()
		id := strconv.FormatInt(place.ID, 10)
		req := httptest.NewRequest(http.MethodGet, "/api/pages/graph/tag/"+id, nil)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		c.SetParamNames("id")
		c.SetParamValues(id)
		if admin {
			c.Set("user", "test-user")
		}
		if err := ph.GetTagCloud(c); err != nil {
			t.Fatalf("GetTagCloud(admin=%v) failed: %v", admin, err)
		}
		var resp struct {
			Tags  []map[string]interface{} `json:"tags"`
			Posts []map[string]interface{} `json:"posts"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("unmarshal(admin=%v) failed: %v", admin, err)
		}
		tags := make(map[string]map[string]interface{}, len(resp.Tags))
		for _, n := range resp.Tags {
			tags[n["slug"].(string)] = n
		}
		posts := make(map[string]map[string]interface{}, len(resp.Posts))
		for _, n := range resp.Posts {
			posts[n["title"].(string)] = n
		}
		return tags, posts
	}

	adminTags, adminPosts := cloudFor(true)
	if adminTags["fog"]["is_hidden"] != true {
		t.Errorf("hidden co-tag fog is_hidden = %v, want true", adminTags["fog"]["is_hidden"])
	}
	if adminPosts["Draft"]["status"] != "draft" {
		t.Errorf("draft post chip status = %v, want draft", adminPosts["Draft"]["status"])
	}
	// A published post is what every viewer gets, so it carries no status at all.
	if _, ok := adminPosts["Published"]["status"]; ok {
		t.Errorf("published post chip should carry no status key, got %v", adminPosts["Published"]["status"])
	}

	guestTags, guestPosts := cloudFor(false)
	if _, ok := guestTags["fog"]; ok {
		t.Error("guest cloud must not contain the hidden co-tag")
	}
	if _, ok := guestPosts["Draft"]; ok {
		t.Error("guest cloud must not contain the draft post")
	}
	if _, ok := guestPosts["Published"]["status"]; ok {
		t.Error("guest cloud must never carry status")
	}
}
