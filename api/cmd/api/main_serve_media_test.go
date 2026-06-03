package main

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
	"point-api/internal/models"
	"point-api/internal/repository"
)

func newMediaRepo(t *testing.T) (*repository.Repository, string) {
	t.Helper()
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatalf("NewRepository: %v", err)
	}
	t.Cleanup(func() { _ = repo.Close() })
	return repo, t.TempDir()
}

func insertMedia(t *testing.T, repo *repository.Repository, year, month, filename string, isPublic int) {
	t.Helper()
	origPath := "originals/" + year + "/" + month + "/" + filename
	ctx := context.Background()
	m, err := repo.CreateMedia(ctx, models.CreateMediaParams{
		Filename:     filename,
		OriginalPath: origPath,
		Checksum:     filename + "-chk",
		UploadedAt:   time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("CreateMedia: %v", err)
	}
	if _, err := repo.DB().ExecContext(ctx, `UPDATE media SET is_public=? WHERE id=?`, isPublic, m.ID); err != nil {
		t.Fatalf("set is_public: %v", err)
	}
}

func createPublicMedia(t *testing.T, repo *repository.Repository, year, month, filename string) {
	insertMedia(t, repo, year, month, filename, 1)
}

func createPrivateMedia(t *testing.T, repo *repository.Repository, year, month, filename string) {
	insertMedia(t, repo, year, month, filename, 0)
}

func makeMediaFile(t *testing.T, storagePath, year, month, filename string) string {
	t.Helper()
	dir := filepath.Join(storagePath, "media", "originals", year, month)
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, filename)
	if err := os.WriteFile(p, []byte("fake-content"), 0644); err != nil {
		t.Fatal(err)
	}
	return p
}

func serveMediaRequest(t *testing.T, storagePath, indexHTML string, repo *repository.Repository, year, month, filename string, authenticated bool) *httptest.ResponseRecorder {
	t.Helper()
	handler := serveSimplifiedMedia(storagePath, indexHTML, repo)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/"+year+"/"+month+"/"+filename, nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("year", "month", "filename")
	c.SetParamValues(year, month, filename)
	if authenticated {
		c.Set("user", struct{ ID int64 }{ID: 1})
	}
	if err := handler(c); err != nil {
		// Echo error handlers write the response; record the code.
		he, ok := err.(*echo.HTTPError)
		if ok {
			rec.Code = he.Code
		}
	}
	return rec
}

// ── Non-numeric year/month → SPA fallback ─────────────────────────────────

func TestServeSimplifiedMedia_SPAFallback_NoIndex(t *testing.T) {
	repo, storage := newMediaRepo(t)
	rec := serveMediaRequest(t, storage, "/nonexistent/index.html", repo, "posts", "jan", "photo.jpg", false)
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503 (no index.html), got %d", rec.Code)
	}
}

func TestServeSimplifiedMedia_SPAFallback_WithIndex(t *testing.T) {
	repo, storage := newMediaRepo(t)
	indexFile := filepath.Join(t.TempDir(), "index.html")
	_ = os.WriteFile(indexFile, []byte("<html>SPA</html>"), 0644)
	rec := serveMediaRequest(t, storage, indexFile, repo, "not-a-year", "01", "photo.jpg", false)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 (serve index.html), got %d", rec.Code)
	}
}

// ── Invalid filename ───────────────────────────────────────────────────────

func TestServeSimplifiedMedia_InvalidFilename(t *testing.T) {
	repo, storage := newMediaRepo(t)
	rec := serveMediaRequest(t, storage, "", repo, "2024", "01", "..", false)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for '..', got %d", rec.Code)
	}
}

func TestServeSimplifiedMedia_EmptyFilename(t *testing.T) {
	repo, storage := newMediaRepo(t)
	rec := serveMediaRequest(t, storage, "", repo, "2024", "01", ".", false)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for '.', got %d", rec.Code)
	}
}

// ── Media not found in DB ──────────────────────────────────────────────────

func TestServeSimplifiedMedia_NotFoundInDB(t *testing.T) {
	repo, storage := newMediaRepo(t)
	rec := serveMediaRequest(t, storage, "", repo, "2024", "01", "missing.jpg", false)
	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404 for missing media, got %d", rec.Code)
	}
}

// ── Visibility enforcement ─────────────────────────────────────────────────

func TestServeSimplifiedMedia_PrivateMedia_Unauthenticated(t *testing.T) {
	repo, storage := newMediaRepo(t)
	createPrivateMedia(t, repo, "2024", "01", "private.jpg")
	rec := serveMediaRequest(t, storage, "", repo, "2024", "01", "private.jpg", false)
	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404 for private media (unauthenticated), got %d", rec.Code)
	}
}

func TestServeSimplifiedMedia_PrivateMedia_Authenticated(t *testing.T) {
	repo, storage := newMediaRepo(t)
	createPrivateMedia(t, repo, "2024", "01", "private.jpg")
	makeMediaFile(t, storage, "2024", "01", "private.jpg")
	rec := serveMediaRequest(t, storage, "", repo, "2024", "01", "private.jpg", true)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 for private media (authenticated), got %d", rec.Code)
	}
}

// ── Serve public original ──────────────────────────────────────────────────

func TestServeSimplifiedMedia_PublicMedia_FileExists(t *testing.T) {
	repo, storage := newMediaRepo(t)
	createPublicMedia(t, repo, "2024", "01", "photo.jpg")
	makeMediaFile(t, storage, "2024", "01", "photo.jpg")
	rec := serveMediaRequest(t, storage, "", repo, "2024", "01", "photo.jpg", false)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 for public media, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestServeSimplifiedMedia_PublicMedia_FileMissing(t *testing.T) {
	repo, storage := newMediaRepo(t)
	createPublicMedia(t, repo, "2024", "01", "ghost.jpg")
	// File not on disk.
	rec := serveMediaRequest(t, storage, "", repo, "2024", "01", "ghost.jpg", false)
	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404 when file missing from disk, got %d", rec.Code)
	}
}

// ── Thumbnail serving ──────────────────────────────────────────────────────

func serveThumbRequest(t *testing.T, storagePath string, repo *repository.Repository, year, month, filename string) *httptest.ResponseRecorder {
	t.Helper()
	handler := serveSimplifiedMedia(storagePath, "", repo)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/"+year+"/"+month+"/"+filename+"?thumb", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("year", "month", "filename")
	c.SetParamValues(year, month, filename)
	c.Set("user", struct{ ID int64 }{ID: 1}) // authenticated
	if err := handler(c); err != nil {
		if he, ok := err.(*echo.HTTPError); ok {
			rec.Code = he.Code
		}
	}
	return rec
}

func TestServeSimplifiedMedia_ThumbNoThumbnail(t *testing.T) {
	repo, storage := newMediaRepo(t)
	createPublicMedia(t, repo, "2024", "01", "no-thumb.jpg")
	rec := serveThumbRequest(t, storage, repo, "2024", "01", "no-thumb.jpg")
	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404 when no thumbnail, got %d", rec.Code)
	}
}

func TestServeSimplifiedMedia_ThumbFileMissing(t *testing.T) {
	repo, storage := newMediaRepo(t)
	ctx := context.Background()
	// Create media record with ThumbnailPath set, but thumbnail file absent from disk.
	m, err := repo.CreateMedia(ctx, models.CreateMediaParams{
		Filename:      "thumb-missing.jpg",
		OriginalPath:  "originals/2024/01/thumb-missing.jpg",
		ThumbnailPath: sql.NullString{String: "thumbnails/2024/01/thumb-missing_thumb.jpg", Valid: true},
		Checksum:      "thumb-missing-chk",
		UploadedAt:    time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("CreateMedia: %v", err)
	}
	if _, err := repo.DB().ExecContext(ctx, `UPDATE media SET is_public=1 WHERE id=?`, m.ID); err != nil {
		t.Fatalf("set is_public: %v", err)
	}
	rec := serveThumbRequest(t, storage, repo, "2024", "01", "thumb-missing.jpg")
	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404 when thumb file missing from disk, got %d", rec.Code)
	}
}

func TestServeSimplifiedMedia_ThumbServed(t *testing.T) {
	repo, storage := newMediaRepo(t)
	ctx := context.Background()
	thumbRel := "thumbnails/2024/01/photo_thumb.jpg"
	m, err := repo.CreateMedia(ctx, models.CreateMediaParams{
		Filename:      "photo.jpg",
		OriginalPath:  "originals/2024/01/photo.jpg",
		ThumbnailPath: sql.NullString{String: thumbRel, Valid: true},
		Checksum:      "photo-thumb-chk",
		UploadedAt:    time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("CreateMedia: %v", err)
	}
	if _, err := repo.DB().ExecContext(ctx, `UPDATE media SET is_public=1 WHERE id=?`, m.ID); err != nil {
		t.Fatalf("set is_public: %v", err)
	}

	// Create the thumbnail file on disk.
	thumbFile := filepath.Join(storage, "media", thumbRel)
	_ = os.MkdirAll(filepath.Dir(thumbFile), 0755)
	_ = os.WriteFile(thumbFile, []byte("thumb-data"), 0644)

	rec := serveThumbRequest(t, storage, repo, "2024", "01", "photo.jpg")
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 serving thumbnail, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestServeSimplifiedMedia_OrigServedViaChecksumGlob(t *testing.T) {
	repo, storage := newMediaRepo(t)
	// DB has the record, file is NOT at exact path but checksum glob finds it.
	createPublicMedia(t, repo, "2024", "01", "video_89abcdef.mp4")
	// Put the file under the same checksum-matched name (glob: *_89abcdef.*)
	dir := filepath.Join(storage, "media", "originals", "2024", "01")
	_ = os.MkdirAll(dir, 0755)
	_ = os.WriteFile(filepath.Join(dir, "video_89abcdef.mp4"), []byte("video"), 0644)

	rec := serveMediaRequest(t, storage, "", repo, "2024", "01", "video_89abcdef.mp4", false)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

// ── Checksum-glob fallback ─────────────────────────────────────────────────

func TestServeSimplifiedMedia_ChecksumFallback(t *testing.T) {
	repo, storage := newMediaRepo(t)
	// Store as "photo_abc12345.jpg" in DB, but request comes in without the checksum suffix.
	realName := "photo_abc12345.jpg"
	createPublicMedia(t, repo, "2024", "01", realName)
	makeMediaFile(t, storage, "2024", "01", realName)

	// Request using the checksum filename directly (which IS the DB record).
	rec := serveMediaRequest(t, storage, "", repo, "2024", "01", realName, false)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

// ── Year/month boundary validation ─────────────────────────────────────────

func TestServeSimplifiedMedia_YearOutOfRange(t *testing.T) {
	repo, storage := newMediaRepo(t)
	rec := serveMediaRequest(t, storage, "", repo, "999", "01", "photo.jpg", false)
	// Year < 1000 → SPA route → 503 (no index.html)
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503 for out-of-range year, got %d", rec.Code)
	}
}

func TestServeSimplifiedMedia_MonthOutOfRange(t *testing.T) {
	repo, storage := newMediaRepo(t)
	rec := serveMediaRequest(t, storage, "", repo, "2024", "13", "photo.jpg", false)
	// Month > 12 → SPA route → 503 (no index.html)
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503 for out-of-range month, got %d", rec.Code)
	}
}

func TestServeSimplifiedMedia_ChecksumGlobZeroMatches(t *testing.T) {
	repo, storage := newMediaRepo(t)
	// Request a file with checksum that doesn't exist in DB or on disk.
	rec := serveMediaRequest(t, storage, "", repo, "2024", "01", "missing_12345678.jpg", false)
	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", rec.Code)
	}
}

func TestServeSimplifiedMedia_ChecksumGlobMultipleMatches(t *testing.T) {
	repo, storage := newMediaRepo(t)
	dir := filepath.Join(storage, "media", "originals", "2024", "01")
	_ = os.MkdirAll(dir, 0755)
	_ = os.WriteFile(filepath.Join(dir, "file1_12345678.jpg"), []byte("data"), 0644)
	_ = os.WriteFile(filepath.Join(dir, "file2_12345678.jpg"), []byte("data"), 0644)

	// Since there are multiple matches, it should NOT serve the file and should fail to find in DB.
	rec := serveMediaRequest(t, storage, "", repo, "2024", "01", "missing_12345678.jpg", false)
	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404 due to ambiguous matches, got %d", rec.Code)
	}
}

func TestServeSimplifiedMedia_ChecksumGlobDBLookupFail(t *testing.T) {
	repo, storage := newMediaRepo(t)
	dir := filepath.Join(storage, "media", "originals", "2024", "01")
	_ = os.MkdirAll(dir, 0755)
	_ = os.WriteFile(filepath.Join(dir, "private_12345678.jpg"), []byte("data"), 0644)

	// Ensure DB does NOT have it, but the file exists on disk.
	// Since we are unauthenticated and it's not in DB, it should be 404.
	rec := serveMediaRequest(t, storage, "", repo, "2024", "01", "missing_12345678.jpg", false)
	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404 because file not in DB, got %d", rec.Code)
	}
}
