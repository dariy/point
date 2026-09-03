package config

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/spf13/viper"
)

// hermeticEnv clears every variable LoadConfig reads for the duration of the
// test. LoadConfig calls viper's AutomaticEnv, so an exported DATABASE_URL or
// STORAGE_PATH outranks both the defaults and the fixture .env a test writes —
// and a developer running the suite from a checkout with a .env and direnv has
// exactly those exported. Without this, the path tests below pass on CI and
// fail on the machine the engine is actually developed on.
//
// Clearing rather than unsetting is deliberate: t.Setenv restores the previous
// value at the end of the test, and viper treats an empty variable as unset
// (allowEmptyEnv defaults to false). The keys come off Config's mapstructure
// tags so a new field cannot quietly escape the cleanup.
func hermeticEnv(t *testing.T) {
	t.Helper()
	typ := reflect.TypeOf(Config{})
	for i := range typ.NumField() {
		if key := typ.Field(i).Tag.Get("mapstructure"); key != "" {
			t.Setenv(key, "")
		}
	}
}

// TestDeploymentInjectionEnv verifies the deployment-driven head/CSP knobs load
// from the container environment (how the hosting pipeline supplies them).
func TestDeploymentInjectionEnv(t *testing.T) {
	viper.Reset()
	hermeticEnv(t)
	tmpDir := t.TempDir()
	head := `<script defer src="https://stats.example/s.js" data-website-id="abc"></script>`
	t.Setenv("HEAD_HTML", head)
	t.Setenv("CSP_SCRIPT_SRC", "https://stats.example")
	t.Setenv("CSP_CONNECT_SRC", "https://stats.example")

	config, err := LoadConfig(tmpDir)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if config.HeadHTML != head {
		t.Errorf("HeadHTML = %q, want %q", config.HeadHTML, head)
	}
	if config.CSPScriptSrc != "https://stats.example" {
		t.Errorf("CSPScriptSrc = %q", config.CSPScriptSrc)
	}
	if config.CSPConnectSrc != "https://stats.example" {
		t.Errorf("CSPConnectSrc = %q", config.CSPConnectSrc)
	}
}

// The page cache budget is the only thing standing between a rarely-published
// blog and a cache directory that grows until the volume is full, so both its
// default and the operator's override have to actually arrive.
func TestPageCacheBudget(t *testing.T) {
	viper.Reset()
	hermeticEnv(t)

	config, err := LoadConfig(t.TempDir())
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if config.PageCacheBudgetMB != 64 {
		t.Errorf("default PageCacheBudgetMB = %d, want 64", config.PageCacheBudgetMB)
	}

	t.Setenv("PAGE_CACHE_BUDGET_MB", "256")
	config, err = LoadConfig(t.TempDir())
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if config.PageCacheBudgetMB != 256 {
		t.Errorf("PageCacheBudgetMB = %d, want the 256 from the environment", config.PageCacheBudgetMB)
	}
}

func TestLoadConfig(t *testing.T) {
	viper.Reset()
	hermeticEnv(t)
	tmpDir, err := os.MkdirTemp("", "config-test")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = os.RemoveAll(tmpDir)
	}()

	envContent := `
APP_NAME=TestApp
PORT=9000
DATABASE_URL=sqlite:///./test.db
APP_URL=https://blog.example.com
`
	err = os.WriteFile(filepath.Join(tmpDir, ".env"), []byte(envContent), 0644)
	if err != nil {
		t.Fatal(err)
	}

	config, err := LoadConfig(tmpDir)
	if err != nil {
		t.Fatalf("failed to load config: %v", err)
	}

	if config.AppName != "TestApp" {
		t.Errorf("expected AppName TestApp, got %s", config.AppName)
	}
	if config.Port != 9000 {
		t.Errorf("expected Port 9000, got %d", config.Port)
	}
	if config.DatabaseURL != "./test.db" {
		t.Errorf("expected DatabaseURL ./test.db, got %s", config.DatabaseURL)
	}
	if config.AppURL != "https://blog.example.com" {
		t.Errorf("expected AppURL https://blog.example.com, got %s", config.AppURL)
	}
}

func TestLoadConfigDefaults(t *testing.T) {
	viper.Reset()
	hermeticEnv(t)
	// Empty temp dir should load defaults
	tmpDir, err := os.MkdirTemp("", "config-test-defaults")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = os.RemoveAll(tmpDir)
	}()

	config, err := LoadConfig(tmpDir)
	if err != nil {
		t.Fatalf("failed to load config: %v", err)
	}

	if config.AppName != "Point" {
		t.Errorf("expected default AppName Point, got %s", config.AppName)
	}
	if config.Port != 8000 {
		t.Errorf("expected default Port 8000, got %d", config.Port)
	}
}

func TestThemesPathDerivation(t *testing.T) {
	viper.Reset()
	hermeticEnv(t)
	tmpDir, err := os.MkdirTemp("", "config-test-themes")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = os.RemoveAll(tmpDir)
	}()

	// Test case 1: Neither FRONTEND_DIR nor THEMES_PATH set
	config, _ := LoadConfig(tmpDir)
	expectedThemesPath := filepath.Join("../frontend", "themes")
	if config.ThemesPath != expectedThemesPath {
		t.Errorf("expected ThemesPath %s, got %s", expectedThemesPath, config.ThemesPath)
	}

	// Test case 2: FRONTEND_DIR set, THEMES_PATH not set
	viper.Reset()
	t.Setenv("FRONTEND_DIR", "/custom/frontend")
	config, _ = LoadConfig(tmpDir)
	expectedThemesPath = "/custom/frontend/themes"
	if config.ThemesPath != expectedThemesPath {
		t.Errorf("expected ThemesPath %s, got %s", expectedThemesPath, config.ThemesPath)
	}

	// Test case 3: Both set
	viper.Reset()
	t.Setenv("FRONTEND_DIR", "/custom/frontend")
	t.Setenv("THEMES_PATH", "/custom/themes")
	config, _ = LoadConfig(tmpDir)
	expectedThemesPath = "/custom/themes"
	if config.ThemesPath != expectedThemesPath {
		t.Errorf("expected ThemesPath %s, got %s", expectedThemesPath, config.ThemesPath)
	}
}

func TestSmartPathDetection(t *testing.T) {
	viper.Reset()
	hermeticEnv(t)
	// Create a temp dir to act as our "working directory"
	wd, err := os.MkdirTemp("", "config-test-wd")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.RemoveAll(wd) }()

	// Change working directory to our temp wd
	oldWd, _ := os.Getwd()
	_ = os.Chdir(wd)
	defer func() { _ = os.Chdir(oldWd) }()

	// Case 1: Run from root (frontend exists)
	_ = os.Mkdir("frontend", 0755)
	_ = os.Mkdir("data", 0755)

	config, err := LoadConfig(".")
	if err != nil {
		t.Fatalf("failed to load config: %v", err)
	}

	if config.FrontendDir != "frontend" {
		t.Errorf("expected FrontendDir 'frontend', got %s", config.FrontendDir)
	}
	if config.StoragePath != "./data" {
		t.Errorf("expected StoragePath './data', got %s", config.StoragePath)
	}
	if config.DatabaseURL != "./data/point.db" {
		t.Errorf("expected DatabaseURL './data/point.db', got %s", config.DatabaseURL)
	}

	// Case 2: Run from 'api' (frontend does not exist here, but ../frontend does)
	_ = os.RemoveAll("frontend")
	_ = os.RemoveAll("data")
	_ = os.Mkdir("api", 0755)
	_ = os.Mkdir("frontend", 0755)
	_ = os.Mkdir("data", 0755)
	_ = os.Chdir("api")
	// Now wd is <temp>/api. ../frontend and ../data exist.

	viper.Reset()
	config, err = LoadConfig(".")
	if err != nil {
		t.Fatalf("failed to load config: %v", err)
	}

	if config.FrontendDir != "../frontend" {
		t.Errorf("expected FrontendDir '../frontend', got %s", config.FrontendDir)
	}
	if config.StoragePath != "../data" {
		t.Errorf("expected StoragePath '../data', got %s", config.StoragePath)
	}
	if config.DatabaseURL != "../data/point.db" {
		t.Errorf("expected DatabaseURL '../data/point.db', got %s", config.DatabaseURL)
	}
}

func TestUserThemesPathDerivation(t *testing.T) {
	viper.Reset()
	hermeticEnv(t)
	tmpDir, err := os.MkdirTemp("", "config-test-user-themes")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = os.RemoveAll(tmpDir)
	}()

	// Default: derived from STORAGE_PATH default
	config, _ := LoadConfig(tmpDir)
	expectedUserThemesPath := filepath.Join("./data", "themes")
	if config.UserThemesPath != expectedUserThemesPath {
		t.Errorf("expected UserThemesPath %s, got %s", expectedUserThemesPath, config.UserThemesPath)
	}

	// STORAGE_PATH set explicitly
	viper.Reset()
	t.Setenv("STORAGE_PATH", "/data")
	config, _ = LoadConfig(tmpDir)
	if config.UserThemesPath != "/data/themes" {
		t.Errorf("expected UserThemesPath /data/themes, got %s", config.UserThemesPath)
	}

	// USER_THEMES_PATH set explicitly overrides derivation
	viper.Reset()
	t.Setenv("STORAGE_PATH", "/data")
	t.Setenv("USER_THEMES_PATH", "/custom/user-themes")
	config, _ = LoadConfig(tmpDir)
	if config.UserThemesPath != "/custom/user-themes" {
		t.Errorf("expected UserThemesPath /custom/user-themes, got %s", config.UserThemesPath)
	}
}

// TRUSTED_PROXIES is the trust boundary for c.RealIP(), so both ends matter:
// the default must not widen it, and a typo must not be silently narrowed into
// a boundary the operator did not write.
func TestParseTrustedProxies(t *testing.T) {
	if nets, err := ParseTrustedProxies(""); err != nil || len(nets) != 0 {
		t.Errorf("empty: got %v, %v; want no networks and no error", nets, err)
	}

	nets, err := ParseTrustedProxies(" 173.245.48.0/20, 2400:cb00::/32 ,")
	if err != nil {
		t.Fatalf("ParseTrustedProxies: %v", err)
	}
	if len(nets) != 2 {
		t.Fatalf("got %d networks, want 2 (blanks skipped, spaces trimmed)", len(nets))
	}
	if got := nets[0].String(); got != "173.245.48.0/20" {
		t.Errorf("nets[0] = %q, want 173.245.48.0/20", got)
	}
	if got := nets[1].String(); got != "2400:cb00::/32" {
		t.Errorf("nets[1] = %q, want 2400:cb00::/32", got)
	}

	for _, bad := range []string{"203.0.113.7", "not-an-address", "10.0.0.0/33"} {
		if _, err := ParseTrustedProxies("192.0.2.0/24," + bad); err == nil {
			t.Errorf("ParseTrustedProxies(%q): want error, got nil", bad)
		}
	}
}

// A malformed list must stop the process at load, not start a server whose
// trust boundary is quietly narrower than the deploy config says.
func TestLoadConfigRejectsBadTrustedProxies(t *testing.T) {
	viper.Reset()
	hermeticEnv(t)
	t.Setenv("TRUSTED_PROXIES", "173.245.48.0/20,garbage")

	if _, err := LoadConfig(t.TempDir()); err == nil {
		t.Fatal("LoadConfig accepted a malformed TRUSTED_PROXIES")
	}

	viper.Reset()
	t.Setenv("TRUSTED_PROXIES", "173.245.48.0/20")
	config, err := LoadConfig(t.TempDir())
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if config.TrustedProxies != "173.245.48.0/20" {
		t.Errorf("TrustedProxies = %q", config.TrustedProxies)
	}
}
