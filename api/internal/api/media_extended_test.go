package api

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/labstack/echo/v4"
	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/services"
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
