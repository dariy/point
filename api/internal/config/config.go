package config

import (
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

	MaxUploadSizeMB int `mapstructure:"MAX_UPLOAD_SIZE_MB"`
	MaxImageWidth   int `mapstructure:"MAX_IMAGE_WIDTH"`
	JpegQuality     int `mapstructure:"JPEG_QUALITY"`
	ThumbnailWidth  int `mapstructure:"THUMBNAIL_WIDTH"`
	ThumbnailHeight int `mapstructure:"THUMBNAIL_HEIGHT"`
	AvatarSize      int `mapstructure:"AVATAR_SIZE"`

	SessionExpiryHours       int    `mapstructure:"SESSION_EXPIRY_HOURS"`
	SessionExpiryPublicHours int    `mapstructure:"SESSION_EXPIRY_PUBLIC_HOURS"`
	FrontendDir              string `mapstructure:"FRONTEND_DIR"`
	ThemesPath               string `mapstructure:"THEMES_PATH"`
	GeminiAPIKey             string `mapstructure:"GEMINI_API_KEY"`
	MediaImportPath          string `mapstructure:"MEDIA_IMPORT_PATH"`
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
	v.SetDefault("THEMES_PATH", "")
	v.SetDefault("APP_VERSION", "1.0.0")
	v.SetDefault("SESSION_EXPIRY_HOURS", 720)
	v.SetDefault("SESSION_EXPIRY_PUBLIC_HOURS", 24)
	v.SetDefault("MAX_UPLOAD_SIZE_MB", 50)
	v.SetDefault("THUMBNAIL_WIDTH", 400)
	v.SetDefault("THUMBNAIL_HEIGHT", 300)
	v.SetDefault("JPEG_QUALITY", 85)
	v.SetDefault("GEMINI_API_KEY", "")
	v.SetDefault("MEDIA_IMPORT_PATH", "")

	err = v.ReadInConfig()
	if err != nil {
		// It's okay if .env is missing, we use defaults and ENV vars
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return
		}
	}

	err = v.Unmarshal(&config)

	// If THEMES_PATH was not set (or set to empty), derive it from FRONTEND_DIR
	if config.ThemesPath == "" {
		config.ThemesPath = filepath.Join(config.FrontendDir, "themes")
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
