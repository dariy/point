package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
	"point-api/internal/config"
	"point-api/internal/services"
)

func TestThemeHandler(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	themesDir := t.TempDir()
	validTheme := []byte(`{
		"light": {"colors": {"bg-primary": "#fff"}},
		"dark": {"colors": {"bg-primary": "#000"}}
	}`)
	_ = os.WriteFile(filepath.Join(themesDir, "default.json"), validTheme, 0644)
	_ = os.WriteFile(filepath.Join(themesDir, "custom.json"), validTheme, 0644)

	cfg := &config.Config{ThemesPath: themesDir}
	settingsSvc := services.NewSettingsService(repo)
	themeSvc := services.NewThemeService(cfg, settingsSvc)
	handler := NewThemeHandler(themeSvc)

	e := echo.New()

	t.Run("ListThemes", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/themes", nil)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)

		err := handler.ListThemes(c)
		assert.NoError(t, err)
		assert.Equal(t, http.StatusOK, rec.Code)

		var themes []services.Theme
		_ = json.Unmarshal(rec.Body.Bytes(), &themes)
		assert.Len(t, themes, 2)
	})

	t.Run("ListThemes error", func(t *testing.T) {
		badCfg := &config.Config{ThemesPath: ""}
		badThemeSvc := services.NewThemeService(badCfg, settingsSvc)
		badHandler := NewThemeHandler(badThemeSvc)

		req := httptest.NewRequest(http.MethodGet, "/api/themes", nil)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)

		err := badHandler.ListThemes(c)
		assert.NoError(t, err)
		assert.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("GetActiveTheme", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/themes/active", nil)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)

		err := handler.GetActiveTheme(c)
		assert.NoError(t, err)
		assert.Equal(t, http.StatusOK, rec.Code)

		var theme services.Theme
		_ = json.Unmarshal(rec.Body.Bytes(), &theme)
		assert.Equal(t, "default", theme.Name)
	})

	t.Run("GetActiveTheme error", func(t *testing.T) {
		badCfg := &config.Config{ThemesPath: t.TempDir()}
		badThemeSvc := services.NewThemeService(badCfg, settingsSvc)
		badHandler := NewThemeHandler(badThemeSvc)

		req := httptest.NewRequest(http.MethodGet, "/api/themes/active", nil)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)

		err := badHandler.GetActiveTheme(c)
		assert.NoError(t, err)
		assert.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("SetActiveTheme", func(t *testing.T) {
		body := []byte(`{"name":"custom"}`)
		req := httptest.NewRequest(http.MethodPut, "/api/themes/active", bytes.NewReader(body))
		req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)

		err := handler.SetActiveTheme(c)
		assert.NoError(t, err)
		assert.Equal(t, http.StatusOK, rec.Code)

		// Verify it was set
		req = httptest.NewRequest(http.MethodGet, "/api/themes/active", nil)
		rec = httptest.NewRecorder()
		c = e.NewContext(req, rec)
		_ = handler.GetActiveTheme(c)

		var theme services.Theme
		_ = json.Unmarshal(rec.Body.Bytes(), &theme)
		assert.Equal(t, "custom", theme.Name)
	})

	t.Run("SetActiveTheme missing name", func(t *testing.T) {
		body := []byte(`{}`)
		req := httptest.NewRequest(http.MethodPut, "/api/themes/active", bytes.NewReader(body))
		req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)

		err := handler.SetActiveTheme(c)
		assert.NoError(t, err)
		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("SetActiveTheme invalid json", func(t *testing.T) {
		body := []byte(`{invalid}`)
		req := httptest.NewRequest(http.MethodPut, "/api/themes/active", bytes.NewReader(body))
		req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)

		err := handler.SetActiveTheme(c)
		assert.NoError(t, err)
		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("SetActiveTheme invalid theme", func(t *testing.T) {
		body := []byte(`{"name":"does_not_exist"}`)
		req := httptest.NewRequest(http.MethodPut, "/api/themes/active", bytes.NewReader(body))
		req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)

		err := handler.SetActiveTheme(c)
		assert.NoError(t, err)
		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})
}
