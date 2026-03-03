package services

import (
	"context"
	"testing"

	"point-api/internal/models"
)

func TestTagService_CRUD(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()

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
	defer repo.Close()

	service := NewTagService(repo)
	ctx := context.Background()

	// Create some tags with different post counts
	t1, _ := service.CreateTag(ctx, CreateTagParams{Name: "Tag 1"})
	t2, _ := service.CreateTag(ctx, CreateTagParams{Name: "Tag 2"})

	// Manually update post counts for testing (since we don't have posts yet)
	_, _ = repo.DB().Exec("UPDATE tags SET post_count = 10 WHERE id = ?", t1.ID)
	_, _ = repo.DB().Exec("UPDATE tags SET post_count = 5 WHERE id = ?", t2.ID)

	cloud, err := service.GetTagCloud(ctx, 10, false)
	if err != nil {
		t.Fatalf("GetTagCloud failed: %v", err)
	}

	if len(cloud) != 2 {
		t.Errorf("expected 2 cloud items, got %d", len(cloud))
	}

	// Check weights
	for _, item := range cloud {
		if item.ID == t1.ID {
			if item.Weight != 1.0 {
				t.Errorf("expected weight 1.0 for Tag 1, got %f", item.Weight)
			}
		} else if item.ID == t2.ID {
			if item.Weight != 0.5 {
				t.Errorf("expected weight 0.5 for Tag 2, got %f", item.Weight)
			}
		}
	}
}

func TestTagService_Hierarchy(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()

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
