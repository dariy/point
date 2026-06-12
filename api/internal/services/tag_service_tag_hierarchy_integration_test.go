//go:build integration

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
	root, _ := service.CreateTag(ctx, CreateTagParams{
		Name:       "Root",
		Hidden:     true,
		HidesPosts: true,
	})
	child, _ := service.CreateTag(ctx, CreateTagParams{Name: "Child"})
	grandchild, _ := service.CreateTag(ctx, CreateTagParams{Name: "Grandchild"})

	_ = service.SetTagChildren(ctx, root.ID, []int64{child.ID})
	_ = service.SetTagChildren(ctx, child.ID, []int64{grandchild.ID})

	// Check effectively hidden — all should be hidden via propagation.
	service.Invalidate()
	snap, _ := service.GetTagSnapshot(ctx)
	hidden := snap.EffectiveHidden
	if !hidden[root.ID] || !hidden[child.ID] || !hidden[grandchild.ID] {
		t.Errorf("expected all tags to be effectively hidden, got: root=%v, child=%v, grandchild=%v", hidden[root.ID], hidden[child.ID], hidden[grandchild.ID])
	}

	hiddenPosts := snap.EffectiveHidesPosts
	if !hiddenPosts[root.ID] || !hiddenPosts[child.ID] || !hiddenPosts[grandchild.ID] {
		t.Error("expected all tags to hide posts via propagation")
	}

	// Tag not under hidden root should NOT be hidden.
	other, _ := service.CreateTag(ctx, CreateTagParams{Name: "Other"})
	service.Invalidate()
	snap, _ = service.GetTagSnapshot(ctx)
	hidden2 := snap.EffectiveHidden
	if hidden2[other.ID] {
		t.Error("Other should NOT be hidden (not under hidden root)")
	}
}

func TestTagService_NavTree(t *testing.T) {
	service, repo := setupTagService(t)
	defer func() {
		_ = repo.Close()
	}()

	ctx := context.Background()

	// Tag with nav_order set appears in nav even with 0 posts.
	navOrder := int64(1)
	featured, _ := service.CreateTag(ctx, CreateTagParams{
		Name:     "Featured",
		NavOrder: &navOrder,
	})

	nodes, err := service.GetHierarchicalNavTags(ctx, nil, true, 0)
	if err != nil {
		t.Fatal(err)
	}
	_ = nodes // nav tree built without error

	found := false
	for _, n := range nodes {
		if n.ID == featured.ID {
			found = true
			break
		}
	}
	if !found {
		t.Error("featured tag with nav_order should appear in nav")
	}

	// Regular tag with no posts and no nav_order should NOT appear.
	regular, _ := service.CreateTag(ctx, CreateTagParams{Name: "Regular"})
	nodes, _ = service.GetHierarchicalNavTags(ctx, nil, true, 0)
	for _, n := range nodes {
		if n.ID == regular.ID {
			t.Error("regular tag with 0 posts and no nav_order should NOT appear in nav")
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
	posts, total, err := service.GetPostsByTag(ctx, parent.ID, 1, 10, true, false, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || len(posts) != 1 {
		t.Errorf("expected 1 post via inheritance, got total=%d, len=%d", total, len(posts))
	}
}

func TestTagService_GetTagBySlugNotFound(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	if _, err := svc.GetTagBySlug(ctx, "doesnotexist"); err == nil {
		t.Error("expected error for non-existent slug")
	}

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'T','found-slug')`)
	svc.Invalidate()
	tag, err := svc.GetTagBySlug(ctx, "found-slug")
	if err != nil {
		t.Fatalf("GetTagBySlug found: %v", err)
	}
	if tag.Slug != "found-slug" {
		t.Errorf("expected slug 'found-slug', got %s", tag.Slug)
	}
}

func TestTagService_EffectivelyHiddenBoost(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	snap, err := svc.GetTagSnapshot(ctx)
	if err != nil {
		t.Fatalf("GetTagSnapshot failed: %v", err)
	}
	ids := snap.EffectiveHidesPosts
	if len(ids) != 0 {
		t.Errorf("expected empty, got %d", len(ids))
	}

	ids2 := snap.EffectiveHidden
	if len(ids2) != 0 {
		t.Errorf("expected empty, got %d", len(ids2))
	}
}

func TestTagService_GetHierarchicalNavTagsBoost(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	nodes, err := svc.GetHierarchicalNavTags(ctx, nil, false, 0)
	if err != nil {
		t.Fatalf("GetHierarchicalNavTags failed: %v", err)
	}
	_ = nodes

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug, post_count) VALUES (1,'_root','_root',0),(2,'Nature','nature',5)`)
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (1,2)`)

	svc.Invalidate()
	nodes, err = svc.GetHierarchicalNavTags(ctx, nil, true, 0)
	if err != nil {
		t.Fatalf("GetHierarchicalNavTags (public) failed: %v", err)
	}
	_ = nodes

	id := int64(1)
	nodes, err = svc.GetHierarchicalNavTags(ctx, &id, false, 0)
	if err != nil {
		t.Fatalf("GetHierarchicalNavTags (with rootID) failed: %v", err)
	}
	_ = nodes
}

func TestTagService_CreateTagErrors(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	// system slugs no longer rejected by prefix
	tag, err := svc.CreateTag(ctx, CreateTagParams{Name: "My Tag"})
	if err != nil {
		t.Fatalf("CreateTag (auto-slug) failed: %v", err)
	}
	if tag.Slug == "" {
		t.Error("expected auto-generated slug")
	}

	// underscore slugs preserved
	tagU, err := svc.CreateTag(ctx, CreateTagParams{Name: "_Underscore"})
	if err != nil {
		t.Fatalf("CreateTag (_Underscore) failed: %v", err)
	}
	if tagU.Slug != "_underscore" {
		t.Errorf("expected slug _underscore, got %q", tagU.Slug)
	}
}

func TestTagService_GetTagCloud_Branches(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	items, err := svc.GetTagCloud(ctx, 10, false, 0)
	if err != nil || len(items) != 0 {
		t.Errorf("empty DB: expected [], got %v %v", items, err)
	}

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1, 'Sys', '_sys')`)
	svc.Invalidate()
	// system tags now just regular tags
	items, err = svc.GetTagCloud(ctx, 10, false, 0)
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug, post_count) VALUES (2, 'Regular', 'regular', 0)`)
	items, err = svc.GetTagCloud(ctx, 10, false, 0)
	if err != nil || len(items) != 0 {
		t.Errorf("no posts: expected [], got %v %v", items, err)
	}
}

func TestTagService_EffectivelyHiddenWithData(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug, post_count, hidden) VALUES (2,'HiddenParent','hidden-parent',0, 1),(3,'Pub','pub',1, 0)`)
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (2,3)`)

	svc.Invalidate()
	snap, err := svc.GetTagSnapshot(ctx)
	if err != nil {
		t.Fatalf("GetTagSnapshot: %v", err)
	}
	ids := snap.EffectiveHidesPosts
	_ = ids

	ids2 := snap.EffectiveHidden
	_ = ids2
}

func TestTagService_CreateTagWithNavOrder(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	navOrder := int64(5)
	tag, err := svc.CreateTag(ctx, CreateTagParams{Name: "Ordered", Slug: "ordered", NavOrder: &navOrder})
	if err != nil {
		t.Fatalf("CreateTag with NavOrder failed: %v", err)
	}
	if !tag.NavOrder.Valid || tag.NavOrder.Int64 != 5 {
		t.Errorf("expected nav_order=5, got %+v", tag.NavOrder)
	}
}

func TestTagService_UpdateTag_WithNavOrder(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id,name,slug) VALUES (1,'Regular','regular')`)
	navOrder := int64(10)
	if _, err := svc.UpdateTag(ctx, UpdateTagParams{
		ID: 1, Name: "Regular", Slug: "regular", NavOrder: &navOrder,
	}); err != nil {
		t.Errorf("UpdateTag with NavOrder: unexpected error: %v", err)
	}
}

func TestTagService_ReorderTag_CrossHierarchy(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'P1','parent1'),(2,'P2','parent2'),(3,'Drag','drag'),(4,'Other','other')`)
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (1,3),(2,4)`)

	parent2ID := int64(2)
	if err := svc.ReorderTag(ctx, ReorderTagParams{
		ID: 3, Position: "after", ParentID: &parent2ID,
	}); err != nil {
		t.Errorf("ReorderTag cross-hierarchy: unexpected error: %v", err)
	}
}

func TestTagService_SetTagChildren_ClearError(t *testing.T) {
	svc, repo := setupTagService(t)
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id,name,slug) VALUES (1,'P','parent'),(2,'C','child')`)
	_ = repo.Close()

	if err := svc.SetTagChildren(ctx, 1, []int64{2}); err == nil {
		t.Error("SetTagChildren: expected error from ClearTagChildren")
	}
}

func TestTagService_DBErrors3(t *testing.T) {
	svc, repo := setupTagService(t)
	ctx := context.Background()

	_ = repo.Close()

	if _, err := svc.GetTagChildren(ctx, 1, false, 0); err == nil {
		t.Error("GetTagChildren DB error: expected error")
	}
	if _, err := svc.UpdateMissingCoords(ctx); err == nil {
		t.Error("UpdateMissingCoords DB error: expected error")
	}
}

func TestTagService_DropTable_SetTagErrors(t *testing.T) {
	t.Run("SetTagParents_ClearParentsError", func(t *testing.T) {
		svc, repo := setupTagService(t)
		defer func() { _ = repo.Close() }()
		ctx := context.Background()

		_, _ = repo.DB().Exec(`INSERT INTO tags (id,name,slug) VALUES (1,'T','regular')`)
		_, _ = repo.DB().Exec(`DROP TABLE tag_relationships`)

		if err := svc.SetTagParents(ctx, 1, []int64{}); err == nil {
			t.Error("SetTagParents dropped tag_relationships: expected error")
		}
	})

	t.Run("SetTagChildren_ClearChildrenError", func(t *testing.T) {
		svc, repo := setupTagService(t)
		defer func() { _ = repo.Close() }()
		ctx := context.Background()

		_, _ = repo.DB().Exec(`INSERT INTO tags (id,name,slug) VALUES (1,'P','parent'),(2,'C','child')`)
		_, _ = repo.DB().Exec(`DROP TABLE tag_relationships`)

		if err := svc.SetTagChildren(ctx, 1, []int64{2}); err == nil {
			t.Error("SetTagChildren dropped tag_relationships: expected error")
		}
	})
}

func TestTagService_GeocodeTag_HttpErrors(t *testing.T) {
	ctx := context.Background()

	t.Run("InvalidURL", func(t *testing.T) {
		svc, repo := setupTagService(t)
		defer func() { _ = repo.Close() }()
		_, _ = repo.DB().Exec(`INSERT INTO tags (id,name,slug) VALUES (1,'City','city')`)
		svc.nominatimBaseURL = "http://\x00invalid"
		if _, _, err := svc.GeocodeTag(ctx, 1); err == nil {
			t.Error("GeocodeTag invalid URL: expected error")
		}
	})

	t.Run("ConnectionRefused", func(t *testing.T) {
		svc, repo := setupTagService(t)
		defer func() { _ = repo.Close() }()
		_, _ = repo.DB().Exec(`INSERT INTO tags (id,name,slug) VALUES (1,'City','city')`)
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
		tsURL := ts.URL
		ts.Close()
		svc.nominatimBaseURL = tsURL
		if _, _, err := svc.GeocodeTag(ctx, 1); err == nil {
			t.Error("GeocodeTag connection refused: expected error")
		}
	})

	t.Run("EmptyResults", func(t *testing.T) {
		svc, repo := setupTagService(t)
		defer func() { _ = repo.Close() }()
		_, _ = repo.DB().Exec(`INSERT INTO tags (id,name,slug) VALUES (1,'City','city')`)
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte(`[]`)) //nolint:errcheck
		}))
		defer ts.Close()
		svc.nominatimBaseURL = ts.URL
		if _, _, err := svc.GeocodeTag(ctx, 1); err == nil {
			t.Error("GeocodeTag empty results: expected error")
		}
	})

	t.Run("UpsertError", func(t *testing.T) {
		svc, repo := setupTagService(t)
		defer func() { _ = repo.Close() }()
		_, _ = repo.DB().Exec(`INSERT INTO tags (id,name,slug) VALUES (1,'City','city')`)
		_, _ = repo.DB().Exec(`DROP TABLE tags`)
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte(`[{"lat":"48.85","lon":"2.35"}]`)) //nolint:errcheck
		}))
		defer ts.Close()
		svc.nominatimBaseURL = ts.URL
		if _, _, err := svc.GeocodeTag(ctx, 1); err == nil {
			t.Error("GeocodeTag UpsertTagLocation error: expected error")
		}
	})
}

func TestTagService_ReorderTag_GetSiblingsError(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id,name,slug) VALUES (1,'T','tag1')`)
	_, _ = repo.DB().Exec(`DROP TABLE tag_relationships`)

	if err := svc.ReorderTag(ctx, ReorderTagParams{ID: 1, Position: "after"}); err == nil {
		t.Error("ReorderTag dropped tag_relationships: expected error")
	}
}
