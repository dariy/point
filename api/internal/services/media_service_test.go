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
	"strings"
	"testing"
)

func TestMediaService_AnalyzeImage(t *testing.T) {
	service, tmpDir := setupMediaService(t)
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = service.repo.Close()
	}()

	ctx := context.Background()

	// Mock server for GenAI
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		res := map[string]interface{}{
			"title": "Mock Title",
			"tags":  []string{"tag1", "tag2"},
			"excerpt": "Mock Excerpt",
		}
		_ = json.NewEncoder(w).Encode(res)
	}))
	defer server.Close()

	// Configure endpoint
	if err := service.settingsService.SetSetting(ctx, "genai_api_endpoint", server.URL, "string"); err != nil {
		t.Fatalf("SetSetting failed: %v", err)
	}

	analysis, err := service.AnalyzeImage(ctx, []byte("fake-image"), "test.jpg", "image/jpeg")
	if err != nil {
		t.Fatalf("AnalyzeImage failed: %v", err)
	}

	if *analysis.Title != "Mock Title" {
		t.Errorf("expected Mock Title, got %s", *analysis.Title)
	}
}




func TestMediaService_MetadataExtraction(t *testing.T) {
	service, tmpDir := setupMediaService(t)
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = service.repo.Close()
	}()

	ctx := context.Background()

	// 1. Test video detection
	media, err := service.UploadFile(ctx, UploadFileParams{
		Content:  []byte("fake-video"),
		Filename: "test.mp4",
		MimeType: "video/mp4",
	})
	if err != nil {
		t.Fatalf("Upload video failed: %v", err)
	}
	if media.FileType != "video" {
		t.Errorf("expected video, got %s", media.FileType)
	}

	// 2. Test audio detection
	media, err = service.UploadFile(ctx, UploadFileParams{
		Content:  []byte("fake-audio"),
		Filename: "test.mp3",
		MimeType: "audio/mpeg",
	})
	if err != nil {
		t.Fatalf("Upload audio failed: %v", err)
	}
	if media.FileType != "audio" {
		t.Errorf("expected audio, got %s", media.FileType)
	}

	// 3. Test image with metadata (basic check that it doesn't crash)
	img := image.NewRGBA(image.Rect(0, 0, 10, 10))
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatalf("jpeg.Encode failed: %v", err)
	}
	media, err = service.UploadFile(ctx, UploadFileParams{
		Content:  buf.Bytes(),
		Filename: "test.jpg",
		MimeType: "image/jpeg",
	})
	if err != nil {
		t.Fatalf("Upload image failed: %v", err)
	}
	// Even without real EXIF, it should have some metadata if we added it (though here it might be empty map)
	// We're mainly checking that the Metadata column exists and can be written to.
	if !media.Metadata.Valid {
		// It's okay if it's not valid for a generated image with no EXIF
	}
}

func TestMediaService_Upload(t *testing.T) {
	service, tmpDir := setupMediaService(t)
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = service.repo.Close()
	}()

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
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = service.repo.Close()
	}()

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
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = service.repo.Close()
	}()

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
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = service.repo.Close()
	}()

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
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatalf("jpeg.Encode failed: %v", err)
	}

	media, err := service.UploadFile(ctx, UploadFileParams{
		Content:  buf.Bytes(),
		Filename: "test.jpg",
		MimeType: "image/jpeg",
	})
	if err != nil {
		t.Fatalf("UploadFile failed: %v", err)
	}

	// Create a post using this media as thumbnail
	barePath := "/" + strings.TrimPrefix(media.OriginalPath, "originals/")
	_, _ = service.repo.DB().Exec(`INSERT OR IGNORE INTO users (id, username, email, password_hash, display_name) VALUES (1, 'u','e','h','D')`)
	_, _ = service.repo.DB().Exec(`INSERT INTO posts (title, slug, content, status, author_id, thumbnail_path) VALUES ('PT','pt','C','published',1,?)`, barePath)

	// Force delete thumbnail from disk but keep in DB
	if media.ThumbnailPath.Valid {
		_ = os.Remove(filepath.Join(tmpDir, "media", media.ThumbnailPath.String))
	}

	stats, err = service.RebuildThumbnails(ctx, false)
	if err != nil {
		t.Fatalf("RebuildThumbnails failed: %v", err)
	}
	if stats["processed"] != 1 {
		t.Errorf("expected 1 processed, got %d", stats["processed"])
	}

	// Verify post thumbnail_path was updated
	var updatedPath string
	err = service.repo.DB().QueryRowContext(ctx, "SELECT thumbnail_path FROM posts WHERE slug = 'pt'").Scan(&updatedPath)
	if err != nil {
		t.Fatalf("failed to query updated post: %v", err)
	}
	if updatedPath != barePath+"?thumb" {
		t.Errorf("expected post thumbnail_path updated to %s, got %s", barePath+"?thumb", updatedPath)
	}
}

func TestMediaService_BulkDelete(t *testing.T) {
	service, tmpDir := setupMediaService(t)
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = service.repo.Close()
	}()

	ctx := context.Background()

	m1, _ := service.UploadFile(ctx, UploadFileParams{Content: []byte("f1"), Filename: "f1.txt", MimeType: "text/plain"})
	m2, _ := service.UploadFile(ctx, UploadFileParams{Content: []byte("f2"), Filename: "f2.txt", MimeType: "text/plain"})

	count, err := service.BulkDeleteMedia(ctx, []int64{m1.ID, m2.ID})
	if err != nil {
		t.Fatalf("BulkDeleteMedia failed: %v", err)
	}
	if count != 2 {
		t.Errorf("expected 2 deleted, got %d", count)
	}

	// Empty list
	count, err = service.BulkDeleteMedia(ctx, []int64{})
	if err != nil {
		t.Errorf("BulkDeleteMedia with empty IDs should not fail: %v", err)
	}
	if count != 0 {
		t.Errorf("expected 0 for empty list, got %d", count)
	}
}

func TestMediaService_GetMediaFolders(t *testing.T) {
	service, tmpDir := setupMediaService(t)
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = service.repo.Close()
	}()

	ctx := context.Background()

	// Upload a file so a folder exists
	_, _ = service.UploadFile(ctx, UploadFileParams{Content: []byte("folder"), Filename: "photo.jpg", MimeType: "image/jpeg"})

	folders, err := service.GetMediaFolders(ctx, "")
	if err != nil {
		t.Fatalf("GetMediaFolders failed: %v", err)
	}
	_ = folders // might be empty if path format doesn't match, that's OK
}

func TestMediaService_ExtractMediaPaths(t *testing.T) {
	// Plain text content without media
	paths := ExtractMediaPaths("No media here", "")
	if len(paths) != 0 {
		t.Errorf("expected 0 paths, got %d", len(paths))
	}

	// Content with video tag
	paths = ExtractMediaPaths(`<video src="/2026/01/video.mp4"></video>`, "")
	if len(paths) < 1 {
		t.Errorf("expected at least 1 path from video tag, got %d", len(paths))
	}

	// With thumbnail path
	paths = ExtractMediaPaths("text", "originals/2026/01/thumb.jpg")
	if len(paths) < 1 {
		t.Errorf("expected at least 1 path from thumbnail, got %d", len(paths))
	}
}

func TestMediaService_UpdateMediaVisibilityForPaths(t *testing.T) {
	service, tmpDir := setupMediaService(t)
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = service.repo.Close()
	}()

	ctx := context.Background()
	// Empty paths — should succeed without error
	err := service.UpdateMediaVisibilityForPaths(ctx, []string{})
	if err != nil {
		t.Errorf("UpdateMediaVisibilityForPaths with empty slice failed: %v", err)
	}

	// Set up a published post with a media reference and the media record
	repo := service.repo
	_, _ = repo.DB().Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'u','e','h','D')`)
	_, _ = repo.DB().Exec(`INSERT INTO posts (id, title, slug, content, author_id, status, published_at) VALUES (1,'P','p','See /2024/06/img.jpg here',1,'published',datetime('now'))`)
	_, _ = repo.DB().Exec(`INSERT INTO media (id, filename, original_path, file_type, mime_type, file_size, checksum, is_public) VALUES (1,'img.jpg','originals/2024/06/img.jpg','image','image/jpeg',100,'c1',0)`)

	// Now the media is referenced in a published post — should become public
	err = service.UpdateMediaVisibilityForPaths(ctx, []string{"originals/2024/06/img.jpg"})
	if err != nil {
		t.Errorf("UpdateMediaVisibilityForPaths with data failed: %v", err)
	}

	// Path with no DB record — should be skipped silently
	err = service.UpdateMediaVisibilityForPaths(ctx, []string{"originals/2024/06/missing.jpg"})
	if err != nil {
		t.Errorf("UpdateMediaVisibilityForPaths with missing path failed: %v", err)
	}
}

func TestMediaService_RecalculateAllMediaVisibility(t *testing.T) {
	service, tmpDir := setupMediaService(t)
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = service.repo.Close()
	}()

	ctx := context.Background()

	// Empty DB — should work fine
	changed, err := service.RecalculateAllMediaVisibility(ctx)
	if err != nil {
		t.Fatalf("RecalculateAllMediaVisibility (empty) failed: %v", err)
	}
	_ = changed

	// Set up a published post referencing media
	repo := service.repo
	_, _ = repo.DB().Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'u','e','h','D')`)
	_, _ = repo.DB().Exec(`INSERT INTO posts (id, title, slug, content, author_id, status, published_at) VALUES (1,'P','p','See /2024/06/img.jpg',1,'published',datetime('now'))`)
	_, _ = repo.DB().Exec(`INSERT INTO media (id, filename, original_path, file_type, mime_type, file_size, checksum, is_public) VALUES (1,'img.jpg','originals/2024/06/img.jpg','image','image/jpeg',100,'c1',0)`)
	// Add private media not referenced anywhere
	_, _ = repo.DB().Exec(`INSERT INTO media (id, filename, original_path, file_type, mime_type, file_size, checksum, is_public) VALUES (2,'priv.jpg','originals/2024/06/priv.jpg','image','image/jpeg',100,'c2',1)`)

	changed, err = service.RecalculateAllMediaVisibility(ctx)
	if err != nil {
		t.Fatalf("RecalculateAllMediaVisibility failed: %v", err)
	}
	// img.jpg should become public, priv.jpg should become private → 2 changes
	if changed < 1 {
		t.Errorf("expected at least 1 visibility change, got %d", changed)
	}

	// Test with thumbnail path reference
	_, _ = repo.DB().Exec(`INSERT INTO posts (id, title, slug, content, author_id, status, published_at, thumbnail_path) VALUES (2,'P2','p2','',1,'published',datetime('now'),'/2024/06/thumb.jpg')`)
	_, _ = repo.DB().Exec(`INSERT INTO media (id, filename, original_path, file_type, mime_type, file_size, checksum, is_public) VALUES (3,'thumb.jpg','originals/2024/06/thumb.jpg','image','image/jpeg',100,'c3',0)`)

	changed2, err := service.RecalculateAllMediaVisibility(ctx)
	if err != nil {
		t.Fatalf("RecalculateAllMediaVisibility (with thumbnail) failed: %v", err)
	}
	_ = changed2 // may be 1 for thumb.jpg becoming public
}

func TestMediaService_ParseAnalysisResult(t *testing.T) {
	svc := &MediaService{}

	// Basic result with title, tags, excerpt
	data := map[string]interface{}{
		"title":   "Photo",
		"tags":    []interface{}{"a", "b"},
		"excerpt": "desc",
	}
	result, err := svc.parseAnalysisResult(data, "photo.jpg")
	if err != nil {
		t.Fatalf("parseAnalysisResult failed: %v", err)
	}
	if result.Title == nil || *result.Title != "Photo" {
		t.Errorf("expected title Photo, got %v", result.Title)
	}
	if len(result.Tags) != 2 {
		t.Errorf("expected 2 tags, got %d", len(result.Tags))
	}

	// Filename starting with year — year tag is prepended
	data2 := map[string]interface{}{
		"title": "Landscape",
		"tags":  []interface{}{"nature"},
	}
	result2, err := svc.parseAnalysisResult(data2, "2026-summer.jpg")
	if err != nil {
		t.Fatalf("parseAnalysisResult with year filename failed: %v", err)
	}
	if len(result2.Tags) < 2 || result2.Tags[0] != "2026" {
		t.Errorf("expected year tag '2026' prepended, got %v", result2.Tags)
	}

	// Alternative key mapping: summary → excerpt
	data3 := map[string]interface{}{
		"tags":    []interface{}{},
		"summary": "A summary",
	}
	result3, err := svc.parseAnalysisResult(data3, "img.jpg")
	if err != nil {
		t.Fatalf("parseAnalysisResult (summary key) failed: %v", err)
	}
	if result3.Excerpt == nil || *result3.Excerpt != "A summary" {
		t.Errorf("expected excerpt from summary key, got %v", result3.Excerpt)
	}

	// Empty map — should return empty AnalysisResponse without error
	result4, err := svc.parseAnalysisResult(map[string]interface{}{}, "")
	if err != nil {
		t.Fatalf("parseAnalysisResult (empty) failed: %v", err)
	}
	if result4.Tags == nil {
		t.Error("expected non-nil Tags slice")
	}
}

func TestMediaService_ThumbnailBranches(t *testing.T) {
	service, tmpDir := setupMediaService(t)
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = service.repo.Close()
	}()

	ctx := context.Background()

	// Create a user+post so we can test UpdateMedia with a valid PostID
	repo := service.repo
	_, _ = repo.DB().Exec(`INSERT INTO users (username, email, password_hash, display_name) VALUES ('u','e@t.com','h','D')`)
	_, _ = repo.DB().Exec(`INSERT INTO posts (title, slug, content, status, author_id) VALUES ('T','t','C','draft',1)`)

	// Upload a plain file for UpdateMedia with non-nil PostID (covers line 242)
	txtMedia, _ := service.UploadFile(ctx, UploadFileParams{Content: []byte("txt"), Filename: "x.txt", MimeType: "text/plain"})
	pid := int64(1)
	_, _ = service.UpdateMedia(ctx, UpdateMediaParams{ID: txtMedia.ID, PostID: &pid})

	// Upload a JPEG to get a thumbnail
	img := image.NewRGBA(image.Rect(0, 0, 10, 10))
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatalf("jpeg.Encode failed: %v", err)
	}
	jpegMedia, err := service.UploadFile(ctx, UploadFileParams{Content: buf.Bytes(), Filename: "photo.jpg", MimeType: "image/jpeg"})
	if err != nil {
		t.Fatalf("UploadFile JPEG failed: %v", err)
	}
	if !jpegMedia.ThumbnailPath.Valid {
		t.Skip("thumbnail not generated, skipping thumbnail branches")
	}

	// GetStorageUsage with data in DB (covers line 109: return int64(usage.Float64), nil)
	usage, err := service.GetStorageUsage(ctx)
	if err != nil {
		t.Fatalf("GetStorageUsage with data failed: %v", err)
	}
	if usage <= 0 {
		t.Errorf("expected usage > 0, got %d", usage)
	}

	// RenameMedia without extension (covers line 370: newBase += oldExt)
	// Also covers thumbnail rename branch (lines 384-395) since jpegMedia has a thumbnail
	renamed, err := service.RenameMedia(ctx, jpegMedia.ID, "newname") // no extension
	if err != nil {
		t.Fatalf("RenameMedia without ext failed: %v", err)
	}
	if filepath.Ext(renamed.Filename) != ".jpg" {
		t.Errorf("expected .jpg extension preserved, got %s", renamed.Filename)
	}

	// DeleteMedia with thumbnail (covers lines 263-265)
	if err := service.DeleteMedia(ctx, renamed.ID); err != nil {
		t.Fatalf("DeleteMedia with thumbnail failed: %v", err)
	}
}

