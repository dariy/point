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

func TestCommentsAdminHandler(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()
	svc := services.NewSettingsService(repo)
	if err := svc.SetSetting(ctx, plugins.EnabledKey("comments"), "true", "boolean"); err != nil {
		t.Fatal(err)
	}

	// Fake remark42 admin API recording what reaches it.
	var gotMethod, gotPath, gotUser, gotPass string
	var gotQuery url.Values
	hits := 0
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		gotMethod, gotPath, gotQuery = r.Method, r.URL.Path, r.URL.Query()
		gotUser, gotPass, _ = r.BasicAuth()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[]`))
	}))
	defer backend.Close()
	target, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}

	e := echo.New()
	h := NewCommentsAdminHandler(target, "hunter2")
	gate := RequirePlugin(svc, "comments")
	g := e.Group("/api/admin/comments", gate)
	g.GET("/recent", h.Recent)
	g.GET("/blocked", h.Blocked)
	g.DELETE("/comment/:id", h.DeleteComment)
	g.PUT("/user/:id/block", h.SetBlock)

	call := func(method, path string) int {
		req := httptest.NewRequest(method, path, nil)
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		return rec.Code
	}

	// Recent: default limit 50, site=remark, basic auth forwarded.
	if code := call(http.MethodGet, "/api/admin/comments/recent"); code != http.StatusOK {
		t.Fatalf("recent: want 200, got %d", code)
	}
	if gotMethod != http.MethodGet || gotPath != "/api/v1/last/50" || gotQuery.Get("site") != "remark" {
		t.Errorf("recent forwarded wrong: %s %s %v", gotMethod, gotPath, gotQuery)
	}
	if gotUser != "admin" || gotPass != "hunter2" {
		t.Errorf("basic auth not forwarded: %s:%s", gotUser, gotPass)
	}

	// Recent: non-numeric limit rejected before reaching the backend.
	prev := hits
	if code := call(http.MethodGet, "/api/admin/comments/recent?limit=abc"); code != http.StatusBadRequest || hits != prev {
		t.Errorf("bad limit: want 400 and no hit, got %d hits=%d", code, hits)
	}

	// Delete: url required; forwarded with site+url.
	if code := call(http.MethodDelete, "/api/admin/comments/comment/c1"); code != http.StatusBadRequest {
		t.Errorf("delete without url: want 400, got %d", code)
	}
	if code := call(http.MethodDelete, "/api/admin/comments/comment/c1?url=https%3A%2F%2Fblog%2Fposts%2Fx"); code != http.StatusOK {
		t.Errorf("delete: want 200, got %d", code)
	}
	if gotMethod != http.MethodDelete || gotPath != "/api/v1/admin/comment/c1" ||
		gotQuery.Get("url") != "https://blog/posts/x" || gotQuery.Get("site") != "remark" {
		t.Errorf("delete forwarded wrong: %s %s %v", gotMethod, gotPath, gotQuery)
	}

	// Block: validates block/ttl, forwards both.
	if code := call(http.MethodPut, "/api/admin/comments/user/u1/block?block=2"); code != http.StatusBadRequest {
		t.Errorf("bad block: want 400, got %d", code)
	}
	if code := call(http.MethodPut, "/api/admin/comments/user/u1/block?block=1&ttl=nope"); code != http.StatusBadRequest {
		t.Errorf("bad ttl: want 400, got %d", code)
	}
	if code := call(http.MethodPut, "/api/admin/comments/user/u1/block?block=1&ttl=24h"); code != http.StatusOK {
		t.Errorf("block: want 200, got %d", code)
	}
	if gotMethod != http.MethodPut || gotPath != "/api/v1/admin/user/u1" ||
		gotQuery.Get("block") != "1" || gotQuery.Get("ttl") != "24h" {
		t.Errorf("block forwarded wrong: %s %s %v", gotMethod, gotPath, gotQuery)
	}

	// Blocked list.
	if code := call(http.MethodGet, "/api/admin/comments/blocked"); code != http.StatusOK {
		t.Fatalf("blocked: want 200, got %d", code)
	}
	if gotPath != "/api/v1/admin/blocked" || gotQuery.Get("site") != "remark" {
		t.Errorf("blocked forwarded wrong: %s %v", gotPath, gotQuery)
	}

	// No ADMIN_PASSWD → 503, backend untouched.
	noPass := echo.New()
	h2 := NewCommentsAdminHandler(target, "")
	noPass.GET("/api/admin/comments/recent", h2.Recent)
	prev = hits
	req := httptest.NewRequest(http.MethodGet, "/api/admin/comments/recent", nil)
	rec := httptest.NewRecorder()
	noPass.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable || hits != prev {
		t.Errorf("no passwd: want 503 and no hit, got %d hits=%d", rec.Code, hits)
	}

	// Plugin disabled → 404 before any forwarding.
	if err := svc.SetSetting(ctx, plugins.EnabledKey("comments"), "false", "boolean"); err != nil {
		t.Fatal(err)
	}
	prev = hits
	if code := call(http.MethodGet, "/api/admin/comments/recent"); code != http.StatusNotFound || hits != prev {
		t.Errorf("disabled plugin: want 404 and no hit, got %d hits=%d", code, hits)
	}
}
