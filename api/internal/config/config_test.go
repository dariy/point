package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/spf13/viper"
)

func TestLoadConfig(t *testing.T) {
	viper.Reset()
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
}

func TestLoadConfigDefaults(t *testing.T) {
	viper.Reset()
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
	_ = os.Setenv("FRONTEND_DIR", "/custom/frontend")
	defer func() { _ = os.Unsetenv("FRONTEND_DIR") }()
	config, _ = LoadConfig(tmpDir)
	expectedThemesPath = "/custom/frontend/themes"
	if config.ThemesPath != expectedThemesPath {
		t.Errorf("expected ThemesPath %s, got %s", expectedThemesPath, config.ThemesPath)
	}

	// Test case 3: Both set
	viper.Reset()
	_ = os.Setenv("FRONTEND_DIR", "/custom/frontend")
	_ = os.Setenv("THEMES_PATH", "/custom/themes")
	defer func() { _ = os.Unsetenv("THEMES_PATH") }()
	config, _ = LoadConfig(tmpDir)
	expectedThemesPath = "/custom/themes"
	if config.ThemesPath != expectedThemesPath {
		t.Errorf("expected ThemesPath %s, got %s", expectedThemesPath, config.ThemesPath)
	}
}

func TestUserThemesPathDerivation(t *testing.T) {
	viper.Reset()
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
	_ = os.Setenv("STORAGE_PATH", "/data")
	defer func() { _ = os.Unsetenv("STORAGE_PATH") }()
	config, _ = LoadConfig(tmpDir)
	if config.UserThemesPath != "/data/themes" {
		t.Errorf("expected UserThemesPath /data/themes, got %s", config.UserThemesPath)
	}

	// USER_THEMES_PATH set explicitly overrides derivation
	viper.Reset()
	_ = os.Setenv("STORAGE_PATH", "/data")
	_ = os.Setenv("USER_THEMES_PATH", "/custom/user-themes")
	defer func() { _ = os.Unsetenv("USER_THEMES_PATH") }()
	config, _ = LoadConfig(tmpDir)
	if config.UserThemesPath != "/custom/user-themes" {
		t.Errorf("expected UserThemesPath /custom/user-themes, got %s", config.UserThemesPath)
	}
}
