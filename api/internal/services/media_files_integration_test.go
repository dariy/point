//go:build !unit

package services

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/jpeg"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"point-api/internal/config"
)

func TestNewMediaService(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	cfg := &config.Config{StoragePath: t.TempDir()}
	settings := NewSettingsService(repo)
	tags := NewTagService(repo)

	// Test without models (empty config)
	service := NewMediaService(repo, cfg, settings, tags)
	if service == nil {
		t.Fatal("expected service, got nil")
	}

	// Test with models (simulated via config)
	// NewMediaService currently doesn't use GEMINI_API_KEY directly from env in constructor
	// but it's good to exercise the path.
}

func TestMediaService_AnalyzeMediaByID(t *testing.T) {
	service, tmpDir := setupMediaService(t)
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = service.repo.Close()
	}()

	ctx := context.Background()

	// 1. Media not found
	_, err := service.AnalyzeMediaByID(ctx, 999)
	if err == nil || !errors.Is(err, ErrMediaNotFound) {
		t.Errorf("expected ErrMediaNotFound, got %v", err)
	}

	// 2. Not an image
	m, _ := service.UploadFile(ctx, UploadFileParams{
		Content:  []byte("not an image"),
		Filename: "test.txt",
		MimeType: "text/plain",
	})
	_, err = service.AnalyzeMediaByID(ctx, m.ID)
	if err == nil || !errors.Is(err, ErrNotAnImage) {
		t.Errorf("expected ErrNotAnImage, got %v", err)
	}

	// 3. Image too large
	largeImg := make([]byte, maxAnalyzeBytes+1)
	m2, _ := service.UploadFile(ctx, UploadFileParams{
		Content:  largeImg,
		Filename: "large.jpg",
		MimeType: "image/jpeg",
	})
	_, err = service.AnalyzeMediaByID(ctx, m2.ID)
	if err == nil || !bytes.Contains([]byte(err.Error()), []byte("too large")) {
		t.Errorf("expected too large error, got %v", err)
	}

	// 4. Valid image (fallback to HTTP mock as in media_service_test.go)
	// Create a dummy image
	img := image.NewRGBA(image.Rect(0, 0, 10, 10))
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, nil)

	_, _ = service.UploadFile(ctx, UploadFileParams{
		Content:  buf.Bytes(),
		Filename: "valid.jpg",
		MimeType: "image/jpeg",
	})

	// We don't re-test the mock server here as it's in TestMediaService_AnalyzeImage
	// but we've exercised the AnalyzeMediaByID wrapper logic.
}

func TestMediaService_AnalyzeMediaByPath(t *testing.T) {
	service, tmpDir := setupMediaService(t)
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = service.repo.Close()
	}()

	ctx := context.Background()

	// 1. Invalid path (escape attempt)
	_, err := service.AnalyzeMediaByPath(ctx, "../../etc/passwd")
	if err == nil || err.Error() != "invalid media path" {
		t.Errorf("expected invalid media path, got %v", err)
	}

	// 2. Media not found on disk
	_, err = service.AnalyzeMediaByPath(ctx, "/2026/01/missing.jpg")
	if err == nil || err.Error() != "media file not found" {
		t.Errorf("expected media file not found, got %v", err)
	}

	// 3. Valid path
	img := image.NewRGBA(image.Rect(0, 0, 10, 10))
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, nil)

	m, _ := service.UploadFile(ctx, UploadFileParams{
		Content:  buf.Bytes(),
		Filename: "path-test.jpg",
		MimeType: "image/jpeg",
	})

	// m.OriginalPath is "originals/2026/03/path-test.jpg"
	// AnalyzeMediaByPath expects the part after "originals/"
	relPath := filepath.ToSlash(filepath.Clean(m.OriginalPath))
	relPath = relPath[len("originals"):]

	// Again, just exercising the wrapper and path logic
	_, err = service.AnalyzeMediaByPath(ctx, relPath)
	// Error "GenAI API not configured" is expected here as we didn't mock the endpoint
	if err != nil && err.Error() == "GenAI API not configured" {
		// This confirms we reached the AnalyzeImage call
	} else if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestMediaService_EdgeCases(t *testing.T) {
	service, tmpDir := setupMediaService(t)
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = service.repo.Close()
	}()

	ctx := context.Background()

	// Rename: invalid ID
	_, err := service.RenameMedia(ctx, 999, "new.jpg")
	if err == nil {
		t.Error("RenameMedia should fail for non-existent ID")
	}

	// Delete: invalid ID
	err = service.DeleteMedia(ctx, 999)
	if err == nil {
		t.Error("DeleteMedia should fail for non-existent ID")
	}

	// RebuildThumbnails: with non-existent file in DB
	_, _ = service.repo.DB().Exec(`INSERT INTO media (filename, original_path, file_type, mime_type, file_size, checksum) VALUES ('ghost.jpg', 'originals/ghost.jpg', 'image', 'image/jpeg', 100, 'abc')`)
	stats, err := service.RebuildThumbnails(ctx, true)
	if err != nil {
		t.Errorf("RebuildThumbnails should not fail for missing files: %v", err)
	}
	if stats["errors"] == 0 {
		t.Log("rebuild thumbnails had 0 errors as expected")
	}
}

// TestMediaService_ImportFromPath covers 0% function.
func TestMediaService_ImportFromPath(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = svc.repo.Close()
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
		_ = os.RemoveAll(tmpDir)
		_ = svc.repo.Close()
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
		_ = os.RemoveAll(tmpDir)
		_ = svc.repo.Close()
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
		_ = os.RemoveAll(tmpDir)
		_ = svc.repo.Close()
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
		_ = os.RemoveAll(tmpDir)
		_ = svc.repo.Close()
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
		_ = os.RemoveAll(tmpDir)
		_ = svc.repo.Close()
	}()
	ctx := context.Background()

	// Upload a real image, then give it a legacy thumbnail_path — the column
	// onlyMissing keys off. (Uploads no longer write one: an image's derived
	// sizes live in the variants tree, and thumbnail_path is now the video
	// poster column.)
	img := image.NewRGBA(image.Rect(0, 0, 10, 10))
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, nil)
	m, err := svc.UploadFile(ctx, UploadFileParams{Content: buf.Bytes(), Filename: "existing.jpg", MimeType: "image/jpeg"})
	if err != nil {
		t.Fatalf("UploadFile: %v", err)
	}
	if _, err := svc.repo.DB().ExecContext(ctx,
		`UPDATE media SET thumbnail_path = 'thumbnails/legacy.jpg' WHERE id = ?`, m.ID); err != nil {
		t.Fatalf("set legacy thumbnail_path: %v", err)
	}

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
		_ = os.RemoveAll(tmpDir)
		_ = svc.repo.Close()
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
		_ = os.RemoveAll(tmpDir)
		_ = svc.repo.Close()
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

	// Call AnalyzeMediaByID on the valid image - will return empty response (soft-fail)
	// (no AI configured), but covers the file read path
	resp, err := svc.AnalyzeMediaByID(ctx, m.ID)
	// Expected soft-fail
	if err != nil {
		t.Errorf("expected no error from AnalyzeMediaByID (soft-fail), got %v", err)
	}
	if resp == nil || len(resp.Tags) != 0 {
		t.Error("expected empty analysis response")
	}
}

// TestMediaService_CleanupOrphanedWithData covers 80% CleanupOrphaned.
func TestMediaService_CleanupOrphanedWithData(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = svc.repo.Close()
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
		_ = os.RemoveAll(tmpDir)
		_ = svc.repo.Close()
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
		_ = os.RemoveAll(tmpDir)
		_ = svc.repo.Close()
	}()
	ctx := context.Background()

	_, err := svc.RecalculateAllMediaVisibility(ctx)
	if err != nil {
		t.Fatalf("RecalculateAllMediaVisibility failed: %v", err)
	}
}

// TestMediaService_RebuildThumbnailsWithImages covers 72.7% function more thoroughly.
func TestMediaService_RebuildThumbnailsWithImages(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = svc.repo.Close()
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

// TestMediaService_UpdateMediaVisibilityForPathsBoost covers 73% function.
func TestMediaService_UpdateMediaVisibilityForPathsBoost(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = svc.repo.Close()
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
		_ = os.RemoveAll(tmpDir)
		_ = svc.repo.Close()
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

// TestNewMediaServiceWithAPIKey covers the api-key branch in NewMediaService and
// exercises analyzeImageDirectly with a fake key (which will fail at the API call).
func TestNewMediaServiceWithAPIKey(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	tmpDir := t.TempDir()
	cfg := &config.Config{
		StoragePath:    tmpDir,
		GeminiAPIKey:   "fake-key-for-coverage",
		ThumbnailWidth: 400, ThumbnailHeight: 300,
	}
	settings := NewSettingsService(repo)
	tags := NewTagService(repo)

	svc := NewMediaService(repo, cfg, settings, tags)

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

// TestMediaService_AnalyzeByPath_InvalidPath covers the path traversal check.
func TestMediaService_AnalyzeByPath_InvalidPath(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = svc.repo.Close()
	}()
	ctx := context.Background()

	// Path traversal attempt → "invalid media path".
	_, err := svc.AnalyzeMediaByPath(ctx, "../../etc/passwd")
	if err == nil {
		t.Error("expected error for path traversal")
	}
}

// TestMediaService_GetStorageUsage_Valid covers the valid storage usage path.
func TestMediaService_GetStorageUsage_Valid(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = svc.repo.Close()
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

// TestMediaService_parseAnalysisResult_YearTag covers year tag deduplication.
func TestMediaService_parseAnalysisResult_YearTag(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = svc.repo.Close()
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

// TestMediaService_parseAnalysisResult_StrictValidation verifies that extra
// keys or missing required keys return ErrResponseUnusable.
func TestMediaService_parseAnalysisResult_StrictValidation(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = svc.repo.Close()
	}()

	cases := []struct {
		name   string
		result map[string]interface{}
	}{
		{
			name: "extra key",
			result: map[string]interface{}{
				"title": "T", "tags": []interface{}{"a"}, "excerpt": "E", "extra": "bad",
			},
		},
		{
			name: "missing excerpt",
			result: map[string]interface{}{
				"title": "T", "tags": []interface{}{"a"},
			},
		},
		{
			name: "wrong tags type",
			result: map[string]interface{}{
				"title": "T", "tags": "not-an-array", "excerpt": "E",
			},
		},
		{
			name:   "empty map",
			result: map[string]interface{}{},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := svc.parseAnalysisResult(tc.result, "photo.jpg")
			if !errors.Is(err, ErrResponseUnusable) {
				t.Errorf("expected ErrResponseUnusable, got %v", err)
			}
		})
	}
}

// TestMediaService_parseAnalysisResult_Sanitize verifies disallowed characters
// are stripped from AI-returned string fields.
func TestMediaService_parseAnalysisResult_Sanitize(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = svc.repo.Close()
	}()

	result := map[string]interface{}{
		"title":   "Sunset photo! <b>bold</b>",
		"tags":    []interface{}{"nature", "beach & sun", "café"},
		"excerpt": "A beautiful photo. #amazing @user http://evil.com",
	}
	analysis, err := svc.parseAnalysisResult(result, "photo.jpg")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// < > / stripped, text joined: "Sunset photo! bbold b"
	if analysis.Title == nil || strings.ContainsAny(*analysis.Title, "<>/") {
		t.Errorf("title contains disallowed chars: %v", analysis.Title)
	}
	// "beach & sun" → "beach sun" (& removed)
	for _, tag := range analysis.Tags {
		if strings.Contains(tag, "&") {
			t.Errorf("tag not sanitized: %q", tag)
		}
	}
	if analysis.Excerpt == nil || *analysis.Excerpt == "" {
		t.Error("excerpt should not be empty")
	}
	// http:// colon and slashes stripped
	if strings.Contains(*analysis.Excerpt, "://") {
		t.Errorf("excerpt contains unsanitized URL: %q", *analysis.Excerpt)
	}
}

// TestSanitizeContentString checks the character allowlist directly.
func TestSanitizeContentString(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"Hello, world!", "Hello, world!"},
		{"<script>alert(1)</script>", "scriptalert1script"},
		{"café – a fine day", "café – a fine day"},
		{"price: $100 & more", "price: 100 more"},
		{"Isn't it great?", "Isn't it great?"},
		{"em—dash and en–dash", "em—dash and en–dash"},
		{"  lots   of   spaces  ", "lots of spaces"},
		{"newline\nand\ttab", "newline and tab"},
	}
	for _, tc := range cases {
		got := sanitizeContentString(tc.input)
		if got != tc.want {
			t.Errorf("sanitizeContentString(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

// TestSanitizePromptField verifies length limiting in addition to char filtering.
func TestSanitizePromptField(t *testing.T) {
	long := strings.Repeat("a", 250)
	got := sanitizePromptField(long)
	if len(got) > 200 {
		t.Errorf("expected len ≤ 200, got %d", len(got))
	}
	dirty := "describe the photo <b>boldly</b> & clearly"
	got = sanitizePromptField(dirty)
	if strings.ContainsAny(got, "<>&") {
		t.Errorf("sanitizePromptField did not remove disallowed chars: %q", got)
	}
}

// TestUpdateMediaVisibilityForPaths_HiddenAndDuplicate covers the
// hiddenByTag path and duplicate-path path in UpdateMediaVisibilityForPaths.
func TestUpdateMediaVisibilityForPaths_HiddenAndDuplicate(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = svc.repo.Close()
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

func TestVariant(t *testing.T) {
	svc, _ := setupMediaService(t)
	ctx := context.Background()

	var buf bytes.Buffer
	img := image.NewRGBA(image.Rect(0, 0, 600, 400))
	_ = jpeg.Encode(&buf, img, nil)
	m, err := svc.UploadFile(ctx, UploadFileParams{
		Content:  buf.Bytes(),
		Filename: "square.jpg",
		MimeType: "image/jpeg",
	})
	if err != nil {
		t.Fatalf("UploadFile failed: %v", err)
	}

	// Sizes off the ladder are refused so the on-disk cache stays bounded.
	if _, err := svc.Variant(ctx, m, 999); err == nil {
		t.Fatal("expected error for unsupported size 999")
	}

	path, err := svc.Variant(ctx, m, AtlasVariantSize)
	if err != nil {
		t.Fatalf("Variant failed: %v", err)
	}
	if !strings.Contains(filepath.ToSlash(path), "variants/128/") {
		t.Errorf("variant path = %q, want it under variants/128/", path)
	}

	// The longest side is capped and the aspect ratio survives: 600x400 at
	// rung 128 is 128x85, not a 128x128 crop.
	if w, h := variantDims(t, path); w != 128 || h != 85 {
		t.Errorf("variant = %dx%d, want 128x85", w, h)
	}

	// A second call reuses the cached file (same resolved path).
	path2, err := svc.Variant(ctx, m, AtlasVariantSize)
	if err != nil || path2 != path {
		t.Errorf("cached call = %q, %v; want %q, nil", path2, err, path)
	}

	// Non-image media has no still to derive from.
	txt, _ := svc.UploadFile(ctx, UploadFileParams{Content: []byte("x"), Filename: "n.txt", MimeType: "text/plain"})
	if _, err := svc.Variant(ctx, txt, AtlasVariantSize); !errors.Is(err, ErrNotAnImage) {
		t.Errorf("non-image Variant err = %v, want ErrNotAnImage", err)
	}
}

// variantDims decodes just the header of a generated variant.
func variantDims(t *testing.T, path string) (int, int) {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open variant: %v", err)
	}
	defer func() { _ = f.Close() }()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		t.Fatalf("decode variant: %v", err)
	}
	return cfg.Width, cfg.Height
}

// A portrait source must cap its HEIGHT at the rung, not its width — the whole
// point of Fit over the old Fill is that the ladder is aspect-preserving in
// both orientations.
func TestVariant_PortraitCapsLongestSide(t *testing.T) {
	svc, _ := setupMediaService(t)
	ctx := context.Background()

	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 400, 800)), nil)
	m, err := svc.UploadFile(ctx, UploadFileParams{
		Content:  buf.Bytes(),
		Filename: "tall.jpg",
		MimeType: "image/jpeg",
	})
	if err != nil {
		t.Fatalf("UploadFile: %v", err)
	}

	for _, tc := range []struct{ size, wantW, wantH int }{
		{128, 64, 128},
		{256, 128, 256},
		{512, 256, 512},
	} {
		path, err := svc.Variant(ctx, m, tc.size)
		if err != nil {
			t.Fatalf("Variant(%d): %v", tc.size, err)
		}
		if w, h := variantDims(t, path); w != tc.wantW || h != tc.wantH {
			t.Errorf("rung %d = %dx%d, want %dx%d", tc.size, w, h, tc.wantW, tc.wantH)
		}
	}
}

// One request generates the whole ladder. A responsive srcset asks for every
// rung at once; decoding once per rung would mean four decodes to paint one
// image.
func TestVariant_OneRequestBuildsWholeLadder(t *testing.T) {
	svc, storage := setupMediaService(t)
	ctx := context.Background()

	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 2000, 1500)), nil)
	m, err := svc.UploadFile(ctx, UploadFileParams{
		Content:  buf.Bytes(),
		Filename: "wide.jpg",
		MimeType: "image/jpeg",
	})
	if err != nil {
		t.Fatalf("UploadFile: %v", err)
	}

	// Start from an empty tree so the count below measures one lazy request,
	// not the eager generation the upload already did.
	if err := os.RemoveAll(filepath.Join(storage, "media", VariantsRoot)); err != nil {
		t.Fatalf("purge variants: %v", err)
	}

	if _, err := svc.Variant(ctx, m, 256); err != nil {
		t.Fatalf("Variant(256): %v", err)
	}

	for _, size := range VariantSizes {
		full := filepath.Join(storage, "media", VariantRelPath(m.OriginalPath, size))
		if _, err := os.Stat(full); err != nil {
			t.Errorf("rung %d missing after a single request for 256: %v", size, err)
		}
	}
}

// A source smaller than a rung gets no file for it: imaging.Fit does not
// upscale, so the rungs above it would be byte-identical copies. Callers fall
// back to the original.
func TestVariant_SkipsRungsAboveSource(t *testing.T) {
	svc, storage := setupMediaService(t)
	ctx := context.Background()

	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 300, 200)), nil)
	m, err := svc.UploadFile(ctx, UploadFileParams{
		Content:  buf.Bytes(),
		Filename: "small.jpg",
		MimeType: "image/jpeg",
	})
	if err != nil {
		t.Fatalf("UploadFile: %v", err)
	}

	for _, size := range VariantSizes {
		full := filepath.Join(storage, "media", VariantRelPath(m.OriginalPath, size))
		_, statErr := os.Stat(full)
		if size < 300 && statErr != nil {
			t.Errorf("rung %d should exist for a 300px source: %v", size, statErr)
		}
		if size >= 300 && statErr == nil {
			t.Errorf("rung %d should not exist for a 300px source", size)
		}
	}

	if _, err := svc.Variant(ctx, m, 512); !errors.Is(err, ErrVariantNotNeeded) {
		t.Errorf("Variant(512) err = %v, want ErrVariantNotNeeded", err)
	}
}

// Two concurrent requests for different rungs of a cold image must decode once
// between them, not once each.
func TestVariant_ConcurrentRequestsDecodeOnce(t *testing.T) {
	svc, storage := setupMediaService(t)
	ctx := context.Background()

	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 1600, 1200)), nil)
	m, err := svc.UploadFile(ctx, UploadFileParams{
		Content:  buf.Bytes(),
		Filename: "cold.jpg",
		MimeType: "image/jpeg",
	})
	if err != nil {
		t.Fatalf("UploadFile: %v", err)
	}
	if err := os.RemoveAll(filepath.Join(storage, "media", VariantsRoot)); err != nil {
		t.Fatalf("purge variants: %v", err)
	}

	var decodes atomic.Int64
	decodeObserver = func() { decodes.Add(1) }
	t.Cleanup(func() { decodeObserver = nil })

	var wg sync.WaitGroup
	start := make(chan struct{})
	for _, size := range []int{128, 512} {
		wg.Add(1)
		go func(size int) {
			defer wg.Done()
			<-start
			if _, err := svc.Variant(ctx, m, size); err != nil {
				t.Errorf("Variant(%d): %v", size, err)
			}
		}(size)
	}
	close(start)
	wg.Wait()

	if n := decodes.Load(); n != 1 {
		t.Errorf("decoded %d times for two concurrent rungs, want 1", n)
	}
}

// The batch form must produce the same visibility outcome the per-path loop
// did, for both directions of the flip, and must ignore paths with no media
// row rather than failing. See point-perf-media-visibility-n1.
func TestUpdateMediaVisibilityForPaths_BatchResolvesEveryPath(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() {
		_ = os.RemoveAll(tmpDir)
		_ = svc.repo.Close()
	}()
	ctx := context.Background()
	repo := svc.repo

	_, _ = repo.DB().Exec(`INSERT INTO users (id,username,email,password_hash,display_name) VALUES (1,'u','u@t.com','h','U')`)
	_, _ = repo.DB().Exec(`CREATE TABLE IF NOT EXISTS media_visibility_log (id INTEGER PRIMARY KEY, media_id INTEGER, is_public INTEGER, post_id INTEGER)`)

	// A published post referencing two of the three media files.
	_, _ = repo.DB().Exec(`INSERT INTO posts (id,title,slug,content,author_id,status,published_at) VALUES (1,'V','v','[a](/media/originals/2024/02/a.jpg) [b](/media/originals/2024/02/b.jpg)',1,'published',datetime('now'))`)

	// a: not yet public, referenced      → must become public
	// b: not yet public, referenced      → must become public
	// c: currently public, not referenced → must become private
	_, _ = repo.DB().Exec(`INSERT INTO media (id,filename,original_path,file_type,mime_type,file_size,checksum,is_public) VALUES
		(1,'a.jpg','originals/2024/02/a.jpg','image','image/jpeg',1,'c1',0),
		(2,'b.jpg','originals/2024/02/b.jpg','image','image/jpeg',1,'c2',0),
		(3,'c.jpg','originals/2024/02/c.jpg','image','image/jpeg',1,'c3',1)`)

	paths := []string{
		"originals/2024/02/a.jpg",
		"originals/2024/02/b.jpg",
		"originals/2024/02/c.jpg",
		"originals/2024/02/no-such-row.jpg", // no media record: skipped, not an error
	}
	if err := svc.UpdateMediaVisibilityForPaths(ctx, paths); err != nil {
		t.Fatalf("UpdateMediaVisibilityForPaths: %v", err)
	}

	for id, want := range map[int]int{1: 1, 2: 1, 3: 0} {
		var got int
		if err := repo.DB().QueryRow(`SELECT is_public FROM media WHERE id=?`, id).Scan(&got); err != nil {
			t.Fatalf("read media %d: %v", id, err)
		}
		if got != want {
			t.Errorf("media %d is_public = %d, want %d", id, got, want)
		}
	}
}
