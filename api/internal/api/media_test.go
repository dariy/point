package api

import (
	"bytes"
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
	mediaService := services.NewMediaService(repo, cfg, settingsService)
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
	mediaService := services.NewMediaService(repo, cfg, settingsService)
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
