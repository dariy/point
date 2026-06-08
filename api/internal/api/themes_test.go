package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"point-api/internal/config"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
)

const testThemeCSS = `:root { --bg-primary: #fff; --color-primary: #000; }`

func TestThemeHandler(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	themesDir := t.TempDir()
	frontendDir := t.TempDir()
	_ = os.WriteFile(filepath.Join(themesDir, "default.css"), []byte(testThemeCSS), 0644)
	_ = os.WriteFile(filepath.Join(themesDir, "custom.css"), []byte(testThemeCSS), 0644)

	cfg := &config.Config{ThemesPath: themesDir, FrontendDir: frontendDir}
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

		var theme services.Theme
		_ = json.Unmarshal(rec.Body.Bytes(), &theme)
		assert.Equal(t, "custom", theme.Name)

		// Verify it was set in DB too
		req = httptest.NewRequest(http.MethodGet, "/api/themes/active", nil)
		rec = httptest.NewRecorder()
		c = e.NewContext(req, rec)
		_ = handler.GetActiveTheme(c)

		var activeTheme services.Theme
		_ = json.Unmarshal(rec.Body.Bytes(), &activeTheme)
		assert.Equal(t, "custom", activeTheme.Name)
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

	t.Run("CustomCSS", func(t *testing.T) {
		// 1. Get initial (empty)
		req := httptest.NewRequest(http.MethodGet, "/api/themes/custom-css", nil)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		err := handler.GetCustomCSS(c)
		assert.NoError(t, err)
		assert.Equal(t, http.StatusOK, rec.Code)
		var res map[string]string
		_ = json.Unmarshal(rec.Body.Bytes(), &res)
		assert.Equal(t, "", res["css"])

		// 2. Update
		body := []byte(`{"css":"body { background: red; }"}`)
		req = httptest.NewRequest(http.MethodPut, "/api/themes/custom-css", bytes.NewReader(body))
		req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
		rec = httptest.NewRecorder()
		c = e.NewContext(req, rec)
		err = handler.UpdateCustomCSS(c)
		assert.NoError(t, err)
		assert.Equal(t, http.StatusNoContent, rec.Code)

		// 3. Get updated
		req = httptest.NewRequest(http.MethodGet, "/api/themes/custom-css", nil)
		rec = httptest.NewRecorder()
		c = e.NewContext(req, rec)
		_ = handler.GetCustomCSS(c)
		_ = json.Unmarshal(rec.Body.Bytes(), &res)
		assert.Equal(t, "body { background: red; }", res["css"])

		// 4. Verify file sync
		publicThemePath := filepath.Join(frontendDir, "css", "common", "theme.css")
		data, _ := os.ReadFile(publicThemePath)
		assert.Contains(t, string(data), "body { background: red; }")
		assert.Contains(t, string(data), "System Custom CSS")
	})

	t.Run("UpdateCustomCSS bind error", func(t *testing.T) {
		body := []byte(`{invalid json}`)
		req := httptest.NewRequest(http.MethodPut, "/api/themes/custom-css", bytes.NewReader(body))
		req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)

		err := handler.UpdateCustomCSS(c)
		assert.NoError(t, err)
		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("UpdateCustomCSS service error", func(t *testing.T) {
		emptyDir := t.TempDir()
		badCfg := &config.Config{ThemesPath: emptyDir, FrontendDir: t.TempDir()}
		badThemeSvc := services.NewThemeService(badCfg, settingsSvc)
		badHandler := NewThemeHandler(badThemeSvc)

		body := []byte(`{"css":"body { color: red; }"}`)
		req := httptest.NewRequest(http.MethodPut, "/api/themes/custom-css", bytes.NewReader(body))
		req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)

		err := badHandler.UpdateCustomCSS(c)
		assert.NoError(t, err)
		assert.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}
