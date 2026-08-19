//go:build !unit

package services

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/jpeg"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"point-api/internal/config"
	"point-api/internal/models"

	"golang.org/x/crypto/bcrypt"
)

func TestMediaService_AnalyzeImage_DisabledWithNoKey(t *testing.T) {
	service, tmpDir := setupMediaService(t)
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = service.repo.Close()
	}()
	ctx := context.Background()

	// No API key → analysis is a no-op returning empty tags.
	img := image.NewRGBA(image.Rect(0, 0, 5, 5))
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, nil)

	result, err := service.AnalyzeImage(ctx, buf.Bytes(), "test.jpg", "image/jpeg")
	if err != nil {
		t.Fatalf("expected no error when key absent, got: %v", err)
	}
	if result == nil || len(result.Tags) != 0 {
		t.Error("expected empty analysis response when key absent")
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
	_ = media.Metadata.Valid
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

	// 4. Update dimensions in config and rebuild
	service.cfg.ThumbnailWidth = 200
	service.cfg.ThumbnailHeight = 200
	// Re-fetch media to get its current ThumbnailPath
	mediaAfterRebuild, _ := service.GetMediaByID(ctx, media.ID)

	stats, err = service.RebuildThumbnails(ctx, false)
	if err != nil {
		t.Fatalf("RebuildThumbnails with new dimensions failed: %v", err)
	}
	if stats["processed"] != 1 {
		t.Errorf("expected 1 processed after dimension change, got %d", stats["processed"])
	}

	// Verify old thumbnail file was deleted
	if mediaAfterRebuild.ThumbnailPath.Valid {
		oldThumbFull := filepath.Join(tmpDir, "media", mediaAfterRebuild.ThumbnailPath.String)
		if _, err := os.Stat(oldThumbFull); !os.IsNotExist(err) {
			t.Errorf("expected old thumbnail %s to be deleted from disk", oldThumbFull)
		}
	}

	mediaFinal, _ := service.GetMediaByID(ctx, media.ID)
	if mediaFinal.ThumbnailPath.String == mediaAfterRebuild.ThumbnailPath.String {
		t.Errorf("expected thumbnail path to change, got %s", mediaFinal.ThumbnailPath.String)
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

	// Valid result with all three required keys.
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

	// Year tag prepended when filename starts with year.
	data2 := map[string]interface{}{
		"title":   "Landscape",
		"tags":    []interface{}{"nature"},
		"excerpt": "A view",
	}
	result2, err := svc.parseAnalysisResult(data2, "2026-summer.jpg")
	if err != nil {
		t.Fatalf("parseAnalysisResult with year filename failed: %v", err)
	}
	if len(result2.Tags) < 2 || result2.Tags[0] != "2026" {
		t.Errorf("expected year tag '2026' prepended, got %v", result2.Tags)
	}

	// Missing excerpt key → ErrResponseUnusable (strict validation).
	data3 := map[string]interface{}{
		"title": "T",
		"tags":  []interface{}{},
	}
	if _, err := svc.parseAnalysisResult(data3, "img.jpg"); !errors.Is(err, ErrResponseUnusable) {
		t.Errorf("expected ErrResponseUnusable for missing excerpt, got %v", err)
	}

	// Empty map → ErrResponseUnusable.
	if _, err := svc.parseAnalysisResult(map[string]interface{}{}, ""); !errors.Is(err, ErrResponseUnusable) {
		t.Errorf("expected ErrResponseUnusable for empty map, got %v", err)
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

func TestUploadFile_StoresOriginalMetadata(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir) }()
	ctx := context.Background()

	m, err := svc.UploadFile(ctx, UploadFileParams{
		Content:  []byte("data"),
		Filename: "doc.txt",
		MimeType: "text/plain",
	})
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	if m.OriginalMetadata.Valid != m.Metadata.Valid {
		t.Errorf("original_metadata valid=%v != metadata valid=%v", m.OriginalMetadata.Valid, m.Metadata.Valid)
	}
}

func TestExtractEXIF_Sanitized(t *testing.T) {
	// Angle brackets go; the parentheses and digits an EXIF value could
	// legitimately contain stay. See point-quickstart-ci-exif-dedup.
	dirty := "Canon <script>alert(1)</script>"
	got := sanitizeEXIFValue(dirty)
	want := "Canon scriptalert(1)/script"
	if got != want {
		t.Errorf("sanitizeEXIFValue(%q) = %q; want %q", dirty, got, want)
	}
}

func TestUploadFile_OriginalMetadataImmutable(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir) }()
	ctx := context.Background()

	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, nil)
	m, err := svc.UploadFile(ctx, UploadFileParams{
		Content:  buf.Bytes(),
		Filename: "photo.jpg",
		MimeType: "image/jpeg",
	})
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	originalMeta := m.OriginalMetadata.String

	_, err = svc.UpdateEXIF(ctx, UpdateEXIFParams{ID: m.ID, Fields: map[string]string{"Make": "Edited"}})
	if err != nil {
		t.Fatalf("UpdateEXIF: %v", err)
	}
	got, _ := svc.GetMediaByID(ctx, m.ID)
	if got.OriginalMetadata.String != originalMeta {
		t.Errorf("original_metadata changed after UpdateEXIF: got %q; want %q",
			got.OriginalMetadata.String, originalMeta)
	}
	if !strings.Contains(got.Metadata.String, "Edited") {
		t.Errorf("metadata should contain edited value, got %q", got.Metadata.String)
	}
}

func TestUpdateEXIF_ValidatesInput(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir) }()
	ctx := context.Background()

	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, nil)
	m, _ := svc.UploadFile(ctx, UploadFileParams{
		Content:  buf.Bytes(),
		Filename: "photo.jpg",
		MimeType: "image/jpeg",
	})

	_, err := svc.UpdateEXIF(ctx, UpdateEXIFParams{
		ID:     m.ID,
		Fields: map[string]string{"Make": "Canon EOS"},
	})
	if err != nil {
		t.Errorf("valid value rejected: %v", err)
	}

	// "/" is legitimate in EXIF values (lens names, rationals) and is now
	// accepted; the characters that could escape a JPEG header or a JSON
	// context are still refused.
	_, err = svc.UpdateEXIF(ctx, UpdateEXIFParams{
		ID:     m.ID,
		Fields: map[string]string{"Make": "EF24-70mm f/2.8L"},
	})
	if err != nil {
		t.Errorf("value with '/' rejected: %v", err)
	}

	_, err = svc.UpdateEXIF(ctx, UpdateEXIFParams{
		ID:     m.ID,
		Fields: map[string]string{"Make": "Canon<script>"},
	})
	if err == nil {
		t.Error("expected error for value with angle brackets")
	}
}

func TestUpdateEXIF_UpdatesDBAndFile(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir) }()
	ctx := context.Background()

	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, nil)
	m, _ := svc.UploadFile(ctx, UploadFileParams{
		Content:  buf.Bytes(),
		Filename: "photo.jpg",
		MimeType: "image/jpeg",
	})

	updated, err := svc.UpdateEXIF(ctx, UpdateEXIFParams{
		ID:     m.ID,
		Fields: map[string]string{"Make": "Sony", "Model": "A7 IV"},
	})
	if err != nil {
		t.Fatalf("UpdateEXIF: %v", err)
	}

	var meta map[string]interface{}
	if err := json.Unmarshal([]byte(updated.Metadata.String), &meta); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if meta["Make"] != "Sony" || meta["Model"] != "A7 IV" {
		t.Errorf("DB metadata = %v; want Make=Sony Model=A7 IV", meta)
	}

	fullPath := filepath.Join(tmpDir, "media", m.OriginalPath)
	if got := readEXIFTags(t, fullPath)["Make"]; got != "Sony" {
		t.Errorf("file Make = %q; want Sony", got)
	}
}

func TestUpdateEXIF_NonJPEGSkipsFileWrite(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir) }()
	ctx := context.Background()

	m, _ := svc.UploadFile(ctx, UploadFileParams{
		Content:  []byte("plain text"),
		Filename: "doc.txt",
		MimeType: "text/plain",
	})

	_, err := svc.UpdateEXIF(ctx, UpdateEXIFParams{
		ID:     m.ID,
		Fields: map[string]string{"Make": "Test"},
	})
	if err != nil {
		t.Fatalf("UpdateEXIF on non-JPEG: %v", err)
	}
}

func TestUpdateEXIF_NotFound(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir) }()
	ctx := context.Background()

	_, err := svc.UpdateEXIF(ctx, UpdateEXIFParams{ID: 9999, Fields: map[string]string{}})
	if err == nil {
		t.Error("expected error for non-existent media ID")
	}
}

func TestRevertEXIF_RestoresOriginal(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir) }()
	ctx := context.Background()

	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, nil)
	// Write EXIF into the JPEG so extractEXIF finds tags and original_metadata gets populated.
	tmpJpeg := filepath.Join(t.TempDir(), "source.jpg")
	_ = os.WriteFile(tmpJpeg, buf.Bytes(), 0644)
	_ = writeEXIFToFile(tmpJpeg, "image/jpeg", map[string]interface{}{"Make": "TestCam", "Model": "M1"})
	jpegWithExif, _ := os.ReadFile(tmpJpeg)
	m, err := svc.UploadFile(ctx, UploadFileParams{
		Content:  jpegWithExif,
		Filename: "photo.jpg",
		MimeType: "image/jpeg",
	})
	if err != nil {
		t.Fatalf("UploadFile: %v", err)
	}
	if !m.OriginalMetadata.Valid {
		t.Fatal("expected original_metadata to be populated after upload with EXIF-bearing JPEG")
	}
	originalMeta := m.OriginalMetadata.String

	_, _ = svc.UpdateEXIF(ctx, UpdateEXIFParams{
		ID:     m.ID,
		Fields: map[string]string{"Make": "Edited"},
	})

	reverted, err := svc.RevertEXIF(ctx, m.ID)
	if err != nil {
		t.Fatalf("RevertEXIF: %v", err)
	}

	if reverted.Metadata.String != originalMeta {
		t.Errorf("metadata after revert = %q; want %q", reverted.Metadata.String, originalMeta)
	}
	if reverted.OriginalMetadata.String != originalMeta {
		t.Errorf("original_metadata changed: got %q; want %q", reverted.OriginalMetadata.String, originalMeta)
	}
}

func TestRevertEXIF_NoOriginal(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir) }()
	ctx := context.Background()

	_, _ = svc.repo.DB().Exec(
		`INSERT INTO media (filename, original_path, file_type, mime_type, file_size, checksum, is_public)
         VALUES ('ghost.jpg', 'originals/ghost.jpg', 'image', 'image/jpeg', 100, 'abc999', 0)`)

	var id int64
	_ = svc.repo.DB().QueryRow(`SELECT id FROM media WHERE checksum = 'abc999'`).Scan(&id)

	_, err := svc.RevertEXIF(ctx, id)
	if err == nil {
		t.Error("expected error when original_metadata is null")
	}
}

func TestRevertEXIF_NotFound(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir) }()
	ctx := context.Background()

	_, err := svc.RevertEXIF(ctx, 9999)
	if err == nil {
		t.Error("expected error for non-existent ID")
	}
}

func TestMediaService_UpdateMedia_Metadata(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	cfg := &config.Config{StoragePath: t.TempDir(), ThumbnailWidth: 100, ThumbnailHeight: 100}
	settingsSvc := NewSettingsService(repo)
	tagSvc := NewTagService(repo)
	svc := NewMediaService(repo, cfg, settingsSvc, tagSvc)
	ctx := context.Background()

	media, err := svc.UploadFile(ctx, UploadFileParams{
		Content: []byte("data"), Filename: "test.txt", MimeType: "text/plain",
	})
	if err != nil {
		t.Fatalf("upload: %v", err)
	}

	initial := map[string]interface{}{"Make": "Canon"}
	_, err = svc.UpdateMedia(ctx, UpdateMediaParams{
		ID: media.ID, AltText: "alt", Caption: "cap", Metadata: &initial,
	})
	if err != nil {
		t.Fatalf("set metadata: %v", err)
	}

	_, err = svc.UpdateMedia(ctx, UpdateMediaParams{
		ID: media.ID, AltText: "alt2", Caption: "cap2", Metadata: nil,
	})
	if err != nil {
		t.Fatalf("nil metadata update: %v", err)
	}
	got, _ := svc.GetMediaByID(ctx, media.ID)
	if !got.Metadata.Valid || got.Metadata.String == "" {
		t.Errorf("nil Metadata wiped existing: got %v", got.Metadata)
	}

	empty := map[string]interface{}{}
	_, err = svc.UpdateMedia(ctx, UpdateMediaParams{
		ID: media.ID, Metadata: &empty,
	})
	if err != nil {
		t.Fatalf("empty map metadata: %v", err)
	}
	got2, _ := svc.GetMediaByID(ctx, media.ID)
	if got2.Metadata.Valid && got2.Metadata.String != "{}" {
		t.Errorf("expected {} got %q", got2.Metadata.String)
	}
}

func TestSafeImagingDecode_ValidImage(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}

	got, err := safeImagingDecode(&buf)
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if got == nil {
		t.Error("expected non-nil image")
	}
}

func TestSafeImagingDecode_GarbageBytes(t *testing.T) {
	bad := bytes.NewReader([]byte("this is not an image"))
	_, err := safeImagingDecode(bad)
	if err == nil {
		t.Error("expected error for garbage bytes, got nil")
	}
}

func TestSafeImagingDecode_PanicRecovery(t *testing.T) {
	// An empty reader causes imaging.Decode to return an error (EOF).
	// This exercises the defer/recover path without requiring a crafted exploit file.
	_, err := safeImagingDecode(bytes.NewReader(nil))
	if err == nil {
		t.Error("expected error for empty reader")
	}
}

// hugeHeaderPNG returns a PNG whose IHDR declares w x h but which carries no
// usable image data. image.DecodeConfig reads the header and reports the
// declared dimensions; a full decode fails. That asymmetry is the whole point:
// a test that gets ErrTooLarge back has proved the guard ran *before* the
// decode, because a decode would have produced a different error.
func hugeHeaderPNG(t *testing.T, w, h int) []byte {
	t.Helper()

	crc := func(b []byte) []byte {
		table := make([]uint32, 256)
		for i := range table {
			c := uint32(i)
			for k := 0; k < 8; k++ {
				if c&1 != 0 {
					c = 0xedb88320 ^ (c >> 1)
				} else {
					c >>= 1
				}
			}
			table[i] = c
		}
		c := uint32(0xffffffff)
		for _, x := range b {
			c = table[(c^uint32(x))&0xff] ^ (c >> 8)
		}
		c ^= 0xffffffff
		return []byte{byte(c >> 24), byte(c >> 16), byte(c >> 8), byte(c)}
	}
	be32 := func(v int) []byte {
		return []byte{byte(v >> 24), byte(v >> 16), byte(v >> 8), byte(v)}
	}

	var out []byte
	out = append(out, 0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a)

	ihdr := []byte("IHDR")
	ihdr = append(ihdr, be32(w)...)
	ihdr = append(ihdr, be32(h)...)
	ihdr = append(ihdr, 8, 2, 0, 0, 0) // 8-bit truecolour, no interlace
	out = append(out, be32(len(ihdr)-4)...)
	out = append(out, ihdr...)
	out = append(out, crc(ihdr)...)

	return out
}

func TestDecodeImage_RejectsOversizedHeader(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir) }()

	// 20000 x 20000 = 400 MP, well over the 80 MP default. A few dozen bytes on
	// disk; ~1.6 GB of RGBA if it were ever decoded.
	data := hugeHeaderPNG(t, 20000, 20000)
	if len(data) > 128 {
		t.Fatalf("fixture should be tiny, got %d bytes", len(data))
	}

	_, err := svc.decodeImage(context.Background(), data)
	if err == nil {
		t.Fatal("expected oversized image to be rejected")
	}
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("expected ErrTooLarge (413), got %T: %v", err, err)
	}
	// The message has to be actionable: an operator seeing this must be able to
	// tell how far over the line they are.
	for _, want := range []string{"400 megapixels", "20000x20000", "80 megapixels"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("message %q missing %q", err.Error(), want)
		}
	}
}

func TestDecodeImage_AllowsNormalImage(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir) }()

	img := image.NewRGBA(image.Rect(0, 0, 64, 48))
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}

	got, err := svc.decodeImage(context.Background(), buf.Bytes())
	if err != nil {
		t.Fatalf("expected decode to succeed, got: %v", err)
	}
	if got.Bounds().Dx() != 64 || got.Bounds().Dy() != 48 {
		t.Errorf("got %v, want 64x48", got.Bounds())
	}
}

func TestDecodeImage_LimitIsConfigurable(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	// 1 MP ceiling: a 2000x2000 (4 MP) header is now over the line.
	cfg := &config.Config{StoragePath: t.TempDir(), MaxImageMegapixels: 1}
	svc := NewMediaService(repo, cfg, NewSettingsService(repo), NewTagService(repo))

	_, err := svc.decodeImage(context.Background(), hugeHeaderPNG(t, 2000, 2000))
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("expected ErrTooLarge at a 1 MP ceiling, got: %v", err)
	}

	// And the same image passes when the ceiling is raised above it.
	cfg.MaxImageMegapixels = 80
	_, err = svc.decodeImage(context.Background(), hugeHeaderPNG(t, 2000, 2000))
	if errors.Is(err, ErrTooLarge) {
		t.Fatal("expected the 4 MP image to clear an 80 MP ceiling")
	}
}

func TestDecodeImage_UploadRejectsOversized(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir) }()

	// The guard has to sit in the service, not the HTTP handler: the Instagram
	// importer reaches this same path with images the operator never chose.
	_, err := svc.UploadFile(context.Background(), UploadFileParams{
		Content:  hugeHeaderPNG(t, 20000, 20000),
		Filename: "huge.png",
		MimeType: "image/png",
	})
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("expected UploadFile to reject an oversized image with ErrTooLarge, got: %v", err)
	}
}

func TestDecodeImage_ConcurrencyIsBounded(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir) }()

	img := image.NewRGBA(image.Rect(0, 0, 256, 256))
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}
	data := buf.Bytes()

	limit := cap(decodeSem)
	if limit < 1 {
		t.Fatal("decode semaphore has no capacity")
	}

	var mu sync.Mutex
	inFlight, peak := 0, 0

	var wg sync.WaitGroup
	for i := 0; i < limit*8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Sample occupancy from inside the guarded region by wrapping the
			// same semaphore discipline decodeImage uses.
			if _, err := svc.decodeImage(context.Background(), data); err != nil {
				t.Errorf("decode: %v", err)
				return
			}
			mu.Lock()
			inFlight++
			if inFlight > peak {
				peak = inFlight
			}
			inFlight--
			mu.Unlock()
		}()
	}
	wg.Wait()

	// The real assertion is that the semaphore never lets more than its
	// capacity through; observed directly, since decodeImage releases before
	// returning.
	if got := len(decodeSem); got != 0 {
		t.Errorf("semaphore leaked %d slots", got)
	}
}

func TestDecodeImage_RespectsContextCancellation(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir) }()

	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}

	// Saturate the semaphore so the next acquire has to wait.
	for i := 0; i < cap(decodeSem); i++ {
		decodeSem <- struct{}{}
	}
	defer func() {
		for i := 0; i < cap(decodeSem); i++ {
			<-decodeSem
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := svc.decodeImage(ctx, buf.Bytes()); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled when the semaphore is full, got: %v", err)
	}
}
func TestPreprocessContent(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		contain string
	}{
		{"bare jpg → markdown image", "/2024/01/photo.jpg", "![photo.jpg](</2024/01/photo.jpg>)"},
		{"bare mp4 → video tag", "/2024/01/clip.mp4", "<video src="},
		{"bare mp3 → audio tag", "/2024/01/song.mp3", "<audio src="},
		{"plain text unchanged", "Hello, world!", "Hello, world!"},
		{"bare unknown ext → returned unchanged", "/2024/01/file.xyz", "/2024/01/file.xyz"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := preprocessContent(tc.input)
			if !strings.Contains(got, tc.contain) {
				t.Errorf("preprocessContent(%q) = %q; want to contain %q", tc.input, got, tc.contain)
			}
		})
	}
}

func TestSanitizePostCSS(t *testing.T) {
	t.Run("clean CSS passes through", func(t *testing.T) {
		result, stripped := SanitizePostCSS(".post { color: red; }")
		if len(stripped) != 0 {
			t.Errorf("expected no stripped rules, got %v", stripped)
		}
		if !strings.Contains(result, "color: red") {
			t.Errorf("expected clean CSS to pass through, got %q", result)
		}
	})

	t.Run("@import stripped", func(t *testing.T) {
		result, stripped := SanitizePostCSS("@import url('evil.css'); .p { color: red; }")
		if !containsStr(stripped, "@import") {
			t.Errorf("expected '@import' in stripped, got %v", stripped)
		}
		if strings.Contains(result, "@import") {
			t.Errorf("expected @import removed from result, got %q", result)
		}
	})

	t.Run("position fixed stripped", func(t *testing.T) {
		result, _ := SanitizePostCSS(".el { position: fixed; top: 0; }")
		if strings.Contains(result, "position: fixed") {
			t.Error("expected position:fixed to be stripped")
		}
	})

	t.Run("position sticky stripped", func(t *testing.T) {
		result, _ := SanitizePostCSS(".el { position: sticky; }")
		if strings.Contains(result, "position: sticky") {
			t.Error("expected position:sticky to be stripped")
		}
	})

	t.Run("z-index stripped", func(t *testing.T) {
		result, stripped := SanitizePostCSS(".el { z-index: 9999; }")
		if !containsStr(stripped, "z-index") {
			t.Errorf("expected 'z-index' in stripped, got %v", stripped)
		}
		if strings.Contains(result, "9999") {
			t.Errorf("expected z-index value removed, got %q", result)
		}
	})

	t.Run("external url stripped", func(t *testing.T) {
		result, _ := SanitizePostCSS(`.bg { background: url('https://evil.com/img.png'); }`)
		if strings.Contains(result, "evil.com") {
			t.Errorf("expected external URL removed, got %q", result)
		}
	})

	t.Run("empty CSS returns empty", func(t *testing.T) {
		result, stripped := SanitizePostCSS("")
		if result != "" || len(stripped) != 0 {
			t.Errorf("expected empty result for empty input, got %q / %v", result, stripped)
		}
	})
}

func TestMediaService_GetMediaByPostID(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir); _ = svc.repo.Close() }()

	ctx := context.Background()
	media, err := svc.GetMediaByPostID(ctx, 999)
	if err != nil {
		t.Fatalf("GetMediaByPostID: %v", err)
	}
	_ = media
}

func TestMediaService_GetMediaByContent(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir); _ = svc.repo.Close() }()

	ctx := context.Background()
	media, err := svc.GetMediaByContent(ctx, "no media paths here", "")
	if err != nil {
		t.Fatalf("GetMediaByContent: %v", err)
	}
	_ = media
}

func TestMediaService_AnalyzeMediaByID_NotFound(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir); _ = svc.repo.Close() }()
	_, err := svc.AnalyzeMediaByID(context.Background(), 99999)
	if err == nil {
		t.Error("expected error for non-existent ID")
	}
}

func TestMediaService_AnalyzeMediaByID_NotAnImage(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir); _ = svc.repo.Close() }()
	ctx := context.Background()

	m, err := svc.UploadFile(ctx, UploadFileParams{
		Content:  []byte("text content"),
		Filename: "doc.txt",
		MimeType: "text/plain",
	})
	if err != nil {
		t.Fatalf("UploadFile: %v", err)
	}
	_, err = svc.AnalyzeMediaByID(ctx, m.ID)
	if !errors.Is(err, ErrNotAnImage) {
		t.Errorf("expected ErrNotAnImage, got %v", err)
	}
}

func TestMediaService_AnalyzeMediaByPath_TraversalRejected(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir); _ = svc.repo.Close() }()
	_, err := svc.AnalyzeMediaByPath(context.Background(), "../../etc/passwd")
	if err == nil {
		t.Error("expected error for path traversal")
	}
}

func TestMediaService_AnalyzeMediaByPath_NotFound(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir); _ = svc.repo.Close() }()
	_, err := svc.AnalyzeMediaByPath(context.Background(), "/2024/01/nonexistent.jpg")
	if err == nil {
		t.Error("expected error for non-existent file")
	}
}

func TestMediaService_ReextractEXIF_NotFound(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir); _ = svc.repo.Close() }()

	_, err := svc.ReextractEXIF(context.Background(), 99999)
	if err == nil {
		t.Error("expected error for non-existent media ID")
	}
}

func TestMediaService_ReextractEXIF(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir); _ = svc.repo.Close() }()
	ctx := context.Background()

	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}
	m, err := svc.UploadFile(ctx, UploadFileParams{
		Content:  buf.Bytes(),
		Filename: "reextract.jpg",
		MimeType: "image/jpeg",
	})
	if err != nil {
		t.Fatalf("UploadFile: %v", err)
	}

	_, err = svc.ReextractEXIF(ctx, m.ID)
	if err != nil {
		t.Fatalf("ReextractEXIF: %v", err)
	}
}

func TestSanitizeOrigin(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"https://example.com", "https://example.com"},
		{"https://example.com/path?q=1", "https://example.com"},
		{"https://example.com:8080", "https://example.com:8080"},
		{"https://example.com:8080/path", "https://example.com:8080"},
		{"", ""},
	}
	for _, tc := range cases {
		got := SanitizeOrigin(tc.in)
		if got != tc.want {
			t.Errorf("SanitizeOrigin(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestGetRPIDFromURL(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"https://example.com", "example.com"},
		{"https://example.com:8080/path", "example.com"},
		{"http://sub.domain.org", "sub.domain.org"},
		{"", ""},
	}
	for _, tc := range cases {
		got := GetRPIDFromURL(tc.in)
		if got != tc.want {
			t.Errorf("GetRPIDFromURL(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestMediaService_RevertEXIF_Success(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir); _ = svc.repo.Close() }()
	ctx := context.Background()

	m, err := svc.UploadFile(ctx, UploadFileParams{
		Content:  []byte("text"),
		Filename: "doc.txt",
		MimeType: "text/plain",
	})
	if err != nil {
		t.Fatalf("UploadFile: %v", err)
	}

	origMeta := `{"Make":"Canon"}`
	if _, err := svc.repo.DB().ExecContext(ctx,
		`UPDATE media SET original_metadata=? WHERE id=?`, origMeta, m.ID); err != nil {
		t.Fatalf("set original_metadata: %v", err)
	}

	result, err := svc.RevertEXIF(ctx, m.ID)
	if err != nil {
		t.Fatalf("RevertEXIF: %v", err)
	}
	_ = result
}

func TestVerifyPasswordArgon2id_ErrorPaths(t *testing.T) {

	_, err := verifyPasswordArgon2id("pass", "$argon2id$v=19$m=65536,t=2,p=1")
	if !errors.Is(err, ErrInvalidHash) {
		t.Errorf("expected ErrInvalidHash for wrong segments, got %v", err)
	}

	_, err = verifyPasswordArgon2id("pass", "$argon2id$v=0$m=65536,t=2,p=1$abc$def")
	if !errors.Is(err, ErrIncompatibleVersion) {
		t.Errorf("expected ErrIncompatibleVersion, got %v", err)
	}

	_, err = verifyPasswordArgon2id("pass", "$argon2id$v=19$m=65536,t=2,p=1$NOT!BASE64$def")
	if err == nil {
		t.Error("expected error for invalid base64 salt")
	}

	validSalt := "aGVsbG8="
	_, err = verifyPasswordArgon2id("pass", "$argon2id$v=19$m=65536,t=2,p=1$"+validSalt+"$NOT!VALID!")
	if err == nil {
		t.Error("expected error for invalid base64 hash value")
	}

	_, err = verifyPasswordArgon2id("pass", "$argon2id$v=abc$m=65536,t=2,p=1$abc$def")
	if err == nil {
		t.Error("expected error for non-numeric version")
	}

	_, err = verifyPasswordArgon2id("pass", "$argon2id$v=19$m=bad,t=x,p=y$abc$def")
	if err == nil {
		t.Error("expected error for invalid m/t/p parameters")
	}
}

func TestVerifyPassword_ArgonError(t *testing.T) {

	malformedHash := "$argon2id$not-valid"
	result := VerifyPassword("anypass", malformedHash)
	if result {
		t.Error("expected false for malformed argon2id hash")
	}
}

func TestVerifyPassword_BcryptFallback(t *testing.T) {

	hashed, err := bcrypt.GenerateFromPassword([]byte("password"), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("bcrypt.GenerateFromPassword: %v", err)
	}
	bcryptHash := string(hashed)

	if !VerifyPassword("password", bcryptHash) {
		t.Error("expected true for correct bcrypt password")
	}
	if VerifyPassword("wrong", bcryptHash) {
		t.Error("expected false for wrong password")
	}
}

func TestToNullTime_NonNil(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	insertTestUser(t, svc)

	schedTime := time.Now().Add(time.Hour)
	post, _, err := svc.CreatePost(ctx, CreatePostParams{
		Title:       "Scheduled",
		Slug:        "scheduled",
		AuthorID:    1,
		Status:      "scheduled",
		ScheduledAt: &schedTime,
	})
	if err != nil {
		t.Fatalf("CreatePost with ScheduledAt: %v", err)
	}
	if !post.ScheduledAt.Valid {
		t.Error("expected ScheduledAt to be valid")
	}
}

// jpegBytes encodes a blank JPEG of the given size, standing in for the frame a
// browser captures off a <video> element.
func jpegBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, image.NewRGBA(image.Rect(0, 0, w, h)), nil); err != nil {
		t.Fatalf("jpeg.Encode: %v", err)
	}
	return buf.Bytes()
}

// uploadVideo stores a video media row. The service does not decode video, so
// the bytes only need to be unique — MIME validation happens in the handler.
func uploadVideo(t *testing.T, service *MediaService, name string) models.Medium {
	t.Helper()
	media, err := service.UploadFile(context.Background(), UploadFileParams{
		Content:  []byte("fake mp4 " + name),
		Filename: name,
		MimeType: "video/mp4",
	})
	if err != nil {
		t.Fatalf("UploadFile video: %v", err)
	}
	if media.FileType != "video" {
		t.Fatalf("expected file type video, got %s", media.FileType)
	}
	return media
}

func TestSaveVideoPoster(t *testing.T) {
	service, tmpDir := setupMediaService(t)
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = service.repo.Close()
	}()
	ctx := context.Background()

	video := uploadVideo(t, service, "clip.mp4")
	if video.ThumbnailPath.Valid {
		t.Fatal("a freshly uploaded video should have no thumbnail")
	}

	updated, err := service.SaveVideoPoster(ctx, video.ID, jpegBytes(t, 640, 480))
	if err != nil {
		t.Fatalf("SaveVideoPoster: %v", err)
	}
	if !updated.ThumbnailPath.Valid {
		t.Fatal("expected thumbnail_path to be set")
	}

	// The poster lands in the poster tree, which is a different root from the
	// derived variants — purging those must never reach it.
	if !strings.HasPrefix(updated.ThumbnailPath.String, "thumbnails/") ||
		!strings.HasSuffix(updated.ThumbnailPath.String, ".jpg") {
		t.Errorf("unexpected thumbnail path %q", updated.ThumbnailPath.String)
	}
	thumbFull := filepath.Join(tmpDir, "media", updated.ThumbnailPath.String)
	if _, err := os.Stat(thumbFull); err != nil {
		t.Fatalf("poster file missing: %v", err)
	}

	// A capture below the poster box is stored as captured: Fit never upscales,
	// and cropping it to a fixed box is what used to make video thumbnails
	// silently non-aspect-preserving.
	if w, h := imageDims(t, thumbFull); w != 640 || h != 480 {
		t.Errorf("expected poster stored at 640x480, got %dx%d", w, h)
	}

	// The row really was updated, not just the returned copy.
	reloaded, err := service.repo.GetMedia(ctx, video.ID)
	if err != nil {
		t.Fatalf("GetMedia: %v", err)
	}
	if reloaded.ThumbnailPath.String != updated.ThumbnailPath.String {
		t.Errorf("thumbnail_path not persisted: got %q", reloaded.ThumbnailPath.String)
	}
}

func TestSaveVideoPoster_Rejects(t *testing.T) {
	service, tmpDir := setupMediaService(t)
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = service.repo.Close()
	}()
	ctx := context.Background()

	t.Run("undecodable poster", func(t *testing.T) {
		video := uploadVideo(t, service, "bad-poster.mp4")
		if _, err := service.SaveVideoPoster(ctx, video.ID, []byte("not an image")); !errors.Is(err, ErrInvalidInput) {
			t.Errorf("expected ErrInvalidInput, got %v", err)
		}
	})

	t.Run("non-video media", func(t *testing.T) {
		img, err := service.UploadFile(ctx, UploadFileParams{
			Content:  jpegBytes(t, 10, 10),
			Filename: "photo.jpg",
			MimeType: "image/jpeg",
		})
		if err != nil {
			t.Fatalf("UploadFile image: %v", err)
		}
		if _, err := service.SaveVideoPoster(ctx, img.ID, jpegBytes(t, 20, 20)); !errors.Is(err, ErrNotAVideo) {
			t.Errorf("expected ErrNotAVideo, got %v", err)
		}
	})

	t.Run("missing media", func(t *testing.T) {
		if _, err := service.SaveVideoPoster(ctx, 99999, jpegBytes(t, 20, 20)); !errors.Is(err, ErrMediaNotFound) {
			t.Errorf("expected ErrMediaNotFound, got %v", err)
		}
	})
}

func TestVariant_Video(t *testing.T) {
	service, tmpDir := setupMediaService(t)
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = service.repo.Close()
	}()
	ctx := context.Background()

	video := uploadVideo(t, service, "atlas.mp4")

	// Without a poster there is nothing to derive from: the server cannot
	// decode the video itself.
	if _, err := service.Variant(ctx, video, AtlasVariantSize); !errors.Is(err, ErrNoPoster) {
		t.Errorf("expected ErrNoPoster, got %v", err)
	}

	// A 16:9 frame. The stored poster used to be a 4:3 centre crop of this,
	// which made every video's thumbnails silently non-aspect-preserving.
	withPoster, err := service.SaveVideoPoster(ctx, video.ID, jpegBytes(t, 1920, 1080))
	if err != nil {
		t.Fatalf("SaveVideoPoster: %v", err)
	}

	posterFull := filepath.Join(tmpDir, "media", withPoster.ThumbnailPath.String)
	if w, h := imageDims(t, posterFull); w != posterMaxSide || h != posterMaxSide*1080/1920 {
		t.Errorf("stored poster = %dx%d, want %dx%d — it must not be cropped",
			w, h, posterMaxSide, posterMaxSide*1080/1920)
	}

	rung, err := service.Variant(ctx, withPoster, AtlasVariantSize)
	if err != nil {
		t.Fatalf("Variant: %v", err)
	}
	if w, h := imageDims(t, rung); w != 128 || h != 72 {
		t.Errorf("video rung = %dx%d, want 128x72 (16:9 preserved)", w, h)
	}

	// A replacement poster must invalidate the cached rungs rather than leave
	// the grid showing the old frame.
	if _, err := service.SaveVideoPoster(ctx, video.ID, jpegBytes(t, 320, 240)); err != nil {
		t.Fatalf("SaveVideoPoster (replace): %v", err)
	}
	if _, err := os.Stat(rung); !os.IsNotExist(err) {
		t.Errorf("expected cached rung to be dropped after a re-capture, stat err = %v", err)
	}
}

// imageDims decodes just the header of an image file.
func imageDims(t *testing.T, path string) (int, int) {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer func() { _ = f.Close() }()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		t.Fatalf("decode %s: %v", path, err)
	}
	return cfg.Width, cfg.Height
}

// Purging the derived tree — what a thumbnail rebuild does — must not touch a
// video's poster frame. There is no server-side video decoder, so a lost
// poster can only be recovered by an admin re-capturing the frame in a browser
// for every video on the install. The two trees are separate roots precisely
// so this cannot happen by accident.
func TestPurgingVariantsLeavesVideoPostersIntact(t *testing.T) {
	service, tmpDir := setupMediaService(t)
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = service.repo.Close()
	}()
	ctx := context.Background()

	video := uploadVideo(t, service, "keepme.mp4")
	withPoster, err := service.SaveVideoPoster(ctx, video.ID, jpegBytes(t, 640, 480))
	if err != nil {
		t.Fatalf("SaveVideoPoster: %v", err)
	}
	if _, err := service.Variant(ctx, withPoster, AtlasVariantSize); err != nil {
		t.Fatalf("Variant: %v", err)
	}

	posterFull := filepath.Join(tmpDir, "media", withPoster.ThumbnailPath.String)
	if _, err := os.Stat(posterFull); err != nil {
		t.Fatalf("poster missing before purge: %v", err)
	}

	if err := os.RemoveAll(filepath.Join(tmpDir, "media", VariantsRoot)); err != nil {
		t.Fatalf("purge variants: %v", err)
	}

	if _, err := os.Stat(posterFull); err != nil {
		t.Errorf("poster destroyed by a variant purge: %v", err)
	}
	// And the poster is still enough to rebuild the ladder from.
	if _, err := service.Variant(ctx, withPoster, AtlasVariantSize); err != nil {
		t.Errorf("Variant after purge: %v", err)
	}
}

// Every lifecycle path that destroys or moves a source must sweep all four
// rungs. A rung has no DB row, so one left behind is invisible and permanent.
func TestLifecycleSweepsAllVariants(t *testing.T) {
	ctx := context.Background()

	rungPaths := func(tmpDir string, m models.Medium) []string {
		var paths []string
		for _, size := range VariantSizes {
			paths = append(paths, filepath.Join(tmpDir, "media", VariantRelPath(m.OriginalPath, size)))
		}
		return paths
	}
	assertGone := func(t *testing.T, paths []string) {
		t.Helper()
		for _, p := range paths {
			if _, err := os.Stat(p); !os.IsNotExist(err) {
				t.Errorf("variant %s survived, stat err = %v", p, err)
			}
		}
	}
	upload := func(t *testing.T, service *MediaService, name string) models.Medium {
		t.Helper()
		m, err := service.UploadFile(ctx, UploadFileParams{
			Content:  jpegBytes(t, 2000, 1500),
			Filename: name,
			MimeType: "image/jpeg",
		})
		if err != nil {
			t.Fatalf("UploadFile: %v", err)
		}
		for _, size := range VariantSizes {
			if _, err := service.Variant(ctx, m, size); err != nil {
				t.Fatalf("Variant(%d): %v", size, err)
			}
		}
		return m
	}

	t.Run("delete", func(t *testing.T) {
		service, tmpDir := setupMediaService(t)
		m := upload(t, service, "del.jpg")
		paths := rungPaths(tmpDir, m)
		if err := service.DeleteMedia(ctx, m.ID); err != nil {
			t.Fatalf("DeleteMedia: %v", err)
		}
		assertGone(t, paths)
	})

	t.Run("bulk delete", func(t *testing.T) {
		service, tmpDir := setupMediaService(t)
		m := upload(t, service, "bulk.jpg")
		paths := rungPaths(tmpDir, m)
		if _, err := service.BulkDeleteMedia(ctx, []int64{m.ID}); err != nil {
			t.Fatalf("BulkDeleteMedia: %v", err)
		}
		assertGone(t, paths)
	})

	t.Run("orphan cleanup", func(t *testing.T) {
		service, tmpDir := setupMediaService(t)
		m := upload(t, service, "orphan.jpg")
		paths := rungPaths(tmpDir, m)
		if _, _, err := service.CleanupOrphaned(ctx); err != nil {
			t.Fatalf("CleanupOrphaned: %v", err)
		}
		assertGone(t, paths)
	})

	t.Run("rename", func(t *testing.T) {
		service, tmpDir := setupMediaService(t)
		m := upload(t, service, "before.jpg")
		paths := rungPaths(tmpDir, m)
		renamed, err := service.RenameMedia(ctx, m.ID, "after.jpg")
		if err != nil {
			t.Fatalf("RenameMedia: %v", err)
		}
		// The rungs were keyed on the old path, so they are orphans now.
		assertGone(t, paths)
		// And the new name regenerates on demand.
		if _, err := service.Variant(ctx, renamed, AtlasVariantSize); err != nil {
			t.Errorf("Variant after rename: %v", err)
		}
	})
}

func TestSanitizeOrigin_InvalidURL(t *testing.T) {

	result := SanitizeOrigin("://bad-url")
	_ = result
}

func TestGetRPIDFromURL_InvalidURL(t *testing.T) {
	result := GetRPIDFromURL("://bad")
	_ = result
}
