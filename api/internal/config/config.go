package config

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/viper"
)

type Config struct {
	AppName     string `mapstructure:"APP_NAME"`
	AppVersion  string `mapstructure:"APP_VERSION"`
	AppEnv      string `mapstructure:"APP_ENV"`
	Debug       bool   `mapstructure:"DEBUG"`
	SecretKey   string `mapstructure:"SECRET_KEY"`
	Host        string `mapstructure:"HOST"`
	Port        int    `mapstructure:"PORT"`
	DatabaseURL string `mapstructure:"DATABASE_URL"`
	StoragePath string `mapstructure:"STORAGE_PATH"`

	MaxImageWidth   int `mapstructure:"MAX_IMAGE_WIDTH"`
	JpegQuality     int `mapstructure:"JPEG_QUALITY"`
	ThumbnailWidth  int `mapstructure:"THUMBNAIL_WIDTH"`
	ThumbnailHeight int `mapstructure:"THUMBNAIL_HEIGHT"`
	AvatarSize      int `mapstructure:"AVATAR_SIZE"`

	SessionExpiryHours       int    `mapstructure:"SESSION_EXPIRY_HOURS"`
	SessionExpiryPublicHours int    `mapstructure:"SESSION_EXPIRY_PUBLIC_HOURS"`
	FrontendDir              string `mapstructure:"FRONTEND_DIR"`
	// FrontendDebug serves the debug frontend bundle (frontend/js-debug, with
	// plugin/console debug logging) instead of the minified release bundle when
	// that bundle exists. Off by default so production serves the release build.
	FrontendDebug    bool   `mapstructure:"FRONTEND_DEBUG"`
	ThemesPath       string `mapstructure:"THEMES_PATH"`
	UserThemesPath   string `mapstructure:"USER_THEMES_PATH"`
	GeminiAPIKey     string `mapstructure:"GEMINI_API_KEY"`
	PhotoLibraryPath string `mapstructure:"PHOTO_LIBRARY_PATH"`

	// SMTP for password reset emails
	SMTPHost     string `mapstructure:"SMTP_HOST"`
	SMTPPort     int    `mapstructure:"SMTP_PORT"`
	SMTPUsername string `mapstructure:"SMTP_USERNAME"`
	SMTPPassword string `mapstructure:"SMTP_PASSWORD"`
	SMTPFrom     string `mapstructure:"SMTP_FROM"`
	AppURL       string `mapstructure:"APP_URL"`

	// MCP server (the "mcp" plugin, served at /mcp). OAuth login uses the admin password.
	MCPBaseURL string `mapstructure:"MCP_BASE_URL"` // public HTTPS base URL for OAuth discovery; falls back to APP_URL
}

func LoadConfig(path string) (config Config, err error) {
	v := viper.New()
	v.AddConfigPath(path)
	v.SetConfigName(".env")
	v.SetConfigType("env")

	v.AutomaticEnv()

	// Defaults
	v.SetDefault("APP_NAME", "Point")
	v.SetDefault("APP_ENV", "development")
	v.SetDefault("DEBUG", true)
	v.SetDefault("HOST", "0.0.0.0")
	v.SetDefault("PORT", 8000)
	v.SetDefault("DATABASE_URL", "sqlite:./data/point.db")
	v.SetDefault("STORAGE_PATH", "./data")
	v.SetDefault("FRONTEND_DIR", "../frontend")
	v.SetDefault("FRONTEND_DEBUG", false)
	v.SetDefault("THEMES_PATH", "")
	v.SetDefault("USER_THEMES_PATH", "")
	v.SetDefault("APP_VERSION", "")
	v.SetDefault("SESSION_EXPIRY_HOURS", 720)
	v.SetDefault("SESSION_EXPIRY_PUBLIC_HOURS", 24)
	v.SetDefault("THUMBNAIL_WIDTH", 400)
	v.SetDefault("THUMBNAIL_HEIGHT", 300)
	v.SetDefault("JPEG_QUALITY", 85)
	v.SetDefault("GEMINI_API_KEY", "")
	v.SetDefault("PHOTO_LIBRARY_PATH", "")
	v.SetDefault("SMTP_HOST", "")
	v.SetDefault("SMTP_PORT", 587)
	v.SetDefault("SMTP_USERNAME", "")
	v.SetDefault("SMTP_PASSWORD", "")
	v.SetDefault("SMTP_FROM", "")
	v.SetDefault("APP_URL", "")
	v.SetDefault("MCP_BASE_URL", "")

	err = v.ReadInConfig()
	if err != nil {
		// It's okay if .env is missing, we use defaults and ENV vars
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return
		}
	}

	err = v.Unmarshal(&config)

	// Smart path detection: if running from repo root, frontend and data dirs
	// are local, but defaults assume we are in 'api' directory.
	if config.FrontendDir == "../frontend" {
		if _, err := os.Stat(filepath.Join(path, "../frontend")); os.IsNotExist(err) {
			if _, err := os.Stat(filepath.Join(path, "frontend")); err == nil {
				config.FrontendDir = "frontend"
			}
		}
	}
	if config.StoragePath == "./data" {
		if _, err := os.Stat(filepath.Join(path, "./data")); os.IsNotExist(err) {
			if _, err := os.Stat(filepath.Join(path, "../data")); err == nil {
				config.StoragePath = "../data"
				// Also update default database URL if it was used
				if config.DatabaseURL == "sqlite:./data/point.db" {
					config.DatabaseURL = "sqlite:../data/point.db"
				}
			}
		}
	}

	// If THEMES_PATH was not set (or set to empty), derive it from FRONTEND_DIR
	if config.ThemesPath == "" {
		config.ThemesPath = filepath.Join(config.FrontendDir, "themes")
	}

	// If USER_THEMES_PATH was not set, derive it from STORAGE_PATH
	if config.UserThemesPath == "" {
		config.UserThemesPath = filepath.Join(config.StoragePath, "themes")
	}

	// Clean database URL (remove python-specific aiosqlite prefix if present)
	if strings.Contains(config.DatabaseURL, "sqlite+aiosqlite:///") {
		config.DatabaseURL = strings.Replace(config.DatabaseURL, "sqlite+aiosqlite:///", "", 1)
	} else if strings.Contains(config.DatabaseURL, "sqlite:///") {
		config.DatabaseURL = strings.Replace(config.DatabaseURL, "sqlite:///", "", 1)
	} else if strings.HasPrefix(config.DatabaseURL, "sqlite:") {
		config.DatabaseURL = strings.Replace(config.DatabaseURL, "sqlite:", "", 1)
	}

	return
}
