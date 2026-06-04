package services

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"point-api/internal/config"
)

func TestThemeService_PathTraversal(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	settingsService := NewSettingsService(repo)

	themesDir := t.TempDir()
	cfg := &config.Config{
		ThemesPath: themesDir,
	}

	themeService := NewThemeService(cfg, settingsService)

	t.Run("findTheme with path traversal", func(t *testing.T) {
		// Create a file outside the themes directory
		parentDir := t.TempDir()
		themesDirInside := filepath.Join(parentDir, "themes")
		err := os.Mkdir(themesDirInside, 0755)
		assert.NoError(t, err)

		themeService.cfg.ThemesPath = themesDirInside

		secretFile := filepath.Join(parentDir, "secret.css")
		err = os.WriteFile(secretFile, []byte(":root { --secret: true; }"), 0644)
		assert.NoError(t, err)

		// Try to access it via ../secret
		_, err = themeService.findTheme("../secret")
		assert.Error(t, err, "Should not be able to find theme outside themes directory")
		assert.Contains(t, err.Error(), "invalid theme name", "Error should indicate invalid name")

		// Try to access it via .
		_, err = themeService.findTheme(".")
		assert.Error(t, err)
	})
}

func TestPathWithinDir(t *testing.T) {
	t.Run("path within dir, file does not exist", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "subfile.txt")
		assert.NoError(t, pathWithinDir(path, dir))
	})

	t.Run("path escapes dir, file does not exist", func(t *testing.T) {
		parent := t.TempDir()
		dir := filepath.Join(parent, "subdir")
		assert.NoError(t, os.Mkdir(dir, 0755))
		path := filepath.Join(parent, "outside.txt")
		err := pathWithinDir(path, dir)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "path escapes base directory")
	})

	t.Run("path within dir, file exists", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "file.txt")
		assert.NoError(t, os.WriteFile(path, []byte("data"), 0644))
		assert.NoError(t, pathWithinDir(path, dir))
	})

	t.Run("symlink escapes dir", func(t *testing.T) {
		parent := t.TempDir()
		dir := filepath.Join(parent, "themes")
		assert.NoError(t, os.Mkdir(dir, 0755))
		outside := filepath.Join(parent, "secret.css")
		assert.NoError(t, os.WriteFile(outside, []byte("data"), 0644))
		link := filepath.Join(dir, "evil.css")
		assert.NoError(t, os.Symlink(outside, link))
		err := pathWithinDir(link, dir)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "path escapes base directory")
	})

	t.Run("nonexistent dir uses Clean fallback, path within", func(t *testing.T) {
		dir := filepath.Join(t.TempDir(), "nonexistent")
		path := filepath.Join(dir, "file.txt")
		assert.NoError(t, pathWithinDir(path, dir))
	})

	t.Run("nonexistent dir uses Clean fallback, path escapes", func(t *testing.T) {
		parent := t.TempDir()
		dir := filepath.Join(parent, "nonexistent")
		path := filepath.Join(parent, "outside.txt")
		err := pathWithinDir(path, dir)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "path escapes base directory")
	})
}

func TestFindTheme_UserThemesPath(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	settingsService := NewSettingsService(repo)

	validCSS := ":root { --color: red; }"

	t.Run("finds theme in user dir", func(t *testing.T) {
		parent := t.TempDir()
		userDir := filepath.Join(parent, "user")
		sysDir := filepath.Join(parent, "system")
		assert.NoError(t, os.Mkdir(userDir, 0755))
		assert.NoError(t, os.Mkdir(sysDir, 0755))

		themeFile := filepath.Join(userDir, "mytest.css")
		assert.NoError(t, os.WriteFile(themeFile, []byte(validCSS), 0644))

		svc := NewThemeService(&config.Config{ThemesPath: sysDir, UserThemesPath: userDir}, settingsService)
		theme, err := svc.findTheme("mytest")
		assert.NoError(t, err)
		assert.Equal(t, themeFile, theme.Path)
	})

	t.Run("falls back to system dir when not in user dir", func(t *testing.T) {
		parent := t.TempDir()
		userDir := filepath.Join(parent, "user")
		sysDir := filepath.Join(parent, "system")
		assert.NoError(t, os.Mkdir(userDir, 0755))
		assert.NoError(t, os.Mkdir(sysDir, 0755))

		themeFile := filepath.Join(sysDir, "systheme.css")
		assert.NoError(t, os.WriteFile(themeFile, []byte(validCSS), 0644))

		svc := NewThemeService(&config.Config{ThemesPath: sysDir, UserThemesPath: userDir}, settingsService)
		theme, err := svc.findTheme("systheme")
		assert.NoError(t, err)
		assert.Equal(t, themeFile, theme.Path)
	})

	t.Run("symlink in user dir escaping is silently skipped, falls through to system", func(t *testing.T) {
		parent := t.TempDir()
		userDir := filepath.Join(parent, "user")
		sysDir := filepath.Join(parent, "system")
		assert.NoError(t, os.Mkdir(userDir, 0755))
		assert.NoError(t, os.Mkdir(sysDir, 0755))

		outside := filepath.Join(parent, "secret99.css")
		assert.NoError(t, os.WriteFile(outside, []byte(validCSS), 0644))
		link := filepath.Join(userDir, "evil99.css")
		assert.NoError(t, os.Symlink(outside, link))

		svc := NewThemeService(&config.Config{ThemesPath: sysDir, UserThemesPath: userDir}, settingsService)
		// user path skipped (symlink escapes), system path has no file → error
		_, err := svc.findTheme("evil99")
		assert.Error(t, err)
	})

	t.Run("symlink in system dir escaping returns error", func(t *testing.T) {
		parent := t.TempDir()
		sysDir := filepath.Join(parent, "system")
		assert.NoError(t, os.Mkdir(sysDir, 0755))

		outside := filepath.Join(parent, "secret-sys.css")
		assert.NoError(t, os.WriteFile(outside, []byte(validCSS), 0644))
		link := filepath.Join(sysDir, "evils.css")
		assert.NoError(t, os.Symlink(outside, link))

		svc := NewThemeService(&config.Config{ThemesPath: sysDir}, settingsService)
		_, err := svc.findTheme("evils")
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "path escapes base directory")
	})
}
