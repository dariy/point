package services

import (
	"context"
	"testing"

	"point-api/internal/models"
	"point-api/internal/repository"
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
		IsImportant: true,
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
		ID:          tag.ID,
		Name:        "Updated Tag",
		IsImportant: false,
	})
	if err != nil {
		t.Errorf("UpdateTag failed: %v", err)
	}
	if updated.Name != "Updated Tag" {
		t.Errorf("expected name Updated Tag, got %s", updated.Name)
	}

	// Test List
	tags, err := service.ListTags(ctx, true, false, false)
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
	posts, total, err := service.GetPostsByTag(ctx, 999, 1, 10, true, false)
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
	t1, _ := service.CreateTag(ctx, CreateTagParams{Name: "Tag 1", IsImportant: true})
	t2, _ := service.CreateTag(ctx, CreateTagParams{Name: "Tag 2", IsImportant: true})

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

	cloud, err := service.GetTagCloud(ctx, 10, false)
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
	children, err := service.GetTagChildren(ctx, parent.ID, false)
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
	children, err := svc.GetTagChildren(ctx, parent.ID, false)
	if err != nil || len(children) != 1 || children[0].ID != child.ID {
		t.Errorf("GetTagChildren after SetTagParents: got %v, err %v", children, err)
	}

	// SetTagChildren: parent now has child + child2
	if err := svc.SetTagChildren(ctx, parent.ID, []int64{child.ID, child2.ID}); err != nil {
		t.Fatalf("SetTagChildren failed: %v", err)
	}

	children, _ = svc.GetTagChildren(ctx, parent.ID, false)
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
	tags := []models.Tag{
		{ID: 1, IsHidden: true, IsHiddenPosts: true},
		{ID: 2, IsHidden: false, IsHiddenPosts: false},
		{ID: 3, IsHidden: false, IsHiddenPosts: false},
	}
	rels := []repository.TagRelationship{
		{ParentID: 1, ChildID: 2}, // 2 is child of hidden+hiddenPosts 1
		{ParentID: 2, ChildID: 3}, // 3 is grandchild
	}

	hidden := buildEffectivelyHiddenIDs(tags, rels)
	if !hidden[1] {
		t.Error("tag 1 should be hidden (direct)")
	}
	if !hidden[2] {
		t.Error("tag 2 should be hidden (parent is hidden+hiddenPosts)")
	}
	if !hidden[3] {
		t.Error("tag 3 should be hidden (grandparent propagation)")
	}

	// Tag with is_hidden=true but is_hidden_posts=false does NOT propagate
	tags2 := []models.Tag{
		{ID: 10, IsHidden: true, IsHiddenPosts: false},
		{ID: 11, IsHidden: false, IsHiddenPosts: false},
	}
	rels2 := []repository.TagRelationship{{ParentID: 10, ChildID: 11}}
	hidden2 := buildEffectivelyHiddenIDs(tags2, rels2)
	if !hidden2[10] {
		t.Error("tag 10 should be hidden (direct)")
	}
	if hidden2[11] {
		t.Error("tag 11 should NOT be hidden (parent is hidden but not hiddenPosts)")
	}
}

func TestBuildEffectivelyHiddenPostsTagIDs(t *testing.T) {
	tags := []models.Tag{
		{ID: 1, IsHiddenPosts: true},
		{ID: 2, IsHiddenPosts: false},
		{ID: 3, IsHiddenPosts: false},
	}
	rels := []repository.TagRelationship{
		{ParentID: 1, ChildID: 2},
		{ParentID: 2, ChildID: 3},
	}

	hiddenPosts := buildEffectivelyHiddenPostsTagIDs(tags, rels)
	if !hiddenPosts[1] {
		t.Error("tag 1 should hide posts (direct)")
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

	// With a hidden tag
	_, _ = repo.DB().Exec(`INSERT INTO tags (name, slug, is_hidden, is_hidden_posts) VALUES ('Secret','secret',1,1)`)

	hidden, err = svc.EffectivelyHiddenIDs(ctx)
	if err != nil {
		t.Fatalf("EffectivelyHiddenIDs (with data) failed: %v", err)
	}
	if !hidden[1] {
		t.Error("expected tag 1 to be hidden")
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
	nodes, err := svc.GetHierarchicalNavTags(ctx, nil, true)
	if err != nil {
		t.Fatalf("GetHierarchicalNavTags (empty) failed: %v", err)
	}
	if nodes == nil {
		t.Error("expected non-nil slice")
	}

	// With tags
	parent, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Travel", IsImportant: true})
	child, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Europe"})
	_ = svc.SetTagParents(ctx, child.ID, []int64{parent.ID})

	// Public mode (no hidden)
	nodes, err = svc.GetHierarchicalNavTags(ctx, nil, true)
	if err != nil {
		t.Fatalf("GetHierarchicalNavTags (public) failed: %v", err)
	}
	_ = nodes

	// Admin mode
	nodes, err = svc.GetHierarchicalNavTags(ctx, nil, false)
	if err != nil {
		t.Fatalf("GetHierarchicalNavTags (admin) failed: %v", err)
	}
	_ = nodes

	// With rootID (children of parent)
	nodes, err = svc.GetHierarchicalNavTags(ctx, &parent.ID, false)
	if err != nil {
		t.Fatalf("GetHierarchicalNavTags (rootID) failed: %v", err)
	}
	_ = nodes

	// Public mode (filtering hidden)
	nodes, err = svc.GetHierarchicalNavTags(ctx, nil, true)
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
	visible, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Visible", IsHidden: false})
	_, _ = svc.CreateTag(ctx, CreateTagParams{Name: "Hidden", IsHidden: true})

	// publicOnly=false: should return both
	all, err := svc.ListTags(ctx, true, false, false)
	if err != nil {
		t.Fatalf("ListTags failed: %v", err)
	}
	if len(all) < 2 {
		t.Errorf("expected at least 2 tags, got %d", len(all))
	}

	// publicOnly=true: hidden tag should be filtered out
	public, err := svc.ListTags(ctx, true, false, true)
	if err != nil {
		t.Fatalf("ListTags (public) failed: %v", err)
	}
	for _, tag := range public {
		if tag.ID == visible.ID && !tag.IsHidden {
			continue // expected
		}
		if tag.IsHidden {
			t.Errorf("hidden tag appeared in publicOnly results: %s", tag.Name)
		}
	}
}

func TestTagService_GetTagChildrenPublicOnly(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	svc := NewTagService(repo)
	ctx := context.Background()

	parent, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Parent", IsHidden: false})
	child, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Child", IsHidden: false})
	_, _ = svc.CreateTag(ctx, CreateTagParams{Name: "HiddenChild", IsHidden: true})

	// Set up relationships
	_ = svc.SetTagParents(ctx, child.ID, []int64{parent.ID})

	// Without publicOnly
	children, err := svc.GetTagChildren(ctx, parent.ID, false)
	if err != nil {
		t.Fatalf("GetTagChildren failed: %v", err)
	}
	_ = children

	// With publicOnly
	pubChildren, err := svc.GetTagChildren(ctx, parent.ID, true)
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

	// Create featured tags so they appear in nav (featured bypasses PostCount=0 filter)
	parent, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Travel", IsFeatured: true})
	child, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Europe", IsFeatured: true})
	_ = svc.SetTagParents(ctx, child.ID, []int64{parent.ID})

	// Admin mode with rootID
	nodes, err := svc.GetHierarchicalNavTags(ctx, &parent.ID, false)
	if err != nil {
		t.Fatalf("GetHierarchicalNavTags failed: %v", err)
	}
	// parent has 1 featured child
	if len(nodes) != 1 {
		t.Errorf("expected 1 child node, got %d", len(nodes))
	}

	// Public mode - parent tag with child
	nodes2, err := svc.GetHierarchicalNavTags(ctx, nil, true)
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
	tag, _ := svc.CreateTag(ctx, CreateTagParams{Name: "CloudTag", IsImportant: true})
	_, _ = repo.DB().Exec(`INSERT INTO users (username, email, password_hash, display_name) VALUES ('cu','cu@t','h','CU')`)
	var uid int64
	_ = repo.DB().QueryRow(`SELECT id FROM users WHERE username='cu'`).Scan(&uid)
	_, _ = repo.DB().Exec(`INSERT INTO posts (title, slug, content, author_id, status, published_at) VALUES ('CP','cp','',?,'published',datetime('now'))`, uid)
	var pid int64
	_ = repo.DB().QueryRow(`SELECT id FROM posts WHERE slug='cp'`).Scan(&pid)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (?,?)`, pid, tag.ID)

	// publicOnly=true with actual candidates (exercises the filtering loop)
	cloud, err := svc.GetTagCloud(ctx, 10, true)
	if err != nil {
		t.Fatalf("GetTagCloud(public) failed: %v", err)
	}
	if len(cloud) != 1 {
		t.Errorf("expected 1 cloud item (public), got %d", len(cloud))
	}

	// publicOnly=false
	cloud2, err := svc.GetTagCloud(ctx, 10, false)
	if err != nil {
		t.Fatalf("GetTagCloud(admin) failed: %v", err)
	}
	_ = cloud2

	// With limit=1 (exercises limit branch)
	cloud3, err := svc.GetTagCloud(ctx, 1, false)
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
