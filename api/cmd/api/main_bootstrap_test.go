package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/services"
)

// inlineBootstrapRe pulls the body out of the injected <script>. The shell's own
// inline scripts are hashed at startup; this one is appended just before
// </head>, so it is the last <script> in the head.
var inlineBootstrapRe = regexp.MustCompile(`(?s)<script>(window\.__PLUGINS__=.*?)</script>`)

// assertBootstrap checks that the served document carries both bootstrap
// assignments in ONE script body and that the CSP names that body's hash.
// One body means one hash, which is what lets every injection site keep its
// existing two-line CSP splice.
func assertBootstrap(t *testing.T, rec *httptest.ResponseRecorder, wantGen string) {
	t.Helper()
	body := rec.Body.String()

	m := inlineBootstrapRe.FindStringSubmatch(body)
	if m == nil {
		t.Fatalf("no bootstrap script in served HTML:\n%s", body)
	}
	script := m[1]
	if !strings.Contains(script, "window.__PLUGINS__=[") {
		t.Errorf("bootstrap script has no __PLUGINS__ manifest: %s", script)
	}
	if !strings.Contains(script, `window.__MEDIA__={"gen":"`+wantGen+`"`) {
		t.Errorf("bootstrap script has no __MEDIA__ with gen %q: %s", wantGen, script)
	}
	// The ladder ships too, so the client picks rungs from the server's list
	// instead of a copy that can drift.
	if !strings.Contains(script, `"sizes":[128,256,512,1024]`) {
		t.Errorf("bootstrap script has no ladder: %s", script)
	}
	if n := strings.Count(body, "window.__MEDIA__="); n != 1 {
		t.Errorf("expected exactly one __MEDIA__ assignment, got %d", n)
	}

	sum := sha256.Sum256([]byte(script))
	want := "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
	csp := rec.Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, want) {
		t.Errorf("CSP does not carry the served script's hash %s:\nCSP: %s", want, csp)
	}
	// Both injection sites splice the bootstrap hash in by string-replacing
	// "script-src" in the enforcing header, which now also carries the Trusted
	// Types directives. A splice that widened its match, or replaced more than
	// the first occurrence, would show up here as a mangled tail.
	if !strings.HasSuffix(csp, "; "+trustedTypesCSP) {
		t.Errorf("script-src splice damaged the trusted-types tail:\nCSP: %s", csp)
	}
	if got := rec.Header().Get("Content-Security-Policy-Report-Only"); got != "" {
		t.Errorf("a Report-Only policy is still being served: %q", got)
	}
}

// Every HTML injection site must ship __MEDIA__: the SPA fallback, the
// per-post crawler prerender, the admin shell, and the media route's
// non-numeric (i.e. SPA) branch. A client that loads on any of them and then
// navigates builds variant URLs for the whole session.
func TestBootstrapScriptOnEveryInjectionSite(t *testing.T) {
	root, _ := writePluginFrontend(t, "immersive")
	cfg := config.Config{AppVersion: "1.0.0", FrontendDir: root}
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = repo.Close() }()
	seedOwner(t, repo)

	ctx := context.Background()
	if _, err := repo.CreatePost(ctx, models.CreatePostParams{
		Title:    "Prerendered",
		Slug:     "prerendered",
		AuthorID: 1,
		Status:   "published",
		Content:  "hello",
	}); err != nil {
		t.Fatal(err)
	}

	svcs := initServices(&cfg, repo)
	e := setupEcho(cfg, repo, svcs)

	sites := map[string]string{
		"SPA fallback":      "/",
		"crawler prerender": "/posts/prerendered",
		"admin shell":       "/light/media",
		"media-route SPA":   "/notayear/nn/thing",
	}
	for name, path := range sites {
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			rec := httptest.NewRecorder()
			e.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("GET %s = %d, want 200", path, rec.Code)
			}
			assertBootstrap(t, rec, services.DefaultThumbnailGeneration)
		})
	}
}

// A rolled token has to reach clients on the very next document: the whole
// point of a rebuild is that every variant URL on the site moves at once. It
// is read through the settings cache, so this also covers that a write
// invalidates it rather than pinning the old token until a restart.
func TestBootstrapScriptTracksRolledGeneration(t *testing.T) {
	root, _ := writePluginFrontend(t, "immersive")
	cfg := config.Config{AppVersion: "1.0.0", FrontendDir: root}
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = repo.Close() }()
	seedOwner(t, repo)

	svcs := initServices(&cfg, repo)
	e := setupEcho(cfg, repo, svcs)

	get := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		return rec
	}

	assertBootstrap(t, get(), services.DefaultThumbnailGeneration)

	ctx := context.Background()
	if err := svcs.Settings.SetSetting(ctx, services.ThumbnailGenerationSetting, "c0ffee01", "string"); err != nil {
		t.Fatal(err)
	}
	assertBootstrap(t, get(), "c0ffee01")

	// Same repo, fresh services and router: the token is persisted, not held in
	// a process-local field, so a restart keeps serving it.
	restarted := initServices(&cfg, repo)
	e2 := setupEcho(cfg, repo, restarted)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	e2.ServeHTTP(rec, req)
	assertBootstrap(t, rec, "c0ffee01")
}

// The token rides into the media URLs the prerender emits as well, so a social
// card fetched after a rebuild is not served the pre-rebuild bytes.
func TestPrerenderOGImageCarriesGeneration(t *testing.T) {
	root, _ := writePluginFrontend(t, "immersive")
	cfg := config.Config{AppVersion: "1.0.0", FrontendDir: root}
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = repo.Close() }()
	seedOwner(t, repo)

	ctx := context.Background()
	svcs := initServices(&cfg, repo)
	if err := svcs.Settings.SetSetting(ctx, services.ThumbnailGenerationSetting, "c0ffee01", "string"); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.CreateMedia(ctx, models.CreateMediaParams{
		Filename:     "shot.jpg",
		OriginalPath: "originals/2024/01/shot.jpg",
		FileType:     "image",
		Checksum:     "abc",
		UploadedAt:   time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.CreatePost(ctx, models.CreatePostParams{
		Title:    "Carded",
		Slug:     "carded",
		AuthorID: 1,
		Status:   "published",
		Content:  "look: /originals/2024/01/shot.jpg",
	}); err != nil {
		t.Fatal(err)
	}

	e := setupEcho(cfg, repo, svcs)
	req := httptest.NewRequest(http.MethodGet, "/posts/carded", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	want := `og:image" content="http://example.com/2024/01/shot.jpg?s=1024&amp;v=c0ffee01"`
	if !strings.Contains(rec.Body.String(), want) {
		t.Errorf("og:image missing %s:\n%s", want, rec.Body.String())
	}
}

// A video with no captured poster has no still behind it. Pointing a card at
// it makes the crawler download the whole stream and render nothing, so it is
// skipped in favour of the next usable media — or of the plain summary card.
func TestPrerenderSkipsPosterlessVideo(t *testing.T) {
	root, _ := writePluginFrontend(t, "immersive")
	cfg := config.Config{AppVersion: "1.0.0", FrontendDir: root}
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = repo.Close() }()
	seedOwner(t, repo)

	ctx := context.Background()
	if _, err := repo.CreateMedia(ctx, models.CreateMediaParams{
		Filename:     "clip.mp4",
		OriginalPath: "originals/2024/01/clip.mp4",
		FileType:     "video",
		Checksum:     "def",
		UploadedAt:   time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.CreatePost(ctx, models.CreatePostParams{
		Title:    "Clip",
		Slug:     "clip",
		AuthorID: 1,
		Status:   "published",
		Content:  "watch: /originals/2024/01/clip.mp4",
	}); err != nil {
		t.Fatal(err)
	}

	svcs := initServices(&cfg, repo)
	e := setupEcho(cfg, repo, svcs)
	req := httptest.NewRequest(http.MethodGet, "/posts/clip", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	body := rec.Body.String()
	if strings.Contains(body, "og:image") {
		t.Errorf("posterless video must not become a card image:\n%s", body)
	}
	if !strings.Contains(body, `twitter:card" content="summary"`) {
		t.Errorf("expected the plain summary card:\n%s", body)
	}

	// Give it a poster and the card comes back.
	m, err := repo.GetMediaByPath(ctx, "originals/2024/01/clip.mp4")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.UpdateMediaFilename(ctx, models.UpdateMediaFilenameParams{
		ID:            m.ID,
		Filename:      m.Filename,
		OriginalPath:  m.OriginalPath,
		ThumbnailPath: sql.NullString{String: "thumbnails/2024/01/clip.jpg", Valid: true},
	}); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/posts/clip", nil))
	if !strings.Contains(rec.Body.String(), "og:image") {
		t.Errorf("a video with a poster should get a card image:\n%s", rec.Body.String())
	}
}
