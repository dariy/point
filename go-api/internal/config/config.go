package config

import (
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
}

func LoadConfig(path string) (config Config, err error) {
	viper.AddConfigPath(path)
	viper.SetConfigName(".env")
	viper.SetConfigType("env")

	viper.AutomaticEnv()

	// Defaults
	viper.SetDefault("APP_NAME", "Point")
	viper.SetDefault("APP_ENV", "development")
	viper.SetDefault("DEBUG", true)
	viper.SetDefault("HOST", "0.0.0.0")
	viper.SetDefault("PORT", 8000)
	viper.SetDefault("DATABASE_URL", "sqlite:./data/point.db")
	viper.SetDefault("STORAGE_PATH", "./data")
	viper.SetDefault("FRONTEND_DIR", "../frontend")
	viper.SetDefault("APP_VERSION", "1.0.0")
	viper.SetDefault("SESSION_EXPIRY_HOURS", 720)
	viper.SetDefault("SESSION_EXPIRY_PUBLIC_HOURS", 24)
	viper.SetDefault("MAX_UPLOAD_SIZE_MB", 50)
	viper.SetDefault("THUMBNAIL_WIDTH", 400)
	viper.SetDefault("THUMBNAIL_HEIGHT", 300)
	viper.SetDefault("JPEG_QUALITY", 85)

	err = viper.ReadInConfig()
	if err != nil {
		// It's okay if .env is missing, we use defaults and ENV vars
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return
		}
	}

	err = viper.Unmarshal(&config)
	
	// Clean database URL (remove python-specific aiosqlite prefix if present)
	if strings.Contains(config.DatabaseURL, "sqlite+aiosqlite:///") {
		config.DatabaseURL = strings.Replace(config.DatabaseURL, "sqlite+aiosqlite:///", "", 1)
	} else if strings.Contains(config.DatabaseURL, "sqlite:///") {
		config.DatabaseURL = strings.Replace(config.DatabaseURL, "sqlite:///", "", 1)
	}

	return
}
