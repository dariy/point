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
	defer os.RemoveAll(tmpDir)

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
	defer os.RemoveAll(tmpDir)

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
