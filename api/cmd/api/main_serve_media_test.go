package main

import (
	"context"
	"database/sql"
	"errors"
	"image"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

// testMediaSvc builds a MediaService backed by the test repo and temp storage,
// enough for the media-serving handler (incl. on-demand square thumbnails).
func testMediaSvc(t *testing.T, repo repository.Repository, storagePath string) *services.MediaService {
	t.Helper()
	return services.NewMediaService(
		repo,
		&config.Config{StoragePath: storagePath},
		services.NewSettingsService(repo),
		services.NewTagService(repo),
	)
}

func newMediaRepo(t *testing.T) (repository.Repository, string) {
	t.Helper()
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatalf("NewRepository: %v", err)
	}
	t.Cleanup(func() { _ = repo.Close() })
	return repo, t.TempDir()
}

func insertMedia(t *testing.T, repo repository.Repository, year, month, filename string, isPublic int) {
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

func createPublicMedia(t *testing.T, repo repository.Repository, year, month, filename string) {
	insertMedia(t, repo, year, month, filename, 1)
}

func createPrivateMedia(t *testing.T, repo repository.Repository, year, month, filename string) {
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

func serveMediaRequest(t *testing.T, storagePath, indexHTMLContent string, repo repository.Repository, year, month, filename string, authenticated bool) *httptest.ResponseRecorder {
	t.Helper()
	handler := serveSimplifiedMedia(storagePath, indexHTMLContent, repo, testMediaSvc(t, repo, storagePath), nil, services.NewSettingsService(repo), nil, nil)
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
		var he *echo.HTTPError
		if errors.As(err, &he) {
			rec.Code = he.Code
		}
	}
	return rec
}

// ── Non-numeric year/month → SPA fallback ─────────────────────────────────

func TestServeSimplifiedMedia_SPAFallback_NoIndex(t *testing.T) {
	repo, storage := newMediaRepo(t)
	// Empty index content = frontend not built → SPA fallback returns 503.
	rec := serveMediaRequest(t, storage, "", repo, "posts", "jan", "photo.jpg", false)
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503 (no index.html), got %d", rec.Code)
	}
}

func TestServeSimplifiedMedia_SPAFallback_WithIndex(t *testing.T) {
	repo, storage := newMediaRepo(t)
	rec := serveMediaRequest(t, storage, "<html><head></head><body>SPA</body></html>", repo, "not-a-year", "01", "photo.jpg", false)
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

func TestServeSimplifiedMedia_PublicMedia_CacheControl(t *testing.T) {
	repo, storage := newMediaRepo(t)
	createPublicMedia(t, repo, "2024", "01", "photo.jpg")
	makeMediaFile(t, storage, "2024", "01", "photo.jpg")
	rec := serveMediaRequest(t, storage, "", repo, "2024", "01", "photo.jpg", false)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "public, max-age=300, s-maxage=86400" {
		t.Errorf("expected Cache-Control: public, max-age=300, s-maxage=86400, got %q", cc)
	}
}

func TestServeSimplifiedMedia_PrivateMedia_Unauthenticated_NoStore(t *testing.T) {
	repo, storage := newMediaRepo(t)
	createPrivateMedia(t, repo, "2024", "01", "private.jpg")
	makeMediaFile(t, storage, "2024", "01", "private.jpg")
	rec := serveMediaRequest(t, storage, "", repo, "2024", "01", "private.jpg", false)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("expected Cache-Control: no-store on 404, got %q", cc)
	}
}

func TestServeSimplifiedMedia_NotFound_ShortCache(t *testing.T) {
	repo, storage := newMediaRepo(t)
	rec := serveMediaRequest(t, storage, "", repo, "2024", "01", "ghost.jpg", false)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != notFoundCacheControl {
		t.Errorf("expected Cache-Control: %q on 404, got %q", notFoundCacheControl, cc)
	}
}

// A public media record whose bytes are missing from disk — the shape of a
// stale or unmounted media volume. The hit TTL is set before the file is
// touched, so the 404 must overwrite it: inheriting s-maxage=86400 here once
// let a transient mount fault keep a site's images 404ing at the edge for the
// rest of the day, long after the volume was healthy again.
func TestServeSimplifiedMedia_FileMissingOnDisk_DoesNotInheritHitTTL(t *testing.T) {
	repo, storage := newMediaRepo(t)
	createPublicMedia(t, repo, "2024", "01", "vanished.jpg") // record, but no file
	rec := serveMediaRequest(t, storage, "", repo, "2024", "01", "vanished.jpg", false)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != notFoundCacheControl {
		t.Errorf("expected Cache-Control: %q on 404, got %q", notFoundCacheControl, cc)
	}
}

func TestServeSimplifiedMedia_PrivateMedia_CacheControl(t *testing.T) {
	repo, storage := newMediaRepo(t)
	createPrivateMedia(t, repo, "2024", "01", "private.jpg")
	makeMediaFile(t, storage, "2024", "01", "private.jpg")
	rec := serveMediaRequest(t, storage, "", repo, "2024", "01", "private.jpg", true)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "private, no-store" {
		t.Errorf("expected Cache-Control: private, no-store, got %q", cc)
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

// serveQueryRequest issues an authenticated GET for a media path with an
// arbitrary query string (no leading "?").
func serveQueryRequest(t *testing.T, storagePath string, repo repository.Repository, year, month, filename, query string) *httptest.ResponseRecorder {
	t.Helper()
	handler := serveSimplifiedMedia(storagePath, "", repo, testMediaSvc(t, repo, storagePath), nil, services.NewSettingsService(repo), nil, nil)
	e := echo.New()
	url := "/" + year + "/" + month + "/" + filename
	if query != "" {
		url += "?" + query
	}
	req := httptest.NewRequest(http.MethodGet, url, nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("year", "month", "filename")
	c.SetParamValues(year, month, filename)
	c.Set("user", struct{ ID int64 }{ID: 1}) // authenticated
	if err := handler(c); err != nil {
		var he *echo.HTTPError
		if errors.As(err, &he) {
			rec.Code = he.Code
		}
	}
	return rec
}

// serveThumbRequest issues an authenticated GET for a bare `?thumb`.
func serveThumbRequest(t *testing.T, storagePath string, repo repository.Repository, year, month, filename string) *httptest.ResponseRecorder {
	t.Helper()
	return serveQueryRequest(t, storagePath, repo, year, month, filename, "thumb")
}

// writeJPEG puts a real, decodable original on disk so variants can be
// generated from it, and returns its path.
func writeJPEG(t *testing.T, storagePath, year, month, filename string, w, h int) string {
	t.Helper()
	dir := filepath.Join(storagePath, "media", "originals", year, month)
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, filename)
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := jpeg.Encode(f, image.NewRGBA(image.Rect(0, 0, w, h)), nil); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	return p
}

// publicImage inserts a public image row and writes a real original for it.
func publicImage(t *testing.T, repo repository.Repository, storage, year, month, filename string, w, h int) {
	t.Helper()
	createPublicMedia(t, repo, year, month, filename)
	if _, err := repo.DB().Exec(`UPDATE media SET file_type='image' WHERE original_path=?`,
		"originals/"+year+"/"+month+"/"+filename); err != nil {
		t.Fatal(err)
	}
	writeJPEG(t, storage, year, month, filename, w, h)
}

func TestServeSimplifiedMedia_ThumbNoSource(t *testing.T) {
	repo, storage := newMediaRepo(t)
	createPublicMedia(t, repo, "2024", "01", "no-thumb.jpg")
	rec := serveThumbRequest(t, storage, repo, "2024", "01", "no-thumb.jpg")
	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404 when there is nothing to derive a thumbnail from, got %d", rec.Code)
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
	publicImage(t, repo, storage, "2024", "01", "photo.jpg", 1200, 800)

	rec := serveThumbRequest(t, storage, repo, "2024", "01", "photo.jpg")
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 serving thumbnail, got %d: %s", rec.Code, rec.Body.String())
	}

	// A bare `?thumb` predates the ladder and has no size in it, so it resolves
	// to the default rung — the URL is in published post content and cannot be
	// migrated.
	cached := filepath.Join(storage, "media",
		services.VariantRelPath("originals/2024/01/photo.jpg", services.DefaultVariantSize))
	if _, err := os.Stat(cached); err != nil {
		t.Errorf("expected the default rung at %s: %v", cached, err)
	}
}

// TestServeSimplifiedMedia_ThumbVideoNoPoster covers the one case where ?thumb
// must not degrade to the original: a video whose poster was never captured.
// Streaming the .mp4 to an <img> would download the whole file to render a
// broken image, so the request 404s and the UI falls back to its play glyph.
func TestServeSimplifiedMedia_ThumbVideoNoPoster(t *testing.T) {
	repo, storage := newMediaRepo(t)
	ctx := context.Background()
	m, err := repo.CreateMedia(ctx, models.CreateMediaParams{
		Filename:     "clip.mp4",
		OriginalPath: "originals/2024/01/clip.mp4",
		FileType:     "video",
		MimeType:     "video/mp4",
		Checksum:     "clip-chk",
		UploadedAt:   time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("CreateMedia: %v", err)
	}
	if _, err := repo.DB().ExecContext(ctx, `UPDATE media SET is_public=1 WHERE id=?`, m.ID); err != nil {
		t.Fatalf("set is_public: %v", err)
	}
	// The original is on disk — without the type check it would be served here.
	makeMediaFile(t, storage, "2024", "01", "clip.mp4")

	if rec := serveThumbRequest(t, storage, repo, "2024", "01", "clip.mp4"); rec.Code != http.StatusNotFound {
		t.Errorf("expected 404 for a posterless video, got %d", rec.Code)
	}

	// The original itself is still served untouched.
	if rec := serveMediaRequest(t, storage, "", repo, "2024", "01", "clip.mp4", true); rec.Code != http.StatusOK {
		t.Errorf("expected 200 for the video itself, got %d", rec.Code)
	}
}

// TestServeSimplifiedMedia_ThumbVideoWithPoster is the payoff: once a poster is
// stored, a video's thumbnail request derives its rungs from that still.
func TestServeSimplifiedMedia_ThumbVideoWithPoster(t *testing.T) {
	repo, storage := newMediaRepo(t)
	ctx := context.Background()
	thumbRel := "thumbnails/2024/01/clip.jpg"
	m, err := repo.CreateMedia(ctx, models.CreateMediaParams{
		Filename:      "clip.mp4",
		OriginalPath:  "originals/2024/01/clip.mp4",
		ThumbnailPath: sql.NullString{String: thumbRel, Valid: true},
		FileType:      "video",
		MimeType:      "video/mp4",
		Checksum:      "clip-poster-chk",
		UploadedAt:    time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("CreateMedia: %v", err)
	}
	if _, err := repo.DB().ExecContext(ctx, `UPDATE media SET is_public=1 WHERE id=?`, m.ID); err != nil {
		t.Fatalf("set is_public: %v", err)
	}

	// A real poster frame, since the ladder is now cut from it.
	thumbFile := filepath.Join(storage, "media", thumbRel)
	if err := os.MkdirAll(filepath.Dir(thumbFile), 0755); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(thumbFile)
	if err != nil {
		t.Fatal(err)
	}
	if err := jpeg.Encode(f, image.NewRGBA(image.Rect(0, 0, 640, 480)), nil); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()

	rec := serveThumbRequest(t, storage, repo, "2024", "01", "clip.mp4")
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 serving the poster rung, got %d: %s", rec.Code, rec.Body.String())
	}

	// The rung is keyed on the original's path even though it was cut from the
	// poster, so one media item has one variant key.
	cached := filepath.Join(storage, "media",
		services.VariantRelPath("originals/2024/01/clip.mp4", services.DefaultVariantSize))
	if _, err := os.Stat(cached); err != nil {
		t.Errorf("expected the video's rung at %s: %v", cached, err)
	}
}

func TestServeSimplifiedMedia_VariantGenerated(t *testing.T) {
	repo, storage := newMediaRepo(t)
	publicImage(t, repo, storage, "2024", "01", "square.jpg", 300, 200)

	rec := serveQueryRequest(t, storage, repo, "2024", "01", "square.jpg", "s=128")
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for ?s=128, got %d: %s", rec.Code, rec.Body.String())
	}
	cached := filepath.Join(storage, "media", "variants", "128", "2024", "01", "square.jpg")
	if _, err := os.Stat(cached); err != nil {
		t.Errorf("expected cached variant at %s: %v", cached, err)
	}
}

func TestServeSimplifiedMedia_VariantBadSize(t *testing.T) {
	repo, storage := newMediaRepo(t)
	createPublicMedia(t, repo, "2024", "01", "square.jpg")

	for _, q := range []string{"s=999", "thumb=999", "s=abc", "s="} {
		rec := serveQueryRequest(t, storage, repo, "2024", "01", "square.jpg", q)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("expected 400 for ?%s, got %d", q, rec.Code)
		}
	}
}

// The legacy query forms must resolve to exactly the rungs the new form does.
// There is no data migration behind them: posts.thumbnail_path rows and
// published post content already carry `?thumb` and `?thumb=128`.
func TestServeSimplifiedMedia_LegacyThumbMatchesExplicitSize(t *testing.T) {
	repo, storage := newMediaRepo(t)
	publicImage(t, repo, storage, "2024", "01", "compat.jpg", 1200, 800)

	for _, tc := range []struct{ legacy, explicit string }{
		{"thumb", "s=512"},
		{"thumb=128", "s=128"},
	} {
		legacy := serveQueryRequest(t, storage, repo, "2024", "01", "compat.jpg", tc.legacy)
		explicit := serveQueryRequest(t, storage, repo, "2024", "01", "compat.jpg", tc.explicit)
		if legacy.Code != http.StatusOK || explicit.Code != http.StatusOK {
			t.Fatalf("?%s = %d, ?%s = %d; want 200 for both",
				tc.legacy, legacy.Code, tc.explicit, explicit.Code)
		}
		if legacy.Body.String() != explicit.Body.String() {
			t.Errorf("?%s and ?%s served different bytes", tc.legacy, tc.explicit)
		}
	}
}

// A rung at or above the source's longest side is never generated — Fit does
// not upscale — so the request falls through to the original rather than
// serving a re-encoded copy of it.
func TestServeSimplifiedMedia_RungAboveSourceServesOriginal(t *testing.T) {
	repo, storage := newMediaRepo(t)
	publicImage(t, repo, storage, "2024", "01", "small.jpg", 300, 200)

	rec := serveQueryRequest(t, storage, repo, "2024", "01", "small.jpg", "s=512")
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	original, err := os.ReadFile(filepath.Join(storage, "media", "originals", "2024", "01", "small.jpg"))
	if err != nil {
		t.Fatal(err)
	}
	if rec.Body.String() != string(original) {
		t.Error("expected the original bytes when the source is below the rung")
	}
	if _, err := os.Stat(filepath.Join(storage, "media", "variants", "512", "2024", "01", "small.jpg")); !os.IsNotExist(err) {
		t.Errorf("rung 512 should not have been written for a 300px source, stat err = %v", err)
	}
}

// The full Cache-Control matrix. What a response may be pinned for depends on
// which file was resolved, so every case here is also a check that the header
// is decided after variant resolution and not from the query alone.
func TestServeSimplifiedMedia_VariantCacheControlMatrix(t *testing.T) {
	const current = services.DefaultThumbnailGeneration

	cases := []struct {
		name      string
		filename  string
		w, h      int
		isPublic  bool
		query     string
		wantCode  int
		wantCache string
	}{
		{
			name:     "variant, current token, content-addressed name",
			filename: "photo_89017c29.jpg", w: 1200, h: 800, isPublic: true,
			query: "s=256&v=" + current, wantCode: 200, wantCache: immutableCacheControl,
		},
		{
			name:     "variant, current token, plain name",
			filename: "photo.jpg", w: 1200, h: 800, isPublic: true,
			query: "s=256&v=" + current, wantCode: 200, wantCache: publicVariantCacheControl,
		},
		{
			name:     "variant, stale token, never an error",
			filename: "photo_89017c29.jpg", w: 1200, h: 800, isPublic: true,
			query: "s=256&v=stale", wantCode: 200, wantCache: publicShortCacheControl,
		},
		{
			name:     "variant, no token",
			filename: "photo_89017c29.jpg", w: 1200, h: 800, isPublic: true,
			query: "s=256", wantCode: 200, wantCache: publicShortCacheControl,
		},
		{
			// The query asks for a variant with a current token, but the source
			// is below the rung so the ORIGINAL is what gets served — and an
			// original is not a function of the generation token, so it may not
			// take the variant's long TTL.
			name:     "rung above source falls back to the original TTL",
			filename: "small.jpg", w: 300, h: 200, isPublic: true,
			query: "s=512&v=" + current, wantCode: 200, wantCache: publicShortCacheControl,
		},
		{
			name:     "original, content-addressed name",
			filename: "photo_89017c29.jpg", w: 1200, h: 800, isPublic: true,
			query: "", wantCode: 200, wantCache: immutableCacheControl,
		},
		{
			name:     "private variant never reaches a shared cache",
			filename: "photo_89017c29.jpg", w: 1200, h: 800, isPublic: false,
			query: "s=256&v=" + current, wantCode: 200, wantCache: "private, no-store",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			repo, storage := newMediaRepo(t)
			visibility := 0
			if tc.isPublic {
				visibility = 1
			}
			insertMedia(t, repo, "2024", "01", tc.filename, visibility)
			if _, err := repo.DB().Exec(`UPDATE media SET file_type='image' WHERE original_path=?`,
				"originals/2024/01/"+tc.filename); err != nil {
				t.Fatal(err)
			}
			writeJPEG(t, storage, "2024", "01", tc.filename, tc.w, tc.h)

			rec := serveQueryRequest(t, storage, repo, "2024", "01", tc.filename, tc.query)
			if rec.Code != tc.wantCode {
				t.Fatalf("code = %d, want %d: %s", rec.Code, tc.wantCode, rec.Body.String())
			}
			if cc := rec.Header().Get("Cache-Control"); cc != tc.wantCache {
				t.Errorf("Cache-Control = %q, want %q", cc, tc.wantCache)
			}
		})
	}
}

// A thumbnail 404 must never inherit the hit TTL. The filename here is
// content-addressed, so under the old ordering — Cache-Control first, variant
// second — this response was pinned as immutable for a year before the 404 was
// even known.
func TestServeSimplifiedMedia_ThumbNotFoundDoesNotInheritImmutable(t *testing.T) {
	repo, storage := newMediaRepo(t)
	ctx := context.Background()
	m, err := repo.CreateMedia(ctx, models.CreateMediaParams{
		Filename:     "clip_89017c29.mp4",
		OriginalPath: "originals/2024/01/clip_89017c29.mp4",
		FileType:     "video",
		MimeType:     "video/mp4",
		Checksum:     "clip-immutable-chk",
		UploadedAt:   time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("CreateMedia: %v", err)
	}
	if _, err := repo.DB().ExecContext(ctx, `UPDATE media SET is_public=1 WHERE id=?`, m.ID); err != nil {
		t.Fatalf("set is_public: %v", err)
	}
	makeMediaFile(t, storage, "2024", "01", "clip_89017c29.mp4")

	rec := serveQueryRequest(t, storage, repo, "2024", "01", "clip_89017c29.mp4", "s=256")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for a posterless video, got %d", rec.Code)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != notFoundCacheControl {
		t.Errorf("Cache-Control = %q, want %q", cc, notFoundCacheControl)
	}
}

func TestServeSimplifiedMedia_OrigServedViaChecksumGlob(t *testing.T) {
	repo, storage := newMediaRepo(t)
	// DB has the record under requested name
	createPublicMedia(t, repo, "2024", "01", "requested_89abcdef.mp4")
	// Put the file on disk under a DIFFERENT name but with same checksum
	dir := filepath.Join(storage, "media", "originals", "2024", "01")
	_ = os.MkdirAll(dir, 0755)
	_ = os.WriteFile(filepath.Join(dir, "actual_89abcdef.mp4"), []byte("video"), 0644)

	rec := serveMediaRequest(t, storage, "", repo, "2024", "01", "requested_89abcdef.mp4", false)
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

// Checksum-named media is content-addressed, so it is cacheable forever;
// non-checksum names keep the short revalidating TTL (asserted above).
// See point-perf-immutable-cache-headers.
func TestServeSimplifiedMedia_ChecksumNamed_ImmutableCacheControl(t *testing.T) {
	repo, storage := newMediaRepo(t)
	createPublicMedia(t, repo, "2024", "01", "photo_89017c29.jpg")
	makeMediaFile(t, storage, "2024", "01", "photo_89017c29.jpg")
	rec := serveMediaRequest(t, storage, "", repo, "2024", "01", "photo_89017c29.jpg", false)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != immutableCacheControl {
		t.Errorf("expected Cache-Control: %q, got %q", immutableCacheControl, cc)
	}
}

// Private media never gets the immutable treatment, even when checksum-named.
func TestServeSimplifiedMedia_ChecksumNamedPrivate_StaysNoStore(t *testing.T) {
	repo, storage := newMediaRepo(t)
	createPrivateMedia(t, repo, "2024", "01", "photo_89017c29.jpg")
	makeMediaFile(t, storage, "2024", "01", "photo_89017c29.jpg")
	rec := serveMediaRequest(t, storage, "", repo, "2024", "01", "photo_89017c29.jpg", true)
	if cc := rec.Header().Get("Cache-Control"); cc != "private, no-store" {
		t.Errorf("expected Cache-Control: private, no-store, got %q", cc)
	}
}

// Serving an SVG must lock the response down independently of the site-wide
// CSP, so a regression in the global policy cannot turn a stored file into
// stored XSS. See point-sec-svg-upload-xss.
func TestServeSimplifiedMedia_SVGIsNeutralized(t *testing.T) {
	repo, storage := newMediaRepo(t)
	createPublicMedia(t, repo, "2024", "01", "logo.svg")
	makeMediaFile(t, storage, "2024", "01", "logo.svg")
	rec := serveMediaRequest(t, storage, "", repo, "2024", "01", "logo.svg", false)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	csp := rec.Header().Get("Content-Security-Policy")
	for _, want := range []string{"default-src 'none'", "sandbox"} {
		if !strings.Contains(csp, want) {
			t.Errorf("SVG response CSP missing %q; got %q", want, csp)
		}
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Error("SVG response is missing nosniff")
	}
}

// Non-SVG media must not pick up the sandbox policy.
func TestServeSimplifiedMedia_NonSVGKeepsGlobalCSP(t *testing.T) {
	repo, storage := newMediaRepo(t)
	createPublicMedia(t, repo, "2024", "01", "photo.jpg")
	makeMediaFile(t, storage, "2024", "01", "photo.jpg")
	rec := serveMediaRequest(t, storage, "", repo, "2024", "01", "photo.jpg", false)
	if csp := rec.Header().Get("Content-Security-Policy"); csp != "" {
		t.Errorf("non-SVG media should not set its own CSP, got %q", csp)
	}
}

// ── S3 Direct serving ──────────────────────────────────────────────────────

func TestServeSimplifiedMedia_S3Direct(t *testing.T) {
	repo, storage := newMediaRepo(t)

	year, month, filename := "2023", "10", "test-s3.jpg"
	createPublicMedia(t, repo, year, month, filename)
	makeMediaFile(t, storage, year, month, filename)

	// Setup Presigner
	s3p, _ := services.NewS3Presigner("http://localhost:9000", "us-east-1", "test", "test", "mybucket")

	handler := serveSimplifiedMedia(storage, "", repo, testMediaSvc(t, repo, storage), s3p, services.NewSettingsService(repo), nil, nil)
	e := echo.New()

	req := httptest.NewRequest(http.MethodGet, "/"+year+"/"+month+"/"+filename, nil)
	req.Header.Set("X-Point-Direct-S3", "1")

	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("year", "month", "filename")
	c.SetParamValues(year, month, filename)

	err := handler(c)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}

	presignedURL := rec.Header().Get("X-S3-Presigned-Url")
	if presignedURL == "" {
		t.Errorf("expected X-S3-Presigned-Url header to be set")
	}
	if !strings.Contains(presignedURL, filename) {
		t.Errorf("presigned URL should contain filename, got %s", presignedURL)
	}
}
