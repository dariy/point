package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

func newNavMenuHandler(t *testing.T) *NavMenuHandler {
	t.Helper()
	repo := setupTestDB(t)
	return NewNavMenuHandler(services.NewSettingsService(repo), services.NewTagService(repo))
}

// getNavMore drives GetAdminNavMenu and returns the more_title field.
func getNavMore(t *testing.T, h *NavMenuHandler) string {
	t.Helper()
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/nav-menu", nil)
	rec := httptest.NewRecorder()
	if err := h.GetAdminNavMenu(e.NewContext(req, rec)); err != nil {
		t.Fatalf("GetAdminNavMenu: %v", err)
	}
	var resp map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal GET response: %v", err)
	}
	title, _ := resp["more_title"].(string)
	return title
}

// putNavMore drives UpdateAdminNavMenu with the given more_title and returns the
// echoed value from the response body.
func putNavMore(t *testing.T, h *NavMenuHandler, moreTitle string) string {
	t.Helper()
	e := echo.New()
	body, _ := json.Marshal(map[string]interface{}{"mode": "tags", "more_title": moreTitle})
	req := httptest.NewRequest(http.MethodPut, "/api/nav-menu", strings.NewReader(string(body)))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	if err := h.UpdateAdminNavMenu(e.NewContext(req, rec)); err != nil {
		t.Fatalf("UpdateAdminNavMenu: %v", err)
	}
	var resp map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal PUT response: %v", err)
	}
	title, _ := resp["more_title"].(string)
	return title
}

func TestNavMenuHandler_MoreTitle(t *testing.T) {
	h := newNavMenuHandler(t)

	// Unset: GetAdminNavMenu falls back to the "More" default.
	if got := getNavMore(t, h); got != "More" {
		t.Errorf("default more_title: expected %q, got %q", "More", got)
	}

	// A custom title is persisted and echoed back, and a subsequent GET reads it.
	if got := putNavMore(t, h, "Menu"); got != "Menu" {
		t.Errorf("PUT more_title: response expected %q, got %q", "Menu", got)
	}
	if got := getNavMore(t, h); got != "Menu" {
		t.Errorf("persisted more_title: expected %q, got %q", "Menu", got)
	}

	// An empty more_title falls back to "More" rather than storing a blank label.
	if got := putNavMore(t, h, ""); got != "More" {
		t.Errorf("empty more_title: response expected %q, got %q", "More", got)
	}
	if got := getNavMore(t, h); got != "More" {
		t.Errorf("empty more_title should persist default: expected %q, got %q", "More", got)
	}
}
