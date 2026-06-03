package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"point-api/internal/config"

	"github.com/labstack/echo/v4"
)

func TestWebAuthnHandler_Unconfigured(t *testing.T) {
	// Without webauthn configured
	h := NewWebAuthnHandler(nil, nil, &config.Config{})
	e := echo.New()

	tests := []struct {
		name   string
		method string
		path   string
		fn     func(c echo.Context) error
	}{
		{"BeginRegistration", http.MethodPost, "/api/auth/webauthn/register/begin", h.BeginRegistration},
		{"FinishRegistration", http.MethodPost, "/api/auth/webauthn/register/finish", h.FinishRegistration},
		{"BeginLogin", http.MethodPost, "/api/auth/webauthn/login/begin", h.BeginLogin},
		{"FinishLogin", http.MethodPost, "/api/auth/webauthn/login/finish", h.FinishLogin},
		{"DeleteCredential", http.MethodDelete, "/api/auth/webauthn/credential", h.DeleteCredential},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, tt.path, nil)
			rec := httptest.NewRecorder()
			c := e.NewContext(req, rec)

			err := tt.fn(c)
			if err != nil {
				t.Fatalf("expected no error from handler, got %v", err)
			}

			if rec.Code != http.StatusServiceUnavailable {
				t.Errorf("expected status 503, got %d", rec.Code)
			}
		})
	}

	t.Run("GetStatus", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/auth/webauthn/status", nil)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)

		err := h.GetStatus(c)
		if err != nil {
			t.Fatalf("expected no error from handler, got %v", err)
		}

		if rec.Code != http.StatusOK {
			t.Errorf("expected status 200, got %d", rec.Code)
		}
		var resp map[string]interface{}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("json.Unmarshal failed: %v", err)
		}
		if resp["configured"] != false {
			t.Errorf("expected configured to be false")
		}
	})
}
