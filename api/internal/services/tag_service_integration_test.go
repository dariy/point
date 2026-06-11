//go:build integration

package services

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"point-api/internal/models"
	"point-api/internal/repository"

	"github.com/labstack/echo/v4"
)

func TestTagService_CRUD(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	service := NewTagService(repo)
	ctx := context.Background()

	// Test Create
	tag, err := service.CreateTag(ctx, CreateTagParams{
		Name:        "Test Tag",
		Description: "Test Description",
	})
	if err != nil {
		t.Fatalf("CreateTag failed: %v", err)
	}
	if tag.Name != "Test Tag" {
		t.Errorf("expected name Test Tag, got %s", tag.Name)
	}
	if tag.Slug != "test-tag" {
		t.Errorf("expected slug test-tag, got %s", tag.Slug)
	}

	// Test GetBySlug
	fetched, err := service.GetTagBySlug(ctx, "test-tag")
	if err != nil {
		t.Errorf("GetTagBySlug failed: %v", err)
	}
	if fetched.ID != tag.ID {
		t.Errorf("expected ID %d, got %d", tag.ID, fetched.ID)
	}

	// Test UpdatePostCounts
	err = service.UpdateAllPostCounts(ctx)
	if err != nil {
		t.Errorf("UpdateAllPostCounts failed: %v", err)
	}

	// Test UpdateMissingCoords (with base tag but no children)
	_, _ = repo.DB().Exec(`INSERT INTO tags (name, slug) VALUES ('city', 'city')`)
	res, err := service.UpdateMissingCoords(ctx)
	if err != nil {
		t.Fatalf("UpdateMissingCoords failed: %v", err)
	}
	if res["updated_count"] != 0 {
		t.Errorf("expected 0 updated, got %v", res["updated_count"])
	}

	// Test Update
	updated, err := service.UpdateTag(ctx, UpdateTagParams{
		ID:   tag.ID,
		Name: "Updated Tag",
	})
	if err != nil {
		t.Errorf("UpdateTag failed: %v", err)
	}
	if updated.Name != "Updated Tag" {
		t.Errorf("expected name Updated Tag, got %s", updated.Name)
	}

	// Test List
	tags, err := service.ListTags(ctx, true, false)
	if err != nil {
		t.Errorf("ListTags failed: %v", err)
	}
	if len(tags) != 2 {
		t.Errorf("expected 2 tags, got %d", len(tags))
	}

	// Test Delete
	err = service.DeleteTag(ctx, tag.ID)
	if err != nil {
		t.Errorf("DeleteTag failed: %v", err)
	}

	_, err = service.GetTagByID(ctx, tag.ID)
	if err == nil {
		t.Error("expected error getting deleted tag, got nil")
	}

	// Test GetPostsByTag (empty result)
	posts, total, err := service.GetPostsByTag(ctx, 999, 1, 10, true, false, 0, 0)
	if err != nil {
		t.Errorf("GetPostsByTag failed: %v", err)
	}
	if total != 0 {
		t.Errorf("expected 0 posts, got %d", total)
	}
	if len(posts) != 0 {
		t.Errorf("expected 0 posts, got %d", len(posts))
	}
}

func TestTagService_TagCloud(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	service := NewTagService(repo)
	ctx := context.Background()

	// Create some tags (IsImportant=true so they appear in the tag cloud)
	t1, _ := service.CreateTag(ctx, CreateTagParams{Name: "Tag 1"})
	t2, _ := service.CreateTag(ctx, CreateTagParams{Name: "Tag 2"})

	// Create a user and posts so hierarchical counts work from actual post_tags data.
	// Tag 1 gets 2 posts, Tag 2 gets 1 post → weights 1.0 and 0.5.
	_, _ = repo.DB().Exec(`INSERT INTO users (username, email, password_hash, display_name) VALUES ('u', 'u@t', 'h', 'U')`)
	var userID int64
	_ = repo.DB().QueryRow(`SELECT id FROM users LIMIT 1`).Scan(&userID)
	for i := 1; i <= 3; i++ {
		_, _ = repo.DB().Exec(
			`INSERT INTO posts (title, slug, content, formatter, status, author_id) VALUES (?, ?, '', 'markdown', 'published', ?)`,
			"p"+string(rune('0'+i)), "p"+string(rune('0'+i)), userID,
		)
	}
	var p1, p2, p3 int64
	rows, _ := repo.DB().Query(`SELECT id FROM posts ORDER BY id LIMIT 3`)
	ids := []*int64{&p1, &p2, &p3}
	for i := 0; rows.Next(); i++ {
		_ = rows.Scan(ids[i])
	}
	_ = rows.Close()
	// p1, p2 → Tag 1 (count=2); p3 → Tag 2 (count=1)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)`, p1, t1.ID)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)`, p2, t1.ID)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)`, p3, t2.ID)

	cloud, err := service.GetTagCloud(ctx, 10, false, 0)
	if err != nil {
		t.Fatalf("GetTagCloud failed: %v", err)
	}

	if len(cloud) != 2 {
		t.Errorf("expected 2 cloud items, got %d", len(cloud))
	}

	// Check weights: Tag 1 has 2 posts (weight=1.0), Tag 2 has 1 post (weight=0.5).
	for _, item := range cloud {
		switch item.ID {
		case t1.ID:
			if item.Weight != 1.0 {
				t.Errorf("expected weight 1.0 for Tag 1, got %f", item.Weight)
			}
			if item.Count != 2 {
				t.Errorf("expected count 2 for Tag 1, got %d", item.Count)
			}
		case t2.ID:
			if item.Weight != 0.5 {
				t.Errorf("expected weight 0.5 for Tag 2, got %f", item.Weight)
			}
			if item.Count != 1 {
				t.Errorf("expected count 1 for Tag 2, got %d", item.Count)
			}
		}
	}
}

func TestTagService_Hierarchy(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	service := NewTagService(repo)
	ctx := context.Background()

	parent, _ := service.CreateTag(ctx, CreateTagParams{Name: "Parent"})
	child, _ := service.CreateTag(ctx, CreateTagParams{Name: "Child"})

	// Set hierarchy
	err := repo.AddTagRelationship(ctx, models.AddTagRelationshipParams{
		ParentID: parent.ID,
		ChildID:  child.ID,
	})
	if err != nil {
		t.Fatalf("AddTagRelationship failed: %v", err)
	}

	// Test GetChildren
	children, err := service.GetTagChildren(ctx, parent.ID, false, 0)
	if err != nil {
		t.Errorf("GetTagChildren failed: %v", err)
	}
	if len(children) != 1 || children[0].ID != child.ID {
		t.Error("failed to get correct child")
	}

	// Test GetParents
	parents, err := service.GetTagParents(ctx, child.ID)
	if err != nil {
		t.Errorf("GetTagParents failed: %v", err)
	}
	if len(parents) != 1 || parents[0].ID != parent.ID {
		t.Error("failed to get correct parent")
	}
}

func TestTagService_SetRelationships(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	svc := NewTagService(repo)
	ctx := context.Background()

	parent, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Parent"})
	child, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Child"})
	child2, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Child2"})

	// SetTagParents: make child a child of parent
	if err := svc.SetTagParents(ctx, child.ID, []int64{parent.ID}); err != nil {
		t.Fatalf("SetTagParents failed: %v", err)
	}

	// Verify via GetTagChildren
	children, err := svc.GetTagChildren(ctx, parent.ID, false, 0)
	if err != nil || len(children) != 1 || children[0].ID != child.ID {
		t.Errorf("GetTagChildren after SetTagParents: got %v, err %v", children, err)
	}

	// SetTagChildren: parent now has child + child2
	if err := svc.SetTagChildren(ctx, parent.ID, []int64{child.ID, child2.ID}); err != nil {
		t.Fatalf("SetTagChildren failed: %v", err)
	}

	children, _ = svc.GetTagChildren(ctx, parent.ID, false, 0)
	if len(children) != 2 {
		t.Errorf("expected 2 children after SetTagChildren, got %d", len(children))
	}

	// GetAllTagRelationships
	rels, err := svc.GetAllTagRelationships(ctx)
	if err != nil {
		t.Fatalf("GetAllTagRelationships failed: %v", err)
	}
	if len(rels) < 2 {
		t.Errorf("expected at least 2 relationships, got %d", len(rels))
	}

	// SetTagParents with empty slice clears parents
	if err := svc.SetTagParents(ctx, child.ID, []int64{}); err != nil {
		t.Errorf("SetTagParents (clear) failed: %v", err)
	}
	// SetTagChildren with empty slice clears children
	if err := svc.SetTagChildren(ctx, parent.ID, []int64{}); err != nil {
		t.Errorf("SetTagChildren (clear) failed: %v", err)
	}
}

func TestTagService_ReorderTag(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	svc := NewTagService(repo)
	ctx := context.Background()

	t1, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Alpha"})
	t2, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Beta"})
	t3, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Gamma"})

	// Reorder t1 after t3 (root level, no parent)
	if err := svc.ReorderTag(ctx, ReorderTagParams{
		ID:       t1.ID,
		TargetID: &t3.ID,
		Position: "after",
	}); err != nil {
		t.Fatalf("ReorderTag (after) failed: %v", err)
	}

	// Reorder t2 before t1
	if err := svc.ReorderTag(ctx, ReorderTagParams{
		ID:       t2.ID,
		TargetID: &t1.ID,
		Position: "before",
	}); err != nil {
		t.Fatalf("ReorderTag (before) failed: %v", err)
	}

	// Invalid position
	err := svc.ReorderTag(ctx, ReorderTagParams{ID: t3.ID, Position: "sideways"})
	if err == nil {
		t.Error("expected error for invalid position")
	}

	// Tag not among siblings (non-existent ID)
	err = svc.ReorderTag(ctx, ReorderTagParams{ID: 9999, Position: "after"})
	if err == nil {
		t.Error("expected error for non-existent tag among siblings")
	}
}

func TestTagService_Locations(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	svc := NewTagService(repo)
	ctx := context.Background()

	tag, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Paris"})

	// Set location
	if err := svc.SetTagLocations(ctx, tag.ID, []TagLocationInput{
		{Latitude: 48.8566, Longitude: 2.3522},
	}); err != nil {
		t.Fatalf("SetTagLocations failed: %v", err)
	}

	// Get location
	locs, err := svc.GetTagLocationsByTagIDs(ctx, []int64{tag.ID})
	if err != nil {
		t.Fatalf("GetTagLocationsByTagIDs failed: %v", err)
	}
	if loc, ok := locs[tag.ID]; !ok {
		t.Error("expected location for tag")
	} else if loc.Latitude != 48.8566 {
		t.Errorf("expected lat 48.8566, got %v", loc.Latitude)
	}

	// Clear locations
	if err := svc.SetTagLocations(ctx, tag.ID, []TagLocationInput{}); err != nil {
		t.Errorf("SetTagLocations (clear) failed: %v", err)
	}

	// Empty tag IDs
	locs, err = svc.GetTagLocationsByTagIDs(ctx, []int64{})
	if err != nil {
		t.Errorf("GetTagLocationsByTagIDs (empty) failed: %v", err)
	}
	if len(locs) != 0 {
		t.Errorf("expected empty map, got %v", locs)
	}
}

func TestTagService_GetTagsByPostIDs(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	svc := NewTagService(repo)
	ctx := context.Background()

	// Empty
	result, err := svc.GetTagsByPostIDs(ctx, []int64{})
	if err != nil {
		t.Fatalf("GetTagsByPostIDs (empty) failed: %v", err)
	}
	if len(result) != 0 {
		t.Errorf("expected empty result, got %v", result)
	}

	// With data
	_, _ = repo.DB().Exec(`INSERT INTO users (username, email, password_hash, display_name) VALUES ('u','u@t.com','h','U')`)
	_, _ = repo.DB().Exec(`INSERT INTO posts (title, slug, content, status, author_id) VALUES ('P','p','b','published',1)`)
	_, _ = repo.DB().Exec(`INSERT INTO tags (name, slug) VALUES ('Tech','tech')`)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (1, 1)`)

	result, err = svc.GetTagsByPostIDs(ctx, []int64{1})
	if err != nil {
		t.Fatalf("GetTagsByPostIDs failed: %v", err)
	}
	if len(result[1]) != 1 {
		t.Errorf("expected 1 tag for post 1, got %d", len(result[1]))
	}
}

func TestBuildEffectivelyHiddenIDs(t *testing.T) {
	// Tag 1 is hidden; descendants should all be hidden.
	tags := []models.Tag{
		{ID: 1, Slug: "tag1", Hidden: true},
		{ID: 2, Slug: "tag2"},
		{ID: 3, Slug: "tag3"},
	}
	rels := []repository.TagRelationship{
		{ParentID: 1, ChildID: 2},
		{ParentID: 2, ChildID: 3},
	}

	hidden := buildEffectivelyHiddenIDs(tags, rels)
	if !hidden[1] {
		t.Error("tag 1 should be hidden (Hidden=true)")
	}
	if !hidden[2] {
		t.Error("tag 2 should be hidden (descendant)")
	}
	if !hidden[3] {
		t.Error("tag 3 should be hidden (grandparent propagation)")
	}

	// Tag not connected to a hidden tag should not be hidden.
	tags2 := []models.Tag{
		{ID: 10, Slug: "tag10"},
		{ID: 11, Slug: "tag11"},
	}
	rels2 := []repository.TagRelationship{{ParentID: 10, ChildID: 11}}
	hidden2 := buildEffectivelyHiddenIDs(tags2, rels2)
	if hidden2[10] {
		t.Error("tag 10 should NOT be hidden")
	}
	if hidden2[11] {
		t.Error("tag 11 should NOT be hidden")
	}
}

func TestBuildEffectivelyHiddenPostsTagIDs(t *testing.T) {
	// Tag 1 hides posts; descendants should all hide posts.
	tags := []models.Tag{
		{ID: 1, Slug: "tag1", HidesPosts: true},
		{ID: 2, Slug: "tag2"},
		{ID: 3, Slug: "tag3"},
	}
	rels := []repository.TagRelationship{
		{ParentID: 1, ChildID: 2},
		{ParentID: 2, ChildID: 3},
	}

	hiddenPosts := buildEffectivelyHiddenPostsTagIDs(tags, rels)
	if !hiddenPosts[1] {
		t.Error("tag 1 should hide posts (HidesPosts=true)")
	}
	if !hiddenPosts[2] {
		t.Error("tag 2 should hide posts (inherited from tag 1)")
	}
	if !hiddenPosts[3] {
		t.Error("tag 3 should hide posts (inherited via chain)")
	}
}

func TestTagService_EffectivelyHidden(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	svc := NewTagService(repo)
	ctx := context.Background()

	// Empty DB — both return empty maps without error
	hiddenPosts, err := svc.EffectivelyHiddenPostsTagIDs(ctx)
	if err != nil {
		t.Fatalf("EffectivelyHiddenPostsTagIDs failed: %v", err)
	}
	if len(hiddenPosts) != 0 {
		t.Errorf("expected empty map, got %v", hiddenPosts)
	}

	hidden, err := svc.EffectivelyHiddenIDs(ctx)
	if err != nil {
		t.Fatalf("EffectivelyHiddenIDs failed: %v", err)
	}
	if len(hidden) != 0 {
		t.Errorf("expected empty map, got %v", hidden)
	}

	// Set up a tag with hidden=true and make another tag its child.
	_, _ = repo.DB().Exec(`INSERT INTO tags (name, slug, hidden, post_count) VALUES ('Hidden','hiddentag',1,0)`)
	_, _ = repo.DB().Exec(`INSERT INTO tags (name, slug, post_count) VALUES ('Secret','secret',0)`)
	_, _ = repo.DB().Exec(`
		INSERT INTO tag_relationships (parent_id, child_id)
		SELECT h.id, s.id FROM tags h, tags s WHERE h.slug='hiddentag' AND s.slug='secret'`)

	var secretID int64
	_ = repo.DB().QueryRow(`SELECT id FROM tags WHERE slug='secret'`).Scan(&secretID)

	hidden, err = svc.EffectivelyHiddenIDs(ctx)
	if err != nil {
		t.Fatalf("EffectivelyHiddenIDs (with data) failed: %v", err)
	}
	if !hidden[secretID] {
		t.Errorf("expected secret tag (id=%d) to be hidden", secretID)
	}
}

func TestTagService_GetHierarchicalNavTags(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	svc := NewTagService(repo)
	ctx := context.Background()

	// Empty DB
	nodes, err := svc.GetHierarchicalNavTags(ctx, nil, true, 0)
	if err != nil {
		t.Fatalf("GetHierarchicalNavTags (empty) failed: %v", err)
	}
	if nodes == nil {
		t.Error("expected non-nil slice")
	}

	// With tags
	parent, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Travel"})
	child, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Europe"})
	_ = svc.SetTagParents(ctx, child.ID, []int64{parent.ID})

	// Public mode (no hidden)
	nodes, err = svc.GetHierarchicalNavTags(ctx, nil, true, 0)
	if err != nil {
		t.Fatalf("GetHierarchicalNavTags (public) failed: %v", err)
	}
	_ = nodes

	// Admin mode
	nodes, err = svc.GetHierarchicalNavTags(ctx, nil, false, 0)
	if err != nil {
		t.Fatalf("GetHierarchicalNavTags (admin) failed: %v", err)
	}
	_ = nodes

	// With rootID (children of parent)
	nodes, err = svc.GetHierarchicalNavTags(ctx, &parent.ID, false, 0)
	if err != nil {
		t.Fatalf("GetHierarchicalNavTags (rootID) failed: %v", err)
	}
	_ = nodes

	// Public mode (filtering hidden)
	nodes, err = svc.GetHierarchicalNavTags(ctx, nil, true, 0)
	if err != nil {
		t.Fatalf("GetHierarchicalNavTags (public) failed: %v", err)
	}
	_ = nodes
}

func TestTagService_ListTagsPublicOnly(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	svc := NewTagService(repo)
	ctx := context.Background()

	// Create a visible tag and a hidden tag
	visible, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Visible"})
	_, _ = svc.CreateTag(ctx, CreateTagParams{Name: "Hidden"})

	// publicOnly=false: should return both
	all, err := svc.ListTags(ctx, true, false)
	if err != nil {
		t.Fatalf("ListTags failed: %v", err)
	}
	if len(all) < 2 {
		t.Errorf("expected at least 2 tags, got %d", len(all))
	}

	// publicOnly=true: hidden tag should be filtered out
	public, err := svc.ListTags(ctx, true, true)
	if err != nil {
		t.Fatalf("ListTags (public) failed: %v", err)
	}
	// Verify visible tag appears and no system tags appear.
	found := false
	for _, tag := range public {
		if tag.ID == visible.ID {
			found = true
		}
		if strings.HasPrefix(tag.Slug, "_") {
			t.Errorf("system tag appeared in publicOnly results: %s", tag.Name)
		}
	}
	if !found {
		t.Error("visible tag not found in public listing")
	}
}

func TestTagService_GetTagChildrenPublicOnly(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	svc := NewTagService(repo)
	ctx := context.Background()

	parent, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Parent"})
	child, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Child"})
	_, _ = svc.CreateTag(ctx, CreateTagParams{Name: "HiddenChild"})

	// Set up relationships
	_ = svc.SetTagParents(ctx, child.ID, []int64{parent.ID})

	// Without publicOnly
	children, err := svc.GetTagChildren(ctx, parent.ID, false, 0)
	if err != nil {
		t.Fatalf("GetTagChildren failed: %v", err)
	}
	_ = children

	// With publicOnly
	pubChildren, err := svc.GetTagChildren(ctx, parent.ID, true, 0)
	if err != nil {
		t.Fatalf("GetTagChildren (public) failed: %v", err)
	}
	_ = pubChildren
}

func TestTagService_GetHierarchicalNavTagsWithPosts(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	svc := NewTagService(repo)
	ctx := context.Background()

	parent, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Travel"})
	child, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Europe"})
	_ = svc.SetTagParents(ctx, child.ID, []int64{parent.ID})

	// Give child a post so it appears in nav (post_count > 0).
	_, _ = repo.DB().Exec(`INSERT INTO users (username, email, password_hash, display_name) VALUES ('nv','nv@t.com','h','NV')`)
	_, _ = repo.DB().Exec(`INSERT INTO posts (title, slug, content, author_id, status, published_at) VALUES ('P','p','',1,'published',datetime('now'))`)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (1, ?)`, child.ID)
	_ = svc.UpdateAllPostCounts(ctx)

	// Admin mode with rootID — child has posts so it appears.
	nodes, err := svc.GetHierarchicalNavTags(ctx, &parent.ID, false, 0)
	if err != nil {
		t.Fatalf("GetHierarchicalNavTags failed: %v", err)
	}
	if len(nodes) != 1 {
		t.Errorf("expected 1 child node, got %d", len(nodes))
	}

	// Public mode - parent tag with child
	nodes2, err := svc.GetHierarchicalNavTags(ctx, nil, true, 0)
	if err != nil {
		t.Fatalf("GetHierarchicalNavTags (public) failed: %v", err)
	}
	_ = nodes2
}

func TestTagService_GetTagCloudWithData(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	svc := NewTagService(repo)
	ctx := context.Background()

	// Create a tag, add a published post to it so hierarchical count > 0
	tag, _ := svc.CreateTag(ctx, CreateTagParams{Name: "CloudTag"})
	_, _ = repo.DB().Exec(`INSERT INTO users (username, email, password_hash, display_name) VALUES ('cu','cu@t','h','CU')`)
	var uid int64
	_ = repo.DB().QueryRow(`SELECT id FROM users WHERE username='cu'`).Scan(&uid)
	_, _ = repo.DB().Exec(`INSERT INTO posts (title, slug, content, author_id, status, published_at) VALUES ('CP','cp','',?,'published',datetime('now'))`, uid)
	var pid int64
	_ = repo.DB().QueryRow(`SELECT id FROM posts WHERE slug='cp'`).Scan(&pid)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (?,?)`, pid, tag.ID)

	// publicOnly=true with actual candidates (exercises the filtering loop)
	cloud, err := svc.GetTagCloud(ctx, 10, true, 0)
	if err != nil {
		t.Fatalf("GetTagCloud(public) failed: %v", err)
	}
	if len(cloud) != 1 {
		t.Errorf("expected 1 cloud item (public), got %d", len(cloud))
	}

	// publicOnly=false
	cloud2, err := svc.GetTagCloud(ctx, 10, false, 0)
	if err != nil {
		t.Fatalf("GetTagCloud(admin) failed: %v", err)
	}
	_ = cloud2

	// With limit=1 (exercises limit branch)
	cloud3, err := svc.GetTagCloud(ctx, 1, false, 0)
	if err != nil {
		t.Fatalf("GetTagCloud(limit=1) failed: %v", err)
	}
	if len(cloud3) > 1 {
		t.Errorf("expected at most 1 item with limit=1, got %d", len(cloud3))
	}
}

func TestTagService_UpdateMissingCoordsNoBaseTags(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	svc := NewTagService(repo)
	ctx := context.Background()

	// No base tags (city/country) exist — should return success with 0 updated
	result, err := svc.UpdateMissingCoords(ctx)
	if err != nil {
		t.Fatalf("UpdateMissingCoords failed: %v", err)
	}
	if result["updated_count"] != 0 {
		t.Errorf("expected 0 updated, got %v", result["updated_count"])
	}
}

func TestTagService_GetTagDescendants(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'P','parent'),(2,'C','child')`)
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (1,2)`)

	desc, err := svc.GetTagDescendants(ctx, 1)
	if err != nil {
		t.Fatalf("GetTagDescendants failed: %v", err)
	}
	if len(desc) != 1 {
		t.Errorf("expected 1 descendant, got %d", len(desc))
	}
}

func TestTagService_GetTagByID(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'T','t')`)

	tag, err := svc.GetTagByID(ctx, 1)
	if err != nil {
		t.Fatalf("GetTagByID failed: %v", err)
	}
	if tag.Slug != "t" {
		t.Errorf("expected slug 't', got %s", tag.Slug)
	}

	_, err = svc.GetTagByID(ctx, 999)
	if err == nil {
		t.Error("expected error for non-existent tag ID")
	}
}

func TestTagService_WithRelatedIDs(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	ids, err := svc.WithRelatedIDs(ctx)
	if err != nil {
		t.Fatalf("WithRelatedIDs failed: %v", err)
	}
	if len(ids) != 0 {
		t.Errorf("expected empty map, got %d entries", len(ids))
	}

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug, show_related) VALUES (20,'User','user', 1)`)

	ids, err = svc.WithRelatedIDs(ctx)
	if err != nil {
		t.Fatalf("WithRelatedIDs (with data) failed: %v", err)
	}
	if !ids[20] {
		t.Error("expected tag 20 in WithRelatedIDs result")
	}
}

func TestTagService_InBreadcrumbsIDs(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	ids, err := svc.InBreadcrumbsIDs(ctx)
	if err != nil {
		t.Fatalf("InBreadcrumbsIDs failed: %v", err)
	}
	if len(ids) != 0 {
		t.Errorf("expected empty map, got %d entries", len(ids))
	}

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug, in_breadcrumbs) VALUES (30,'User','user2', 1)`)

	ids, err = svc.InBreadcrumbsIDs(ctx)
	if err != nil {
		t.Fatalf("InBreadcrumbsIDs (with data) failed: %v", err)
	}
	if !ids[30] {
		t.Error("expected tag 30 in InBreadcrumbsIDs result")
	}
}

func TestTagService_SetTagParentsAndChildren(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'P','parent'),(2,'C','child')`)

	if err := svc.SetTagParents(ctx, 2, []int64{1}); err != nil {
		t.Fatalf("SetTagParents failed: %v", err)
	}
	if err := svc.SetTagChildren(ctx, 1, []int64{2}); err != nil {
		t.Fatalf("SetTagChildren failed: %v", err)
	}
	if err := svc.SetTagParents(ctx, 2, []int64{}); err != nil {
		t.Fatalf("SetTagParents (clear) failed: %v", err)
	}
	if err := svc.SetTagChildren(ctx, 1, []int64{}); err != nil {
		t.Fatalf("SetTagChildren (clear) failed: %v", err)
	}
}

func TestTagService_UpdateTag(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'Original','orig')`)

	updated, err := svc.UpdateTag(ctx, UpdateTagParams{
		ID: 1, Name: "Updated", Slug: "updated", Description: "desc",
	})
	if err != nil {
		t.Fatalf("UpdateTag failed: %v", err)
	}
	if updated.Name != "Updated" {
		t.Errorf("expected name 'Updated', got %s", updated.Name)
	}

	_, err = svc.UpdateTag(ctx, UpdateTagParams{ID: 999, Name: "X", Slug: "x"})
	if err == nil {
		t.Error("expected error for non-existent tag")
	}
}

func TestTagService_DeleteTag(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'T','t')`)

	if err := svc.DeleteTag(ctx, 1); err != nil {
		t.Fatalf("DeleteTag failed: %v", err)
	}
	if err := svc.DeleteTag(ctx, 999); err == nil {
		t.Error("expected error for non-existent tag")
	}
}

func TestTagService_GetTagBySlug(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'T','myslug')`)

	tag, err := svc.GetTagBySlug(ctx, "myslug")
	if err != nil {
		t.Fatalf("GetTagBySlug failed: %v", err)
	}
	if tag.Slug != "myslug" {
		t.Errorf("expected slug 'myslug', got %s", tag.Slug)
	}

	_, err = svc.GetTagBySlug(ctx, "nonexistent")
	if err == nil {
		t.Error("expected error for non-existent slug")
	}
}

func TestTagService_PageTagIDs(t *testing.T) {
	svc, repo := setupTagService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	// No hidden tags — should return empty map, not error
	ids, err := svc.PageTagIDs(ctx)
	if err != nil {
		t.Fatalf("PageTagIDs (no hidden tags) failed: %v", err)
	}
	if len(ids) != 0 {
		t.Errorf("expected empty map, got %d entries", len(ids))
	}

	// Create a hidden tag and a child tag
	_, _ = repo.DB().Exec(`INSERT INTO tags (id,name,slug,hidden) VALUES (200,'HiddenParent','hidden-parent',1)`)
	_, _ = repo.DB().Exec(`INSERT INTO tags (id,name,slug) VALUES (201,'About','about')`)
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id,child_id) VALUES (200,201)`)

	ids2, err := svc.PageTagIDs(ctx)
	if err != nil {
		t.Fatalf("PageTagIDs failed: %v", err)
	}
	if !ids2[201] {
		t.Errorf("expected tag 201 to be a page tag ID (inherited from hidden parent)")
	}
}

func TestTagService_CycleRejection(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()
	service := NewTagService(repo)
	ctx := context.Background()

	// Create tags: A, B, C
	tagA, _ := service.CreateTag(ctx, CreateTagParams{Name: "A", Slug: "a"})
	tagB, _ := service.CreateTag(ctx, CreateTagParams{Name: "B", Slug: "b"})
	tagC, _ := service.CreateTag(ctx, CreateTagParams{Name: "C", Slug: "c"})

	// Create hierarchy: A -> B -> C
	_ = repo.AddTagRelationship(ctx, models.AddTagRelationshipParams{ParentID: tagA.ID, ChildID: tagB.ID})
	_ = repo.AddTagRelationship(ctx, models.AddTagRelationshipParams{ParentID: tagB.ID, ChildID: tagC.ID})

	// Try to add C -> A (should fail)
	err := service.SetTagParents(ctx, tagA.ID, []int64{tagC.ID})
	if err == nil {
		t.Error("expected error when creating cycle C -> A -> B -> C, but got nil")
	} else {
		he, ok := err.(*echo.HTTPError)
		if !ok || he.Code != http.StatusConflict {
			t.Errorf("expected 409 Conflict, got %v", err)
		} else {
			t.Logf("Got expected error (Parents): %v", he.Message)
		}
	}

	// Try to add A -> C as a child of C (should fail)
	// A -> B -> C already exists. Adding A as a child of C means C -> A.
	err = service.SetTagChildren(ctx, tagC.ID, []int64{tagA.ID})
	if err == nil {
		t.Error("expected error when creating cycle A -> C -> B -> A, but got nil")
	} else {
		he, ok := err.(*echo.HTTPError)
		if !ok || he.Code != http.StatusConflict {
			t.Errorf("expected 409 Conflict, got %v", err)
		} else {
			t.Logf("Got expected error (Children): %v", he.Message)
		}
	}

	// Try direct AddTagRelationship
	err = service.AddTagRelationship(ctx, tagC.ID, tagA.ID)
	if err == nil {
		t.Error("expected error when creating cycle C -> A -> B -> C via AddTagRelationship, but got nil")
	} else {
		he, ok := err.(*echo.HTTPError)
		if !ok || he.Code != http.StatusConflict {
			t.Errorf("expected 409 Conflict, got %v", err)
		} else {
			t.Logf("Got expected error (AddTagRelationship): %v", he.Message)
		}
	}
}
