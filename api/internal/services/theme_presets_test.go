package services

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"point-api/internal/config"
)

// The built-in style presets live in frontend/themes. These tests read the
// real files, so a preset edit that breaks the onboarding contract fails here.
func builtinPresets(t *testing.T) (map[string]*ThemePreset, string) {
	t.Helper()
	frontend, err := filepath.Abs(filepath.Join("..", "..", "..", "frontend"))
	if err != nil {
		t.Fatal(err)
	}
	svc := NewThemeService(&config.Config{ThemesPath: filepath.Join(frontend, "themes")}, nil)
	themes, err := svc.ListThemes()
	if err != nil {
		t.Fatalf("ListThemes: %v", err)
	}
	presets := make(map[string]*ThemePreset)
	for _, th := range themes {
		if th.Preset != nil {
			presets[th.Preset.Name] = th.Preset
		}
	}
	return presets, frontend
}

func TestBuiltinPresets_SetIsComplete(t *testing.T) {
	presets, frontend := builtinPresets(t)
	want := []string{"Classic", "Editorial", "Gallery", "Journal", "Dark Studio", "Zine"}
	if len(presets) != len(want) {
		t.Fatalf("got %d presets, want %d", len(presets), len(want))
	}
	for _, name := range want {
		p, ok := presets[name]
		if !ok {
			t.Fatalf("preset %q is missing", name)
		}
		if p.Description == "" || p.Layout == "" || p.Typography == "" || p.Palette == "" || p.Header == "" {
			t.Errorf("preset %q has empty metadata: %+v", name, p)
		}
		if p.PreviewImage == "" {
			t.Errorf("preset %q has no valid preview image", name)
			continue
		}
		img := filepath.Join(frontend, "images", strings.TrimPrefix(p.PreviewImage, "/assets/images/"))
		if _, err := os.Stat(img); err != nil {
			t.Errorf("preset %q preview image: %v", name, err)
		}
	}
}

func TestBuiltinPresets_EachPairDiffersInTwoDimensions(t *testing.T) {
	presets, _ := builtinPresets(t)
	var list []*ThemePreset
	for _, p := range presets {
		list = append(list, p)
	}
	for i := range list {
		for j := i + 1; j < len(list); j++ {
			a, b := list[i], list[j]
			diff := 0
			for _, d := range [][2]string{{a.Layout, b.Layout}, {a.Typography, b.Typography}, {a.Palette, b.Palette}, {a.Header, b.Header}} {
				if d[0] != d[1] {
					diff++
				}
			}
			if diff < 2 {
				t.Errorf("%q and %q differ in %d dimensions, want >= 2", a.Name, b.Name, diff)
			}
		}
	}
}

// Fonts must be self-hosted: no theme may pull CSS or fonts from another origin.
func TestBuiltinThemes_LoadNoThirdPartyResources(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "frontend", "themes")
	files, err := filepath.Glob(filepath.Join(dir, "*.css"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no themes found in %s: %v", dir, err)
	}
	external := regexp.MustCompile(`(?i)@import|url\(\s*['"]?(https?:)?//`)
	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if loc := external.FindString(string(data)); loc != "" {
			t.Errorf("%s loads an external resource: %q", filepath.Base(f), loc)
		}
	}
}

// An install with no stored theme (every existing instance that never picked
// one) resolves to the default theme, which is the Classic preset.
func TestActiveTheme_DefaultIsClassicPreset(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	frontend, _ := filepath.Abs(filepath.Join("..", "..", "..", "frontend"))
	svc := NewThemeService(&config.Config{ThemesPath: filepath.Join(frontend, "themes")}, NewSettingsService(repo))
	th, err := svc.GetActiveTheme(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if th.Preset == nil || th.Preset.Name != "Classic" {
		t.Fatalf("active theme preset = %+v, want Classic", th.Preset)
	}
}

func TestParsePreset(t *testing.T) {
	if p := parsePreset(`/* theme-title: "X" */ :root {}`); p != nil {
		t.Fatalf("plain theme got preset %+v", p)
	}
	p := parsePreset(`/* preset: "X" */
/* preview-image: "https://evil.example/x.svg" */`)
	if p == nil || p.Name != "X" || p.PreviewImage != "" {
		t.Fatalf("got %+v, want name X and no off-origin preview image", p)
	}
}
