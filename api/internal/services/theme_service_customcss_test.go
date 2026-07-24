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
		_, err := ts.UpdateCustomCSS(ctx, "body { color: red; }")
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

		_, err := badTS.UpdateCustomCSS(ctx, "body {}")
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

		_, err := ts.UpdateCustomCSS(ctx, "body {}")
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

// Global custom CSS used to be written straight to disk with no sanitizing at
// all, while per-post CSS was sanitized. It is now sanitized under the global
// policy: escapes out, admin theming intact.
// See point-sec-custom-css-unsanitized.
func TestThemeService_UpdateCustomCSS_Sanitizes(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	settingsSvc := NewSettingsService(repo)
	themesDir := t.TempDir()
	frontendDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(themesDir, "default.css"), []byte(":root{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	ts := NewThemeService(&config.Config{ThemesPath: themesDir, FrontendDir: frontendDir}, settingsSvc)
	ctx := context.Background()

	warnings, err := ts.UpdateCustomCSS(ctx, `@import url("https://evil.example/x.css");
.header { position: fixed; z-index: 99; }
.hero { background: url(https://evil.example/track.png); }
.badge::after { content: "hi"; }`)
	assert.NoError(t, err)

	stored, err := ts.GetCustomCSS(ctx)
	assert.NoError(t, err)

	// Escapes are gone.
	assert.NotContains(t, stored, "@import")
	assert.NotContains(t, stored, "evil.example")
	assert.Contains(t, warnings, "@import")
	assert.Contains(t, warnings, "url() with external resource")

	// Admin theming of their own site survives — these are exactly what the
	// per-post policy strips, and exactly what a site-wide stylesheet needs.
	assert.Contains(t, stored, "position: fixed")
	assert.Contains(t, stored, "z-index: 99")
	assert.Contains(t, stored, `content: "hi"`)
	assert.NotContains(t, warnings, "z-index")
	assert.NotContains(t, warnings, "position: fixed")

	// The sanitized text, not the original, is what reaches the served file.
	data, _ := os.ReadFile(filepath.Join(frontendDir, "css", "common", "theme.css"))
	assert.NotContains(t, string(data), "evil.example")
}

// The per-post policy must stay strict — the global scope is additive, not a
// relaxation of the existing one.
func TestSanitizePostCSS_StillStrictAfterScoping(t *testing.T) {
	clean, warnings := SanitizePostCSS(`.a { position: fixed; z-index: 5; content: "x"; }`)
	assert.NotContains(t, clean, "position: fixed")
	assert.NotContains(t, clean, "z-index")
	assert.NotContains(t, clean, "content")
	assert.Contains(t, warnings, "position: fixed")
	assert.Contains(t, warnings, "z-index")
	assert.Contains(t, warnings, "content")
}

// A '<' is never valid CSS in either scope; it is a style/script breakout.
func TestSanitizeGlobalCSS_DropsBreakout(t *testing.T) {
	clean, warnings := SanitizeGlobalCSS(`.a { color: red; } < /style><script>alert(1)</script>`)
	assert.NotContains(t, clean, "<")
	assert.Contains(t, warnings, "<script>")
}
