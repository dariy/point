package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

func TestSystemService_CreateBackup_InsufficientDisk(t *testing.T) {
	repo := setupTestDB(t)
	tmpDir := t.TempDir()
	defer func() { _ = repo.Close() }()

	svc := services.NewSystemService(repo, tmpDir)

	// Get actual free space
	info, err := svc.GetDiskInfo()
	if err != nil {
		t.Fatalf("GetDiskInfo: %v", err)
	}

	// Create a fake "previous backup" whose size > free/1.5 (1.5x would exceed free)
	backupDir := filepath.Join(tmpDir, "backups")
	_ = os.MkdirAll(backupDir, 0755)
	fakeSize := info.Free + 1 // larger than free space itself
	fakeFile := filepath.Join(backupDir, "backup_20200101_000000.tar.gz")
	f, _ := os.Create(fakeFile)
	_ = f.Truncate(fakeSize)
	_ = f.Close()

	_, _, err = svc.CreateBackup(context.Background())
	if err == nil {
		t.Fatal("expected error for insufficient disk space, got nil")
	}
	if !strings.Contains(err.Error(), "insufficient disk space") {
		t.Errorf("expected 'insufficient disk space' in error, got: %v", err)
	}
}

func TestSystemHandler_Stats(t *testing.T) {
	repo := setupTestDB(t)
	tmpDir, _ := os.MkdirTemp("", "system-api-test")
	defer func() {
		_ = repo.Close()
		_ = os.RemoveAll(tmpDir)
	}()

	settingsService := services.NewSettingsService(repo)
	tagService := services.NewTagService(repo)
	postService := services.NewPostService(repo, nil, nil, nil, "")
	mediaService := services.NewMediaService(repo, &config.Config{}, settingsService, tagService)
	systemService := services.NewSystemService(repo, tmpDir)
	cacheSvc := services.NewCacheService(tmpDir)
	handler := NewSystemHandler(repo, mediaService, postService, settingsService, tagService, systemService, cacheSvc, tmpDir, "1.0.0")

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/system/stats", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := handler.GetStats(c); err != nil {
		t.Fatalf("GetStats failed: %v", err)
	}

	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}
}

func TestSystemHandler_Logs(t *testing.T) {
	repo := setupTestDB(t)
	tmpDir, _ := os.MkdirTemp("", "system-api-test-logs")
	defer func() {
		_ = repo.Close()
		_ = os.RemoveAll(tmpDir)
	}()

	// Create a log file
	logPath := filepath.Join(tmpDir, "logs", "app.log")
	_ = os.MkdirAll(filepath.Join(tmpDir, "logs"), 0755)
	_ = os.WriteFile(logPath, []byte(`line1
line2
line3`), 0644)

	settingsService := services.NewSettingsService(repo)
	tagService := services.NewTagService(repo)
	postService := services.NewPostService(repo, nil, nil, nil, "")
	mediaService := services.NewMediaService(repo, &config.Config{}, settingsService, tagService)
	systemService := services.NewSystemService(repo, tmpDir)
	cacheSvc := services.NewCacheService(tmpDir)
	handler := NewSystemHandler(repo, mediaService, postService, settingsService, tagService, systemService, cacheSvc, tmpDir, "1.0.0")

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/system/logs", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := handler.GetLogs(c); err != nil {
		t.Fatalf("GetLogs failed: %v", err)
	}

	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}
}

func TestSystemHandler_GetMigrations(t *testing.T) {
	repo := setupTestDB(t)
	tmpDir, _ := os.MkdirTemp("", "sys-test")
	defer func() {
		_ = repo.Close()
		_ = os.RemoveAll(tmpDir)
	}()

	cfg := &config.Config{StoragePath: tmpDir}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo, nil, nil, nil, "")
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	systemSvc := services.NewSystemService(repo, tmpDir)
	cacheSvc := services.NewCacheService(tmpDir)
	handler := NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc, systemSvc, cacheSvc, tmpDir, "1.0.0")

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/system/migrations", nil)
	rec := httptest.NewRecorder()

	if err := handler.GetMigrations(e.NewContext(req, rec)); err != nil {
		t.Fatalf("GetMigrations failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestSystemHandler_RecalculateMediaVisibility(t *testing.T) {
	repo := setupTestDB(t)
	tmpDir, _ := os.MkdirTemp("", "sys-test")
	defer func() {
		_ = repo.Close()
		_ = os.RemoveAll(tmpDir)
	}()

	cfg := &config.Config{StoragePath: tmpDir}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo, nil, nil, nil, "")
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	systemSvc := services.NewSystemService(repo, tmpDir)
	cacheSvc := services.NewCacheService(tmpDir)
	handler := NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc, systemSvc, cacheSvc, tmpDir, "1.0.0")

	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/system/media/recalculate", nil)
	rec := httptest.NewRecorder()

	if err := handler.RecalculateMediaVisibility(e.NewContext(req, rec)); err != nil {
		t.Fatalf("RecalculateMediaVisibility failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestSystemHandler_UpdateMapCoords(t *testing.T) {
	repo := setupTestDB(t)
	tmpDir, _ := os.MkdirTemp("", "sys-test")
	defer func() {
		_ = repo.Close()
		_ = os.RemoveAll(tmpDir)
	}()

	cfg := &config.Config{StoragePath: tmpDir}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo, nil, nil, nil, "")
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	systemSvc := services.NewSystemService(repo, tmpDir)
	cacheSvc := services.NewCacheService(tmpDir)
	handler := NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc, systemSvc, cacheSvc, tmpDir, "1.0.0")

	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/system/tags/update-coords", nil)
	rec := httptest.NewRecorder()

	if err := handler.UpdateMapCoords(e.NewContext(req, rec)); err != nil {
		t.Fatalf("UpdateMapCoords failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestSystemHandler_ClearCache(t *testing.T) {
	repo := setupTestDB(t)
	tmpDir, _ := os.MkdirTemp("", "sys-test")
	defer func() {
		_ = repo.Close()
		_ = os.RemoveAll(tmpDir)
	}()

	cfg := &config.Config{StoragePath: tmpDir}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo, nil, nil, nil, "")
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	systemSvc := services.NewSystemService(repo, tmpDir)
	cacheSvc := services.NewCacheService(tmpDir)
	handler := NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc, systemSvc, cacheSvc, tmpDir, "1.0.0")

	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/api/system/cache/clear", nil)
	rec := httptest.NewRecorder()

	if err := handler.ClearCache(e.NewContext(req, rec)); err != nil {
		t.Fatalf("ClearCache failed: %v", err)
	}

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if resp["status"] != "success" {
		t.Errorf("expected status 'success', got %v", resp["status"])
	}

	if _, ok := resp["updated_media"]; !ok {
		t.Errorf("expected 'updated_media' field in response")
	}
}

func TestSystemHandler_GetStats_Success(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	tmpDir := t.TempDir()
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo, nil, nil, nil, "")
	mediaSvc := services.NewMediaService(repo, &config.Config{StoragePath: tmpDir}, settingsSvc, tagSvc)
	systemSvc := services.NewSystemService(repo, tmpDir)
	cacheSvc := services.NewCacheService(tmpDir)
	h := NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc, systemSvc, cacheSvc, tmpDir, "1.2.3")
	e := echo.New()

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})
	if err := h.GetStats(c); err != nil {
		t.Fatalf("GetStats failed: %v", err)
	}
}

func TestSemverGreaterThan(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		// major version differences
		{"2.0.0", "1.0.0", true},
		{"1.0.0", "2.0.0", false},
		// minor version differences
		{"1.2.0", "1.1.0", true},
		{"1.1.0", "1.2.0", false},
		// patch version differences
		{"1.0.2", "1.0.1", true},
		{"1.0.1", "1.0.2", false},
		// equal versions
		{"1.0.0", "1.0.0", false},
		// v prefix stripped
		{"v2.0.0", "v1.0.0", true},
		{"v1.0.0", "v2.0.0", false},
		// pre-release suffix ignored in comparison
		{"1.0.2-beta", "1.0.1", true},
		{"1.0.0-rc1", "1.0.0", false},
		// invalid semver → false
		{"not-a-version", "1.0.0", false},
		{"1.0.0", "not-a-version", false},
		{"1.0", "1.0.0", false},     // too few parts
		{"1.0.abc", "1.0.0", false}, // non-numeric patch
		{"a.0.0", "1.0.0", false},   // non-numeric major
	}
	for _, tc := range cases {
		got := semverGreaterThan(tc.a, tc.b)
		if got != tc.want {
			t.Errorf("semverGreaterThan(%q, %q) = %v, want %v", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestSystemHandler_GetDiskInfo(t *testing.T) {
	repo := setupTestDB(t)
	tmpDir := t.TempDir()
	defer func() { _ = repo.Close() }()

	cfg := &config.Config{StoragePath: tmpDir}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo, nil, nil, nil, "")
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	systemSvc := services.NewSystemService(repo, tmpDir)
	cacheSvc := services.NewCacheService(tmpDir)
	h := NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc, systemSvc, cacheSvc, tmpDir, "1.0.0")

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/system/disk", nil)
	rec := httptest.NewRecorder()
	if err := h.GetDiskInfo(e.NewContext(req, rec)); err != nil {
		t.Fatalf("GetDiskInfo failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	for _, key := range []string{"total", "free", "used"} {
		if _, ok := resp[key]; !ok {
			t.Errorf("response missing field %q", key)
		}
	}
}

// newSystemHandler is a test helper that builds a SystemHandler with a real temp DB and dir.
func newSystemHandler(t *testing.T) (*SystemHandler, string) {
	t.Helper()
	repo := setupTestDB(t)
	tmpDir := t.TempDir()
	cfg := &config.Config{StoragePath: tmpDir}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo, nil, nil, nil, "")
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	systemSvc := services.NewSystemService(repo, tmpDir)
	cacheSvc := services.NewCacheService(tmpDir)
	h := NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc, systemSvc, cacheSvc, tmpDir, "1.0.0")
	return h, tmpDir
}

func TestSafeJoin(t *testing.T) {
	root := "/data/library"
	// safeJoin neutralizes traversal by prepending "/" before Clean, so paths like
	// "../escape" become "/escape" and then get joined safely under root.
	// The function only errors if the result somehow escapes the root prefix.
	cases := []struct {
		rel  string
		want string
	}{
		{"", root},
		{"subdir", root + "/subdir"},
		{"subdir/file.jpg", root + "/subdir/file.jpg"},
		{"../escape", root + "/escape"},            // traversal neutralized → inside root
		{"../../etc/passwd", root + "/etc/passwd"}, // deeper traversal also neutralized
	}
	for _, tc := range cases {
		got, err := safeJoin(root, tc.rel)
		if err != nil {
			t.Errorf("safeJoin(%q, %q): unexpected error: %v", root, tc.rel, err)
			continue
		}
		if got != tc.want {
			t.Errorf("safeJoin(%q, %q): got %q, want %q", root, tc.rel, got, tc.want)
		}
	}
}

func TestSystemHandler_GetPhotoLibraryContents_NotConfigured(t *testing.T) {
	h, _ := newSystemHandler(t)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/system/photo-library", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	err := h.GetPhotoLibraryContents(c)
	if err == nil {
		t.Fatal("expected error when photo_library_path not configured")
	}
	he, ok := err.(*echo.HTTPError)
	if !ok || he.Code != http.StatusBadRequest {
		t.Errorf("expected 400 HTTPError, got %v", err)
	}
}

func TestSystemHandler_GetPhotoLibraryContents_Success(t *testing.T) {
	h, _ := newSystemHandler(t)
	ctx := context.Background()

	// Create a temp library dir with a subdirectory, a supported image, and a hidden file.
	libDir := t.TempDir()
	_ = os.MkdirAll(filepath.Join(libDir, "Vacation"), 0755)
	_ = os.WriteFile(filepath.Join(libDir, "photo.jpg"), []byte("fake-jpeg"), 0644)
	_ = os.WriteFile(filepath.Join(libDir, ".hidden"), []byte("skip me"), 0644)
	_ = os.WriteFile(filepath.Join(libDir, "readme.txt"), []byte("not media"), 0644)

	// Set the secret so the handler can find the library root.
	settingsSvc := services.NewSettingsService(h.repo)
	if err := settingsSvc.SetSecret(ctx, "photo_library_path", libDir); err != nil {
		t.Fatalf("SetSecret: %v", err)
	}

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/system/photo-library?path=", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := h.GetPhotoLibraryContents(c); err != nil {
		t.Fatalf("GetPhotoLibraryContents: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	folders, ok := resp["folders"].([]interface{})
	if !ok {
		t.Fatal("expected folders array")
	}
	if len(folders) != 1 || folders[0].(string) != "Vacation" {
		t.Errorf("expected [Vacation], got %v", folders)
	}

	files, ok := resp["files"].([]interface{})
	if !ok {
		t.Fatal("expected files array")
	}
	if len(files) != 1 {
		t.Errorf("expected 1 file (photo.jpg), got %d", len(files))
	}
}

func TestSystemHandler_GetPhotoLibraryFile_NotConfigured(t *testing.T) {
	h, _ := newSystemHandler(t)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/system/photo-library/file?path=photo.jpg", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	err := h.GetPhotoLibraryFile(c)
	if err == nil {
		t.Fatal("expected error when not configured")
	}
}

func TestSystemHandler_GetPhotoLibraryFile_MissingPathParam(t *testing.T) {
	h, _ := newSystemHandler(t)
	ctx := context.Background()
	libDir := t.TempDir()
	settingsSvc := services.NewSettingsService(h.repo)
	_ = settingsSvc.SetSecret(ctx, "photo_library_path", libDir)

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/system/photo-library/file", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	err := h.GetPhotoLibraryFile(c)
	if err == nil {
		t.Fatal("expected error when path param missing")
	}
	he, ok := err.(*echo.HTTPError)
	if !ok || he.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %v", err)
	}
}

func TestSystemHandler_GetPhotoLibraryFile_UnsupportedExt(t *testing.T) {
	h, _ := newSystemHandler(t)
	ctx := context.Background()
	libDir := t.TempDir()
	settingsSvc := services.NewSettingsService(h.repo)
	_ = settingsSvc.SetSecret(ctx, "photo_library_path", libDir)

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/system/photo-library/file?path=readme.txt", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	err := h.GetPhotoLibraryFile(c)
	if err == nil {
		t.Fatal("expected error for unsupported extension")
	}
	he, ok := err.(*echo.HTTPError)
	if !ok || he.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %v", err)
	}
}

func TestSystemHandler_ImportSelectedPhotos_NotConfigured(t *testing.T) {
	h, _ := newSystemHandler(t)
	e := echo.New()
	body := `{"paths":["photo.jpg"]}`
	req := httptest.NewRequest(http.MethodPost, "/api/system/photo-library/import", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	err := h.ImportSelectedPhotos(c)
	if err == nil {
		t.Fatal("expected error when not configured")
	}
}

func TestSystemHandler_ImportSelectedPhotos_SkipsDuplicates(t *testing.T) {
	h, _ := newSystemHandler(t)
	ctx := context.Background()
	libDir := t.TempDir()

	// Create a real importable file
	imgData := makeMinimalJPEG(t)
	imgPath := filepath.Join(libDir, "test.jpg")
	if err := os.WriteFile(imgPath, imgData, 0644); err != nil {
		t.Fatal(err)
	}

	settingsSvc := services.NewSettingsService(h.repo)
	_ = settingsSvc.SetSecret(ctx, "photo_library_path", libDir)

	e := echo.New()
	body := `{"paths":["test.jpg"]}`

	// First import
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	if err := h.ImportSelectedPhotos(e.NewContext(req, rec)); err != nil {
		t.Fatalf("first import: %v", err)
	}

	// Second import — same file should be skipped
	req2 := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	req2.Header.Set("Content-Type", "application/json")
	rec2 := httptest.NewRecorder()
	if err := h.ImportSelectedPhotos(e.NewContext(req2, rec2)); err != nil {
		t.Fatalf("second import: %v", err)
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(rec2.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if skipped, _ := resp["skipped"].(float64); skipped != 1 {
		t.Errorf("expected skipped=1, got %v", resp["skipped"])
	}
}

func TestSystemHandler_ImportSelectedPhotos_InvalidPath(t *testing.T) {
	h, _ := newSystemHandler(t)
	ctx := context.Background()
	libDir := t.TempDir()
	settingsSvc := services.NewSettingsService(h.repo)
	_ = settingsSvc.SetSecret(ctx, "photo_library_path", libDir)

	e := echo.New()
	body := `{"paths":["../../etc/passwd"]}`
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	if err := h.ImportSelectedPhotos(e.NewContext(req, rec)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	errors, _ := resp["errors"].([]interface{})
	if len(errors) == 0 {
		t.Error("expected path traversal to produce an error entry")
	}
}

// makeMinimalJPEG creates a tiny valid JPEG for testing imports.
func makeMinimalJPEG(t *testing.T) []byte {
	t.Helper()
	// Minimal 1×1 white JPEG
	return []byte{
		0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
		0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
		0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
		0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
		0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
		0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
		0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
		0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
		0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00,
		0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
		0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5, 0x10, 0x00, 0x02, 0x01, 0x03,
		0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7d,
		0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06,
		0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
		0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
		0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
		0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45,
		0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
		0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
		0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
		0x8a, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4,
		0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7,
		0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca,
		0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3,
		0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5,
		0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00,
		0x00, 0x3f, 0x00, 0xfb, 0xd3, 0xff, 0xd9,
	}
}

func TestSystemHandler_GetStats_DBError(t *testing.T) {
	h, cleanup := setupSystemHandler(t)
	defer cleanup()

	repo := setupTestDB(t)
	_ = repo.Close()
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo, nil, nil, nil, "")
	mediaSvc := services.NewMediaService(repo, &config.Config{
		StoragePath:     t.TempDir(),
		ThumbnailWidth:  400,
		ThumbnailHeight: 300,
	}, settingsSvc, tagSvc)
	tmpDir2 := t.TempDir()
	systemSvc2 := services.NewSystemService(repo, tmpDir2)
	cacheSvc2 := services.NewCacheService(tmpDir2)
	h2 := NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc, systemSvc2, cacheSvc2, tmpDir2, "1.0")

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	err := h2.GetStats(e.NewContext(req, rec))
	if err == nil {
		t.Error("expected error")
	}
	_ = h
}

func TestSystemHandler_GetLogs_NoFile(t *testing.T) {
	h, cleanup := setupSystemHandler(t)
	defer cleanup()
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	if err := h.GetLogs(e.NewContext(req, rec)); err != nil {
		t.Fatalf("GetLogs: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestSystemHandler_ListBackups_NotExist(t *testing.T) {
	h, cleanup := setupSystemHandler(t)
	defer cleanup()
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	if err := h.ListBackups(e.NewContext(req, rec)); err != nil {
		t.Fatalf("ListBackups: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestSystemHandler_RestoreBackup_NotFound(t *testing.T) {
	h, cleanup := setupSystemHandler(t)
	defer cleanup()
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("filename")
	c.SetParamValues("nonexistent.tar.gz")
	err := h.RestoreBackup(c)
	if err == nil {
		t.Error("expected 404")
	}
}

func TestSystemHandler_DeleteBackup_NotFound(t *testing.T) {
	h, cleanup := setupSystemHandler(t)
	defer cleanup()
	e := echo.New()
	req := httptest.NewRequest(http.MethodDelete, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("filename")
	c.SetParamValues("nonexistent.tar.gz")
	err := h.DeleteBackup(c)
	if err == nil {
		t.Error("expected 404")
	}
}

func TestSystemHandler_GetMigrations_OK(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo, nil, nil, nil, "")
	mediaSvc := services.NewMediaService(repo, &config.Config{StoragePath: t.TempDir(), ThumbnailWidth: 400, ThumbnailHeight: 300}, settingsSvc, tagSvc)
	tmpDir := t.TempDir()
	systemSvc := services.NewSystemService(repo, tmpDir)
	cacheSvc := services.NewCacheService(tmpDir)
	h := NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc, systemSvc, cacheSvc, tmpDir, "1.0")

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	err := h.GetMigrations(e.NewContext(req, rec))
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestSystemHandler_ClearCache_DBError(t *testing.T) {
	repo := setupTestDB(t)
	_ = repo.Close()
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo, nil, nil, nil, "")
	mediaSvc := services.NewMediaService(repo, &config.Config{StoragePath: t.TempDir(), ThumbnailWidth: 400, ThumbnailHeight: 300}, settingsSvc, tagSvc)
	tmpDir := t.TempDir()
	systemSvc := services.NewSystemService(repo, tmpDir)
	cacheSvc := services.NewCacheService(tmpDir)
	h := NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc, systemSvc, cacheSvc, tmpDir, "1.0")

	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	err := h.ClearCache(e.NewContext(req, rec))
	if err == nil {
		t.Error("expected error")
	}
}

func TestSystemHandler_RecalculateMediaVisibility_DBError(t *testing.T) {
	repo := setupTestDB(t)
	_ = repo.Close()
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo, nil, nil, nil, "")
	mediaSvc := services.NewMediaService(repo, &config.Config{StoragePath: t.TempDir(), ThumbnailWidth: 400, ThumbnailHeight: 300}, settingsSvc, tagSvc)
	tmpDir := t.TempDir()
	systemSvc := services.NewSystemService(repo, tmpDir)
	cacheSvc := services.NewCacheService(tmpDir)
	h := NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc, systemSvc, cacheSvc, tmpDir, "1.0")

	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	err := h.RecalculateMediaVisibility(e.NewContext(req, rec))
	if err == nil {
		t.Error("expected error")
	}
}

func TestSystemHandler_UpdateMapCoords_DBError(t *testing.T) {
	repo := setupTestDB(t)
	_ = repo.Close()
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo, nil, nil, nil, "")
	mediaSvc := services.NewMediaService(repo, &config.Config{StoragePath: t.TempDir(), ThumbnailWidth: 400, ThumbnailHeight: 300}, settingsSvc, tagSvc)
	tmpDir := t.TempDir()
	systemSvc := services.NewSystemService(repo, tmpDir)
	cacheSvc := services.NewCacheService(tmpDir)
	h := NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc, systemSvc, cacheSvc, tmpDir, "1.0")

	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	err := h.UpdateMapCoords(e.NewContext(req, rec))
	if err == nil {
		t.Error("expected error")
	}
}
func TestSystemHandler_GetLogs_ManyLines(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	dataDir := t.TempDir()
	logsDir := filepath.Join(dataDir, "logs")
	_ = os.MkdirAll(logsDir, 0755)
	logLines := strings.Repeat("log line entry\n", 150)
	_ = os.WriteFile(filepath.Join(logsDir, "app.log"), []byte(logLines), 0644)

	systemSvc := services.NewSystemService(h.repo, dataDir)
	cacheSvc := services.NewCacheService(dataDir)
	sh := NewSystemHandler(h.repo, h.mediaSvc, h.postSvc, h.settingsSvc, h.tagSvc, systemSvc, cacheSvc, dataDir, "1.0")
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/?lines=50", nil)
	rec := httptest.NewRecorder()
	err := sh.GetLogs(e.NewContext(req, rec))
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}
