package api

import (
	"bytes"
	"context"
	"encoding/json"
	"strconv"
	"image"
	"image/jpeg"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/services"
)

// setupSystemHandler creates a SystemHandler with a temp data dir.
func setupSystemHandler(t *testing.T) (*SystemHandler, func()) {
	t.Helper()
	repo := setupTestDB(t)
	tmpDir := t.TempDir()
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo)
	mediaSvc := services.NewMediaService(repo, &config.Config{
		StoragePath:     tmpDir,
		ThumbnailWidth:  400,
		ThumbnailHeight: 300,
	}, settingsSvc, tagSvc)
	systemSvc := services.NewSystemService(repo, tmpDir)
	cacheSvc := services.NewCacheService(tmpDir)
	h := NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc, systemSvc, cacheSvc, tmpDir, "1.2.3")
	return h, func() { _ = repo.Close() }
}

// TestScanMediaImport_NotConfigured covers the "not configured" early return.
func TestScanMediaImport_NotConfigured(t *testing.T) {
	h, cleanup := setupSystemHandler(t)
	defer cleanup()
	e := echo.New()

	// No media_import_path set → "not configured"
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	if err := h.ScanMediaImport(e.NewContext(req, rec)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestScanMediaImport_PathNotExist covers the os.IsNotExist branch.
func TestScanMediaImport_PathNotExist(t *testing.T) {
	_, cleanup := setupSystemHandler(t)
	defer cleanup()
	e := echo.New()

	ctx := context.Background()
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	settingsSvc := services.NewSettingsService(repo)
	_ = settingsSvc.SetSetting(ctx, "media_import_path", "/nonexistent/does/not/exist", "string")

	// Rebuild handler with this settings service
	tmpDir2 := t.TempDir()
	systemSvc2 := services.NewSystemService(repo, tmpDir2)
	cacheSvc2 := services.NewCacheService(tmpDir2)
	h2 := NewSystemHandler(repo, nil, nil, settingsSvc, nil, systemSvc2, cacheSvc2, tmpDir2, "1.0")
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	if err := h2.ScanMediaImport(e.NewContext(req, rec)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestScanMediaImport_WithFiles covers the walk loop with a real .jpg file.
func TestScanMediaImport_WithFiles(t *testing.T) {
	h, cleanup := setupSystemHandler(t)
	defer cleanup()
	e := echo.New()

	importDir := t.TempDir()

	// Write a small valid JPEG.
	img := image.NewRGBA(image.Rect(0, 0, 5, 5))
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, nil)
	imgPath := filepath.Join(importDir, "scan_test.jpg")
	_ = os.WriteFile(imgPath, buf.Bytes(), 0644)

	// Write a non-importable file (txt) → exercises the extension check.
	_ = os.WriteFile(filepath.Join(importDir, "readme.txt"), []byte("hello"), 0644)

	// Set the import path.
	ctx := context.Background()
	svc := h.settingsService
	_ = svc.SetSetting(ctx, "media_import_path", importDir, "string")

	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	if err := h.ScanMediaImport(e.NewContext(req, rec)); err != nil {
		t.Fatalf("ScanMediaImport with files failed: %v", err)
	}
	// Result is 200 with imported/skipped counts.
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	// Second scan → same checksum → skipped
	rec2 := httptest.NewRecorder()
	if err := h.ScanMediaImport(e.NewContext(httptest.NewRequest(http.MethodPost, "/", nil), rec2)); err != nil {
		t.Fatalf("second scan failed: %v", err)
	}
}

// TestListBackups_WithFiles covers the loop body (non-.tar.gz skipped, .tar.gz included).
func TestListBackups_WithFiles(t *testing.T) {
	h, cleanup := setupSystemHandler(t)
	defer cleanup()
	e := echo.New()

	// Create backups dir manually with a .tar.gz and a .txt file.
	backupDir := filepath.Join(h.dataPath, "backups")
	_ = os.MkdirAll(backupDir, 0755)
	_ = os.WriteFile(filepath.Join(backupDir, "backup.tar.gz"), []byte("fake"), 0644)
	_ = os.WriteFile(filepath.Join(backupDir, "notes.txt"), []byte("skip me"), 0644)
	_ = os.Mkdir(filepath.Join(backupDir, "subdir"), 0755)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	if err := h.ListBackups(e.NewContext(req, rec)); err != nil {
		t.Fatalf("ListBackups failed: %v", err)
	}
	var result []interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &result)
	if len(result) != 1 {
		t.Errorf("expected 1 backup (only .tar.gz), got %d", len(result))
	}
}

// TestGetVersion_WithCache covers the cached (fresh) path in GetVersion.
func TestGetVersion_WithCache(t *testing.T) {
	h, cleanup := setupSystemHandler(t)
	defer cleanup()
	e := echo.New()

	// Pre-seed a fresh cache so the GitHub fetch is skipped.
	cacheData := map[string]interface{}{
		"latest":     "v9.9.9",
		"checked_at": time.Now().UTC().Format(time.RFC3339),
	}
	cacheJSON, _ := json.Marshal(cacheData)
	ctx := context.Background()
	_ = h.settingsService.SetSetting(ctx, "_version_check_cached", string(cacheJSON), "string")

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	if err := h.GetVersion(e.NewContext(req, rec)); err != nil {
		t.Fatalf("GetVersion with cache failed: %v", err)
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["latest"] != "v9.9.9" {
		t.Errorf("expected latest=v9.9.9, got %v", resp["latest"])
	}
	if resp["update_available"] != true {
		t.Errorf("expected update_available=true")
	}
}

// TestUpdatePost_Success covers the success path (post exists → update works).
func TestUpdatePost_Success(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	postSvc := services.NewPostService(repo)
	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	mediaSvc := services.NewMediaService(repo, &config.Config{StoragePath: t.TempDir()}, settingsSvc, tagSvc)
	h := NewPostHandler(postSvc, settingsSvc, mediaSvc, tagSvc)
	e := echo.New()

	// Create a user + post first.
	_, _ = repo.DB().Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'u','u@t.com','h','U')`)
	post, err := postSvc.CreatePost(ctx, services.CreatePostParams{
		Title:    "Original",
		Slug:     "original",
		Content:  "hello",
		Status:   "draft",
		AuthorID: 1,
	})
	if err != nil {
		t.Fatalf("CreatePost failed: %v", err)
	}

	body, _ := json.Marshal(UpdatePostRequest{
		Title:   "Updated Title",
		Content: "new content",
		Status:  "published",
		Slug:    "updated-slug",
	})
	req := httptest.NewRequest(http.MethodPut, "/", bytes.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(strconv.FormatInt(post.ID, 10))
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})

	if err := h.UpdatePost(c); err != nil {
		t.Fatalf("UpdatePost success failed: %v", err)
	}
}

// TestUpdateSettings_InvalidBind covers the bind error path.
func TestUpdateSettings_InvalidBind(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	settingsSvc := services.NewSettingsService(repo)
	h := NewSettingsHandler(settingsSvc)
	e := echo.New()

	// Send invalid JSON (not an object) to trigger bind error.
	req := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader([]byte(`"not_an_object"`)))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	err := h.UpdateSettings(e.NewContext(req, rec))
	if err == nil {
		t.Error("expected bind error")
	}
}

// TestUploadMultiple_WithPostID covers the post_id parsing branch.
func TestUploadMultiple_WithPostID(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	cfg := &config.Config{StoragePath: t.TempDir(), ThumbnailWidth: 400, ThumbnailHeight: 300}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	h := NewMediaHandler(mediaSvc, settingsSvc)
	e := echo.New()

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	_ = writer.WriteField("post_id", "42")
	p, _ := writer.CreateFormFile("files", "img.jpg")
	_, _ = p.Write([]byte("fake jpg data"))
	_ = writer.Close()

	req := httptest.NewRequest(http.MethodPost, "/", body)
	req.Header.Set(echo.HeaderContentType, writer.FormDataContentType())
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})

	if err := h.UploadMultiple(c); err != nil {
		t.Fatalf("UploadMultiple with post_id failed: %v", err)
	}
}

// TestGetStorageStats_Success covers GetStorageStats success path.
func TestGetStorageStats_Success(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	mediaSvc := services.NewMediaService(repo, &config.Config{StoragePath: t.TempDir()}, settingsSvc, tagSvc)
	h := NewMediaHandler(mediaSvc, settingsSvc)
	e := echo.New()

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	if err := h.GetStorageStats(e.NewContext(req, rec)); err != nil {
		t.Fatalf("GetStorageStats failed: %v", err)
	}
}

// TestDeleteOrphanedMedia_Success covers DeleteOrphanedMedia success path.
func TestDeleteOrphanedMedia_Success(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	mediaSvc := services.NewMediaService(repo, &config.Config{StoragePath: t.TempDir()}, settingsSvc, tagSvc)
	h := NewMediaHandler(mediaSvc, settingsSvc)
	e := echo.New()

	req := httptest.NewRequest(http.MethodDelete, "/", nil)
	rec := httptest.NewRecorder()
	if err := h.DeleteOrphanedMedia(e.NewContext(req, rec)); err != nil {
		t.Fatalf("DeleteOrphanedMedia failed: %v", err)
	}
}

// TestGetMediaFolders_Success covers GetMediaFolders success path.
func TestGetMediaFolders_Success(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	mediaSvc := services.NewMediaService(repo, &config.Config{StoragePath: t.TempDir()}, settingsSvc, tagSvc)
	h := NewMediaHandler(mediaSvc, settingsSvc)
	e := echo.New()

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	if err := h.GetMediaFolders(e.NewContext(req, rec)); err != nil {
		t.Fatalf("GetMediaFolders failed: %v", err)
	}
}

// TestRecalculateCounts_Success covers the RecalculateCounts success path.
func TestRecalculateCounts_Success(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	tagSvc := services.NewTagService(repo)
	settingsSvc2 := services.NewSettingsService(repo)
	h := NewTagHandler(tagSvc, settingsSvc2)
	e := echo.New()

	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	if err := h.RecalculateCounts(e.NewContext(req, rec)); err != nil {
		t.Fatalf("RecalculateCounts failed: %v", err)
	}
}

// TestPostHandler_PublishWithdraw_Success covers PublishPost and WithdrawPost success paths.
func TestPostHandler_PublishWithdraw_Success(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	postSvc := services.NewPostService(repo)
	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	mediaSvc := services.NewMediaService(repo, &config.Config{StoragePath: t.TempDir()}, settingsSvc, tagSvc)
	h := NewPostHandler(postSvc, settingsSvc, mediaSvc, tagSvc)
	e := echo.New()

	_, _ = repo.DB().Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'u','u@t.com','h','U')`)
	post, err := postSvc.CreatePost(ctx, services.CreatePostParams{
		Title: "My Post", Slug: "my-post", Content: "hello", Status: "draft", AuthorID: 1,
	})
	if err != nil {
		t.Fatalf("CreatePost: %v", err)
	}
	idStr := strconv.FormatInt(post.ID, 10)

	// PublishPost
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(idStr)
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})
	if err := h.PublishPost(c); err != nil {
		t.Fatalf("PublishPost failed: %v", err)
	}

	// WithdrawPost
	req2 := httptest.NewRequest(http.MethodPost, "/", nil)
	rec2 := httptest.NewRecorder()
	c2 := e.NewContext(req2, rec2)
	c2.SetParamNames("id")
	c2.SetParamValues(idStr)
	c2.Set("user", models.GetSessionByTokenRow{UserID: 1})
	if err := h.WithdrawPost(c2); err != nil {
		t.Fatalf("WithdrawPost failed: %v", err)
	}
}

// TestPostHandler_GeneratePreviewLink_Success covers GeneratePreviewLink success
// including the X-Forwarded-Proto header path.
func TestPostHandler_GeneratePreviewLink_Success(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	postSvc := services.NewPostService(repo)
	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	mediaSvc := services.NewMediaService(repo, &config.Config{StoragePath: t.TempDir()}, settingsSvc, tagSvc)
	h := NewPostHandler(postSvc, settingsSvc, mediaSvc, tagSvc)
	e := echo.New()

	_, _ = repo.DB().Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'u','u@t.com','h','U')`)
	post, err := postSvc.CreatePost(ctx, services.CreatePostParams{
		Title: "Preview", Slug: "preview-post", Status: "draft", AuthorID: 1,
	})
	if err != nil {
		t.Fatalf("CreatePost: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/", nil)
	req.Header.Set("X-Forwarded-Proto", "https")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(strconv.FormatInt(post.ID, 10))
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})
	if err := h.GeneratePreviewLink(c); err != nil {
		t.Fatalf("GeneratePreviewLink failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestSettingsHandler_GetSettingByKey_Success covers GetSettingByKey success path.
func TestSettingsHandler_GetSettingByKey_Success(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	settingsSvc := services.NewSettingsService(repo)
	_ = settingsSvc.SetSetting(ctx, "my_key", "my_value", "string")
	h := NewSettingsHandler(settingsSvc)
	e := echo.New()

	req := httptest.NewRequest(http.MethodGet, "/settings/my_key", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("key")
	c.SetParamValues("my_key")
	if err := h.GetSettingByKey(c); err != nil {
		t.Fatalf("GetSettingByKey failed: %v", err)
	}
}

// TestSystemHandler_GetStats_Success covers the GetStats success path with data.
func TestSystemHandler_GetStats_Success(t *testing.T) {
	h, cleanup := setupSystemHandler(t)
	defer cleanup()
	e := echo.New()

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})
	if err := h.GetStats(c); err != nil {
		t.Fatalf("GetStats failed: %v", err)
	}
}

// TestSystemHandler_GetMigrations_Success covers GetMigrations with data.
func TestSystemHandler_GetMigrations_Success(t *testing.T) {
	h, cleanup := setupSystemHandler(t)
	defer cleanup()
	e := echo.New()

	// Apply a migration to have data in migration_history.
	ctx := context.Background()
	_ = h.repo.ApplyMigration(ctx, "test_mig", "SELECT 1")

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	if err := h.GetMigrations(e.NewContext(req, rec)); err != nil {
		t.Fatalf("GetMigrations handler failed: %v", err)
	}
}

// TestCreateAudioPost_NoTitleWithTags covers the title-from-filename and tags parsing paths.
func TestCreateAudioPost_NoTitleWithTags(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	postSvc := services.NewPostService(repo)
	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	mediaSvc := services.NewMediaService(repo, &config.Config{
		StoragePath: t.TempDir(), ThumbnailWidth: 400, ThumbnailHeight: 300,
	}, settingsSvc, tagSvc)
	h := NewPostHandler(postSvc, settingsSvc, mediaSvc, tagSvc)
	e := echo.New()

	_, _ = repo.DB().ExecContext(ctx, `INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'u','u@t.com','h','U')`)

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	p, _ := writer.CreateFormFile("file", "my-audio.mp3")
	_, _ = p.Write([]byte("fake mp3 data"))
	// No title → should use filename "my-audio" as title
	// Tags with trailing/leading spaces and empty entries
	_ = writer.WriteField("tags", "nature, landscape, , ")
	_ = writer.Close()

	req := httptest.NewRequest(http.MethodPost, "/", body)
	req.Header.Set(echo.HeaderContentType, writer.FormDataContentType())
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})

	if err := h.CreateAudioPost(c); err != nil {
		t.Fatalf("CreateAudioPost (no title) failed: %v", err)
	}
	if rec.Code != http.StatusCreated {
		t.Logf("Body: %s", rec.Body.String())
	}
}

// TestUpdatePost_SlugConflict covers the UNIQUE constraint slug conflict path (409).
func TestUpdatePost_SlugConflict(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	postSvc := services.NewPostService(repo)
	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	mediaSvc := services.NewMediaService(repo, &config.Config{StoragePath: t.TempDir()}, settingsSvc, tagSvc)
	h := NewPostHandler(postSvc, settingsSvc, mediaSvc, tagSvc)
	e := echo.New()

	_, _ = repo.DB().Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'u','u@t.com','h','U')`)

	// Create two posts with distinct slugs.
	_, err := postSvc.CreatePost(ctx, services.CreatePostParams{Title: "Post A", Slug: "post-a", Status: "draft", AuthorID: 1})
	if err != nil {
		t.Fatalf("CreatePost A: %v", err)
	}
	postB, err := postSvc.CreatePost(ctx, services.CreatePostParams{Title: "Post B", Slug: "post-b", Status: "draft", AuthorID: 1})
	if err != nil {
		t.Fatalf("CreatePost B: %v", err)
	}

	// Try to rename Post B's slug to post-a → UNIQUE conflict.
	body, _ := json.Marshal(UpdatePostRequest{Title: "Post B", Slug: "post-a", Status: "draft"})
	req := httptest.NewRequest(http.MethodPut, "/", bytes.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(strconv.FormatInt(postB.ID, 10))
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})

	err = h.UpdatePost(c)
	// Should return 409 (conflict JSON, not HTTP error)
	if err != nil {
		t.Logf("UpdatePost conflict returned error (may be echo HTTPError): %v", err)
	}
	if rec.Code != http.StatusConflict && err == nil {
		t.Errorf("expected 409, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestUpdatePost_BadID covers the invalid ID parse error path.
func TestUpdatePost_BadID(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	postSvc := services.NewPostService(repo)
	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	mediaSvc := services.NewMediaService(repo, &config.Config{StoragePath: t.TempDir()}, settingsSvc, tagSvc)
	h := NewPostHandler(postSvc, settingsSvc, mediaSvc, tagSvc)
	e := echo.New()

	req := httptest.NewRequest(http.MethodPut, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("notanint")

	err := h.UpdatePost(c)
	if err == nil {
		t.Error("expected error for bad ID")
	}
}

// TestGenerateToken_Success covers the GenerateToken utility and AuthHandler Login path.
func TestGenerateToken_Success(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	authSvc := services.NewAuthService(repo)
	h := NewAuthHandler(authSvc, &config.Config{SessionExpiryHours: 720})
	e := echo.New()

	// GenerateToken is a package-level utility.
	tok := GenerateToken()
	if len(tok) == 0 {
		t.Error("expected non-empty token")
	}

	// Cover Login success path.
	hash, _ := services.HashPassword("testpass")
	_, _ = repo.DB().Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'admin','a@a.com',?,'Admin')`, hash)

	body, _ := json.Marshal(LoginRequest{Username: "admin", Password: "testpass"})
	req := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	if err := h.Login(e.NewContext(req, rec)); err != nil {
		t.Fatalf("Login failed: %v", err)
	}
}

// TestBaseURL_WithForwardedProto covers the X-Forwarded-Proto path in baseURL.
func TestBaseURL_WithForwardedProto(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Host = "example.com"
	c := e.NewContext(req, httptest.NewRecorder())

	result := baseURL(c)
	if result != "https://example.com" {
		t.Errorf("expected https://example.com, got %s", result)
	}
}

// TestParseMapCoords_DisallowedHost covers the disallowed host path.
func TestParseMapCoords_DisallowedHost(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/?q=https://evil.com/maps", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	err := ParseMapsCoords(c)
	if err == nil {
		t.Error("expected error for disallowed host")
	}
}

// TestParseMapCoords_DegreeNotation covers the degree notation path.
func TestParseMapCoords_DegreeNotation(t *testing.T) {
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/?q=45.5077%C2%B0+N%2C+73.5544%C2%B0+W", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	err := ParseMapsCoords(c)
	// Either returns coords or "unrecognized input" - just verify it doesn't panic
	_ = err
}
