package services

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"point-api/internal/config"
)

func TestThemeService(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	settingsService := NewSettingsService(repo)

	themesDir := t.TempDir()
	cfg := &config.Config{
		ThemesPath: themesDir,
	}

	themeService := NewThemeService(cfg, settingsService)
	ctx := context.Background()

	validTheme := []byte(`{
		"light": {"colors": {"bg-primary": "#fff"}},
		"dark": {"colors": {"bg-primary": "#000"}}
	}`)
	err := os.WriteFile(filepath.Join(themesDir, "valid.json"), validTheme, 0644)
	assert.NoError(t, err)

	invalidTheme := []byte(`{ "invalid": "json" `)
	err = os.WriteFile(filepath.Join(themesDir, "invalid.json"), invalidTheme, 0644)
	assert.NoError(t, err)

	missingTheme := []byte(`{ "shared": {} }`)
	err = os.WriteFile(filepath.Join(themesDir, "missing.json"), missingTheme, 0644)
	assert.NoError(t, err)

	err = os.WriteFile(filepath.Join(themesDir, "not-a-theme.txt"), []byte("text"), 0644)
	assert.NoError(t, err)

	t.Run("ListThemes", func(t *testing.T) {
		themes, err := themeService.ListThemes()
		assert.NoError(t, err)
		assert.Len(t, themes, 1)
		assert.Equal(t, "valid", themes[0].Name)
	})

	t.Run("GetActiveTheme fallback", func(t *testing.T) {
		err = os.WriteFile(filepath.Join(themesDir, "default.json"), validTheme, 0644)
		assert.NoError(t, err)

		theme, err := themeService.GetActiveTheme(ctx)
		assert.NoError(t, err)
		assert.Equal(t, "default", theme.Name)
	})

	t.Run("SetActiveTheme success", func(t *testing.T) {
		frontendDir := t.TempDir()
		themeService.cfg.FrontendDir = frontendDir

		err := themeService.SetActiveTheme(ctx, "valid")
		assert.NoError(t, err)

		theme, err := themeService.GetActiveTheme(ctx)
		assert.NoError(t, err)
		assert.Equal(t, "valid", theme.Name)

		// Verify theme.json sync
		publicThemePath := filepath.Join(frontendDir, "images", "theme.json")
		data, err := os.ReadFile(publicThemePath)
		assert.NoError(t, err)
		assert.JSONEq(t, string(validTheme), string(data))
	})

	t.Run("SetActiveTheme invalid", func(t *testing.T) {
		err := themeService.SetActiveTheme(ctx, "invalid")
		assert.Error(t, err)
	})

	t.Run("ListThemes missing path", func(t *testing.T) {
		emptyCfg := &config.Config{ThemesPath: ""}
		ts := NewThemeService(emptyCfg, settingsService)
		_, err := ts.ListThemes()
		assert.Error(t, err)
	})

	t.Run("GetActiveTheme with no defaults", func(t *testing.T) {
		emptyCfg := &config.Config{ThemesPath: t.TempDir()}
		ts := NewThemeService(emptyCfg, settingsService)
		_, err := ts.GetActiveTheme(ctx)
		assert.Error(t, err)
	})

	t.Run("ReadAndValidateTheme missing file", func(t *testing.T) {
		_, err := themeService.ReadAndValidateTheme(filepath.Join(themesDir, "non_existent.json"), "non_existent")
		assert.Error(t, err)
	})
}
