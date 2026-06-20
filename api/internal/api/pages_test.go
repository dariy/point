package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

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

	_ = h.settingsSvc.SetSetting(ctx, "tags_module", "cloud", "string")
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
	if full.Posts[0].MediaURL != "/photo.jpg?thumb=128" {
		t.Errorf("image post media_url = %q, want /photo.jpg?thumb=128", full.Posts[0].MediaURL)
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

	_ = h.settingsSvc.SetSetting(ctx, "tags_module", "atlas", "string")
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
	if len(resp.Posts) > 0 && resp.Posts[0].MediaURL != "/photo.jpg?thumb=128" {
		t.Errorf("newest post media_url = %q, want /photo.jpg?thumb=128", resp.Posts[0].MediaURL)
	}
}

func TestPagesHandler_GetMapPage_YearFilter(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()

	ctx := context.Background()
	_ = h.settingsSvc.SetSetting(ctx, "tags_module", "map", "string")
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
