package services

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"point-api/internal/config"
)

func TestNormalizeAndValidateThemeName(t *testing.T) {
	ts := &ThemeService{}

	tests := []struct {
		name     string
		input    string
		expected string
		wantErr  bool
	}{
		{"valid lowercase", "modern", "modern", false},
		{"valid with hyphen", "dark-mode", "dark-mode", false},
		{"valid with underscore", "blue_theme", "blue_theme", false},
		{"valid alphanumeric", "theme123", "theme123", false},
		{"normalization: uppercase to lowercase", "Modern", "modern", false},
		{"normalization: spaces", "  modern  ", "modern", false},
		{"normalization: mixed case and spaces", "  Dark-Mode  ", "dark-mode", false},
		
		{"invalid: empty string", "", "", true},
		{"invalid: just spaces", "   ", "", true},
		{"invalid: path traversal forward slash", "themes/dark", "", true},
		{"invalid: path traversal backward slash", "themes\\dark", "", true},
		{"invalid: path traversal dot dot", "../../etc/passwd", "", true},
		{"invalid: dot dot in name", "theme..name", "", true},
		{"invalid: special characters", "theme!", "", true},
		{"invalid: special characters", "theme@#", "", true},
		{"invalid: spaces inside name", "modern theme", "", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ts.normalizeAndValidateThemeName(tt.input)
			if tt.wantErr {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
				assert.Equal(t, tt.expected, got)
			}
		})
	}
}

func TestFindThemeSecurity(t *testing.T) {
	themesDir := t.TempDir()
	cfg := &config.Config{
		ThemesPath: themesDir,
	}
	ts := NewThemeService(cfg, nil)

	t.Run("prevents path traversal via findTheme", func(t *testing.T) {
		invalidNames := []string{
			"../outside",
			"/absolute/path",
			"sub/dir",
			"dir\\backslash",
			"dot.dot",
		}

		for _, name := range invalidNames {
			_, err := ts.findTheme(name)
			assert.Error(t, err, "expected error for theme name: %s", name)
			assert.Contains(t, err.Error(), "invalid theme name")
		}
	})
}

func TestReadAndValidateThemePreviewColors(t *testing.T) {
	dir := t.TempDir()
	ts := NewThemeService(&config.Config{ThemesPath: dir}, nil)

	write := func(name, body string) string {
		path := filepath.Join(dir, name)
		require.NoError(t, os.WriteFile(path, []byte(body), 0o600))
		return path
	}

	t.Run("reads the light :root palette, not the dark override", func(t *testing.T) {
		path := write("ocean.css", `/* theme-title: "Ocean" */
/* preview-color: "#0891b2" */
:root {
  --bg-primary: #f0f9ff;
  --surface-card: #ffffff;
  --text-primary: #0c4a6e;
  --border-primary: rgba(186, 230, 253, 0.9);
}
[data-theme="dark"] {
  --bg-primary: #000000;
  --text-primary: #ffffff;
}`)

		theme, err := ts.ReadAndValidateTheme(path, "ocean")
		require.NoError(t, err)
		assert.Equal(t, "#0891b2", theme.PreviewColor)
		assert.Equal(t, "#f0f9ff", theme.PreviewBg)
		assert.Equal(t, "#ffffff", theme.PreviewSurface)
		assert.Equal(t, "#0c4a6e", theme.PreviewText)
		assert.Equal(t, "rgba(186, 230, 253, 0.9)", theme.PreviewBorder)
		assert.True(t, theme.HasDarkMode)
	})

	t.Run("falls back to --color-primary when the accent comment is absent", func(t *testing.T) {
		path := write("plain.css", ":root {\n  --color-primary: #123456;\n}")

		theme, err := ts.ReadAndValidateTheme(path, "plain")
		require.NoError(t, err)
		assert.Equal(t, "#123456", theme.PreviewColor)
	})

	t.Run("drops values that are not plain colour literals", func(t *testing.T) {
		path := write("indirect.css", `:root {
  --bg-primary: var(--somewhere-else);
  --surface-card: url(https://example.invalid/x.png);
  --text-primary: red; expression(alert(1));
}`)

		theme, err := ts.ReadAndValidateTheme(path, "indirect")
		require.NoError(t, err)
		assert.Empty(t, theme.PreviewBg)
		assert.Empty(t, theme.PreviewSurface)
		assert.Empty(t, theme.PreviewText)
	})
}
