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
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/services"
)

func TestMediaHandler_Upload(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	tmpDir, _ := os.MkdirTemp("", "media-api-test")
	defer func() {
		_ = os.RemoveAll(tmpDir)
	}()

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
	_, _ = part.Write([]byte("hello api"))
	_ = writer.WriteField("alt_text", "some alt")
	_ = writer.Close()

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
	_ = json.Unmarshal(rec.Body.Bytes(), &m)
	if m["filename"] != "test.txt" {
		t.Errorf("expected test.txt, got %v", m["filename"])
	}
}

func TestMediaHandler_List(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	tmpDir, _ := os.MkdirTemp("", "media-api-test-list")
	defer func() {
		_ = os.RemoveAll(tmpDir)
	}()

	cfg := &config.Config{StoragePath: tmpDir, ThumbnailWidth: 100, ThumbnailHeight: 100}
	settingsService := services.NewSettingsService(repo)
	tagService := services.NewTagService(repo)
	mediaService := services.NewMediaService(repo, cfg, settingsService, tagService)
	handler := NewMediaHandler(mediaService, settingsService)

	e := echo.New()

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/media", nil)
	c := e.NewContext(req, rec)
	_ = handler.ListMedia(c)

	// Rename
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, _ := writer.CreateFormFile("file", "rename.jpg")
	_, _ = part.Write([]byte("rename me"))
	_ = writer.Close()
	req = httptest.NewRequest(http.MethodPost, "/upload", body)
	req.Header.Set(echo.HeaderContentType, writer.FormDataContentType())
	rec = httptest.NewRecorder()
	_ = handler.UploadFile(e.NewContext(req, rec))
	var m map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &m)
	mediaID := int64(m["id"].(float64))

	renameBody, _ := json.Marshal(RenameMediaRequest{NewFilename: "renamed.jpg"})
	req = httptest.NewRequest(http.MethodPost, "/media/"+strconv.FormatInt(mediaID, 10)+"/rename", bytes.NewReader(renameBody))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(strconv.FormatInt(mediaID, 10))
	if err := handler.RenameMedia(c); err != nil {
		t.Fatalf("RenameMedia failed: %v", err)
	}

	// Stats
	_ = handler.GetStorageStats(e.NewContext(httptest.NewRequest(http.MethodGet, "/stats", nil), httptest.NewRecorder()))

	// Bulk delete
	bulkBody, _ := json.Marshal(BulkDeleteRequest{IDs: []int64{mediaID}})
	req = httptest.NewRequest(http.MethodPost, "/bulk-delete", bytes.NewReader(bulkBody))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec = httptest.NewRecorder()
	_ = handler.BulkDeleteMedia(e.NewContext(req, rec))
}

func TestMediaHandler_GetMediaFolders(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	tmpDir, _ := os.MkdirTemp("", "media-handler-test")
	defer func() {
		_ = os.RemoveAll(tmpDir)
	}()

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
	defer func() {
		_ = repo.Close()
	}()

	tmpDir, _ := os.MkdirTemp("", "media-handler-test")
	defer func() {
		_ = os.RemoveAll(tmpDir)
	}()

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
	defer func() {
		_ = repo.Close()
	}()

	tmpDir, _ := os.MkdirTemp("", "media-handler-test")
	defer func() {
		_ = os.RemoveAll(tmpDir)
	}()

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
	defer func() {
		_ = repo.Close()
	}()

	tmpDir, _ := os.MkdirTemp("", "media-handler-test")
	defer func() {
		_ = os.RemoveAll(tmpDir)
	}()

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
	defer func() {
		_ = repo.Close()
	}()

	tmpDir, _ := os.MkdirTemp("", "media-handler-test")
	defer func() {
		_ = os.RemoveAll(tmpDir)
	}()

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
		_ = repo.Close()
		_ = os.RemoveAll(tmpDir)
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
	_ = handler.BulkDeleteMedia(c) // may return 400
}

func TestMediaHandler_UploadMultiple(t *testing.T) {
	handler, cleanup := setupMediaHandler(t)
	defer cleanup()

	e := echo.New()

	// No files → error
	body := &bytes.Buffer{}
	w := multipart.NewWriter(body)
	_ = w.Close()
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
	_, _ = part.Write([]byte("multi content"))
	_ = w.Close()
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

func TestMediaHandler_AnalyzeImageByID(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	tmpDir, _ := os.MkdirTemp("", "media-analyze-test")
	defer func() {
		_ = os.RemoveAll(tmpDir)
	}()

	cfg := &config.Config{StoragePath: tmpDir, ThumbnailWidth: 100, ThumbnailHeight: 100}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	handler := NewMediaHandler(mediaSvc, settingsSvc)
	e := echo.New()

	ctx := context.Background()
	// Upload a non-image file
	media, _ := mediaSvc.UploadFile(ctx, services.UploadFileParams{
		Content: []byte("hello"), Filename: "test.txt", MimeType: "text/plain",
	})

	// Case 1: Invalid ID
	req := httptest.NewRequest(http.MethodPost, "/media/abc/analyze", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("abc")
	err := handler.AnalyzeImageByID(c)
	if err == nil {
		t.Error("expected error for invalid ID")
	}

	// Case 2: Media Not Found
	req = httptest.NewRequest(http.MethodPost, "/media/9999/analyze", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("9999")
	err = handler.AnalyzeImageByID(c)
	if err == nil {
		t.Error("expected error for non-existent media")
	} else if he, ok := err.(*echo.HTTPError); ok && he.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", he.Code)
	}

	// Case 3: Not an Image
	req = httptest.NewRequest(http.MethodPost, "/media/1/analyze", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(strconv.FormatInt(media.ID, 10))
	err = handler.AnalyzeImageByID(c)
	if err == nil {
		t.Error("expected error for non-image media")
	} else if he, ok := err.(*echo.HTTPError); ok && he.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", he.Code)
	}
}

func TestMediaHandler_AnalyzeImageByPath(t *testing.T) {
	handler, cleanup := setupMediaHandler(t)
	defer cleanup()

	e := echo.New()

	// Empty path → 400
	body, _ := json.Marshal(map[string]string{"path": ""})
	req := httptest.NewRequest(http.MethodPost, "/media/analyze-path", bytes.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	if handler.AnalyzeImageByPath(c) == nil {
		t.Error("expected error for empty path")
	}

	// Invalid JSON
	req = httptest.NewRequest(http.MethodPost, "/media/analyze-path", bytes.NewReader([]byte("{bad")))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec = httptest.NewRecorder()
	_ = handler.AnalyzeImageByPath(e.NewContext(req, rec))
}

func TestMediaHandler_AnalyzeImage(t *testing.T) {
	handler, cleanup := setupMediaHandler(t)
	defer cleanup()

	e := echo.New()

	// No image file → 400
	body := &bytes.Buffer{}
	w := multipart.NewWriter(body)
	_ = w.Close()
	req := httptest.NewRequest(http.MethodPost, "/media/analyze", body)
	req.Header.Set(echo.HeaderContentType, w.FormDataContentType())
	rec := httptest.NewRecorder()
	if handler.AnalyzeImage(e.NewContext(req, rec)) == nil {
		t.Error("expected error for missing image file")
	}
}

func TestMediaHandler_UpdateMedia_Metadata(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	tmpDir, _ := os.MkdirTemp("", "media-meta-test")
	defer func() { _ = os.RemoveAll(tmpDir) }()

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

	body, _ := json.Marshal(map[string]interface{}{
		"alt_text": "alt",
		"metadata": map[string]interface{}{"Make": "Sony"},
	})
	req := httptest.NewRequest(http.MethodPatch, "/", bytes.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(strconv.FormatInt(media.ID, 10))
	if err := handler.UpdateMedia(c); err != nil {
		t.Fatalf("UpdateMedia: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 got %d: %s", rec.Code, rec.Body.String())
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	meta, ok := resp["metadata"].(map[string]interface{})
	if !ok || meta["Make"] != "Sony" {
		t.Errorf("metadata not updated: %v", resp["metadata"])
	}

	body2, _ := json.Marshal(map[string]interface{}{"alt_text": "alt2"})
	req2 := httptest.NewRequest(http.MethodPatch, "/", bytes.NewReader(body2))
	req2.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec2 := httptest.NewRecorder()
	c2 := e.NewContext(req2, rec2)
	c2.SetParamNames("id")
	c2.SetParamValues(strconv.FormatInt(media.ID, 10))
	if err := handler.UpdateMedia(c2); err != nil {
		t.Fatalf("UpdateMedia2: %v", err)
	}
	var resp2 map[string]interface{}
	_ = json.Unmarshal(rec2.Body.Bytes(), &resp2)
	meta2, ok2 := resp2["metadata"].(map[string]interface{})
	if !ok2 || meta2["Make"] != "Sony" {
		t.Errorf("metadata wiped on nil: %v", resp2["metadata"])
	}
}

func TestMediaHandler_ReextractEXIF(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	tmpDir, _ := os.MkdirTemp("", "media-reextract-test")
	defer func() { _ = os.RemoveAll(tmpDir) }()

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

	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(strconv.FormatInt(media.ID, 10))
	if err := handler.ReextractEXIF(c); err != nil {
		t.Fatalf("ReextractEXIF: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 got %d", rec.Code)
	}

	req2 := httptest.NewRequest(http.MethodPost, "/", nil)
	rec2 := httptest.NewRecorder()
	c2 := e.NewContext(req2, rec2)
	c2.SetParamNames("id")
	c2.SetParamValues("nope")
	if handler.ReextractEXIF(c2) == nil {
		t.Error("expected error for invalid id")
	}
}

// Regression: post response must include media array populated via content paths, not
// media.post_id. Images added via the VisualEditor never have post_id set, so the old
// GetMediaByPostID-based lookup always returned an empty array.
func TestPostHandler_GetPostBySlug_MediaByContentPaths(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()
	tmpDir, _ := os.MkdirTemp("", "post-media-paths-test")
	defer os.RemoveAll(tmpDir)

	cfg := &config.Config{StoragePath: tmpDir, ThumbnailWidth: 100, ThumbnailHeight: 100}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	postSvc := services.NewPostService(repo)
	handler := NewPostHandler(postSvc, settingsSvc, mediaSvc, tagSvc)
	e := echo.New()
	ctx := context.Background()

	user, _ := repo.CreateUser(ctx, models.CreateUserParams{
		Username: "exiftest", Email: "exif@test.com", PasswordHash: "h", DisplayName: "T",
	})

	// Upload a media item — post_id intentionally NOT set (simulates VisualEditor use)
	media, _ := mediaSvc.UploadFile(ctx, services.UploadFileParams{
		Content: []byte("data"), Filename: "shot.jpg", MimeType: "image/jpeg",
	})
	meta := map[string]interface{}{"Make": "Canon"}
	_, _ = mediaSvc.UpdateMedia(ctx, services.UpdateMediaParams{
		ID: media.ID, Metadata: &meta,
	})

	// Create a post whose content references the media path (no post_id on media)
	mediaPath := "/" + strings.TrimPrefix(media.OriginalPath, "originals/")
	post, _ := postSvc.CreatePost(ctx, services.CreatePostParams{
		Title: "Photo Post", Content: mediaPath, Status: "published", AuthorID: user.ID,
	})

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues(post.Slug)
	c.Set("user", "admin")
	if err := handler.GetPostBySlug(c); err != nil {
		t.Fatalf("GetPostBySlug: %v", err)
	}
	var resp map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	mediaArr, ok := resp["media"].([]interface{})
	if !ok || len(mediaArr) == 0 {
		t.Fatalf("expected non-empty media array, got %v", resp["media"])
	}
	item := mediaArr[0].(map[string]interface{})
	m, ok := item["metadata"].(map[string]interface{})
	if !ok || m["Make"] != "Canon" {
		t.Errorf("expected EXIF metadata in media item, got %v", item["metadata"])
	}
}

// Regression: ListMedia must return metadata so the EXIF panel renders on page load.
// Before the fix, ListMediaFiltered selected 15 columns and omitted metadata.
func TestMediaHandler_ListMedia_IncludesMetadata(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()
	tmpDir, _ := os.MkdirTemp("", "media-list-meta-test")
	defer os.RemoveAll(tmpDir)

	cfg := &config.Config{StoragePath: tmpDir, ThumbnailWidth: 100, ThumbnailHeight: 100}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	handler := NewMediaHandler(mediaSvc, settingsSvc)
	e := echo.New()
	ctx := context.Background()

	media, _ := mediaSvc.UploadFile(ctx, services.UploadFileParams{
		Content: []byte("data"), Filename: "meta.txt", MimeType: "text/plain",
	})
	initialMeta := map[string]interface{}{"Make": "Nikon"}
	_, err := mediaSvc.UpdateMedia(ctx, services.UpdateMediaParams{
		ID: media.ID, AltText: "alt", Metadata: &initialMeta,
	})
	if err != nil {
		t.Fatalf("set metadata: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/media", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	if err := handler.ListMedia(c); err != nil {
		t.Fatalf("ListMedia: %v", err)
	}
	var resp map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	items := resp["media"].([]interface{})
	if len(items) == 0 {
		t.Fatal("expected at least one media item")
	}
	item := items[0].(map[string]interface{})
	meta, ok := item["metadata"].(map[string]interface{})
	if !ok || meta["Make"] != "Nikon" {
		t.Errorf("ListMedia did not return metadata: got %v", item["metadata"])
	}
}

// Regression: PATCH /api/media/:id with only metadata must not wipe alt_text/caption/post_id.
// Before the fix, UpdateMedia SQL used unconditional SET (not COALESCE) for those fields.
func TestMediaHandler_UpdateMedia_MetadataOnly_PreservesOtherFields(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()
	tmpDir, _ := os.MkdirTemp("", "media-preserve-test")
	defer os.RemoveAll(tmpDir)

	cfg := &config.Config{StoragePath: tmpDir, ThumbnailWidth: 100, ThumbnailHeight: 100}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	handler := NewMediaHandler(mediaSvc, settingsSvc)
	e := echo.New()
	ctx := context.Background()

	media, _ := mediaSvc.UploadFile(ctx, services.UploadFileParams{
		Content: []byte("data"), Filename: "preserve.txt", MimeType: "text/plain",
	})
	// Set initial alt_text and caption
	_, err := mediaSvc.UpdateMedia(ctx, services.UpdateMediaParams{
		ID: media.ID, AltText: "my alt", Caption: "my caption",
	})
	if err != nil {
		t.Fatalf("set initial fields: %v", err)
	}

	// PATCH with only metadata — must preserve alt_text and caption
	metaOnly := map[string]interface{}{"ISO": "400"}
	body, _ := json.Marshal(map[string]interface{}{"metadata": metaOnly})
	req := httptest.NewRequest(http.MethodPatch, "/", bytes.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(strconv.FormatInt(media.ID, 10))
	if err := handler.UpdateMedia(c); err != nil {
		t.Fatalf("UpdateMedia: %v", err)
	}
	var resp map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if resp["alt_text"] != "my alt" {
		t.Errorf("alt_text wiped: got %v", resp["alt_text"])
	}
	if resp["caption"] != "my caption" {
		t.Errorf("caption wiped: got %v", resp["caption"])
	}
	meta, ok := resp["metadata"].(map[string]interface{})
	if !ok || meta["ISO"] != "400" {
		t.Errorf("metadata not saved: got %v", resp["metadata"])
	}
}
