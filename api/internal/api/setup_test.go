package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
)

func TestSetupHandler_Validation(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	e := echo.New()

	setupH := NewSetupHandler(h.authSvc, h.settingsSvc, h.repo)

	insertUser(h.repo)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	if err := setupH.SetupStatus(e.NewContext(req, rec)); err != nil {
		t.Fatalf("SetupStatus: %v", err)
	}
	if !strings.Contains(rec.Body.String(), "true") {
		t.Errorf("expected setup_complete:true, got %s", rec.Body.String())
	}
}

func TestSetupHandler_SetupValidation(t *testing.T) {
	e := echo.New()

	t.Run("MissingFields", func(t *testing.T) {
		h := setupHandlers(t)
		defer h.close()
		setupH := NewSetupHandler(h.authSvc, h.settingsSvc, h.repo)
		c, rec := echoCtx(http.MethodPost, "/", `{}`)
		if err := setupH.Setup(c); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if rec.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d", rec.Code)
		}
	})

	t.Run("ShortPassword", func(t *testing.T) {
		h := setupHandlers(t)
		defer h.close()
		setupH := NewSetupHandler(h.authSvc, h.settingsSvc, h.repo)
		body := `{"username":"u","name":"abc","blog_title":"T","author_name":"A"}`
		c, rec := echoCtx(http.MethodPost, "/", body)
		if err := setupH.Setup(c); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if rec.Code != http.StatusBadRequest {
			t.Errorf("expected 400 for short password, got %d", rec.Code)
		}
	})

	t.Run("AlreadySetup", func(t *testing.T) {
		h := setupHandlers(t)
		defer h.close()
		insertUser(h.repo)
		setupH := NewSetupHandler(h.authSvc, h.settingsSvc, h.repo)
		body := `{"username":"u","name":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08","blog_title":"T","author_name":"A"}`
		c, rec := echoCtx(http.MethodPost, "/", body)
		if err := setupH.Setup(c); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if rec.Code != http.StatusConflict {
			t.Errorf("expected 409 conflict, got %d", rec.Code)
		}
	})

	t.Run("CreateUserDBError", func(t *testing.T) {
		h := setupHandlers(t)
		setupH := NewSetupHandler(h.authSvc, h.settingsSvc, h.repo)
		_ = h.repo.Close()
		body := `{"username":"u","name":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08","blog_title":"T","author_name":"A"}`
		c, rec := echoCtx(http.MethodPost, "/", body)
		if err := setupH.Setup(c); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if rec.Code != http.StatusInternalServerError {
			t.Errorf("expected 500, got %d: %s", rec.Code, rec.Body.String())
		}
	})
	_ = e
}
func TestSetup_BindError(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	sh := NewSetupHandler(h.authSvc, h.settingsSvc, h.repo)
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("{notjson}"))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	err := sh.Setup(e.NewContext(req, rec))
	if err != nil {
		t.Fatalf("unexpected handler error: %v", err)
	}
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestSetup_InvalidPasswordFormat(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	sh := NewSetupHandler(h.authSvc, h.settingsSvc, h.repo)
	body := `{"username":"u","name":"tooshort","blog_title":"T","author_name":"A"}`
	c, rec := echoCtx(http.MethodPost, "/", body)
	if err := sh.Setup(c); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid password format, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestSetup_SeedSettingsError(t *testing.T) {
	h := setupHandlers(t)
	_, _ = h.repo.DB().Exec(`DROP TABLE blog_settings`)
	sh := NewSetupHandler(h.authSvc, h.settingsSvc, h.repo)
	body := `{"username":"seeduser","name":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08","blog_title":"T","author_name":"A"}`
	c, rec := echoCtx(http.MethodPost, "/", body)
	if err := sh.Setup(c); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 for seed error, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestSetupStatus_UserExists(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	insertUser(h.repo)
	sh := NewSetupHandler(h.authSvc, h.settingsSvc, h.repo)
	c, rec := echoCtx(http.MethodGet, "/setup/status", "")
	if err := sh.SetupStatus(c); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(rec.Body.String(), "true") {
		t.Error("expected setup_complete: true")
	}
}

func TestSetup_Success(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	sh := NewSetupHandler(h.authSvc, h.settingsSvc, h.repo)
	body := `{"username":"newuser","name":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08","blog_title":"My Blog","author_name":"Author"}`
	c, rec := echoCtx(http.MethodPost, "/setup", body)
	if err := sh.Setup(c); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestSetupStatus_NoUser(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	sh := NewSetupHandler(h.authSvc, h.settingsSvc, h.repo)
	c, rec := echoCtx(http.MethodGet, "/setup/status", "")
	if err := sh.SetupStatus(c); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(rec.Body.String(), "false") {
		t.Errorf("expected setup_complete: false, got: %s", rec.Body.String())
	}
}
