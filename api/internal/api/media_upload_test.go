package api

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

func TestMediaHandler_UploadMultipleExtended(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	tmpDir, _ := os.MkdirTemp("", "media-extended-test")
	defer func() {
		_ = os.RemoveAll(tmpDir)
	}()

	cfg := &config.Config{StoragePath: tmpDir}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	handler := NewMediaHandler(mediaSvc, settingsSvc)
	e := echo.New()

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)

	p1, _ := writer.CreateFormFile("files", "f1.txt")
	_, _ = p1.Write([]byte("f1 content"))
	p2, _ := writer.CreateFormFile("files", "f2.txt")
	_, _ = p2.Write([]byte("f2 content"))
	_ = writer.Close()

	req := httptest.NewRequest(http.MethodPost, "/media/upload/multiple", body)
	req.Header.Set(echo.HeaderContentType, writer.FormDataContentType())
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})

	if err := handler.UploadMultiple(c); err != nil {
		t.Fatalf("UploadMultiple failed: %v", err)
	}
	if rec.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d. Body: %s", rec.Code, rec.Body.String())
	}
}

func TestMediaHandler_Rename_Error(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	cfg := &config.Config{StoragePath: t.TempDir()}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	handler := NewMediaHandler(mediaSvc, settingsSvc)
	e := echo.New()

	// Rename non-existent media
	reqBody, _ := json.Marshal(RenameMediaRequest{NewFilename: "new.jpg"})
	req := httptest.NewRequest(http.MethodPost, "/media/999/rename", bytes.NewReader(reqBody))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("999")
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})

	err := handler.RenameMedia(c)
	if err == nil {
		t.Error("expected error for non-existent media rename")
	} else if he, ok := err.(*echo.HTTPError); ok {
		if he.Code != http.StatusInternalServerError {
			t.Errorf("expected 500, got %d", he.Code)
		}
	}
}

func TestMediaHandler_GetFoldersExtended(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	cfg := &config.Config{StoragePath: t.TempDir()}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	handler := NewMediaHandler(mediaSvc, settingsSvc)
	e := echo.New()

	req := httptest.NewRequest(http.MethodGet, "/media/folders", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})

	if err := handler.GetMediaFolders(c); err != nil {
		t.Fatalf("GetMediaFolders failed: %v", err)
	}
}

func TestMediaHandler_AnalyzeImageBoost(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	cfg := &config.Config{StoragePath: t.TempDir()}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	h := NewMediaHandler(mediaSvc, settingsSvc)
	e := echo.New()

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, _ := writer.CreateFormFile("image", "test.jpg")
	_, _ = part.Write([]byte("fake image data"))
	_ = writer.Close()

	req := httptest.NewRequest(http.MethodPost, "/", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	err := h.AnalyzeImage(c)
	if err != nil {
		t.Errorf("expected no error from AnalyzeImage (soft-fail), got %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestMediaHandler_AnalyzeImageByPathBoost(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	cfg := &config.Config{StoragePath: t.TempDir()}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	h := NewMediaHandler(mediaSvc, settingsSvc)
	e := echo.New()

	body, _ := json.Marshal(map[string]string{"path": "/2026/03/nonexistent.jpg"})
	req := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	err := h.AnalyzeImageByPath(c)
	if err == nil {
		t.Error("expected error for missing file")
	}
}

func TestMediaHandler_UploadFileErrors(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	cfg := &config.Config{StoragePath: t.TempDir(), ThumbnailWidth: 400, ThumbnailHeight: 300}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	h := NewMediaHandler(mediaSvc, settingsSvc)
	e := echo.New()

	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	err := h.UploadFile(c)
	if err == nil {
		t.Error("expected error for missing file")
	}
}

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
