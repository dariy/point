package services

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"point-api/internal/config"
)

type Theme struct {
	Name         string `json:"name"`
	Description  string `json:"description"`
	PreviewColor string `json:"preview_color"`
	HasDarkMode  bool   `json:"has_dark_mode"`
	Path         string `json:"-"`
}

type ThemeService struct {
	cfg             *config.Config
	settingsService *SettingsService
	darkModeCache   map[string]bool
}

func NewThemeService(cfg *config.Config, settingsService *SettingsService) *ThemeService {
	return &ThemeService{
		cfg:             cfg,
		settingsService: settingsService,
		darkModeCache:   make(map[string]bool),
	}
}

var (
	metaTitleRe      = regexp.MustCompile(`/\*\s*theme-title:\s*"([^"]+)"\s*\*/`)
	metaDescRe       = regexp.MustCompile(`/\*\s*description:\s*"([^"]+)"\s*\*/`)
	metaColorRe      = regexp.MustCompile(`/\*\s*preview-color:\s*"([^"]+)"\s*\*/`)
	themeNameSafeRe  = regexp.MustCompile(`^[a-z0-9_-]+$`)
)

// ListThemes scans both ThemesPath (system) and UserThemesPath (user) directories.
// User themes override system themes with the same name.
func (s *ThemeService) ListThemes() ([]Theme, error) {
	if s.cfg.ThemesPath == "" {
		return nil, fmt.Errorf("themes path is not configured")
	}

	seen := make(map[string]bool)
	var themes []Theme

	// User themes take precedence — load them first
	if s.cfg.UserThemesPath != "" {
		userThemes, _ := s.scanThemesDir(s.cfg.UserThemesPath)
		for _, t := range userThemes {
			seen[t.Name] = true
			themes = append(themes, t)
		}
	}

	// System themes — skip any already provided by user
	systemThemes, err := s.scanThemesDir(s.cfg.ThemesPath)
	if err != nil {
		return nil, err
	}
	for _, t := range systemThemes {
		if !seen[t.Name] {
			themes = append(themes, t)
		}
	}

	return themes, nil
}

func (s *ThemeService) scanThemesDir(dir string) ([]Theme, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to read themes directory: %w", err)
	}

	var themes []Theme
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".css") {
			continue
		}
		themePath := filepath.Join(dir, entry.Name())
		themeName := strings.TrimSuffix(entry.Name(), ".css")
		if t, err := s.ReadAndValidateTheme(themePath, themeName); err == nil {
			themes = append(themes, t)
		}
	}
	return themes, nil
}

func (s *ThemeService) normalizeAndValidateThemeName(name string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(name))
	if normalized == "" {
		return "", fmt.Errorf("theme name is required")
	}
	if strings.Contains(normalized, "/") || strings.Contains(normalized, "\\") || strings.Contains(normalized, "..") {
		return "", fmt.Errorf("invalid theme name")
	}
	if !themeNameSafeRe.MatchString(normalized) {
		return "", fmt.Errorf("invalid theme name")
	}
	return normalized, nil
}

func (s *ThemeService) ReadAndValidateTheme(path string, name string) (Theme, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Theme{}, fmt.Errorf("failed to read theme file: %w", err)
	}

	content := string(data)

	if !strings.Contains(content, ":root {") && !strings.Contains(content, ":root{") {
		return Theme{}, fmt.Errorf("theme file missing :root { block")
	}

	hasDark, cached := s.darkModeCache[path]
	if !cached {
		hasDark = strings.Contains(content, `[data-theme="dark"]`)
		s.darkModeCache[path] = hasDark
	}

	theme := Theme{
		Name:        name,
		Path:        path,
		HasDarkMode: hasDark,
	}

	if m := metaTitleRe.FindStringSubmatch(content); len(m) == 2 {
		theme.Name = m[1]
	} else {
		theme.Name = name
	}

	if m := metaDescRe.FindStringSubmatch(content); len(m) == 2 {
		theme.Description = m[1]
	}

	if m := metaColorRe.FindStringSubmatch(content); len(m) == 2 {
		theme.PreviewColor = m[1]
	}

	return theme, nil
}

// pathWithinDir resolves symlinks and verifies the path stays inside dir.
func pathWithinDir(path, dir string) error {
	resolvedDir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		resolvedDir = filepath.Clean(dir)
	}
	resolvedPath, err := filepath.EvalSymlinks(path)
	if err != nil {
		// File doesn't exist yet; verify clean join stays within dir without symlink resolution.
		clean := filepath.Clean(path)
		if !strings.HasPrefix(clean, resolvedDir+string(filepath.Separator)) {
			return fmt.Errorf("path escapes base directory")
		}
		return nil
	}
	if !strings.HasPrefix(resolvedPath, resolvedDir+string(filepath.Separator)) {
		return fmt.Errorf("path escapes base directory")
	}
	return nil
}

// findTheme searches user themes path first (<name>.css), then system themes path (<name>.css).
func (s *ThemeService) findTheme(name string) (Theme, error) {
	name = strings.ToLower(name)
	if !themeNameSafeRe.MatchString(name) {
		return Theme{}, fmt.Errorf("invalid theme name")
	}
	if s.cfg.UserThemesPath != "" {
		userPath := filepath.Join(s.cfg.UserThemesPath, name+".css")
		if pathWithinDir(userPath, s.cfg.UserThemesPath) == nil {
			if t, err := s.ReadAndValidateTheme(userPath, name); err == nil {
				return t, nil
			}
		}
	}
	systemPath := filepath.Join(s.cfg.ThemesPath, name+".css")
	if err := pathWithinDir(systemPath, s.cfg.ThemesPath); err != nil {
		return Theme{}, err
	}
	return s.ReadAndValidateTheme(systemPath, name)
}

func (s *ThemeService) GetActiveTheme(ctx context.Context) (Theme, error) {
	activeThemeName, err := s.settingsService.GetSetting(ctx, "active_css_theme", "default")
	if err != nil || activeThemeName == "" {
		activeThemeName = "default"
	}

	theme, err := s.findTheme(activeThemeName)
	if err != nil {
		// Fallback to default
		theme, err = s.findTheme("default")
		if err != nil {
			return Theme{}, fmt.Errorf("failed to load fallback theme: %w", err)
		}
	}
	return theme, nil
}

func (s *ThemeService) SetActiveTheme(ctx context.Context, name string) (Theme, error) {
	normalizedName, err := s.normalizeAndValidateThemeName(name)
	if err != nil {
		return Theme{}, fmt.Errorf("invalid theme %q: %w", name, err)
	}

	// Validate that the theme exists and is valid (searches both paths)
	theme, err := s.findTheme(normalizedName)
	if err != nil {
		return Theme{}, fmt.Errorf("invalid theme %q: %w", normalizedName, err)
	}

	// Persist the selection in DB
	err = s.settingsService.SetSetting(ctx, "active_css_theme", normalizedName, "string")
	if err != nil {
		return Theme{}, fmt.Errorf("failed to save active theme setting: %w", err)
	}

	// Synchronize the public-facing theme.css file for the frontend
	if err := s.SyncActiveTheme(ctx); err != nil {
		return Theme{}, err
	}

	return theme, nil
}

func (s *ThemeService) GetCustomCSS(ctx context.Context) (string, error) {
	return s.settingsService.GetSetting(ctx, "system_custom_css", "")
}

func (s *ThemeService) UpdateCustomCSS(ctx context.Context, css string) error {
	err := s.settingsService.SetSetting(ctx, "system_custom_css", css, "string")
	if err != nil {
		return fmt.Errorf("failed to save custom css setting: %w", err)
	}

	// Update the public theme.css with the new custom CSS
	return s.SyncActiveTheme(ctx)
}

func (s *ThemeService) SyncActiveTheme(ctx context.Context) error {
	activeTheme, err := s.GetActiveTheme(ctx)
	if err != nil {
		return fmt.Errorf("failed to get active theme: %w", err)
	}

	// Theme CSS is served under /assets/css/theme.css → <FrontendDir>/css/theme.css
	publicThemePath := filepath.Join(s.cfg.FrontendDir, "css", "theme.css")

	if err := os.MkdirAll(filepath.Dir(publicThemePath), 0755); err != nil {
		return fmt.Errorf("failed to create css directory: %w", err)
	}

	data, err := os.ReadFile(activeTheme.Path)
	if err != nil {
		return fmt.Errorf("failed to read source theme file: %w", err)
	}

	// Append system-wide custom CSS if configured
	customCSS, _ := s.GetCustomCSS(ctx)
	if customCSS != "" {
		data = append(data, []byte("\n\n/* System Custom CSS */\n")...)
		data = append(data, []byte(customCSS)...)
	}

	err = os.WriteFile(publicThemePath, data, 0644)
	if err != nil {
		return fmt.Errorf("failed to update public theme.css: %w", err)
	}

	return nil
}
