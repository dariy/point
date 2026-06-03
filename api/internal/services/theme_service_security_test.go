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
