package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"point-api/internal/plugins"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

func TestMiddleware_ExtractIDNil(t *testing.T) {
	if id := extractUserID(nil); id != 0 {
		t.Errorf("expected 0, got %d", id)
	}
	if id := extractSessionID(nil); id != 0 {
		t.Errorf("expected 0, got %d", id)
	}
}

func TestRequirePlugin(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	svc := services.NewSettingsService(repo)
	e := echo.New()
	hit := false
	handler := func(c echo.Context) error {
		hit = true
		return c.NoContent(http.StatusOK)
	}

	call := func(id string) int {
		hit = false
		req := httptest.NewRequest(http.MethodGet, "/api/instagram", nil)
		rec := httptest.NewRecorder()
		mw := RequirePlugin(svc, id)
		err := mw(handler)(e.NewContext(req, rec))
		if err != nil {
			e.HTTPErrorHandler(err, e.NewContext(req, rec))
			if he, ok := err.(*echo.HTTPError); ok {
				return he.Code
			}
			return http.StatusInternalServerError
		}
		return rec.Code
	}

	// Absent key → DefaultEnabled (true) → passes through.
	if code := call("instagram"); code != http.StatusOK || !hit {
		t.Errorf("enabled-by-default plugin should pass: code=%d hit=%v", code, hit)
	}

	// Explicitly disabled → 404, inner handler not reached.
	if err := svc.SetSetting(ctx, plugins.EnabledKey("instagram"), "false", "boolean"); err != nil {
		t.Fatal(err)
	}
	if code := call("instagram"); code != http.StatusNotFound || hit {
		t.Errorf("disabled plugin should 404 without reaching handler: code=%d hit=%v", code, hit)
	}

	// Re-enabled → passes again.
	if err := svc.SetSetting(ctx, plugins.EnabledKey("instagram"), "true", "boolean"); err != nil {
		t.Fatal(err)
	}
	if code := call("instagram"); code != http.StatusOK || !hit {
		t.Errorf("re-enabled plugin should pass: code=%d hit=%v", code, hit)
	}
}
