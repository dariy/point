//go:build integration

package services

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"point-api/internal/config"

	"github.com/stretchr/testify/assert"
)

const validThemeCSS = `/* theme-title: "Valid" */
/* description: "A valid test theme." */
/* preview-color: "#123456" */
:root {
  --bg-primary: #ffffff;
  --color-primary: #123456;
}`

const minimalThemeCSS = `:root { --bg-primary: #fff; }`

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

	err := os.WriteFile(filepath.Join(themesDir, "valid.css"), []byte(validThemeCSS), 0644)
	assert.NoError(t, err)

	err = os.WriteFile(filepath.Join(themesDir, "no-root.css"), []byte(`.hero { color: red; }`), 0644)
	assert.NoError(t, err)

	err = os.WriteFile(filepath.Join(themesDir, "not-a-theme.txt"), []byte("text"), 0644)
	assert.NoError(t, err)

	t.Run("ListThemes", func(t *testing.T) {
		themes, err := themeService.ListThemes()
		assert.NoError(t, err)
		assert.Len(t, themes, 1)
		assert.Equal(t, "Valid", themes[0].Name)
		assert.Equal(t, "#123456", themes[0].PreviewColor)
		assert.Equal(t, "A valid test theme.", themes[0].Description)
	})

	t.Run("GetActiveTheme fallback", func(t *testing.T) {
		err = os.WriteFile(filepath.Join(themesDir, "default.css"), []byte(validThemeCSS), 0644)
		assert.NoError(t, err)

		theme, err := themeService.GetActiveTheme(ctx)
		assert.NoError(t, err)
		assert.Equal(t, filepath.Join(themesDir, "default.css"), theme.Path)
	})

	t.Run("SetActiveTheme success", func(t *testing.T) {
		frontendDir := t.TempDir()
		themeService.cfg.FrontendDir = frontendDir

		theme, err := themeService.SetActiveTheme(ctx, "valid")
		assert.NoError(t, err)
		assert.Equal(t, "Valid", theme.Name)

		theme, err = themeService.GetActiveTheme(ctx)
		assert.NoError(t, err)
		assert.Equal(t, "Valid", theme.Name)

		// Verify theme.css sync to <FrontendDir>/css/theme.css
		publicThemePath := filepath.Join(frontendDir, "css", "theme.css")
		data, err := os.ReadFile(publicThemePath)
		assert.NoError(t, err)
		assert.Equal(t, validThemeCSS, string(data))
	})

	t.Run("SetActiveTheme invalid", func(t *testing.T) {
		_, err := themeService.SetActiveTheme(ctx, "no-root")
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
		_, err := themeService.ReadAndValidateTheme(filepath.Join(themesDir, "non_existent.css"), "non_existent")
		assert.Error(t, err)
	})

	t.Run("ReadAndValidateTheme no :root block", func(t *testing.T) {
		_, err := themeService.ReadAndValidateTheme(filepath.Join(themesDir, "no-root.css"), "no-root")
		assert.Error(t, err)
	})
}

func TestThemeServiceUserThemes(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	settingsService := NewSettingsService(repo)
	ctx := context.Background()

	systemDir := t.TempDir()
	userDir := t.TempDir()

	userThemeCSS := `/* theme-title: "shared" */
:root { --bg-primary: #123; }`

	// System has "system-only" and "shared"; user has "user-only" and "shared" (override)
	assert.NoError(t, os.WriteFile(filepath.Join(systemDir, "system-only.css"), []byte(minimalThemeCSS), 0644))
	assert.NoError(t, os.WriteFile(filepath.Join(systemDir, "shared.css"), []byte(minimalThemeCSS), 0644))
	assert.NoError(t, os.WriteFile(filepath.Join(userDir, "user-only.css"), []byte(minimalThemeCSS), 0644))
	assert.NoError(t, os.WriteFile(filepath.Join(userDir, "shared.css"), []byte(userThemeCSS), 0644))

	cfg := &config.Config{ThemesPath: systemDir, UserThemesPath: userDir}
	ts := NewThemeService(cfg, settingsService)

	t.Run("ListThemes merges both dirs, user overrides system", func(t *testing.T) {
		themes, err := ts.ListThemes()
		assert.NoError(t, err)
		assert.Len(t, themes, 3)

		byName := make(map[string]Theme)
		for _, th := range themes {
			byName[th.Name] = th
		}
		assert.Contains(t, byName, "system-only")
		assert.Contains(t, byName, "user-only")
		assert.Contains(t, byName, "shared")
		// "shared" should come from user dir
		assert.Equal(t, filepath.Join(userDir, "shared.css"), byName["shared"].Path)
	})

	t.Run("GetActiveTheme prefers user theme", func(t *testing.T) {
		assert.NoError(t, os.WriteFile(filepath.Join(userDir, "default.css"), []byte(minimalThemeCSS), 0644))
		theme, err := ts.GetActiveTheme(ctx)
		assert.NoError(t, err)
		assert.Equal(t, filepath.Join(userDir, "default.css"), theme.Path)
	})

	t.Run("SetActiveTheme finds user theme", func(t *testing.T) {
		frontendDir := t.TempDir()
		ts.cfg.FrontendDir = frontendDir

		_, err := ts.SetActiveTheme(ctx, "user-only")
		assert.NoError(t, err)

		theme, err := ts.GetActiveTheme(ctx)
		assert.NoError(t, err)
		assert.Equal(t, "user-only", theme.Name)
	})

	t.Run("SetActiveTheme finds system theme", func(t *testing.T) {
		frontendDir := t.TempDir()
		ts.cfg.FrontendDir = frontendDir

		_, err := ts.SetActiveTheme(ctx, "system-only")
		assert.NoError(t, err)

		theme, err := ts.GetActiveTheme(ctx)
		assert.NoError(t, err)
		assert.Equal(t, "system-only", theme.Name)
	})

	t.Run("findTheme is case-insensitive (lowercases input)", func(t *testing.T) {
		// systemDir has system-only.css
		theme, err := ts.findTheme("System-Only")
		assert.NoError(t, err)
		assert.Equal(t, "system-only", theme.Name)
	})

	t.Run("ListThemes nonexistent user dir is silently ignored", func(t *testing.T) {
		cfg2 := &config.Config{ThemesPath: systemDir, UserThemesPath: "/nonexistent/path"}
		ts2 := NewThemeService(cfg2, settingsService)
		themes, err := ts2.ListThemes()
		assert.NoError(t, err)
		assert.Len(t, themes, 2) // system-only + shared
	})
}

func TestThemeService_SyncActiveTheme_NoThemes(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	cfg := &config.Config{ThemesPath: t.TempDir(), FrontendDir: t.TempDir()}
	ts := NewThemeService(cfg, NewSettingsService(repo))

	err := ts.SyncActiveTheme(t.Context())
	if err == nil {
		t.Error("expected error when no themes available")
	}
	if !strings.Contains(err.Error(), "failed to get active theme") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestThemeService_SyncActiveTheme_ReadOnlyFrontendDir(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	themesDir := t.TempDir()
	frontendDir := t.TempDir()
	cfg := &config.Config{ThemesPath: themesDir, FrontendDir: frontendDir}
	ts := NewThemeService(cfg, NewSettingsService(repo))

	themeContent := `:root { --bg: #fff; }`
	_ = os.WriteFile(filepath.Join(themesDir, "default.css"), []byte(themeContent), 0644)

	cssDir := filepath.Join(frontendDir, "css")
	_ = os.WriteFile(cssDir, []byte("not a dir"), 0644)

	err := ts.SyncActiveTheme(t.Context())
	if err == nil {
		t.Error("expected error when css dir blocked by file")
	}
}
