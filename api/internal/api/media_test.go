package api

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"

	"github.com/labstack/echo/v4"
	"point-api/internal/config"
	"point-api/internal/services"
)

func TestMediaHandler_Upload(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()

	tmpDir, _ := os.MkdirTemp("", "media-api-test")
	defer os.RemoveAll(tmpDir)

	cfg := &config.Config{StoragePath: tmpDir, ThumbnailWidth: 100, ThumbnailHeight: 100}
	settingsService := services.NewSettingsService(repo)
	tagService := services.NewTagService(repo)
	mediaService := services.NewMediaService(repo, cfg, settingsService, tagService)
	handler := NewMediaHandler(mediaService, settingsService)

	e := echo.New()

	// Prepare multipart form
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, _ := writer.CreateFormFile("file", "test.txt")
	part.Write([]byte("hello api"))
	writer.WriteField("alt_text", "some alt")
	writer.Close()

	req := httptest.NewRequest(http.MethodPost, "/media/upload", body)
	req.Header.Set(echo.HeaderContentType, writer.FormDataContentType())
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := handler.UploadFile(c); err != nil {
		t.Fatalf("UploadFile failed: %v", err)
	}

	if rec.Code != http.StatusCreated {
		t.Errorf("expected status 201, got %d", rec.Code)
	}

	var m map[string]interface{}
	json.Unmarshal(rec.Body.Bytes(), &m)
	if m["filename"] != "test.txt" {
		t.Errorf("expected test.txt, got %v", m["filename"])
	}
}

func TestMediaHandler_List(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()

	tmpDir, _ := os.MkdirTemp("", "media-api-test-list")
	defer os.RemoveAll(tmpDir)

	cfg := &config.Config{StoragePath: tmpDir, ThumbnailWidth: 100, ThumbnailHeight: 100}
	settingsService := services.NewSettingsService(repo)
	tagService := services.NewTagService(repo)
	mediaService := services.NewMediaService(repo, cfg, settingsService, tagService)
	handler := NewMediaHandler(mediaService, settingsService)

	e := echo.New()

	// 1. List empty
	req := httptest.NewRequest(http.MethodGet, "/media", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	handler.ListMedia(c)

	// 2. Upload one
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, _ := writer.CreateFormFile("file", "to-rename.txt")
	part.Write([]byte("rename me"))
	writer.Close()
	req = httptest.NewRequest(http.MethodPost, "/media/upload", body)
	req.Header.Set(echo.HeaderContentType, writer.FormDataContentType())
	rec = httptest.NewRecorder()
	handler.UploadFile(e.NewContext(req, rec))
	var m map[string]interface{}
	json.Unmarshal(rec.Body.Bytes(), &m)
	mediaID := int64(m["id"].(float64))

	// 3. Rename
	renBody, _ := json.Marshal(RenameMediaRequest{NewFilename: "renamed.txt"})
	req = httptest.NewRequest(http.MethodPost, "/media/rename", bytes.NewReader(renBody))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(strconv.FormatInt(mediaID, 10))
	if err := handler.RenameMedia(c); err != nil {
		t.Fatalf("RenameMedia failed: %v", err)
	}

	// 4. Stats
	handler.GetStorageStats(e.NewContext(httptest.NewRequest(http.MethodGet, "/stats", nil), httptest.NewRecorder()))

	// 5. Bulk Delete
	bulkBody, _ := json.Marshal(BulkDeleteRequest{IDs: []int64{mediaID}})
	req = httptest.NewRequest(http.MethodPost, "/media/bulk-delete", bytes.NewReader(bulkBody))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec = httptest.NewRecorder()
	handler.BulkDeleteMedia(e.NewContext(req, rec))
}

func TestMediaHandler_GetMediaFolders(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()

	tmpDir, _ := os.MkdirTemp("", "media-handler-test")
	defer os.RemoveAll(tmpDir)

	cfg := &config.Config{StoragePath: tmpDir, ThumbnailWidth: 100, ThumbnailHeight: 100}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	handler := NewMediaHandler(mediaSvc, settingsSvc)
	e := echo.New()

	req := httptest.NewRequest(http.MethodGet, "/media/folders", nil)
	rec := httptest.NewRecorder()
	if err := handler.GetMediaFolders(e.NewContext(req, rec)); err != nil {
		t.Fatalf("GetMediaFolders failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestMediaHandler_GetMedia(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()

	tmpDir, _ := os.MkdirTemp("", "media-handler-test")
	defer os.RemoveAll(tmpDir)

	cfg := &config.Config{StoragePath: tmpDir, ThumbnailWidth: 100, ThumbnailHeight: 100}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	handler := NewMediaHandler(mediaSvc, settingsSvc)
	e := echo.New()

	ctx := context.Background()
	media, _ := mediaSvc.UploadFile(ctx, services.UploadFileParams{
		Content: []byte("hello"), Filename: "test.txt", MimeType: "text/plain",
	})

	// Found
	req := httptest.NewRequest(http.MethodGet, "/media/1", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(strconv.FormatInt(media.ID, 10))
	if err := handler.GetMedia(c); err != nil {
		t.Fatalf("GetMedia failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	// Invalid ID
	req = httptest.NewRequest(http.MethodGet, "/media/abc", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("abc")
	err := handler.GetMedia(c)
	if err == nil {
		t.Error("expected error for invalid ID")
	}

	// Not found
	req = httptest.NewRequest(http.MethodGet, "/media/9999", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("9999")
	err = handler.GetMedia(c)
	if err == nil {
		t.Error("expected error for non-existent media")
	}
}

func TestMediaHandler_UpdateMedia(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()

	tmpDir, _ := os.MkdirTemp("", "media-handler-test")
	defer os.RemoveAll(tmpDir)

	cfg := &config.Config{StoragePath: tmpDir, ThumbnailWidth: 100, ThumbnailHeight: 100}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	handler := NewMediaHandler(mediaSvc, settingsSvc)
	e := echo.New()

	ctx := context.Background()
	media, _ := mediaSvc.UploadFile(ctx, services.UploadFileParams{
		Content: []byte("data"), Filename: "up.txt", MimeType: "text/plain",
	})

	body, _ := json.Marshal(UpdateMediaRequest{AltText: "alt text", Caption: "caption"})
	req := httptest.NewRequest(http.MethodPut, "/media/1", bytes.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(strconv.FormatInt(media.ID, 10))

	if err := handler.UpdateMedia(c); err != nil {
		t.Fatalf("UpdateMedia failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	// Invalid ID
	req = httptest.NewRequest(http.MethodPut, "/media/abc", bytes.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("abc")
	if handler.UpdateMedia(c) == nil {
		t.Error("expected error for invalid ID")
	}
}

func TestMediaHandler_ListOrphanedMedia(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()

	tmpDir, _ := os.MkdirTemp("", "media-handler-test")
	defer os.RemoveAll(tmpDir)

	cfg := &config.Config{StoragePath: tmpDir, ThumbnailWidth: 100, ThumbnailHeight: 100}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	handler := NewMediaHandler(mediaSvc, settingsSvc)
	e := echo.New()

	req := httptest.NewRequest(http.MethodGet, "/media/orphaned", nil)
	rec := httptest.NewRecorder()
	if err := handler.ListOrphanedMedia(e.NewContext(req, rec)); err != nil {
		t.Fatalf("ListOrphanedMedia failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestMediaHandler_DeleteMedia(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()

	tmpDir, _ := os.MkdirTemp("", "media-handler-test")
	defer os.RemoveAll(tmpDir)

	cfg := &config.Config{StoragePath: tmpDir, ThumbnailWidth: 100, ThumbnailHeight: 100}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	handler := NewMediaHandler(mediaSvc, settingsSvc)
	e := echo.New()

	ctx := context.Background()
	media, _ := mediaSvc.UploadFile(ctx, services.UploadFileParams{
		Content: []byte("del"), Filename: "del.txt", MimeType: "text/plain",
	})

	// Success
	req := httptest.NewRequest(http.MethodDelete, "/media/1", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(strconv.FormatInt(media.ID, 10))
	if err := handler.DeleteMedia(c); err != nil {
		t.Fatalf("DeleteMedia failed: %v", err)
	}
	if rec.Code != http.StatusNoContent {
		t.Errorf("expected 204, got %d", rec.Code)
	}

	// Invalid ID
	req = httptest.NewRequest(http.MethodDelete, "/media/abc", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("abc")
	if handler.DeleteMedia(c) == nil {
		t.Error("expected error for invalid ID")
	}
}

func setupMediaHandler(t *testing.T) (*MediaHandler, func()) {
	t.Helper()
	repo := setupTestDB(t)
	tmpDir, _ := os.MkdirTemp("", "media-handler-test")
	cfg := &config.Config{StoragePath: tmpDir, ThumbnailWidth: 100, ThumbnailHeight: 100}
	settingsService := services.NewSettingsService(repo)
	tagService := services.NewTagService(repo)
	mediaService := services.NewMediaService(repo, cfg, settingsService, tagService)
	handler := NewMediaHandler(mediaService, settingsService)
	return handler, func() {
		repo.Close()
		os.RemoveAll(tmpDir)
	}
}

func TestMediaHandler_DeleteOrphanedMedia(t *testing.T) {
	handler, cleanup := setupMediaHandler(t)
	defer cleanup()

	e := echo.New()
	req := httptest.NewRequest(http.MethodDelete, "/media/orphaned", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := handler.DeleteOrphanedMedia(c); err != nil {
		t.Fatalf("DeleteOrphanedMedia failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestMediaHandler_GetStorageStats(t *testing.T) {
	handler, cleanup := setupMediaHandler(t)
	defer cleanup()

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/media/stats", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := handler.GetStorageStats(c); err != nil {
		t.Fatalf("GetStorageStats failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestMediaHandler_BulkDelete(t *testing.T) {
	handler, cleanup := setupMediaHandler(t)
	defer cleanup()

	e := echo.New()
	// Empty IDs → 400
	body, _ := json.Marshal(map[string]interface{}{"ids": []int64{}})
	req := httptest.NewRequest(http.MethodDelete, "/media/bulk", bytes.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	if handler.BulkDeleteMedia(c) == nil {
		t.Error("expected error for empty ids")
	}

	// Invalid JSON → should error
	req = httptest.NewRequest(http.MethodDelete, "/media/bulk", bytes.NewReader([]byte("{bad")))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	handler.BulkDeleteMedia(c) // may return 400
}

func TestMediaHandler_UploadMultiple(t *testing.T) {
	handler, cleanup := setupMediaHandler(t)
	defer cleanup()

	e := echo.New()

	// No files → error
	body := &bytes.Buffer{}
	w := multipart.NewWriter(body)
	w.Close()
	req := httptest.NewRequest(http.MethodPost, "/media/upload-multiple", body)
	req.Header.Set(echo.HeaderContentType, w.FormDataContentType())
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	if handler.UploadMultiple(c) == nil {
		t.Error("expected error for no files")
	}

	// With a file
	body = &bytes.Buffer{}
	w = multipart.NewWriter(body)
	part, _ := w.CreateFormFile("files", "multi.txt")
	part.Write([]byte("multi content"))
	w.Close()
	req = httptest.NewRequest(http.MethodPost, "/media/upload-multiple", body)
	req.Header.Set(echo.HeaderContentType, w.FormDataContentType())
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	if err := handler.UploadMultiple(c); err != nil {
		t.Fatalf("UploadMultiple failed: %v", err)
	}
	if rec.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d", rec.Code)
	}
}

func TestMediaHandler_RebuildThumbnails(t *testing.T) {
	handler, cleanup := setupMediaHandler(t)
	defer cleanup()

	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/media/thumbnails/rebuild", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := handler.RebuildThumbnails(c); err != nil {
		t.Fatalf("RebuildThumbnails failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestMediaHandler_RenameMedia(t *testing.T) {
	handler, cleanup := setupMediaHandler(t)
	defer cleanup()

	e := echo.New()
	body, _ := json.Marshal(map[string]string{"new_filename": "renamed.jpg"})
	req := httptest.NewRequest(http.MethodPost, "/media/1/rename", bytes.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("abc") // invalid id → should error
	if handler.RenameMedia(c) == nil {
		t.Error("expected error for invalid id")
	}
}
