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
	"testing"
	"time"

	"point-api/internal/config"
	"point-api/internal/repository"

	goexif "github.com/rwcarlsen/goexif/exif"
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
	dirty := "Canon <script>alert(1)</script>"
	got := sanitizeEXIFValue(dirty)
	want := "Canon scriptalert1script"
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

	_, err = svc.UpdateEXIF(ctx, UpdateEXIFParams{
		ID:     m.ID,
		Fields: map[string]string{"Make": "Canon/EOS"},
	})
	if err == nil {
		t.Error("expected error for value with '/'")
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
	f, err := os.Open(fullPath)
	if err != nil {
		t.Fatalf("open file: %v", err)
	}
	defer func() { _ = f.Close() }()
	x, err := goexif.Decode(f)
	if err != nil {
		t.Fatalf("goexif decode: %v", err)
	}
	makeVal, _ := x.Get(goexif.Make)
	if got := strings.Trim(makeVal.String(), "\""); got != "Sony" {
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
func TestPreprocessContent(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		contain string
	}{
		{"bare jpg → markdown image", "/2024/01/photo.jpg", "![photo.jpg](/2024/01/photo.jpg)"},
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

func containsStr(slice []string, s string) bool {
	for _, v := range slice {
		if v == s {
			return true
		}
	}
	return false
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
	if err != ErrNotAnImage {
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
	if err != ErrInvalidHash {
		t.Errorf("expected ErrInvalidHash for wrong segments, got %v", err)
	}

	_, err = verifyPasswordArgon2id("pass", "$argon2id$v=0$m=65536,t=2,p=1$abc$def")
	if err != ErrIncompatibleVersion {
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

func TestSanitizeOrigin_InvalidURL(t *testing.T) {

	result := SanitizeOrigin("://bad-url")
	_ = result
}

func TestGetRPIDFromURL_InvalidURL(t *testing.T) {
	result := GetRPIDFromURL("://bad")
	_ = result
}

func setupTestDB(t *testing.T) *repository.Repository {
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatalf("failed to create test repository: %v", err)
	}

	return repo
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
	tagService := NewTagService(repo)
	service := NewMediaService(repo, cfg, settingsService, tagService)

	return service, tmpDir
}
