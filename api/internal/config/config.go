package config

import (
	"errors"
	"fmt"
	"net"
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
	Host        string `mapstructure:"HOST"`
	Port        int    `mapstructure:"PORT"`
	DatabaseURL string `mapstructure:"DATABASE_URL"`
	StoragePath string `mapstructure:"STORAGE_PATH"`

	// MigrationBackup snapshots the database before a boot applies pending
	// migrations, and puts the snapshot back if they fail. Turning it off means
	// a failed migration leaves a half-migrated database with no way back — the
	// escape hatch exists for hosts too tight on disk to hold a second copy.
	// MigrationBackupKeep is how many snapshots to retain.
	MigrationBackup     bool `mapstructure:"MIGRATION_BACKUP"`
	MigrationBackupKeep int  `mapstructure:"MIGRATION_BACKUP_KEEP"`

	// MaxImageMegapixels bounds how many pixels an image may decode to. The
	// upload body limit bounds bytes on the wire, not pixels in memory: JPEG
	// compresses ~10-20x, so a 50 MB upload can carry well over 100 megapixels,
	// and Go decodes to RGBA at 4 bytes/pixel. The header is read first
	// (image.DecodeConfig) and an oversized image is rejected before any full
	// decode allocates. 0 disables the check.
	MaxImageMegapixels int `mapstructure:"MAX_IMAGE_MEGAPIXELS"`

	MaxImageWidth   int `mapstructure:"MAX_IMAGE_WIDTH"`
	JpegQuality     int `mapstructure:"JPEG_QUALITY"`
	AvatarSize      int `mapstructure:"AVATAR_SIZE"`
	MaxUploadSizeMB int `mapstructure:"MAX_UPLOAD_SIZE_MB"`
	// StorageQuotaMB is the media storage allowance the dashboard reports usage
	// against. Operator-set only (never a DB setting): on a hosted install the
	// quota is a property of the plan, not something the blog's admin may raise.
	// 0 means unlimited — the dashboard then shows bare usage with no bar.
	StorageQuotaMB int `mapstructure:"STORAGE_QUOTA_MB"`

	// PageCacheBudgetMB caps the on-disk cache of rendered public pages
	// (`<storage>/cache`). Nothing else bounds it: entries are only removed when
	// a content write drops the whole cache, so a rarely-published blog
	// accumulates one entry per (page, per_page) combination indefinitely.
	// Oldest entries are evicted first once the budget is passed; 0 disables
	// eviction.
	PageCacheBudgetMB int `mapstructure:"PAGE_CACHE_BUDGET_MB"`

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

	// Deployment-injected head markup and the CSP origins it needs. Empty by
	// default so the open-source engine embeds no third-party domain; a hosting
	// pipeline sets these per instance to add analytics/verification scripts.
	// HeadHTML is substituted into index.html's <!-- __HEAD_HTML__ --> slot;
	// CSPScriptSrc/CSPConnectSrc are appended to those CSP directives so an
	// injected external script can load and send data. See cmd/api/main.go.
	HeadHTML      string `mapstructure:"HEAD_HTML"`
	CSPScriptSrc  string `mapstructure:"CSP_SCRIPT_SRC"`
	CSPConnectSrc string `mapstructure:"CSP_CONNECT_SRC"`

	// MetricsEnabled starts a second HTTP listener serving Prometheus text
	// exposition at /metrics. Off by default, and off means off: no listener,
	// no goroutine, no instrumentation on the request path — a self-hoster who
	// sets nothing gets exactly the behaviour of a build without this feature.
	//
	// It is a separate listener rather than a route on the main port so there
	// is no auth decision to get wrong, no interaction with the gzip/CORS/CSP
	// chain, and no exemption to add to the public rate limiter. MetricsBind
	// therefore carries the whole access decision: it defaults to loopback, and
	// widening it publishes post counts, storage usage and error rates to
	// anything that can reach the port.
	MetricsEnabled bool   `mapstructure:"METRICS_ENABLED"`
	MetricsBind    string `mapstructure:"METRICS_BIND"`
	MetricsPort    int    `mapstructure:"METRICS_PORT"`
	// TrustedProxies extends the set of hops c.RealIP() will walk past when it
	// reads X-Forwarded-For: a comma-separated list of CIDR ranges, empty by
	// default. Loopback and private networks are always trusted, which covers
	// the usual deployment (a reverse proxy on the same host or the same
	// container network — its address is private, the walk skips it, and the
	// real client comes out). It does not cover a proxy or CDN whose address is
	// public: the walk stops at the edge address, so every visitor arriving
	// through one edge shares a rate-limit bucket and the session audit trail
	// records the edge instead of the visitor. An operator in that shape lists
	// their provider's ranges here.
	//
	// This is the trust boundary, so a too-wide value is the whole risk:
	// 0.0.0.0/0 trusts every peer and makes c.RealIP() entirely
	// client-controlled. Parsed by ParseTrustedProxies; LoadConfig rejects a
	// malformed list rather than starting with it half-applied.
	TrustedProxies string `mapstructure:"TRUSTED_PROXIES"`
}

// ParseTrustedProxies turns a TRUSTED_PROXIES value — a comma-separated list of
// CIDR ranges, with blanks tolerated — into the networks to trust. An empty
// string yields no networks and no error, which is the default and reproduces
// the loopback+private-only behaviour.
//
// Bare addresses are rejected along with everything else malformed: silently
// widening "203.0.113.7" to a /32 would be a guess about a trust boundary, and
// the error says what to write instead.
func ParseTrustedProxies(s string) ([]*net.IPNet, error) {
	var nets []*net.IPNet
	for _, entry := range strings.Split(s, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		_, ipNet, err := net.ParseCIDR(entry)
		if err != nil {
			return nil, fmt.Errorf("TRUSTED_PROXIES: %q is not a CIDR range "+
				"(a single address needs a prefix, e.g. 203.0.113.7/32)", entry)
		}
		nets = append(nets, ipNet)
	}
	return nets, nil
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
	v.SetDefault("MIGRATION_BACKUP", true)
	v.SetDefault("MIGRATION_BACKUP_KEEP", 3)
	v.SetDefault("FRONTEND_DIR", "../frontend")
	v.SetDefault("FRONTEND_DEBUG", false)
	v.SetDefault("THEMES_PATH", "")
	v.SetDefault("USER_THEMES_PATH", "")
	v.SetDefault("APP_VERSION", "")
	v.SetDefault("SESSION_EXPIRY_HOURS", 720)
	v.SetDefault("SESSION_EXPIRY_PUBLIC_HOURS", 24)
	v.SetDefault("MAX_UPLOAD_SIZE_MB", 50)
	// ~80 MP: above any panorama a blog needs, far below the ~400 MB RGBA
	// allocation a crafted header could otherwise force.
	v.SetDefault("MAX_IMAGE_MEGAPIXELS", 80)
	v.SetDefault("STORAGE_QUOTA_MB", 0)
	// 64 MB holds several hundred rendered pages — far more than a blog's live
	// key set — for a quarter of a percent of a 25 GB root volume. Kept as a
	// literal because services imports config, not the other way round; it must
	// stay in step with services.DefaultBudgetMB, which a test asserts.
	v.SetDefault("PAGE_CACHE_BUDGET_MB", 64)
	v.SetDefault("GEMINI_API_KEY", "")
	v.SetDefault("PHOTO_LIBRARY_PATH", "")
	v.SetDefault("SMTP_HOST", "")
	v.SetDefault("SMTP_PORT", 587)
	v.SetDefault("SMTP_USERNAME", "")
	v.SetDefault("SMTP_PASSWORD", "")
	v.SetDefault("SMTP_FROM", "")
	v.SetDefault("APP_URL", "")
	v.SetDefault("MCP_BASE_URL", "")
	v.SetDefault("HEAD_HTML", "")
	v.SetDefault("CSP_SCRIPT_SRC", "")
	v.SetDefault("CSP_CONNECT_SRC", "")
	v.SetDefault("METRICS_ENABLED", false)
	// Loopback, so enabling metrics never publishes them by accident: a scraper
	// on another host needs either a reverse proxy in front of this port or an
	// explicit widening here.
	v.SetDefault("METRICS_BIND", "127.0.0.1")
	// 9101 rather than 9090, which belongs to the Prometheus server itself and
	// is the port an operator is most likely to already have in use.
	v.SetDefault("METRICS_PORT", 9101)
	v.SetDefault("TRUSTED_PROXIES", "")

	err = v.ReadInConfig()
	if err != nil {
		// It's okay if .env is missing, we use defaults and ENV vars
		var notFound viper.ConfigFileNotFoundError
		if !errors.As(err, &notFound) {
			return
		}
	}

	err = v.Unmarshal(&config)
	if err != nil {
		return
	}

	// Fail on a malformed proxy list here rather than dropping the bad entry at
	// server start: a trust boundary that silently ends up narrower than the
	// operator wrote is how everyone behind a CDN edge lands in one rate-limit
	// bucket, with nothing in the log to say why.
	if _, err = ParseTrustedProxies(config.TrustedProxies); err != nil {
		return
	}

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
