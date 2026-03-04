package services

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTagService_GeocodeTagExtended(t *testing.T) {
	service, repo := setupTagService(t)
	defer func() {
		_ = repo.Close()
	}()

	ctx := context.Background()

	// 1. Tag not found
	_, _, err := service.GeocodeTag(ctx, 999)
	if err == nil {
		t.Error("expected error for non-existent tag")
	}

	// 2. Valid tag (mocking Nominatim)
	tag, _ := service.CreateTag(ctx, CreateTagParams{Name: "Paris"})

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		res := []map[string]string{
			{"lat": "48.8566", "lon": "2.3522"},
		}
		_ = json.NewEncoder(w).Encode(res)
	}))
	defer server.Close()

	service.nominatimBaseURL = server.URL + "?"

	lat, lon, err := service.GeocodeTag(ctx, tag.ID)
	if err != nil {
		t.Fatalf("GeocodeTag failed: %v", err)
	}
	if lat != 48.8566 || lon != 2.3522 {
		t.Errorf("expected 48.8566, 2.3522, got %f, %f", lat, lon)
	}
}

func TestTagService_UpdateMissingCoordsExtended(t *testing.T) {
	service, repo := setupTagService(t)
	defer func() {
		_ = repo.Close()
	}()

	ctx := context.Background()

	// Setup hierarchy: city -> Paris
	city, _ := service.CreateTag(ctx, CreateTagParams{Name: "city"})
	paris, _ := service.CreateTag(ctx, CreateTagParams{Name: "Paris"})
	_ = service.SetTagChildren(ctx, city.ID, []int64{paris.ID})

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		res := []map[string]string{{"lat": "48.8", "lon": "2.3"}}
		_ = json.NewEncoder(w).Encode(res)
	}))
	defer server.Close()

	service.nominatimBaseURL = server.URL + "?"

	res, err := service.UpdateMissingCoords(ctx)
	if err != nil {
		t.Fatalf("UpdateMissingCoords failed: %v", err)
	}
	if res["updated_count"].(int) != 1 {
		t.Errorf("expected 1 updated, got %v", res["updated_count"])
	}
}

func TestTagService_HierarchyVisibility(t *testing.T) {
	service, repo := setupTagService(t)
	defer func() {
		_ = repo.Close()
	}()

	ctx := context.Background()

	// Set up deep hierarchy
	root, _ := service.CreateTag(ctx, CreateTagParams{Name: "Root", IsHidden: true, IsHiddenPosts: true})
	child, _ := service.CreateTag(ctx, CreateTagParams{Name: "Child"})
	grandchild, _ := service.CreateTag(ctx, CreateTagParams{Name: "Grandchild"})

	_ = service.SetTagChildren(ctx, root.ID, []int64{child.ID})
	_ = service.SetTagChildren(ctx, child.ID, []int64{grandchild.ID})

	// Check effectively hidden
	hidden, _ := service.EffectivelyHiddenIDs(ctx)
	if !hidden[root.ID] || !hidden[child.ID] || !hidden[grandchild.ID] {
		t.Errorf("expected all tags to be effectively hidden, got: root=%v, child=%v, grandchild=%v", hidden[root.ID], hidden[child.ID], hidden[grandchild.ID])
	}

	hiddenPosts, _ := service.EffectivelyHiddenPostsTagIDs(ctx)
	if !hiddenPosts[root.ID] || !hiddenPosts[child.ID] || !hiddenPosts[grandchild.ID] {
		t.Error("expected all tags to hide posts")
	}

	// Test case where is_hidden=true but is_hidden_posts=false (no propagation of hidden-ness to children)
	root2, _ := service.CreateTag(ctx, CreateTagParams{Name: "Root2", IsHidden: true, IsHiddenPosts: false})
	child2, _ := service.CreateTag(ctx, CreateTagParams{Name: "Child2"})
	_ = service.SetTagChildren(ctx, root2.ID, []int64{child2.ID})

	hidden2, _ := service.EffectivelyHiddenIDs(ctx)
	if !hidden2[root2.ID] {
		t.Error("Root2 should be hidden (direct)")
	}
	if hidden2[child2.ID] {
		t.Error("Child2 should NOT be hidden (is_hidden does not propagate without is_hidden_posts)")
	}
}

func TestTagService_NavTree(t *testing.T) {
	service, repo := setupTagService(t)
	defer func() {
		_ = repo.Close()
	}()

	ctx := context.Background()

	// Featured tag with no posts
	featured, _ := service.CreateTag(ctx, CreateTagParams{Name: "Featured", IsFeatured: true})

	nodes, err := service.GetHierarchicalNavTags(ctx, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, n := range nodes {
		if n.ID == featured.ID {
			found = true
			break
		}
	}
	if !found {
		t.Error("featured tag with 0 posts should appear in nav")
	}

	// Regular tag with no posts
	regular, _ := service.CreateTag(ctx, CreateTagParams{Name: "Regular"})
	nodes, _ = service.GetHierarchicalNavTags(ctx, nil, true)
	for _, n := range nodes {
		if n.ID == regular.ID {
			t.Error("regular tag with 0 posts should NOT appear in nav")
		}
	}
}

func TestTagService_PostsByTagIDsExtended(t *testing.T) {
	service, repo := setupTagService(t)
	defer func() {
		_ = repo.Close()
	}()

	ctx := context.Background()

	// Parent has posts via child
	parent, _ := service.CreateTag(ctx, CreateTagParams{Name: "Continent"})
	child, _ := service.CreateTag(ctx, CreateTagParams{Name: "Country"})
	_ = service.SetTagChildren(ctx, parent.ID, []int64{child.ID})

	// Add post to child
	_, _ = repo.DB().Exec(`INSERT INTO users (username, email, password_hash, display_name) VALUES ('u','u@t.com','h','U')`)
	_, _ = repo.DB().Exec(`INSERT INTO posts (title, slug, content, author_id, status, published_at) VALUES ('P','p','b',1,'published',datetime('now'))`)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (1, ?)`, child.ID)

	// Parent should show child's posts
	posts, total, err := service.GetPostsByTag(ctx, parent.ID, 1, 10, true, false)
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || len(posts) != 1 {
		t.Errorf("expected 1 post via inheritance, got total=%d, len=%d", total, len(posts))
	}
}
