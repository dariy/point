package services

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"point-api/internal/config"
)

type Theme struct {
	Name         string         `json:"name"`
	Description  string         `json:"description"`
	PreviewColor string         `json:"preview_color"`
	Path         string         `json:"-"`
	Light        map[string]any `json:"light"`
	Dark         map[string]any `json:"dark"`
	Shared       map[string]any `json:"shared,omitempty"`
}

type ThemeService struct {
	cfg             *config.Config
	settingsService *SettingsService
}

func NewThemeService(cfg *config.Config, settingsService *SettingsService) *ThemeService {
	return &ThemeService{
		cfg:             cfg,
		settingsService: settingsService,
	}
}

// ListThemes scans the ThemesPath directory, reads and validates themes
func (s *ThemeService) ListThemes() ([]Theme, error) {
	if s.cfg.ThemesPath == "" {
		return nil, fmt.Errorf("themes path is not configured")
	}

	entries, err := os.ReadDir(s.cfg.ThemesPath)
	if err != nil {
		if os.IsNotExist(err) {
			return []Theme{}, nil
		}
		return nil, fmt.Errorf("failed to read themes directory: %w", err)
	}

	var themes []Theme
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}

		themePath := filepath.Join(s.cfg.ThemesPath, entry.Name())
		themeName := strings.TrimSuffix(entry.Name(), ".json")

		theme, err := s.ReadAndValidateTheme(themePath, themeName)
		if err == nil {
			themes = append(themes, theme)
		}
	}

	return themes, nil
}

func (s *ThemeService) ReadAndValidateTheme(path string, name string) (Theme, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Theme{}, fmt.Errorf("failed to read theme file: %w", err)
	}

	var theme Theme
	if err := json.Unmarshal(data, &theme); err != nil {
		return Theme{}, fmt.Errorf("invalid json in theme file: %w", err)
	}

	theme.Name = name
	theme.Path = path

	if theme.Light == nil || theme.Dark == nil {
		return Theme{}, fmt.Errorf("theme missing required 'light' or 'dark' fields")
	}

	return theme, nil
}

func (s *ThemeService) GetActiveTheme(ctx context.Context) (Theme, error) {
	activeThemeName, err := s.settingsService.GetSetting(ctx, "active_css_theme", "default")
	if err != nil || activeThemeName == "" {
		activeThemeName = "default"
	}

	themePath := filepath.Join(s.cfg.ThemesPath, activeThemeName+".json")
	theme, err := s.ReadAndValidateTheme(themePath, activeThemeName)
	if err != nil {
		// Fallback to default
		themePath = filepath.Join(s.cfg.ThemesPath, "default.json")
		theme, err = s.ReadAndValidateTheme(themePath, "default")
		if err != nil {
			return Theme{}, fmt.Errorf("failed to load fallback theme: %w", err)
		}
	}
	return theme, nil
}

func (s *ThemeService) SetActiveTheme(ctx context.Context, name string) error {
	// Validate that the theme exists and is valid
	themePath := filepath.Join(s.cfg.ThemesPath, name+".json")
	if _, err := s.ReadAndValidateTheme(themePath, name); err != nil {
		return fmt.Errorf("invalid theme %q: %w", name, err)
	}

	// Persist the selection in DB
	err := s.settingsService.SetSetting(ctx, "active_css_theme", name, "string")
	if err != nil {
		return fmt.Errorf("failed to save active theme setting: %w", err)
	}

	// Synchronize the public-facing theme.json file for the frontend
	return s.SyncActiveTheme(ctx)
}

func (s *ThemeService) SyncActiveTheme(ctx context.Context) error {
	activeTheme, err := s.GetActiveTheme(ctx)
	if err != nil {
		return fmt.Errorf("failed to get active theme: %w", err)
	}

	themePath := filepath.Join(s.cfg.ThemesPath, activeTheme.Name+".json")
	publicThemePath := filepath.Join(s.cfg.FrontendDir, "images", "theme.json")

	// Ensure the target directory exists (useful in some environments/tests)
	if err := os.MkdirAll(filepath.Dir(publicThemePath), 0755); err != nil {
		return fmt.Errorf("failed to create public theme directory: %w", err)
	}

	// Read raw content and write to public path (ensures all fields are preserved)
	data, err := os.ReadFile(themePath)
	if err != nil {
		return fmt.Errorf("failed to read source theme file: %w", err)
	}

	err = os.WriteFile(publicThemePath, data, 0644)
	if err != nil {
		return fmt.Errorf("failed to update public theme.json: %w", err)
	}

	return nil
}
