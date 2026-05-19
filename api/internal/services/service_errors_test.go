package services

import (
	"context"
	"os"
	"testing"
)

func TestPostService_Render(t *testing.T) {
	service, repo := setupPostService(t)
	defer func() {
		_ = repo.Close()
	}()

	// 1. Plain text rendering
	html, _ := service.RenderContent("hello world")
	if html != "<p>hello world</p>\n" {
		t.Errorf("expected <p>hello world</p>\\n, got %s", html)
	}

	// 2. Media rendering (embedded in content)
	// Add media record so it can be resolved by UpdateMediaVisibilityForPaths if called
	// but RenderContent itself is mostly about markdown for now.
}

func TestPostService_PreviewToken(t *testing.T) {
	service, repo := setupPostService(t)
	defer func() {
		_ = repo.Close()
	}()

	ctx := context.Background()

	// 1. Create a draft post
	_, _ = repo.DB().Exec(`INSERT INTO users (username, email, password_hash, display_name) VALUES ('u','u@t.com','h','U')`)
	post, _ := service.CreatePost(ctx, CreatePostParams{
		Title:    "Draft",
		Slug:     "draft",
		Content:  "content",
		AuthorID: 1,
		Status:   "draft",
	})

	// 2. Generate preview link
	link, _, err := service.GeneratePreviewLink(ctx, post.ID)
	if err != nil {
		t.Fatalf("GeneratePreviewLink failed: %v", err)
	}
	if link == "" {
		t.Error("expected non-empty preview link")
	}

	// 3. Get by token
	fetched, err := service.GetPostByPreviewToken(ctx, link)
	if err != nil {
		t.Fatalf("GetPostByPreviewToken failed: %v", err)
	}
	if fetched.ID != post.ID {
		t.Error("ID mismatch")
	}

	// 4. Invalid token
	_, err = service.GetPostByPreviewToken(ctx, "invalid-token")
	if err == nil {
		t.Error("expected error for invalid token")
	}
}

func TestPostService_ListPosts(t *testing.T) {
	service, repo := setupPostService(t)
	defer func() {
		_ = repo.Close()
	}()

	ctx := context.Background()

	// Setup: create multiple posts with different statuses
	_, _ = repo.DB().Exec(`INSERT INTO users (username, email, password_hash, display_name) VALUES ('u','u@t.com','h','U')`)
	// 1 published
	_, _ = repo.DB().Exec(`INSERT INTO posts (title, slug, content, author_id, status, published_at) VALUES ('P1','p1','b',1,'published',datetime('now'))`)
	// 1 draft
	_, _ = repo.DB().Exec(`INSERT INTO posts (title, slug, content, author_id, status) VALUES ('D1','d1','b',1,'draft')`)

	// List only published
	posts, total, _ := service.ListPosts(ctx, ListPostsParams{
		Page:    1,
		PerPage: 10,
		Status:  "published",
	})
	if total != 1 {
		t.Errorf("expected 1 published post, got %d", total)
	}
	if posts[0].Status != "published" {
		t.Errorf("expected status published, got %s", posts[0].Status)
	}

	// List all (admin)
	_, total, _ = service.ListPosts(ctx, ListPostsParams{
		Page:          1,
		PerPage:       10,
		IncludeDrafts: true,
	})
	if total != 2 {
		t.Errorf("expected 2 total posts, got %d", total)
	}
}

func TestSettingsService_Defaults(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	service := NewSettingsService(repo)
	ctx := context.Background()

	// 1. Get nonexistent setting with default
	val, _ := service.GetSetting(ctx, "site_name", "Point Blog")
	if val != "Point Blog" {
		t.Errorf("expected default Point Blog, got %s", val)
	}

	// 2. Set it
	_ = service.SetSetting(ctx, "site_name", "My Own Blog", "string")

	// 3. Get it again
	val, _ = service.GetSetting(ctx, "site_name", "Point Blog")
	if val != "My Own Blog" {
		t.Errorf("expected My Own Blog, got %s", val)
	}

	// 4. GetAllSettings (with data)
	settings, _ := service.GetAllSettings(ctx)
	if settings["site_name"] != "My Own Blog" {
		t.Error("site_name missing from GetAllSettings")
	}
}

// TestServiceDBErrors covers DB error paths by closing the DB before operations.
func TestServiceDBErrors(t *testing.T) {
	svc, repo := setupTagService(t)
	ctx := context.Background()

	// Insert minimal data.
	_, _ = repo.DB().Exec(`INSERT INTO users (id,username,email,password_hash,display_name) VALUES (1,'u','u@t.com','h','U')`)
	_, _ = repo.DB().Exec(`INSERT INTO tags (id,name,slug,post_count) VALUES (1,'T1','t1',1)`)

	// Close the DB — all service calls will fail.
	_ = repo.Close()

	// Tag service errors.
	if _, err := svc.ListTags(ctx, false, false); err == nil {
		t.Error("ListTags: expected error")
	}
	if _, err := svc.GetTagByID(ctx, 1); err == nil {
		t.Error("GetTagByID: expected error")
	}
	if _, err := svc.GetTagCloud(ctx, 10, false, 0); err == nil {
		t.Error("GetTagCloud: expected error")
	}
	if _, err := svc.EffectivelyHiddenIDs(ctx); err == nil {
		t.Error("EffectivelyHiddenIDs: expected error")
	}
	if _, err := svc.EffectivelyHiddenPostsTagIDs(ctx); err == nil {
		t.Error("EffectivelyHiddenPostsTagIDs: expected error")
	}
	if _, err := svc.InBreadcrumbsIDs(ctx); err == nil {
		t.Error("InBreadcrumbsIDs: expected error")
	}
	if _, err := svc.WithRelatedIDs(ctx); err == nil {
		t.Error("WithRelatedIDs: expected error")
	}
	if _, err := svc.GetHierarchicalNavTags(ctx, nil, true, 0); err == nil {
		t.Error("GetHierarchicalNavTags: expected error")
	}
}

// TestServiceDBErrors2 covers more DB error paths by closing the DB before service calls.
func TestServiceDBErrors2(t *testing.T) {
	mediaSvc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir) }()
	tagSvc := NewTagService(mediaSvc.repo)
	authSvc := NewAuthService(mediaSvc.repo)
	settingsSvc := NewSettingsService(mediaSvc.repo)
	postSvc := NewPostService(mediaSvc.repo)
	ctx := context.Background()

	// Insert some data before closing.
	_, _ = mediaSvc.repo.DB().Exec(`INSERT INTO users (id,username,email,password_hash,display_name) VALUES (1,'u','u@t.com','h','U')`)
	_, _ = mediaSvc.repo.DB().Exec(`INSERT INTO tags (id,name,slug,post_count) VALUES (1,'T','t',0)`)
	hash, _ := HashPassword("pass123")
	_, _ = mediaSvc.repo.DB().Exec(`UPDATE users SET password_hash=? WHERE id=1`, hash)

	// Close DB — all calls from here return errors.
	_ = mediaSvc.repo.Close()

	// MediaService errors.
	if _, err := mediaSvc.GetStorageUsage(ctx); err == nil {
		t.Error("GetStorageUsage: expected error")
	}
	if _, _, err := mediaSvc.ListMedia(ctx, ListMediaParams{Page: 1, PerPage: 10}); err == nil {
		t.Error("ListMedia: expected error")
	}
	if _, _, err := mediaSvc.ListOrphanedMedia(ctx, 1, 10); err == nil {
		t.Error("ListOrphanedMedia: expected error")
	}
	if _, _, err := mediaSvc.CleanupOrphaned(ctx); err == nil {
		t.Error("CleanupOrphaned: expected error")
	}
	if _, err := mediaSvc.BulkDeleteMedia(ctx, []int64{1}); err == nil {
		t.Error("BulkDeleteMedia: expected error")
	}

	// TagService errors.
	if err := tagSvc.SetTagChildren(ctx, 1, []int64{1}); err == nil {
		t.Error("SetTagChildren: expected error")
	}

	// AuthService errors.
	if err := authSvc.ChangePassword(ctx, 1, "pass123", "new"); err == nil {
		t.Error("ChangePassword (DB closed): expected error")
	}

	// SettingsService errors.
	if _, err := settingsSvc.GetAllSettings(ctx); err == nil {
		t.Error("GetAllSettings: expected error")
	}

	// PostService errors.
	if _, _, err := postSvc.ListPosts(ctx, ListPostsParams{Page: 1, PerPage: 10}); err == nil {
		t.Error("ListPosts: expected error")
	}
}
