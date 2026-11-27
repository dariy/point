package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"

	"point-api/internal/services"
)

func TestSystemHandler_HealthChecks(t *testing.T) {
	h, cleanup := setupSystemHandler(t)
	defer cleanup()
	e := echo.New()

	// Without a SiteHealth the endpoints say so.
	rec := httptest.NewRecorder()
	err := h.GetHealthChecks(e.NewContext(httptest.NewRequest(http.MethodGet, "/", nil), rec))
	var he *echo.HTTPError
	if !errors.As(err, &he) || he.Code != http.StatusNotFound {
		t.Fatalf("GetHealthChecks without SiteHealth: err = %v, want 404", err)
	}

	h = h.WithSiteHealth(services.NewSiteHealth(h.mediaService, h.systemService, h.settingsService))
	for name, call := range map[string]echo.HandlerFunc{"GET": h.GetHealthChecks, "POST": h.RefreshHealthChecks} {
		rec := httptest.NewRecorder()
		if err := call(e.NewContext(httptest.NewRequest(name, "/", nil), rec)); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d, want 200", name, rec.Code)
		}
		var r services.SiteHealthReport
		if err := json.Unmarshal(rec.Body.Bytes(), &r); err != nil {
			t.Fatalf("%s: decode: %v", name, err)
		}
		keys := map[string]bool{}
		for _, it := range r.Items {
			keys[it.Key] = true
		}
		for _, k := range []string{services.HealthItemDerivatives, services.HealthItemOriginals, services.HealthItemReferences, services.HealthItemBackup, services.HealthItemRestoreCheck, services.HealthItemStorage} {
			if !keys[k] {
				t.Errorf("%s: report has no %q item", name, k)
			}
		}
		if r.CheckedAt.IsZero() {
			t.Errorf("%s: report has no checked_at", name)
		}
	}
}
