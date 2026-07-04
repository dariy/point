package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"point-api/internal/plugins"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

func TestCommentsProxy(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()
	svc := services.NewSettingsService(repo)

	// Fake remark42 backend recording what reaches it.
	var gotPath, gotAuth, gotJWT string
	hits := 0
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotJWT = r.Header.Get("X-JWT")
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()
	target, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}

	e := echo.New()
	RegisterCommentsProxy(e, svc, target)

	call := func(path string, hdr map[string]string) int {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		return rec.Code
	}

	// Disabled by default → 404, backend never reached.
	if code := call("/comments/web/embed.mjs", nil); code != http.StatusNotFound || hits != 0 {
		t.Errorf("disabled plugin: want 404 and no backend hit, got code=%d hits=%d", code, hits)
	}

	if err := svc.SetSetting(ctx, plugins.EnabledKey("comments"), "true", "boolean"); err != nil {
		t.Fatal(err)
	}

	// Enabled → proxied with /comments prefix stripped.
	if code := call("/comments/web/embed.mjs", nil); code != http.StatusOK || hits != 1 {
		t.Errorf("enabled plugin: want 200 and backend hit, got code=%d hits=%d", code, hits)
	}
	if gotPath != "/web/embed.mjs" {
		t.Errorf("prefix not stripped: backend saw %q", gotPath)
	}

	// Basic auth is stripped (blocks brute-forcing remark42 admin basic auth
	// from outside); X-JWT (widget auth) passes through.
	call("/comments/api/v1/admin/blocked", map[string]string{
		"Authorization": "Basic YWRtaW46aHVudGVyMg==",
		"X-JWT":         "widget-jwt",
	})
	if gotAuth != "" {
		t.Errorf("Basic Authorization header should be stripped, backend saw %q", gotAuth)
	}
	if gotJWT != "widget-jwt" {
		t.Errorf("X-JWT should pass through, backend saw %q", gotJWT)
	}
	if gotPath != "/api/v1/admin/blocked" {
		t.Errorf("admin path not proxied correctly: backend saw %q", gotPath)
	}

	// Non-Basic Authorization (e.g. Bearer) passes through untouched.
	call("/comments/api/v1/user", map[string]string{"Authorization": "Bearer tok"})
	if gotAuth != "Bearer tok" {
		t.Errorf("non-Basic Authorization should pass through, backend saw %q", gotAuth)
	}

	// Disabled again → 404 and no new backend hits.
	if err := svc.SetSetting(ctx, plugins.EnabledKey("comments"), "false", "boolean"); err != nil {
		t.Fatal(err)
	}
	prev := hits
	if code := call("/comments/web/embed.mjs", nil); code != http.StatusNotFound || hits != prev {
		t.Errorf("re-disabled plugin: want 404 and no backend hit, got code=%d hits=%d (was %d)", code, hits, prev)
	}
}
