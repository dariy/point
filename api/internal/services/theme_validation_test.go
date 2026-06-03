package services

import (
	"testing"

	"github.com/stretchr/testify/assert"
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
