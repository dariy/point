package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
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

	p1, _ := writer.CreateFormFile("files", "f1.jpg")
	_, _ = p1.Write(makeJPEGWithEXIF(t))
	p2, _ := writer.CreateFormFile("files", "f2.jpg")
	_, _ = p2.Write(makeTinyPNG(t))
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
	var resp struct {
		TotalUploaded int `json:"total_uploaded"`
		TotalFailed   int `json:"total_failed"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.TotalUploaded != 2 || resp.TotalFailed != 0 {
		t.Errorf("expected 2 uploaded / 0 failed, got %d / %d", resp.TotalUploaded, resp.TotalFailed)
	}
}

// makeTinyPNG returns a valid 1x1 PNG for upload tests.
func makeTinyPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 1, 1))
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("png.Encode: %v", err)
	}
	return buf.Bytes()
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
	var he *echo.HTTPError
	if err == nil {
		t.Error("expected error for non-existent media rename")
	} else if errors.As(err, &he) {
		// 404, not 500: RenameMedia resolves the row before touching the file,
		// so a missing id is a missing resource, not a server fault. This
		// asserted 500 before the handler moved onto the central error mapper.
		if he.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d", he.Code)
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

// makeTinyMP4 returns bytes that sniff as video/mp4: a size prefix, the "ftyp"
// box marker, and the "isom" major brand. Nothing decodes them — the server has
// no video decoder, which is the whole reason posters are captured client-side.
func makeTinyMP4() []byte {
	return append([]byte("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00"), []byte("mp42isomavc1")...)
}

// newMediaHandler wires a handler over a scratch storage dir.
func newMediaHandler(t *testing.T) (*MediaHandler, *echo.Echo) {
	t.Helper()
	repo := setupTestDB(t)
	t.Cleanup(func() { _ = repo.Close() })

	cfg := &config.Config{StoragePath: t.TempDir(), ThumbnailWidth: 400, ThumbnailHeight: 300}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	return NewMediaHandler(mediaSvc, settingsSvc), echo.New()
}

// uploadVideoWithPoster posts a video, optionally with a poster frame attached,
// and returns the decoded response body.
func uploadVideoWithPoster(t *testing.T, h *MediaHandler, e *echo.Echo, poster []byte) map[string]interface{} {
	t.Helper()
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	p, _ := writer.CreateFormFile("file", "clip.mp4")
	_, _ = p.Write(makeTinyMP4())
	if poster != nil {
		pf, _ := writer.CreateFormFile("poster", "poster.png")
		_, _ = pf.Write(poster)
	}
	_ = writer.Close()

	req := httptest.NewRequest(http.MethodPost, "/", body)
	req.Header.Set(echo.HeaderContentType, writer.FormDataContentType())
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})

	if err := h.UploadFile(c); err != nil {
		t.Fatalf("UploadFile: %v", err)
	}
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d. Body: %s", rec.Code, rec.Body.String())
	}
	var resp map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return resp
}

func TestUploadFile_VideoPoster(t *testing.T) {
	t.Run("poster becomes the video thumbnail", func(t *testing.T) {
		h, e := newMediaHandler(t)
		resp := uploadVideoWithPoster(t, h, e, makeTinyPNG(t))

		if resp["file_type"] != "video" {
			t.Fatalf("expected file_type video, got %v", resp["file_type"])
		}
		// The response exposes the thumbnail as the ?thumb variant of the media
		// URL, which is what the admin grid and the atlas render.
		thumb, _ := resp["thumbnail_path"].(string)
		if thumb == "" || !strings.HasSuffix(thumb, ".mp4?thumb") {
			t.Errorf("expected a ?thumb path for the video, got %q", thumb)
		}
	})

	t.Run("video without a poster keeps none", func(t *testing.T) {
		h, e := newMediaHandler(t)
		resp := uploadVideoWithPoster(t, h, e, nil)

		if resp["thumbnail_path"] != nil {
			t.Errorf("expected no thumbnail, got %v", resp["thumbnail_path"])
		}
	})

	t.Run("unusable poster does not fail the upload", func(t *testing.T) {
		h, e := newMediaHandler(t)
		// A poster the server cannot decode is dropped: the video still uploads,
		// it just goes without a still. Losing the whole file over a bad frame
		// would be a far worse trade.
		resp := uploadVideoWithPoster(t, h, e, []byte("<html>not an image</html>"))

		if resp["thumbnail_path"] != nil {
			t.Errorf("expected no thumbnail, got %v", resp["thumbnail_path"])
		}
		if resp["file_type"] != "video" {
			t.Errorf("expected the video to be stored anyway, got %v", resp["file_type"])
		}
	})
}

func TestSetVideoPoster(t *testing.T) {
	post := func(t *testing.T, h *MediaHandler, e *echo.Echo, id string, poster []byte) (*httptest.ResponseRecorder, error) {
		t.Helper()
		body := &bytes.Buffer{}
		writer := multipart.NewWriter(body)
		if poster != nil {
			pf, _ := writer.CreateFormFile("poster", "poster.png")
			_, _ = pf.Write(poster)
		}
		_ = writer.Close()

		req := httptest.NewRequest(http.MethodPost, "/", body)
		req.Header.Set(echo.HeaderContentType, writer.FormDataContentType())
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		c.SetParamNames("id")
		c.SetParamValues(id)
		c.Set("user", models.GetSessionByTokenRow{UserID: 1})
		return rec, h.SetVideoPoster(c)
	}

	t.Run("backfills a video uploaded without one", func(t *testing.T) {
		h, e := newMediaHandler(t)
		uploaded := uploadVideoWithPoster(t, h, e, nil)
		id := fmt.Sprintf("%v", int64(uploaded["id"].(float64)))

		rec, err := post(t, h, e, id, makeTinyPNG(t))
		if err != nil {
			t.Fatalf("SetVideoPoster: %v", err)
		}
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d. Body: %s", rec.Code, rec.Body.String())
		}
		var resp map[string]interface{}
		_ = json.Unmarshal(rec.Body.Bytes(), &resp)
		if thumb, _ := resp["thumbnail_path"].(string); !strings.HasSuffix(thumb, ".mp4?thumb") {
			t.Errorf("expected a ?thumb path for the video, got %q", thumb)
		}
	})

	t.Run("rejects a missing poster", func(t *testing.T) {
		h, e := newMediaHandler(t)
		uploaded := uploadVideoWithPoster(t, h, e, nil)
		id := fmt.Sprintf("%v", int64(uploaded["id"].(float64)))

		_, err := post(t, h, e, id, nil)
		var he *echo.HTTPError
		if !errors.As(err, &he) || he.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %v", err)
		}
	})

	t.Run("rejects a non-image poster", func(t *testing.T) {
		h, e := newMediaHandler(t)
		uploaded := uploadVideoWithPoster(t, h, e, nil)
		id := fmt.Sprintf("%v", int64(uploaded["id"].(float64)))

		// An .mp4 in the poster slot must not be stored as a still.
		_, err := post(t, h, e, id, makeTinyMP4())
		var he *echo.HTTPError
		if !errors.As(err, &he) || he.Code != http.StatusUnsupportedMediaType {
			t.Errorf("expected 415, got %v", err)
		}
	})

	t.Run("rejects a non-numeric id", func(t *testing.T) {
		h, e := newMediaHandler(t)
		_, err := post(t, h, e, "abc", makeTinyPNG(t))
		var he *echo.HTTPError
		if !errors.As(err, &he) || he.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %v", err)
		}
	})
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
	_, _ = p.Write(makeJPEGWithEXIF(t))
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
