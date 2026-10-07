package services

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"point-api/internal/config"
)

type Theme struct {
	// ID is the file name without .css, e.g. "dark-studio". It is the value
	// that SetActiveTheme and ThemeCSS take; Name can be a display title.
	ID string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	// PreviewColor is the theme's declared accent; the Preview* fields below are
	// read from its :root block so the admin swatch can render the real palette
	// instead of a single accent stripe. Each is empty when the theme omits the
	// variable or declares it as something other than a plain colour literal.
	PreviewColor   string `json:"preview_color"`
	PreviewBg      string `json:"preview_bg,omitempty"`
	PreviewSurface string `json:"preview_surface,omitempty"`
	PreviewText    string `json:"preview_text,omitempty"`
	PreviewBorder  string `json:"preview_border,omitempty"`
	HasDarkMode    bool   `json:"has_dark_mode"`
	// Preset is set when the theme is one of the onboarding style presets
	// (`/* preset: "..." */` metadata). Nil for a plain palette theme.
	Preset *ThemePreset `json:"preset,omitempty"`
	Path   string       `json:"-"`
}

// ThemePreset is a style preset's picker metadata. The four dimensions name
// the layout (grid type and density), typography (font pairing), palette and
// header style that the theme CSS sets, so presets can be compared.
type ThemePreset struct {
	Name         string `json:"name"`
	Description  string `json:"description"`
	PreviewImage string `json:"preview_image"`
	Layout       string `json:"layout"`
	Typography   string `json:"typography"`
	Palette      string `json:"palette"`
	Header       string `json:"header"`
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
	metaTitleRe     = regexp.MustCompile(`/\*\s*theme-title:\s*"([^"]+)"\s*\*/`)
	metaDescRe      = regexp.MustCompile(`/\*\s*description:\s*"([^"]+)"\s*\*/`)
	metaColorRe     = regexp.MustCompile(`/\*\s*preview-color:\s*"([^"]+)"\s*\*/`)
	themeNameSafeRe = regexp.MustCompile(`^[a-z0-9_-]+$`)
	// Preset metadata, e.g. /* preset-layout: "card-grid-dense" */.
	metaPresetRe = regexp.MustCompile(`/\*\s*(preset(?:-[a-z]+)?|preview-image):\s*"([^"]+)"\s*\*/`)
	// A preview image must be a same-origin asset path.
	presetImageRe = regexp.MustCompile(`^/assets/images/presets/[a-z0-9_-]+\.(svg|png|jpg|webp)$`)

	// Light-mode :root block and the custom-property declarations inside it.
	rootBlockRe = regexp.MustCompile(`(?s):root\s*\{(.*?)\}`)
	cssDeclRe   = regexp.MustCompile(`(--[a-zA-Z0-9_-]+)\s*:\s*([^;{}]+);`)
	// Only plain colour literals are surfaced — the values end up in an inline
	// style attribute on the admin page, and anything else (var() chains that
	// resolve elsewhere, url(), functions) is dropped rather than passed along.
	colorLiteralRe = regexp.MustCompile(`^(?i)(#[0-9a-f]{3,8}|rgba?\([0-9.,%\s/]+\)|hsla?\([0-9.,%\s/deg]+\))$`)
)

// rootColorVars returns the plain colour literals declared in a theme's
// light-mode :root block, keyed by custom-property name.
func rootColorVars(content string) map[string]string {
	m := rootBlockRe.FindStringSubmatch(content)
	if len(m) != 2 {
		return nil
	}
	vars := make(map[string]string)
	for _, decl := range cssDeclRe.FindAllStringSubmatch(m[1], -1) {
		value := strings.TrimSpace(decl[2])
		if colorLiteralRe.MatchString(value) {
			vars[decl[1]] = value
		}
	}
	return vars
}

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
		return "", wrapKind(ErrInvalidInput, errors.New("theme name is required"))
	}
	if strings.Contains(normalized, "/") || strings.Contains(normalized, "\\") || strings.Contains(normalized, "..") {
		return "", wrapKind(ErrInvalidInput, errors.New("invalid theme name"))
	}
	if !themeNameSafeRe.MatchString(normalized) {
		return "", wrapKind(ErrInvalidInput, errors.New("invalid theme name"))
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
		return Theme{}, wrapKind(ErrInvalidInput, errors.New("theme file missing :root { block"))
	}

	hasDark, cached := s.darkModeCache[path]
	if !cached {
		hasDark = strings.Contains(content, `[data-theme="dark"]`)
		s.darkModeCache[path] = hasDark
	}

	theme := Theme{
		ID:          name,
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

	vars := rootColorVars(content)
	theme.PreviewBg = vars["--bg-primary"]
	theme.PreviewSurface = vars["--surface-card"]
	theme.PreviewText = vars["--text-primary"]
	theme.PreviewBorder = vars["--border-primary"]
	if theme.PreviewColor == "" {
		theme.PreviewColor = vars["--color-primary"]
	}

	theme.Preset = parsePreset(content)

	return theme, nil
}

// parsePreset reads the preset metadata comments. It returns nil when the
// theme has no `preset` name.
func parsePreset(content string) *ThemePreset {
	meta := make(map[string]string)
	for _, m := range metaPresetRe.FindAllStringSubmatch(content, -1) {
		if _, ok := meta[m[1]]; !ok {
			meta[m[1]] = m[2]
		}
	}
	if meta["preset"] == "" {
		return nil
	}
	p := &ThemePreset{
		Name:        meta["preset"],
		Description: meta["preset-description"],
		Layout:      meta["preset-layout"],
		Typography:  meta["preset-typography"],
		Palette:     meta["preset-palette"],
		Header:      meta["preset-header"],
	}
	if presetImageRe.MatchString(meta["preview-image"]) {
		p.PreviewImage = meta["preview-image"]
	}
	return p
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
		return Theme{}, wrapKind(ErrInvalidInput, errors.New("invalid theme name"))
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

// UpdateCustomCSS stores the site-wide custom CSS and republishes theme.css.
// The CSS is sanitized first — per-post CSS always was, while this path wrote
// straight to disk. It uses the global policy, not the per-post one: an admin
// theming their own site legitimately needs position, z-index and content,
// which SanitizePostCSS strips because a post is a fragment of a page it does
// not own. What is removed either way are the escapes — @import, url() pointing
// off-origin, and a stray '<'. Returns the names of any removed constructs so
// the caller can tell the admin rather than silently dropping their CSS.
func (s *ThemeService) UpdateCustomCSS(ctx context.Context, css string) ([]string, error) {
	clean, warnings := SanitizeGlobalCSS(css)

	if err := s.settingsService.SetSetting(ctx, "system_custom_css", clean, "string"); err != nil {
		return nil, fmt.Errorf("failed to save custom css setting: %w", err)
	}

	// Update the public theme.css with the new custom CSS
	if err := s.SyncActiveTheme(ctx); err != nil {
		return nil, err
	}
	return warnings, nil
}

// ThemeCSS returns the CSS that theme.css would hold if the named theme were
// active: the theme file plus the system custom CSS. The style picker uses it
// to preview a preset without saving it.
func (s *ThemeService) ThemeCSS(ctx context.Context, name string) ([]byte, error) {
	normalizedName, err := s.normalizeAndValidateThemeName(name)
	if err != nil {
		return nil, err
	}
	theme, err := s.findTheme(normalizedName)
	if err != nil {
		return nil, err
	}
	return s.composeThemeCSS(ctx, theme)
}

func (s *ThemeService) composeThemeCSS(ctx context.Context, theme Theme) ([]byte, error) {
	data, err := os.ReadFile(theme.Path)
	if err != nil {
		return nil, fmt.Errorf("failed to read source theme file: %w", err)
	}

	// Append system-wide custom CSS if configured
	customCSS, _ := s.GetCustomCSS(ctx)
	if customCSS != "" {
		data = append(data, []byte("\n\n/* System Custom CSS */\n")...)
		data = append(data, []byte(customCSS)...)
	}
	return data, nil
}

func (s *ThemeService) SyncActiveTheme(ctx context.Context) error {
	activeTheme, err := s.GetActiveTheme(ctx)
	if err != nil {
		return fmt.Errorf("failed to get active theme: %w", err)
	}

	// Theme CSS is served under /assets/css/common/theme.css → <FrontendDir>/css/common/theme.css
	publicThemePath := filepath.Join(s.cfg.FrontendDir, "css", "common", "theme.css")

	if err := os.MkdirAll(filepath.Dir(publicThemePath), 0755); err != nil {
		return fmt.Errorf("failed to create css directory: %w", err)
	}

	data, err := s.composeThemeCSS(ctx, activeTheme)
	if err != nil {
		return err
	}

	// publicThemePath is a fixed location under the configured frontend dir.
	//nolint:gosec // G703: path is composed from config, not from input
	err = os.WriteFile(publicThemePath, data, 0644)
	if err != nil {
		return fmt.Errorf("failed to update public theme.css: %w", err)
	}

	return nil
}
