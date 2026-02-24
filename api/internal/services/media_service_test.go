package services

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"point-api/internal/config"
)

func TestMediaService_AnalyzeImage(t *testing.T) {
	service, tmpDir := setupMediaService(t)
	defer os.RemoveAll(tmpDir)
	defer service.repo.Close()

	ctx := context.Background()

	// Mock server for GenAI
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		res := map[string]interface{}{
			"title": "Mock Title",
			"tags":  []string{"tag1", "tag2"},
			"excerpt": "Mock Excerpt",
		}
		json.NewEncoder(w).Encode(res)
	}))
	defer server.Close()

	// Configure endpoint
	service.settingsService.SetSetting(ctx, "genai_api_endpoint", server.URL, "string")

	analysis, err := service.AnalyzeImage(ctx, []byte("fake-image"), "test.jpg", "image/jpeg")
	if err != nil {
		t.Fatalf("AnalyzeImage failed: %v", err)
	}

	if *analysis.Title != "Mock Title" {
		t.Errorf("expected Mock Title, got %s", *analysis.Title)
	}
}


func setupMediaService(t *testing.T) (*MediaService, string) {
	repo := setupTestDB(t)
	tmpDir, err := os.MkdirTemp("", "media-test")
	if err != nil {
		t.Fatal(err)
	}

	cfg := &config.Config{
		StoragePath:     tmpDir,
		ThumbnailWidth:  400,
		ThumbnailHeight: 300,
	}
	settingsService := NewSettingsService(repo)
	service := NewMediaService(repo, cfg, settingsService)

	return service, tmpDir
}

func TestMediaService_Upload(t *testing.T) {
	service, tmpDir := setupMediaService(t)
	defer os.RemoveAll(tmpDir)
	defer service.repo.Close()

	ctx := context.Background()

	// Test non-image upload
	content := []byte("hello world")
	media, err := service.UploadFile(ctx, UploadFileParams{
		Content:  content,
		Filename: "test.txt",
		MimeType: "text/plain",
	})
	if err != nil {
		t.Fatalf("UploadFile failed: %v", err)
	}
	if media.Filename != "test.txt" {
		t.Errorf("expected filename test.txt, got %s", media.Filename)
	}
	if media.FileType != "file" {
		t.Errorf("expected file type file, got %s", media.FileType)
	}

	// Verify file exists
	origPath := filepath.Join(tmpDir, "media", media.OriginalPath)
	if _, err := os.Stat(origPath); os.IsNotExist(err) {
		t.Error("original file does not exist")
	}

	// Test duplicate upload (should return existing)
	media2, err := service.UploadFile(ctx, UploadFileParams{
		Content:  content,
		Filename: "test-duplicate.txt",
		MimeType: "text/plain",
	})
	if err != nil {
		t.Fatalf("Duplicate upload failed: %v", err)
	}
	if media2.ID != media.ID {
		t.Errorf("expected duplicate to return same ID %d, got %d", media.ID, media2.ID)
	}

	// Test List
	list, total, err := service.ListMedia(ctx, ListMediaParams{Page: 1, PerPage: 10})
	if err != nil {
		t.Fatalf("ListMedia failed: %v", err)
	}
	if total != 1 || len(list) != 1 {
		t.Errorf("expected 1 media item, got %d (total %d)", len(list), total)
	}

	// Test Update
	updated, err := service.UpdateMedia(ctx, UpdateMediaParams{
		ID:      media.ID,
		AltText: "Updated Alt",
	})
	if err != nil {
		t.Fatalf("UpdateMedia failed: %v", err)
	}
	if updated.AltText.String != "Updated Alt" {
		t.Errorf("expected AltText Updated Alt, got %s", updated.AltText.String)
	}

	// Test Rename
	renamed, err := service.RenameMedia(ctx, media.ID, "new-name.txt")
	if err != nil {
		t.Fatalf("RenameMedia failed: %v", err)
	}
	if renamed.Filename != "new-name.txt" {
		t.Errorf("expected filename new-name.txt, got %s", renamed.Filename)
	}
	if _, err := os.Stat(filepath.Join(tmpDir, "media", renamed.OriginalPath)); os.IsNotExist(err) {
		t.Error("renamed file does not exist")
	}

	// Test Delete
	err = service.DeleteMedia(ctx, media.ID)
	if err != nil {
		t.Fatalf("DeleteMedia failed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(tmpDir, "media", renamed.OriginalPath)); !os.IsNotExist(err) {
		t.Error("file still exists after delete")
	}
}

func TestMediaService_Orphaned(t *testing.T) {
	service, tmpDir := setupMediaService(t)
	defer os.RemoveAll(tmpDir)
	defer service.repo.Close()

	ctx := context.Background()

	// Upload something
	media, _ := service.UploadFile(ctx, UploadFileParams{
		Content:  []byte("orphan"),
		Filename: "orphan.txt",
		MimeType: "text/plain",
	})

	// It's orphaned because post_id is NULL
	orphans, total, _ := service.ListOrphanedMedia(ctx, 1, 10)
	if total != 1 {
		t.Errorf("expected 1 orphan, got %d", total)
	}
	if orphans[0].ID != media.ID {
		t.Error("orphan ID mismatch")
	}

	// Test GetMediaByID
	media3, err := service.GetMediaByID(ctx, media.ID)
	if err != nil {
		t.Fatalf("GetMediaByID failed: %v", err)
	}
	if media3.ID != media.ID {
		t.Error("media ID mismatch")
	}

	// Cleanup
	count, freed, err := service.CleanupOrphaned(ctx)
	if err != nil {
		t.Fatalf("CleanupOrphaned failed: %v", err)
	}
	if count != 1 {
		t.Errorf("expected 1 cleaned, got %d", count)
	}
	if freed != int64(len("orphan")) {
		t.Errorf("expected %d freed, got %d", len("orphan"), freed)
	}

	// Test GetStorageUsage
	_, err = service.GetStorageUsage(ctx)
	if err != nil {
		t.Fatalf("GetStorageUsage failed: %v", err)
	}
}


func TestMediaService_Stats(t *testing.T) {
	service, tmpDir := setupMediaService(t)
	defer os.RemoveAll(tmpDir)
	defer service.repo.Close()

	ctx := context.Background()

	_, _ = service.UploadFile(ctx, UploadFileParams{
		Content:  []byte("data"),
		Filename: "f1.txt",
		MimeType: "text/plain",
	})

	stats, err := service.GetStorageStats(ctx)
	if err != nil {
		t.Fatalf("GetStorageStats failed: %v", err)
	}
	if stats.TotalFiles != 1 {
		t.Errorf("expected 1 file, got %d", stats.TotalFiles)
	}
	if stats.TotalBytes != 4 {
		t.Errorf("expected 4 bytes, got %d", stats.TotalBytes)
	}
}

func TestMediaService_RebuildThumbnails(t *testing.T) {
	service, tmpDir := setupMediaService(t)
	defer os.RemoveAll(tmpDir)
	defer service.repo.Close()

	ctx := context.Background()

	// 1. Rebuild on empty should not fail
	stats, err := service.RebuildThumbnails(ctx, false)
	if err != nil {
		t.Fatalf("RebuildThumbnails failed: %v", err)
	}
	if stats["processed"] != 0 {
		t.Errorf("expected 0 processed, got %d", stats["processed"])
	}

	// 2. Create a dummy image
	img := image.NewRGBA(image.Rect(0, 0, 10, 10))
	var buf bytes.Buffer
	jpeg.Encode(&buf, img, nil)

	media, err := service.UploadFile(ctx, UploadFileParams{
		Content:  buf.Bytes(),
		Filename: "test.jpg",
		MimeType: "image/jpeg",
	})
	if err != nil {
		t.Fatalf("UploadFile failed: %v", err)
	}

	// Force delete thumbnail from disk but keep in DB
	if media.ThumbnailPath.Valid {
		os.Remove(filepath.Join(tmpDir, "media", media.ThumbnailPath.String))
	}

	stats, err = service.RebuildThumbnails(ctx, false)
	if err != nil {
		t.Fatalf("RebuildThumbnails failed: %v", err)
	}
	if stats["processed"] != 1 {
		t.Errorf("expected 1 processed, got %d", stats["processed"])
	}
}

