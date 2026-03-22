package services

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"image"
	"image/jpeg"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"point-api/internal/config"
	"point-api/internal/repository"
)

// TestPostService_ListPublishedPostStubs covers the 0% function.
func TestPostService_ListPublishedPostStubs(t *testing.T) {
	svc, repo := setupPostService(t)
	defer repo.Close()
	ctx := context.Background()

	stubs, err := svc.ListPublishedPostStubs(ctx)
	if err != nil {
		t.Fatalf("ListPublishedPostStubs failed: %v", err)
	}
	// Empty DB returns empty slice (may be nil)
	_ = stubs

	// Add a published post and verify it appears
	_, _ = repo.DB().Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'u','u@t.com','h','U')`)
	_, _ = repo.DB().Exec(`INSERT INTO posts (title, slug, content, author_id, status, published_at) VALUES ('T','s','b',1,'published',datetime('now'))`)

	stubs, err = svc.ListPublishedPostStubs(ctx)
	if err != nil {
		t.Fatalf("ListPublishedPostStubs (with data) failed: %v", err)
	}
	if len(stubs) != 1 {
		t.Errorf("expected 1 stub, got %d", len(stubs))
	}
}

// TestTagService_GetTagDescendants covers 0% function.
func TestTagService_GetTagDescendants(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
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

// TestTagService_GetTagByID covers 50% function.
func TestTagService_GetTagByID(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
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

// TestTagService_WithRelatedIDs covers 0% function.
func TestTagService_WithRelatedIDs(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
	ctx := context.Background()

	// No _with_related system tag → returns empty map
	ids, err := svc.WithRelatedIDs(ctx)
	if err != nil {
		t.Fatalf("WithRelatedIDs failed: %v", err)
	}
	if len(ids) != 0 {
		t.Errorf("expected empty map, got %d entries", len(ids))
	}

	// Add system tag and relationship
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (10,'_with_related','_with_related'),(20,'User','user')`)
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (10,20)`)

	ids, err = svc.WithRelatedIDs(ctx)
	if err != nil {
		t.Fatalf("WithRelatedIDs (with data) failed: %v", err)
	}
	if !ids[20] {
		t.Error("expected tag 20 in WithRelatedIDs result")
	}
}

// TestTagService_InBreadcrumbsIDs covers 0% function.
func TestTagService_InBreadcrumbsIDs(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
	ctx := context.Background()

	// No _is_in_breadcrumbs → empty
	ids, err := svc.InBreadcrumbsIDs(ctx)
	if err != nil {
		t.Fatalf("InBreadcrumbsIDs failed: %v", err)
	}
	if len(ids) != 0 {
		t.Errorf("expected empty map, got %d entries", len(ids))
	}

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (10,'_is_in_breadcrumbs','_is_in_breadcrumbs'),(30,'User','user2')`)
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (10,30)`)

	ids, err = svc.InBreadcrumbsIDs(ctx)
	if err != nil {
		t.Fatalf("InBreadcrumbsIDs (with data) failed: %v", err)
	}
	if !ids[30] {
		t.Error("expected tag 30 in InBreadcrumbsIDs result")
	}
}

// TestTagService_SetTagParentsAndChildren covers 66.7% functions.
func TestTagService_SetTagParentsAndChildren(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'P','parent'),(2,'C','child')`)

	// SetTagParents
	err := svc.SetTagParents(ctx, 2, []int64{1})
	if err != nil {
		t.Fatalf("SetTagParents failed: %v", err)
	}

	// SetTagChildren
	err = svc.SetTagChildren(ctx, 1, []int64{2})
	if err != nil {
		t.Fatalf("SetTagChildren failed: %v", err)
	}

	// SetTagParents with empty list clears parents
	err = svc.SetTagParents(ctx, 2, []int64{})
	if err != nil {
		t.Fatalf("SetTagParents (clear) failed: %v", err)
	}

	// SetTagChildren with empty list clears children
	err = svc.SetTagChildren(ctx, 1, []int64{})
	if err != nil {
		t.Fatalf("SetTagChildren (clear) failed: %v", err)
	}
}

// TestTagService_UpdateTag covers 64.3% function.
func TestTagService_UpdateTag(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'Original','orig')`)

	updated, err := svc.UpdateTag(ctx, UpdateTagParams{
		ID:          1,
		Name:        "Updated",
		Slug:        "updated",
		Description: "desc",
	})
	if err != nil {
		t.Fatalf("UpdateTag failed: %v", err)
	}
	if updated.Name != "Updated" {
		t.Errorf("expected name 'Updated', got %s", updated.Name)
	}

	// Update non-existent tag
	_, err = svc.UpdateTag(ctx, UpdateTagParams{ID: 999, Name: "X", Slug: "x"})
	if err == nil {
		t.Error("expected error for non-existent tag")
	}
}

// TestTagService_DeleteTag covers 66.7% function.
func TestTagService_DeleteTag(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'T','t')`)

	err := svc.DeleteTag(ctx, 1)
	if err != nil {
		t.Fatalf("DeleteTag failed: %v", err)
	}

	// Delete non-existent
	err = svc.DeleteTag(ctx, 999)
	if err == nil {
		t.Error("expected error for non-existent tag")
	}
}

// TestTagService_GetTagBySlug covers 66.7% function.
func TestTagService_GetTagBySlug(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
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


// TestMediaService_ImportFromPath covers 0% function.
func TestMediaService_ImportFromPath(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		os.RemoveAll(tmpDir)
		svc.repo.Close()
	}()
	ctx := context.Background()

	// Non-existent file
	_, err := svc.ImportFromPath(ctx, "/nonexistent/file.jpg")
	if err == nil {
		t.Error("expected error for non-existent file")
	}

	// Valid image file
	img := image.NewRGBA(image.Rect(0, 0, 10, 10))
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, nil)

	srcPath := filepath.Join(tmpDir, "import_test.jpg")
	_ = os.WriteFile(srcPath, buf.Bytes(), 0644)

	m, err := svc.ImportFromPath(ctx, srcPath)
	if err != nil {
		t.Fatalf("ImportFromPath failed: %v", err)
	}
	if m.Filename != "import_test.jpg" {
		t.Errorf("expected filename 'import_test.jpg', got %s", m.Filename)
	}

	// Non-image file
	txtPath := filepath.Join(tmpDir, "doc.txt")
	_ = os.WriteFile(txtPath, []byte("hello"), 0644)
	m2, err := svc.ImportFromPath(ctx, txtPath)
	if err != nil {
		t.Fatalf("ImportFromPath (text) failed: %v", err)
	}
	if m2.FileType != "file" {
		t.Errorf("expected file type 'file', got %s", m2.FileType)
	}
}

// TestMediaService_BulkDeleteMedia covers 66.7% function.
func TestMediaService_BulkDeleteMedia(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		os.RemoveAll(tmpDir)
		svc.repo.Close()
	}()
	ctx := context.Background()

	// Upload some media
	img := image.NewRGBA(image.Rect(0, 0, 10, 10))
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, nil)

	m1, _ := svc.UploadFile(ctx, UploadFileParams{Content: buf.Bytes(), Filename: "b1.jpg", MimeType: "image/jpeg"})
	m2, _ := svc.UploadFile(ctx, UploadFileParams{Content: buf.Bytes(), Filename: "b2.jpg", MimeType: "image/jpeg"})

	_, err := svc.BulkDeleteMedia(ctx, []int64{m1.ID, m2.ID})
	if err != nil {
		t.Fatalf("BulkDeleteMedia failed: %v", err)
	}

	// Empty list - no-op
	_, err = svc.BulkDeleteMedia(ctx, []int64{})
	if err != nil {
		t.Fatalf("BulkDeleteMedia (empty) failed: %v", err)
	}
}

// TestMediaService_ImportFromPathVideo covers the video MIME type branch.
func TestMediaService_ImportFromPathVideo(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		os.RemoveAll(tmpDir)
		svc.repo.Close()
	}()
	ctx := context.Background()

	// Create a fake video file (mp4 extension, but fake content)
	videoPath := filepath.Join(tmpDir, "test.mp4")
	_ = os.WriteFile(videoPath, []byte("fake video content"), 0644)

	m, err := svc.ImportFromPath(ctx, videoPath)
	if err != nil {
		t.Fatalf("ImportFromPath (video) failed: %v", err)
	}
	if m.FileType != "video" {
		t.Errorf("expected file_type 'video', got %s", m.FileType)
	}
}

// TestMediaService_ImportFromPathUnknownExt covers the http.DetectContentType fallback.
func TestMediaService_ImportFromPathUnknownExt(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		os.RemoveAll(tmpDir)
		svc.repo.Close()
	}()
	ctx := context.Background()

	// No MIME type for .xyz extension
	unknownPath := filepath.Join(tmpDir, "data.xyz")
	_ = os.WriteFile(unknownPath, []byte("some binary data"), 0644)

	m, err := svc.ImportFromPath(ctx, unknownPath)
	if err != nil {
		t.Fatalf("ImportFromPath (unknown ext) failed: %v", err)
	}
	// Content sniffing should set some MIME type
	if m.MimeType == "" {
		t.Error("expected non-empty MIME type from sniffing")
	}
}

// TestMediaService_UpdateMediaWithPostID covers the PostID branch in UpdateMedia.
func TestMediaService_UpdateMediaWithPostID(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		os.RemoveAll(tmpDir)
		svc.repo.Close()
	}()
	ctx := context.Background()

	// Upload a file first
	m, _ := svc.UploadFile(ctx, UploadFileParams{Content: []byte("data"), Filename: "upd.txt", MimeType: "text/plain"})

	// Create a user and post for PostID linkage
	_, _ = svc.repo.DB().Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'u','u@t.com','h','U')`)
	_, _ = svc.repo.DB().Exec(`INSERT INTO posts (id, title, slug, content, author_id, status) VALUES (1,'P','p','b',1,'draft')`)

	postID := int64(1)
	updated, err := svc.UpdateMedia(ctx, UpdateMediaParams{
		ID:     m.ID,
		PostID: &postID,
	})
	if err != nil {
		t.Fatalf("UpdateMedia with PostID failed: %v", err)
	}
	if !updated.PostID.Valid || updated.PostID.Int64 != 1 {
		t.Errorf("expected PostID=1, got %+v", updated.PostID)
	}
}

// TestMediaService_RebuildThumbnailsOnlyMissing covers the onlyMissing=true "skipped" path.
func TestMediaService_RebuildThumbnailsOnlyMissing(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		os.RemoveAll(tmpDir)
		svc.repo.Close()
	}()
	ctx := context.Background()

	// Upload a real image (creates a thumbnail)
	img := image.NewRGBA(image.Rect(0, 0, 10, 10))
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, nil)
	_, _ = svc.UploadFile(ctx, UploadFileParams{Content: buf.Bytes(), Filename: "existing.jpg", MimeType: "image/jpeg"})

	// onlyMissing=true: image with existing thumbnail should be skipped
	stats, err := svc.RebuildThumbnails(ctx, true)
	if err != nil {
		t.Fatalf("RebuildThumbnails (onlyMissing) failed: %v", err)
	}
	if stats["skipped"] < 1 {
		t.Errorf("expected at least 1 skipped, got %d", stats["skipped"])
	}
}

// TestMediaService_RebuildThumbnailsSkip covers the "skipped" path (non-image file).
func TestMediaService_RebuildThumbnailsSkip(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		os.RemoveAll(tmpDir)
		svc.repo.Close()
	}()
	ctx := context.Background()

	// Upload a text file - it should be skipped during thumbnail rebuild
	_, _ = svc.UploadFile(ctx, UploadFileParams{Content: []byte("text"), Filename: "skip.txt", MimeType: "text/plain"})

	stats, err := svc.RebuildThumbnails(ctx, false)
	if err != nil {
		t.Fatalf("RebuildThumbnails (skip) failed: %v", err)
	}
	// Text files get skipped
	_ = stats
}

// TestMediaService_AnalyzeMediaByIDSuccess covers the file-read path (66.7% function).
func TestMediaService_AnalyzeMediaByIDSuccess(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		os.RemoveAll(tmpDir)
		svc.repo.Close()
	}()
	ctx := context.Background()

	// Upload a small valid image - file will exist on disk
	img := image.NewRGBA(image.Rect(0, 0, 5, 5))
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, nil)

	m, err := svc.UploadFile(ctx, UploadFileParams{
		Content:  buf.Bytes(),
		Filename: "analyze_me.jpg",
		MimeType: "image/jpeg",
	})
	if err != nil {
		t.Fatalf("UploadFile failed: %v", err)
	}

	// Call AnalyzeMediaByID on the valid image - will fail at AnalyzeImage
	// (no AI configured), but covers the file read path
	_, err = svc.AnalyzeMediaByID(ctx, m.ID)
	// Expected error: "GenAI API not configured"
	if err == nil {
		t.Error("expected error from AnalyzeMediaByID (no AI configured)")
	}
}

// TestTagService_GetTagBySlugNotFound covers the not-found path.
func TestTagService_GetTagBySlugNotFound(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
	ctx := context.Background()

	// Not found
	_, err := svc.GetTagBySlug(ctx, "doesnotexist")
	if err == nil {
		t.Error("expected error for non-existent slug")
	}

	// Found
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'T','found-slug')`)
	tag, err := svc.GetTagBySlug(ctx, "found-slug")
	if err != nil {
		t.Fatalf("GetTagBySlug found: %v", err)
	}
	if tag.Slug != "found-slug" {
		t.Errorf("expected slug 'found-slug', got %s", tag.Slug)
	}
}

// TestTagService_UpdateTagSystemSlug covers the system tag slug protection path.
func TestTagService_UpdateTagSystemSlug(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
	ctx := context.Background()

	// Try to update with a system slug (starts with _)
	_, err := svc.UpdateTag(ctx, UpdateTagParams{ID: 0, Name: "Bad", Slug: "_bad"})
	if err == nil {
		t.Error("expected error for slug starting with _")
	}

	// Update a system tag — slug is preserved, other fields updated
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (99,'_sys','_sys')`)
	tag, err := svc.UpdateTag(ctx, UpdateTagParams{ID: 99, Name: "NewName", Description: "desc"})
	if err != nil {
		t.Fatalf("UpdateTag system tag failed: %v", err)
	}
	// System tag slug preserved
	if tag.Slug != "_sys" {
		t.Errorf("expected slug '_sys', got %s", tag.Slug)
	}
}

// TestTagService_SetTagParentsWithInvalidID covers non-existent tag path.
func TestTagService_SetTagParentsWithInvalidID(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
	ctx := context.Background()

	// Non-existent tag
	err := svc.SetTagParents(ctx, 999, []int64{})
	if err == nil {
		t.Error("expected error for non-existent tag in SetTagParents")
	}
}

// TestMediaService_CleanupOrphanedWithData covers 80% CleanupOrphaned.
func TestMediaService_CleanupOrphanedWithData(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		os.RemoveAll(tmpDir)
		svc.repo.Close()
	}()
	ctx := context.Background()

	// Upload orphaned media (not linked to any post)
	_, err := svc.UploadFile(ctx, UploadFileParams{
		Content: []byte("data"), Filename: "orphan.txt", MimeType: "text/plain",
	})
	if err != nil {
		t.Fatalf("UploadFile failed: %v", err)
	}

	count, freed, err := svc.CleanupOrphaned(ctx)
	if err != nil {
		t.Fatalf("CleanupOrphaned failed: %v", err)
	}
	if count < 1 {
		t.Errorf("expected at least 1 cleaned, got %d", count)
	}
	_ = freed
}

// TestMediaService_ListOrphanedMediaWithData covers ListOrphanedMedia.
func TestMediaService_ListOrphanedMediaWithData(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		os.RemoveAll(tmpDir)
		svc.repo.Close()
	}()
	ctx := context.Background()

	_, _ = svc.UploadFile(ctx, UploadFileParams{
		Content: []byte("data"), Filename: "orphan2.txt", MimeType: "text/plain",
	})

	items, total, err := svc.ListOrphanedMedia(ctx, 1, 10)
	if err != nil {
		t.Fatalf("ListOrphanedMedia failed: %v", err)
	}
	if total < 1 {
		t.Errorf("expected at least 1 orphan, got %d", total)
	}
	_ = items
}

// TestMediaService_RecalculateAllMediaVisibilityBoost covers 80.6% function.
func TestMediaService_RecalculateAllMediaVisibilityBoost(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		os.RemoveAll(tmpDir)
		svc.repo.Close()
	}()
	ctx := context.Background()

	_, err := svc.RecalculateAllMediaVisibility(ctx)
	if err != nil {
		t.Fatalf("RecalculateAllMediaVisibility failed: %v", err)
	}
}

// TestTagService_GetHierarchicalNavTagsWithHidden tests the publicOnly+hidden path.
func TestTagService_GetHierarchicalNavTagsWithHidden(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
	ctx := context.Background()

	// Insert system tags needed for hierarchy
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug, post_count) VALUES
		(1,'_root','_root',0),
		(2,'_system','_system',0),
		(3,'_hidden','_hidden',0),
		(4,'Visible','visible',3),
		(5,'Hidden','hidden-tag',3)`)
	// _system → _hidden
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (2,3)`)
	// _root → Visible and Hidden
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (1,4),(1,5)`)
	// _hidden → Hidden tag (makes it effectively hidden)
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (3,5)`)

	nodes, err := svc.GetHierarchicalNavTags(ctx, nil, true, 0)
	if err != nil {
		t.Fatalf("GetHierarchicalNavTags (hidden) failed: %v", err)
	}
	// Should only show Visible, not Hidden
	for _, n := range nodes {
		if n.Slug == "hidden-tag" {
			t.Error("hidden tag should not appear in public nav")
		}
	}
	_ = nodes
}

// TestMediaService_RebuildThumbnailsWithImages covers 72.7% function more thoroughly.
func TestMediaService_RebuildThumbnailsWithImages(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		os.RemoveAll(tmpDir)
		svc.repo.Close()
	}()
	ctx := context.Background()

	// Upload a real image so rebuild can succeed
	img := image.NewRGBA(image.Rect(0, 0, 20, 20))
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, nil)
	m, _ := svc.UploadFile(ctx, UploadFileParams{Content: buf.Bytes(), Filename: "thumb.jpg", MimeType: "image/jpeg"})
	_ = m

	stats, err := svc.RebuildThumbnails(ctx, false)
	if err != nil {
		t.Fatalf("RebuildThumbnails failed: %v", err)
	}
	_ = stats
}

// TestTagService_EffectivelyHiddenBoost covers 71.4% functions.
func TestTagService_EffectivelyHiddenBoost(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
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

// TestNewMediaServiceWithAPIKey covers the api-key branch in NewMediaService and
// exercises analyzeImageDirectly with a fake key (which will fail at the API call).
func TestNewMediaServiceWithAPIKey(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()

	tmpDir := t.TempDir()
	cfg := &config.Config{
		StoragePath:    tmpDir,
		GeminiAPIKey:   "fake-key-for-coverage",
		ThumbnailWidth: 400, ThumbnailHeight: 300,
	}
	settings := NewSettingsService(repo)
	tags := NewTagService(repo)

	svc := NewMediaService(repo, cfg, settings, tags)
	if svc == nil {
		t.Fatal("expected non-nil service")
	}

	// If genaiClient was initialized (fake key, genai.NewClient may still succeed),
	// try to call AnalyzeImage to exercise analyzeImageDirectly code paths.
	// The call will fail (fake key rejected by API), but coverage is the goal.
	if svc.genaiClient != nil {
		ctx := context.Background()
		// Use a tiny image
		img := image.NewRGBA(image.Rect(0, 0, 5, 5))
		var buf bytes.Buffer
		_ = jpeg.Encode(&buf, img, nil)
		_, _ = svc.AnalyzeImage(ctx, buf.Bytes(), "test.jpg", "image/jpeg")
		// Error expected (fake key) — we don't check the error here.
	}
}

// TestTagService_GetHierarchicalNavTagsBoost covers 58% function with rootID.
func TestTagService_GetHierarchicalNavTagsBoost(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
	ctx := context.Background()

	// No data - empty result
	nodes, err := svc.GetHierarchicalNavTags(ctx, nil, false, 0)
	if err != nil {
		t.Fatalf("GetHierarchicalNavTags failed: %v", err)
	}
	_ = nodes

	// With rootID and publicOnly=true
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

// TestTagService_SetTagParentsSystemTag covers forbidden system tag path.
func TestTagService_SetTagParentsSystemTag(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'_system','_system')`)

	err := svc.SetTagParents(ctx, 1, []int64{})
	if err == nil {
		t.Error("expected error for re-parenting system tag")
	}
}

// TestTagService_SetTagChildrenSystemTag covers forbidden system child path.
func TestTagService_SetTagChildrenSystemTag(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'Parent','parent'),(2,'_sys','_sys')`)

	err := svc.SetTagChildren(ctx, 1, []int64{2})
	if err == nil {
		t.Error("expected error for system child tag")
	}
}

// TestTagService_CreateTagErrors covers CreateTag error paths.
func TestTagService_CreateTagErrors(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
	ctx := context.Background()

	// Slug starting with underscore should fail
	_, err := svc.CreateTag(ctx, CreateTagParams{Name: "_sys", Slug: "_sys"})
	if err == nil {
		t.Error("expected error for system slug")
	}

	// Auto-slug from name
	tag, err := svc.CreateTag(ctx, CreateTagParams{Name: "My Tag"})
	if err != nil {
		t.Fatalf("CreateTag (auto-slug) failed: %v", err)
	}
	if tag.Slug == "" {
		t.Error("expected auto-generated slug")
	}
}

// TestMediaService_UpdateMediaVisibilityForPathsBoost covers 73% function.
func TestMediaService_UpdateMediaVisibilityForPathsBoost(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		os.RemoveAll(tmpDir)
		svc.repo.Close()
	}()
	ctx := context.Background()

	err := svc.UpdateMediaVisibilityForPaths(ctx, []string{})
	if err != nil {
		t.Fatalf("UpdateMediaVisibilityForPaths (empty) failed: %v", err)
	}

	err = svc.UpdateMediaVisibilityForPaths(ctx, []string{"originals/2026/03/missing.jpg"})
	if err != nil {
		t.Fatalf("UpdateMediaVisibilityForPaths failed: %v", err)
	}
}

// TestMediaService_ListMedia covers 75% function.
func TestMediaService_ListMedia(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		os.RemoveAll(tmpDir)
		svc.repo.Close()
	}()
	ctx := context.Background()

	// Empty list
	items, total, err := svc.ListMedia(ctx, ListMediaParams{Page: 1, PerPage: 10})
	if err != nil {
		t.Fatalf("ListMedia failed: %v", err)
	}
	if total != 0 {
		t.Errorf("expected 0, got %d", total)
	}
	_ = items

	// With file type filter
	_, _, err = svc.ListMedia(ctx, ListMediaParams{Page: 1, PerPage: 10, FileType: "image"})
	if err != nil {
		t.Fatalf("ListMedia with filter failed: %v", err)
	}
}

// TestTagService_GetTagBySlugSystemPrefix covers the "_" prefix rejection path.
func TestTagService_GetTagBySlugSystemPrefix(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
	ctx := context.Background()

	_, err := svc.GetTagBySlug(ctx, "_system")
	if err == nil {
		t.Error("expected error for system slug, got nil")
	}
}

// TestSettingsService_GetConfigSettingEnvValue covers the envValue != 0 early return.
func TestSettingsService_GetConfigSettingEnvValue(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()
	ctx := context.Background()

	svc := NewSettingsService(repo)
	v := svc.GetConfigSetting(ctx, "some_key", 42, 0)
	if v != 42 {
		t.Errorf("expected 42, got %d", v)
	}

	// envValue == 0, raw setting set → should return parsed value
	_ = svc.SetSetting(ctx, "port_key", "8080", "string")
	v2 := svc.GetConfigSetting(ctx, "port_key", 0, 9999)
	if v2 != 8080 {
		t.Errorf("expected 8080, got %d", v2)
	}
}

// TestMediaService_AnalyzeImageViaHTTP exercises analyzeImageViaHTTP via a mock HTTP server.
func TestMediaService_AnalyzeImageViaHTTP(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		os.RemoveAll(tmpDir)
		svc.repo.Close()
	}()
	ctx := context.Background()

	// Start a mock GenAI HTTP endpoint.
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"title":"Test Title","tags":["a","b"],"excerpt":"desc"}`))
	}))
	defer mockServer.Close()

	// Configure the endpoint in settings.
	_ = svc.settingsService.SetSetting(ctx, "genai_api_endpoint", mockServer.URL, "string")

	// Tiny JPEG image.
	img := image.NewRGBA(image.Rect(0, 0, 5, 5))
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, nil)

	result, err := svc.AnalyzeImage(ctx, buf.Bytes(), "test.jpg", "image/jpeg")
	if err != nil {
		t.Fatalf("AnalyzeImage via HTTP failed: %v", err)
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}
}

// TestMediaService_AnalyzeImageViaHTTPError tests non-200 response path.
func TestMediaService_AnalyzeImageViaHTTPError(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		os.RemoveAll(tmpDir)
		svc.repo.Close()
	}()
	ctx := context.Background()

	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer mockServer.Close()

	_ = svc.settingsService.SetSetting(ctx, "genai_api_endpoint", mockServer.URL, "string")

	img := image.NewRGBA(image.Rect(0, 0, 5, 5))
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, nil)

	_, err := svc.AnalyzeImage(ctx, buf.Bytes(), "test.jpg", "image/jpeg")
	if err == nil {
		t.Error("expected error for non-200 response")
	}
}

// TestTagService_GetHierarchicalNavTagsDeep exercises the uncovered branches:
// _with_related detection, system slug filtering, sort_order comparison, cycle detection.
func TestTagService_GetHierarchicalNavTagsDeep(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
	ctx := context.Background()

	// _root(1), _with_related(2), _sys-child(3, system slug), Alpha(4, sort=2, 3 posts),
	// Beta(5, sort=1, 2 posts), Gamma(6, 0 posts no children → filtered out)
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug, post_count, sort_order) VALUES
		(1,'_root','_root',0,NULL),
		(2,'_with_related','_with_related',0,NULL),
		(3,'_sys-child','_sys-child',0,NULL),
		(4,'Alpha','alpha',3,2),
		(5,'Beta','beta',2,1),
		(6,'Gamma','gamma',0,NULL)`)

	// _root → _sys-child, Alpha, Beta, Gamma
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES
		(1,3),(1,4),(1,5),(1,6)`)
	// _with_related → Alpha (marks Alpha as related)
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (2,4)`)
	// Alpha → Beta (nested)
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (4,5)`)

	// nil rootID: exercises _root detection, _with_related, system slug skip,
	// Gamma skip (0 posts + no children), sort_order comparison
	nodes, err := svc.GetHierarchicalNavTags(ctx, nil, false, 0)
	if err != nil {
		t.Fatalf("GetHierarchicalNavTags deep: %v", err)
	}
	_ = nodes

	// publicOnly=true: exercises effectivelyHidden map path
	nodes, err = svc.GetHierarchicalNavTags(ctx, nil, true, 0)
	if err != nil {
		t.Fatalf("GetHierarchicalNavTags publicOnly: %v", err)
	}
	_ = nodes

	// With explicit rootID → uses else branch with actual children
	rootID := int64(1)
	nodes, err = svc.GetHierarchicalNavTags(ctx, &rootID, false, 0)
	if err != nil {
		t.Fatalf("GetHierarchicalNavTags rootID: %v", err)
	}
	_ = nodes

	// Cycle: Alpha points to itself → visited[cid] triggers continue
	_, _ = repo.DB().Exec(`INSERT OR IGNORE INTO tag_relationships (parent_id, child_id) VALUES (4,4)`)
	nodes, err = svc.GetHierarchicalNavTags(ctx, nil, false, 0)
	if err != nil {
		t.Fatalf("GetHierarchicalNavTags cycle: %v", err)
	}
	_ = nodes
}

// TestTagService_EffectivelyHiddenWithData covers EffectivelyHiddenPostsTagIDs
// and EffectivelyHiddenIDs when tags exist (exercises the build functions with data).
func TestTagService_EffectivelyHiddenWithData(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
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

// TestTagService_CreateTagSystemSlug covers the "_" prefix rejection.
func TestTagService_CreateTagSystemSlug(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
	ctx := context.Background()

	_, err := svc.CreateTag(ctx, CreateTagParams{Name: "_bad", Slug: "_bad"})
	if err == nil {
		t.Error("expected error for system slug")
	}
}

// TestTagService_CreateTagWithSortOrder covers the SortOrder != nil branch.
func TestTagService_CreateTagWithSortOrder(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
	ctx := context.Background()

	sortOrder := int32(5)
	tag, err := svc.CreateTag(ctx, CreateTagParams{
		Name:      "Ordered",
		Slug:      "ordered",
		SortOrder: &sortOrder,
	})
	if err != nil {
		t.Fatalf("CreateTag with SortOrder failed: %v", err)
	}
	if !tag.SortOrder.Valid || tag.SortOrder.Int64 != 5 {
		t.Errorf("expected sort_order=5, got %+v", tag.SortOrder)
	}
}

// TestPostService_RenderContent covers the RenderContent function.
func TestPostService_RenderContent(t *testing.T) {
	svc, repo := setupPostService(t)
	defer repo.Close()

	html, err := svc.RenderContent("# Hello\n\nWorld **bold**")
	if err != nil {
		t.Fatalf("RenderContent failed: %v", err)
	}
	if html == "" {
		t.Error("expected non-empty HTML")
	}
}

// TestUpdateMediaVisibilityForPaths_HiddenAndDuplicate covers the
// hiddenByTag path and duplicate-path path in UpdateMediaVisibilityForPaths.
func TestUpdateMediaVisibilityForPaths_HiddenAndDuplicate(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		os.RemoveAll(tmpDir)
		svc.repo.Close()
	}()
	ctx := context.Background()
	repo := svc.repo

	// Create user.
	_, _ = repo.DB().Exec(`INSERT INTO users (id,username,email,password_hash,display_name) VALUES (1,'u','u@t.com','h','U')`)

	// Create a "_hide_posts" system tag (marks posts as hidden from media visibility).
	_, _ = repo.DB().Exec(`INSERT INTO tags (id,name,slug,post_count) VALUES (1,'_hide_posts','_hide_posts',1)`)

	// Create a post that is tagged with _hide_posts → should be hidden.
	_, _ = repo.DB().Exec(`INSERT INTO posts (id,title,slug,content,author_id,status,published_at) VALUES (1,'Hidden','hidden','[img](/media/originals/2024/01/same.jpg)',1,'published',datetime('now'))`)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id,tag_id) VALUES (1,1)`)

	// Create a visible post that references the same path twice.
	_, _ = repo.DB().Exec(`INSERT INTO posts (id,title,slug,content,author_id,status,published_at,thumbnail_path) VALUES (2,'Vis','vis','[img](/media/originals/2024/01/same.jpg) [img](/media/originals/2024/01/same.jpg)',1,'published',datetime('now'),'/2024/01/same.jpg')`)

	// Insert media records for the paths.
	_, _ = repo.DB().Exec(`INSERT INTO media (id,filename,original_path,file_type,mime_type,file_size,checksum) VALUES (1,'same.jpg','originals/2024/01/same.jpg','image','image/jpeg',100,'c1')`)

	// Ensure media_visibility_log table exists (used by SetMediaPublic).
	_, _ = repo.DB().Exec(`CREATE TABLE IF NOT EXISTS media_visibility_log (id INTEGER PRIMARY KEY, media_id INTEGER, is_public INTEGER, post_id INTEGER)`)

	err := svc.UpdateMediaVisibilityForPaths(ctx, []string{"originals/2024/01/same.jpg"})
	if err != nil {
		t.Fatalf("UpdateMediaVisibilityForPaths with hidden tag: %v", err)
	}
}

// TestTagService_ReorderTag_SameHierarchy covers the in-same-parent reorder path.
func TestTagService_ReorderTag_SameHierarchy(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
	ctx := context.Background()

	// Create parent and two children.
	parent, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Parent", Slug: "parent"})
	child1, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Child1", Slug: "child1"})
	child2, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Child2", Slug: "child2"})
	_ = svc.SetTagParents(ctx, child1.ID, []int64{parent.ID})
	_ = svc.SetTagParents(ctx, child2.ID, []int64{parent.ID})

	// Reorder child1 after child2 (same parent).
	err := svc.ReorderTag(ctx, ReorderTagParams{
		ID:       child1.ID,
		TargetID: &child2.ID,
		Position: "after",
		ParentID: &parent.ID,
	})
	if err != nil {
		t.Fatalf("ReorderTag (same hierarchy): %v", err)
	}
}

// TestTagService_UpdateMissingCoords_AllHaveCoords covers the "all already have coords" path.
func TestTagService_UpdateMissingCoords_AllHaveCoords(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
	ctx := context.Background()

	// Create "city" base tag and a child tag with a location already set.
	cityTag, _ := svc.CreateTag(ctx, CreateTagParams{Name: "city", Slug: "city"})
	childTag, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Paris", Slug: "paris"})
	_ = svc.SetTagParents(ctx, childTag.ID, []int64{cityTag.ID})

	// Insert a location for the child tag (already has coordinates).
	_, _ = repo.DB().Exec(`INSERT INTO tag_locations (tag_id, latitude, longitude) VALUES (?, 48.8566, 2.3522)`, childTag.ID)

	result, err := svc.UpdateMissingCoords(ctx)
	if err != nil {
		t.Fatalf("UpdateMissingCoords: %v", err)
	}
	if result["updated_count"] != 0 {
		t.Errorf("expected 0 updated (all have coords), got %v", result["updated_count"])
	}
}

// TestPostService_ListPosts_WithSearch covers the search path in ListPosts.
func TestPostService_ListPosts_WithSearch(t *testing.T) {
	svc, repo := setupPostService(t)
	defer repo.Close()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO users (id,username,email,password_hash,display_name) VALUES (1,'u','u@t.com','h','U')`)
	_, _ = svc.CreatePost(ctx, CreatePostParams{Title: "Hello World", Slug: "hello-world", Status: "published", AuthorID: 1})

	posts, total, err := svc.ListPosts(ctx, ListPostsParams{
		Page: 1, PerPage: 10, Search: "Hello",
	})
	if err != nil {
		t.Fatalf("ListPosts with search: %v", err)
	}
	if total < 0 {
		t.Error("expected non-negative total")
	}
	_ = posts
}

// TestPostService_GeneratePreviewLink covers the success path.
func TestPostService_GeneratePreviewLink(t *testing.T) {
	svc, repo := setupPostService(t)
	defer repo.Close()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO users (id,username,email,password_hash,display_name) VALUES (1,'u','u@t.com','h','U')`)
	post, _ := svc.CreatePost(ctx, CreatePostParams{Title: "P", Slug: "p", Status: "draft", AuthorID: 1})

	token, expiresAt, err := svc.GeneratePreviewLink(ctx, post.ID)
	if err != nil {
		t.Fatalf("GeneratePreviewLink: %v", err)
	}
	if token == "" {
		t.Error("expected non-empty token")
	}
	if expiresAt.IsZero() {
		t.Error("expected non-zero expiry")
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
	repo.Close()

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

// TestSettingsService_GetSetting_Error covers the DB error path in GetSetting.
func TestSettingsService_GetSetting_Error(t *testing.T) {
	repo := setupTestDB(t)
	svc := NewSettingsService(repo)
	ctx := context.Background()

	repo.Close()

	// GetSetting on closed DB should return the default value (not error).
	val, _ := svc.GetSetting(ctx, "any_key", "default")
	if val != "default" {
		t.Errorf("expected default, got %q", val)
	}
}

// TestAuthService_ChangePassword_Error covers the ChangePassword error paths.
func TestAuthService_ChangePassword_Error(t *testing.T) {
	svc, repo := setupAuthService(t)
	ctx := context.Background()

	// Insert user with known password.
	hash, _ := HashPassword("oldpass")
	_, _ = repo.DB().Exec(`INSERT INTO users (id,username,email,password_hash,display_name) VALUES (1,'u','u@t.com',?,'U')`, hash)

	// Wrong old password → should fail verification.
	err := svc.ChangePassword(ctx, 1, "wrongpass", "newpass")
	if err == nil {
		t.Error("ChangePassword with wrong old password: expected error")
	}

	repo.Close()
}

func setupAuthService(t *testing.T) (*AuthService, *repository.Repository) {
	repo := setupTestDB(t)
	return NewAuthService(repo), repo
}

// TestServiceDBErrors2 covers more DB error paths by closing the DB before service calls.
func TestServiceDBErrors2(t *testing.T) {
	mediaSvc, tmpDir := setupMediaService(t)
	defer os.RemoveAll(tmpDir)
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
	mediaSvc.repo.Close()

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

// TestMediaService_AnalyzeByPath_InvalidPath covers the path traversal check.
func TestMediaService_AnalyzeByPath_InvalidPath(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		os.RemoveAll(tmpDir)
		svc.repo.Close()
	}()
	ctx := context.Background()

	// Path traversal attempt → "invalid media path".
	_, err := svc.AnalyzeMediaByPath(ctx, "../../etc/passwd")
	if err == nil {
		t.Error("expected error for path traversal")
	}
}

// TestTagService_SetTagChildren_ClearError covers the ClearTagChildren error path.
func TestTagService_SetTagChildren_ClearError(t *testing.T) {
	svc, repo := setupTagService(t)
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id,name,slug) VALUES (1,'P','parent'),(2,'C','child')`)
	repo.Close()

	// Non-system child with closed DB → ClearTagChildren fails.
	err := svc.SetTagChildren(ctx, 1, []int64{2})
	if err == nil {
		t.Error("SetTagChildren: expected error from ClearTagChildren")
	}
}

// TestMediaService_GetStorageUsage_Valid covers the valid storage usage path.
func TestMediaService_GetStorageUsage_Valid(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		os.RemoveAll(tmpDir)
		svc.repo.Close()
	}()
	ctx := context.Background()

	usage, err := svc.GetStorageUsage(ctx)
	if err != nil {
		t.Fatalf("GetStorageUsage: %v", err)
	}
	if usage < 0 {
		t.Error("expected non-negative usage")
	}
}

// TestSettingsService_GetSetting_NullValue covers the NULL-value path in GetSetting.
func TestSettingsService_GetSetting_NullValue(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()
	svc := NewSettingsService(repo)
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO blog_settings (key, value, value_type) VALUES ('nullkey', NULL, 'string')`)

	val, _ := svc.GetSetting(ctx, "nullkey", "fallback")
	if val != "fallback" {
		t.Errorf("GetSetting NULL value: expected fallback, got %q", val)
	}
}

// TestTagService_SystemTagAccess covers GetTagByID and DeleteTag with system tags.
func TestTagService_SystemTagAccess(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (99, 'System', '_system')`)

	// GetTagByID with system slug → HTTPError Not Found
	_, err := svc.GetTagByID(ctx, 99)
	if err == nil {
		t.Error("GetTagByID system tag: expected error")
	}

	// DeleteTag with system slug → HTTPError Forbidden
	err = svc.DeleteTag(ctx, 99)
	if err == nil {
		t.Error("DeleteTag system tag: expected error")
	}
}

// TestTagService_GetTagCloud_Branches covers empty DB, no-candidates, and no-filtered paths.
func TestTagService_GetTagCloud_Branches(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
	ctx := context.Background()

	// Empty DB → len(tags)==0 → return []
	items, err := svc.GetTagCloud(ctx, 10, false, 0)
	if err != nil || len(items) != 0 {
		t.Errorf("empty DB: expected [], got %v %v", items, err)
	}

	// Only system tags → candidates is empty
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1, 'Sys', '_sys')`)
	items, err = svc.GetTagCloud(ctx, 10, false, 0)
	if err != nil || len(items) != 0 {
		t.Errorf("only system tags: expected [], got %v %v", items, err)
	}

	// Regular tag with no posts → filtered is empty (effectiveCounts[id]==0)
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug, post_count) VALUES (2, 'Regular', 'regular', 0)`)
	items, err = svc.GetTagCloud(ctx, 10, false, 0)
	if err != nil || len(items) != 0 {
		t.Errorf("no posts: expected [], got %v %v", items, err)
	}
}

// TestTagService_SetTagParents_EmptyParentIDs covers the empty parentIDs → auto-assign _pending path.
func TestTagService_SetTagParents_EmptyParentIDs(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1, 'Regular', 'regular')`)

	// No _pending tag → GetTagBySlug("_pending") fails → no assignment, no error
	if err := svc.SetTagParents(ctx, 1, []int64{}); err != nil {
		t.Errorf("SetTagParents empty no-pending: unexpected error: %v", err)
	}

	// With _pending tag present → GetTagBySlug("_pending") succeeds → AddTagRelationship called
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (2, 'Pending', '_pending')`)
	if err := svc.SetTagParents(ctx, 1, []int64{}); err != nil {
		t.Errorf("SetTagParents empty with _pending: unexpected error: %v", err)
	}
}

// TestTagService_ReorderTag_CrossHierarchy covers draggedIdx==-1 (cross-hierarchy move).
func TestTagService_ReorderTag_CrossHierarchy(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
	ctx := context.Background()

	// parent1 (1), parent2 (2), dragTag (3, child of parent1), anotherTag (4, child of parent2)
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'P1','parent1'),(2,'P2','parent2'),(3,'Drag','drag'),(4,'Other','other')`)
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (1,3),(2,4)`)

	parent2ID := int64(2)
	// Move drag (child of parent1) into parent2 → cross-hierarchy move
	err := svc.ReorderTag(ctx, ReorderTagParams{
		ID:       3,
		Position: "after",
		ParentID: &parent2ID,
	})
	if err != nil {
		t.Errorf("ReorderTag cross-hierarchy: unexpected error: %v", err)
	}
}

// TestPostService_getOrCreateTag_PendingAssign covers auto-assign to _pending via UpdatePost.
func TestPostService_getOrCreateTag_PendingAssign(t *testing.T) {
	svc, repo := setupPostService(t)
	defer repo.Close()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO users (id,username,email,password_hash,display_name) VALUES (1,'u','u@t.com','h','U')`)
	_, _ = repo.DB().Exec(`INSERT INTO tags (id,name,slug) VALUES (99,'Pending','_pending')`)

	// Create a post, then update with a brand-new tag → getOrCreateTag creates it + assigns to _pending
	post, err := svc.CreatePost(ctx, CreatePostParams{Title: "Test", Status: "draft", AuthorID: 1})
	if err != nil {
		t.Fatalf("CreatePost: %v", err)
	}
	_, err = svc.UpdatePost(ctx, UpdatePostParams{
		ID:       post.ID,
		AuthorID: 1,
		Title:    "Test",
		Status:   "draft",
		Tags:     []string{"brandnewtag"},
	})
	if err != nil {
		t.Errorf("UpdatePost with new tag: unexpected error: %v", err)
	}
}

// TestPostService_DBErrors3 covers CreatePost, UpdatePost, GeneratePreviewLink, and ListPosts(search) DB errors.
func TestPostService_DBErrors3(t *testing.T) {
	svc, repo := setupPostService(t)
	ctx := context.Background()

	repo.Close()

	if _, err := svc.CreatePost(ctx, CreatePostParams{Title: "T", Status: "draft", AuthorID: 1}); err == nil {
		t.Error("CreatePost DB error: expected error")
	}
	if _, err := svc.UpdatePost(ctx, UpdatePostParams{ID: 1, AuthorID: 1, Title: "T", Status: "draft"}); err == nil {
		t.Error("UpdatePost DB error: expected error")
	}
	if _, _, err := svc.GeneratePreviewLink(ctx, 1); err == nil {
		t.Error("GeneratePreviewLink DB error: expected error")
	}
	if _, _, err := svc.ListPosts(ctx, ListPostsParams{Page: 1, PerPage: 10, Search: "query"}); err == nil {
		t.Error("ListPosts with search DB error: expected error")
	}
}

// TestTagService_DBErrors3 covers GetTagChildren and UpdateMissingCoords DB errors.
func TestTagService_DBErrors3(t *testing.T) {
	svc, repo := setupTagService(t)
	ctx := context.Background()

	repo.Close()

	if _, err := svc.GetTagChildren(ctx, 1, false, 0); err == nil {
		t.Error("GetTagChildren DB error: expected error")
	}
	if _, err := svc.UpdateMissingCoords(ctx); err == nil {
		t.Error("UpdateMissingCoords DB error: expected error")
	}
}

// TestAuthService_ValidateSession_DBError covers the ValidateSession DB error path.
func TestAuthService_ValidateSession_DBError(t *testing.T) {
	svc, repo := setupAuthService(t)
	ctx := context.Background()

	repo.Close()

	if _, err := svc.ValidateSession(ctx, "sometoken"); err == nil {
		t.Error("ValidateSession DB closed: expected error")
	}
}

// TestAuthService_ChangePassword_LongPassword covers HashPassword bcrypt error.
func TestAuthService_ChangePassword_LongPassword(t *testing.T) {
	svc, repo := setupAuthService(t)
	defer repo.Close()
	ctx := context.Background()

	hash, _ := HashPassword("correct")
	_, _ = repo.DB().Exec(`INSERT INTO users (id,username,email,password_hash,display_name) VALUES (1,'u','u@t.com',?,'U')`, hash)

	// Password > 72 bytes triggers bcrypt.ErrPasswordTooLong
	err := svc.ChangePassword(ctx, 1, "correct", strings.Repeat("x", 73))
	if err == nil {
		t.Error("ChangePassword long password: expected bcrypt error")
	}
}

// TestTagService_DropTable_SetTagErrors covers SetTagParents and SetTagChildren ClearTag errors.
func TestTagService_DropTable_SetTagErrors(t *testing.T) {
	t.Run("SetTagParents_ClearParentsError", func(t *testing.T) {
		svc, repo := setupTagService(t)
		defer repo.Close()
		ctx := context.Background()

		_, _ = repo.DB().Exec(`INSERT INTO tags (id,name,slug) VALUES (1,'T','regular')`)
		_, _ = repo.DB().Exec(`DROP TABLE tag_relationships`)

		if err := svc.SetTagParents(ctx, 1, []int64{}); err == nil {
			t.Error("SetTagParents dropped tag_relationships: expected error")
		}
	})

	t.Run("SetTagChildren_ClearChildrenError", func(t *testing.T) {
		svc, repo := setupTagService(t)
		defer repo.Close()
		ctx := context.Background()

		_, _ = repo.DB().Exec(`INSERT INTO tags (id,name,slug) VALUES (1,'P','parent'),(2,'C','child')`)
		_, _ = repo.DB().Exec(`DROP TABLE tag_relationships`)

		if err := svc.SetTagChildren(ctx, 1, []int64{2}); err == nil {
			t.Error("SetTagChildren dropped tag_relationships: expected error")
		}
	})
}

// TestTagService_GeocodeTag_HttpErrors covers HTTP error paths in GeocodeTag.
func TestTagService_GeocodeTag_HttpErrors(t *testing.T) {
	ctx := context.Background()

	t.Run("InvalidURL", func(t *testing.T) {
		svc, repo := setupTagService(t)
		defer repo.Close()
		_, _ = repo.DB().Exec(`INSERT INTO tags (id,name,slug) VALUES (1,'City','city')`)
		svc.nominatimBaseURL = "http://\x00invalid"
		if _, _, err := svc.GeocodeTag(ctx, 1); err == nil {
			t.Error("GeocodeTag invalid URL: expected error")
		}
	})

	t.Run("ConnectionRefused", func(t *testing.T) {
		svc, repo := setupTagService(t)
		defer repo.Close()
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
		defer repo.Close()
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
		defer repo.Close()
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

// TestMediaService_parseAnalysisResult_YearTag covers year tag deduplication.
func TestMediaService_parseAnalysisResult_YearTag(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		os.RemoveAll(tmpDir)
		svc.repo.Close()
	}()

	// Year "2024" already in tags → found=true, no prepend
	result := map[string]interface{}{
		"title":   "Test",
		"tags":    []interface{}{"2024", "nature"},
		"excerpt": "A photo",
	}
	analysis, err := svc.parseAnalysisResult(result, "2024_photo.jpg")
	if err != nil {
		t.Fatalf("parseAnalysisResult: %v", err)
	}
	if len(analysis.Tags) != 2 {
		t.Errorf("expected 2 tags, got %d: %v", len(analysis.Tags), analysis.Tags)
	}
}

// TestTagService_UpdateTag_WithSortOrder covers the non-nil SortOrder branch.
func TestTagService_UpdateTag_WithSortOrder(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id,name,slug) VALUES (1,'Regular','regular')`)
	sortOrder := int32(10)
	_, err := svc.UpdateTag(ctx, UpdateTagParams{
		ID:        1,
		Name:      "Regular",
		Slug:      "regular",
		SortOrder: &sortOrder,
	})
	if err != nil {
		t.Errorf("UpdateTag with SortOrder: unexpected error: %v", err)
	}
}

// TestTagService_ReorderTag_GetSiblingsError covers the GetRootTags/GetChildrenOfTag error path.
func TestTagService_ReorderTag_GetSiblingsError(t *testing.T) {
	svc, repo := setupTagService(t)
	defer repo.Close()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id,name,slug) VALUES (1,'T','tag1')`)
	_, _ = repo.DB().Exec(`DROP TABLE tag_relationships`)

	// GetRootTags will fail (tag_relationships dropped)
	err := svc.ReorderTag(ctx, ReorderTagParams{
		ID:       1,
		Position: "after",
	})
	if err == nil {
		t.Error("ReorderTag dropped tag_relationships: expected error")
	}
}
