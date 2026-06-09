package services

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"point-api/internal/config"
	"point-api/internal/models"

	"github.com/stretchr/testify/assert"
)

const customCSSTheme = `:root { --bg: #fff; --color: #000; }`

func TestThemeService_GetCustomCSS(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	settingsSvc := NewSettingsService(repo)
	cfg := &config.Config{ThemesPath: t.TempDir()}
	ts := NewThemeService(cfg, settingsSvc)
	ctx := context.Background()

	css, err := ts.GetCustomCSS(ctx)
	assert.NoError(t, err)
	assert.Equal(t, "", css)
}

func TestThemeService_UpdateCustomCSS(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	settingsSvc := NewSettingsService(repo)
	themesDir := t.TempDir()
	frontendDir := t.TempDir()
	_ = os.WriteFile(filepath.Join(themesDir, "default.css"), []byte(customCSSTheme), 0644)

	cfg := &config.Config{ThemesPath: themesDir, FrontendDir: frontendDir}
	ts := NewThemeService(cfg, settingsSvc)
	ctx := context.Background()

	t.Run("stores css and syncs theme file", func(t *testing.T) {
		err := ts.UpdateCustomCSS(ctx, "body { color: red; }")
		assert.NoError(t, err)

		css, err := ts.GetCustomCSS(ctx)
		assert.NoError(t, err)
		assert.Equal(t, "body { color: red; }", css)

		data, _ := os.ReadFile(filepath.Join(frontendDir, "css", "common", "theme.css"))
		assert.Contains(t, string(data), "body { color: red; }")
		assert.Contains(t, string(data), "System Custom CSS")
	})

	t.Run("returns error when sync fails", func(t *testing.T) {
		emptyDir := t.TempDir()
		badCfg := &config.Config{ThemesPath: emptyDir, FrontendDir: t.TempDir()}
		badTS := NewThemeService(badCfg, settingsSvc)

		err := badTS.UpdateCustomCSS(ctx, "body {}")
		assert.Error(t, err)
	})

	t.Run("returns error when SetSetting fails", func(t *testing.T) {
		mockRepo := &mockRepository{
			MockUpdateSetting: func(_ context.Context, arg models.UpdateSettingParams) (models.BlogSetting, error) {
				return models.BlogSetting{}, fmt.Errorf("db write error")
			},
		}
		mockSettingsSvc := NewSettingsService(mockRepo)
		cfg := &config.Config{ThemesPath: themesDir, FrontendDir: frontendDir}
		ts := NewThemeService(cfg, mockSettingsSvc)

		err := ts.UpdateCustomCSS(ctx, "body {}")
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "failed to save custom css setting")
	})
}

func TestThemeService_SyncActiveTheme_WithCustomCSS(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	settingsSvc := NewSettingsService(repo)
	themesDir := t.TempDir()
	frontendDir := t.TempDir()
	_ = os.WriteFile(filepath.Join(themesDir, "default.css"), []byte(customCSSTheme), 0644)

	cfg := &config.Config{ThemesPath: themesDir, FrontendDir: frontendDir}
	ts := NewThemeService(cfg, settingsSvc)
	ctx := context.Background()

	_ = settingsSvc.SetSetting(ctx, "system_custom_css", "body { background: blue; }", "string")

	err := ts.SyncActiveTheme(ctx)
	assert.NoError(t, err)

	data, _ := os.ReadFile(filepath.Join(frontendDir, "css", "common", "theme.css"))
	assert.Contains(t, string(data), customCSSTheme)
	assert.Contains(t, string(data), "System Custom CSS")
	assert.Contains(t, string(data), "body { background: blue; }")
}

func TestThemeService_SetActiveTheme_Normalization(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	settingsSvc := NewSettingsService(repo)
	themesDir := t.TempDir()
	frontendDir := t.TempDir()
	_ = os.WriteFile(filepath.Join(themesDir, "custom.css"), []byte(customCSSTheme), 0644)
	_ = os.WriteFile(filepath.Join(themesDir, "default.css"), []byte(customCSSTheme), 0644)

	cfg := &config.Config{ThemesPath: themesDir, FrontendDir: frontendDir}
	ts := NewThemeService(cfg, settingsSvc)
	ctx := context.Background()

	t.Run("normalizes uppercase and trims spaces", func(t *testing.T) {
		theme, err := ts.SetActiveTheme(ctx, "  Custom  ")
		assert.NoError(t, err)
		assert.Equal(t, "custom", theme.Name)
	})

	t.Run("rejects empty name", func(t *testing.T) {
		_, err := ts.SetActiveTheme(ctx, "")
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "theme name is required")
	})

	t.Run("rejects path traversal", func(t *testing.T) {
		_, err := ts.SetActiveTheme(ctx, "../malicious")
		assert.Error(t, err)
	})

	t.Run("rejects nonexistent theme", func(t *testing.T) {
		_, err := ts.SetActiveTheme(ctx, "nonexistent")
		assert.Error(t, err)
	})
}
