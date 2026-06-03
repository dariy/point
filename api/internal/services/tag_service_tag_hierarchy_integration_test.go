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

	// Seed system tags directly (CreateTag rejects _ prefix).
	_, _ = repo.DB().Exec(`INSERT OR IGNORE INTO tags (name, slug, post_count) VALUES ('Hidden','_hidden',0),('Hide Posts','_hide_posts',0)`)

	// Set up deep hierarchy
	root, _ := service.CreateTag(ctx, CreateTagParams{Name: "Root"})
	child, _ := service.CreateTag(ctx, CreateTagParams{Name: "Child"})
	grandchild, _ := service.CreateTag(ctx, CreateTagParams{Name: "Grandchild"})

	// Make root a child of _hidden and _hide_posts.
	_, _ = repo.DB().Exec(`
		INSERT OR IGNORE INTO tag_relationships (parent_id, child_id)
		SELECT t.id, ? FROM tags t WHERE t.slug IN ('_hidden','_hide_posts')`, root.ID)

	_ = service.SetTagChildren(ctx, root.ID, []int64{child.ID})
	_ = service.SetTagChildren(ctx, child.ID, []int64{grandchild.ID})

	// Check effectively hidden — all should be hidden via propagation.
	hidden, _ := service.EffectivelyHiddenIDs(ctx)
	if !hidden[root.ID] || !hidden[child.ID] || !hidden[grandchild.ID] {
		t.Errorf("expected all tags to be effectively hidden, got: root=%v, child=%v, grandchild=%v", hidden[root.ID], hidden[child.ID], hidden[grandchild.ID])
	}

	hiddenPosts, _ := service.EffectivelyHiddenPostsTagIDs(ctx)
	if !hiddenPosts[root.ID] || !hiddenPosts[child.ID] || !hiddenPosts[grandchild.ID] {
		t.Error("expected all tags to hide posts via propagation")
	}

	// Tag not under _hidden should NOT be hidden.
	other, _ := service.CreateTag(ctx, CreateTagParams{Name: "Other"})
	hidden2, _ := service.EffectivelyHiddenIDs(ctx)
	if hidden2[other.ID] {
		t.Error("Other should NOT be hidden (not under _hidden)")
	}
}

func TestTagService_NavTree(t *testing.T) {
	service, repo := setupTagService(t)
	defer func() {
		_ = repo.Close()
	}()

	ctx := context.Background()

	// Seed _root system tag (CreateTag rejects _ prefix).
	_, _ = repo.DB().Exec(`INSERT OR IGNORE INTO tags (name, slug, post_count) VALUES ('Root','_root',0)`)

	// Tag under _root appears in nav even with 0 posts.
	featured, _ := service.CreateTag(ctx, CreateTagParams{Name: "Featured"})
	_, _ = repo.DB().Exec(`
		INSERT OR IGNORE INTO tag_relationships (parent_id, child_id)
		SELECT id, ? FROM tags WHERE slug = '_root'`, featured.ID)

	nodes, err := service.GetHierarchicalNavTags(ctx, nil, true, 0)
	if err != nil {
		t.Fatal(err)
	}
	_ = nodes // nav tree built without error

	// Regular tag with no posts and not under _root should NOT appear.
	regular, _ := service.CreateTag(ctx, CreateTagParams{Name: "Regular"})
	nodes, _ = service.GetHierarchicalNavTags(ctx, nil, true, 0)
	for _, n := range nodes {
		if n.ID == regular.ID {
			t.Error("regular tag with 0 posts and not under _root should NOT appear in nav")
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
	tag, err := svc.GetTagBySlug(ctx, "found-slug")
	if err != nil {
		t.Fatalf("GetTagBySlug found: %v", err)
	}
	if tag.Slug != "found-slug" {
		t.Errorf("expected slug 'found-slug', got %s", tag.Slug)
	}
}

func TestTagService_UpdateTagSystemSlug(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	if _, err := svc.UpdateTag(ctx, UpdateTagParams{ID: 0, Name: "Bad", Slug: "_bad"}); err == nil {
		t.Error("expected error for slug starting with _")
	}

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (99,'_sys','_sys')`)
	tag, err := svc.UpdateTag(ctx, UpdateTagParams{ID: 99, Name: "NewName", Description: "desc"})
	if err != nil {
		t.Fatalf("UpdateTag system tag failed: %v", err)
	}
	if tag.Slug != "_sys" {
		t.Errorf("expected slug '_sys', got %s", tag.Slug)
	}
}

func TestTagService_SetTagParentsWithInvalidID(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	if err := svc.SetTagParents(ctx, 999, []int64{}); err == nil {
		t.Error("expected error for non-existent tag in SetTagParents")
	}
}

func TestTagService_GetHierarchicalNavTagsWithHidden(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug, post_count) VALUES
		(1,'_root','_root',0),(2,'_system','_system',0),(3,'_hidden','_hidden',0),
		(4,'Visible','visible',3),(5,'Hidden','hidden-tag',3)`)
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (2,3),(1,4),(1,5),(3,5)`)

	nodes, err := svc.GetHierarchicalNavTags(ctx, nil, true, 0)
	if err != nil {
		t.Fatalf("GetHierarchicalNavTags (hidden) failed: %v", err)
	}
	for _, n := range nodes {
		if n.Slug == "hidden-tag" {
			t.Error("hidden tag should not appear in public nav")
		}
	}
}

func TestTagService_EffectivelyHiddenBoost(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	ids, err := svc.EffectivelyHiddenPostsTagIDs(ctx)
	if err != nil {
		t.Fatalf("EffectivelyHiddenPostsTagIDs failed: %v", err)
	}
	if len(ids) != 0 {
		t.Errorf("expected empty, got %d", len(ids))
	}

	ids2, err := svc.EffectivelyHiddenIDs(ctx)
	if err != nil {
		t.Fatalf("EffectivelyHiddenIDs failed: %v", err)
	}
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

func TestTagService_SetTagParentsSystemTag(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'_system','_system')`)
	if err := svc.SetTagParents(ctx, 1, []int64{}); err == nil {
		t.Error("expected error for re-parenting system tag")
	}
}

func TestTagService_SetTagChildrenSystemTag(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'Parent','parent'),(2,'_sys','_sys')`)
	if err := svc.SetTagChildren(ctx, 1, []int64{2}); err == nil {
		t.Error("expected error for system child tag")
	}
}

func TestTagService_CreateTagErrors(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	if _, err := svc.CreateTag(ctx, CreateTagParams{Name: "_sys", Slug: "_sys"}); err == nil {
		t.Error("expected error for system slug")
	}

	tag, err := svc.CreateTag(ctx, CreateTagParams{Name: "My Tag"})
	if err != nil {
		t.Fatalf("CreateTag (auto-slug) failed: %v", err)
	}
	if tag.Slug == "" {
		t.Error("expected auto-generated slug")
	}
}

func TestTagService_SystemTagAccess(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (99, 'System', '_system')`)

	if _, err := svc.GetTagByID(ctx, 99); err == nil {
		t.Error("GetTagByID system tag: expected error")
	}
	if err := svc.DeleteTag(ctx, 99); err == nil {
		t.Error("DeleteTag system tag: expected error")
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
	items, err = svc.GetTagCloud(ctx, 10, false, 0)
	if err != nil || len(items) != 0 {
		t.Errorf("only system tags: expected [], got %v %v", items, err)
	}

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug, post_count) VALUES (2, 'Regular', 'regular', 0)`)
	items, err = svc.GetTagCloud(ctx, 10, false, 0)
	if err != nil || len(items) != 0 {
		t.Errorf("no posts: expected [], got %v %v", items, err)
	}
}

func TestTagService_SetTagParents_EmptyParentIDs(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1, 'Regular', 'regular')`)

	if err := svc.SetTagParents(ctx, 1, []int64{}); err != nil {
		t.Errorf("SetTagParents empty no-pending: unexpected error: %v", err)
	}

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (2, 'Pending', '_pending')`)
	if err := svc.SetTagParents(ctx, 1, []int64{}); err != nil {
		t.Errorf("SetTagParents empty with _pending: unexpected error: %v", err)
	}
}

func TestTagService_ReorderTag_SameHierarchy(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	parent, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Parent", Slug: "parent"})
	child1, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Child1", Slug: "child1"})
	child2, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Child2", Slug: "child2"})
	_ = svc.SetTagParents(ctx, child1.ID, []int64{parent.ID})
	_ = svc.SetTagParents(ctx, child2.ID, []int64{parent.ID})

	if err := svc.ReorderTag(ctx, ReorderTagParams{
		ID: child1.ID, TargetID: &child2.ID, Position: "after", ParentID: &parent.ID,
	}); err != nil {
		t.Fatalf("ReorderTag (same hierarchy): %v", err)
	}
}

func TestTagService_UpdateMissingCoords_AllHaveCoords(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	cityTag, _ := svc.CreateTag(ctx, CreateTagParams{Name: "city", Slug: "city"})
	childTag, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Paris", Slug: "paris"})
	_ = svc.SetTagParents(ctx, childTag.ID, []int64{cityTag.ID})
	_, _ = repo.DB().Exec(`INSERT INTO tag_locations (tag_id, latitude, longitude) VALUES (?, 48.8566, 2.3522)`, childTag.ID)

	result, err := svc.UpdateMissingCoords(ctx)
	if err != nil {
		t.Fatalf("UpdateMissingCoords: %v", err)
	}
	if result["updated_count"] != 0 {
		t.Errorf("expected 0 updated (all have coords), got %v", result["updated_count"])
	}
}

func TestTagService_GetHierarchicalNavTagsDeep(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug, post_count, sort_order) VALUES
		(1,'_root','_root',0,NULL),(2,'_with_related','_with_related',0,NULL),
		(3,'_sys-child','_sys-child',0,NULL),(4,'Alpha','alpha',3,2),
		(5,'Beta','beta',2,1),(6,'Gamma','gamma',0,NULL)`)
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (1,3),(1,4),(1,5),(1,6),(2,4),(4,5)`)

	nodes, err := svc.GetHierarchicalNavTags(ctx, nil, false, 0)
	if err != nil {
		t.Fatalf("GetHierarchicalNavTags deep: %v", err)
	}
	_ = nodes

	nodes, err = svc.GetHierarchicalNavTags(ctx, nil, true, 0)
	if err != nil {
		t.Fatalf("GetHierarchicalNavTags publicOnly: %v", err)
	}
	_ = nodes

	rootID := int64(1)
	nodes, err = svc.GetHierarchicalNavTags(ctx, &rootID, false, 0)
	if err != nil {
		t.Fatalf("GetHierarchicalNavTags rootID: %v", err)
	}
	_ = nodes

	_, _ = repo.DB().Exec(`INSERT OR IGNORE INTO tag_relationships (parent_id, child_id) VALUES (4,4)`)
	nodes, err = svc.GetHierarchicalNavTags(ctx, nil, false, 0)
	if err != nil {
		t.Fatalf("GetHierarchicalNavTags cycle: %v", err)
	}
	_ = nodes
}

func TestTagService_EffectivelyHiddenWithData(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug, post_count) VALUES
		(1,'_system','_system',0),(2,'_hidden','_hidden',0),(3,'Pub','pub',1)`)
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (1,2),(2,3)`)

	ids, err := svc.EffectivelyHiddenPostsTagIDs(ctx)
	if err != nil {
		t.Fatalf("EffectivelyHiddenPostsTagIDs: %v", err)
	}
	_ = ids

	ids2, err := svc.EffectivelyHiddenIDs(ctx)
	if err != nil {
		t.Fatalf("EffectivelyHiddenIDs: %v", err)
	}
	_ = ids2
}

func TestTagService_CreateTagSystemSlug(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	if _, err := svc.CreateTag(ctx, CreateTagParams{Name: "_bad", Slug: "_bad"}); err == nil {
		t.Error("expected error for system slug")
	}
}

func TestTagService_CreateTagWithSortOrder(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	sortOrder := int32(5)
	tag, err := svc.CreateTag(ctx, CreateTagParams{Name: "Ordered", Slug: "ordered", SortOrder: &sortOrder})
	if err != nil {
		t.Fatalf("CreateTag with SortOrder failed: %v", err)
	}
	if !tag.SortOrder.Valid || tag.SortOrder.Int64 != 5 {
		t.Errorf("expected sort_order=5, got %+v", tag.SortOrder)
	}
}

func TestTagService_UpdateTag_WithSortOrder(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id,name,slug) VALUES (1,'Regular','regular')`)
	sortOrder := int32(10)
	if _, err := svc.UpdateTag(ctx, UpdateTagParams{
		ID: 1, Name: "Regular", Slug: "regular", SortOrder: &sortOrder,
	}); err != nil {
		t.Errorf("UpdateTag with SortOrder: unexpected error: %v", err)
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
		_, _ = repo.DB().Exec(`DROP TABLE tag_locations`)
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
