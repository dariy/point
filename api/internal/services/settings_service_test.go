package services

import (
	"context"
	"testing"

	"point-api/internal/config"
)

func TestSettingsService_CRUD(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	service := NewSettingsService(repo)
	ctx := context.Background()

	// Test SetSetting
	err := service.SetSetting(ctx, "site_title", "My Blog", "string")
	if err != nil {
		t.Fatalf("SetSetting failed: %v", err)
	}

	// Test GetSetting
	val, err := service.GetSetting(ctx, "site_title", "Default")
	if err != nil {
		t.Fatalf("GetSetting failed: %v", err)
	}
	if val != "My Blog" {
		t.Errorf("expected My Blog, got %s", val)
	}

	// Test GetSetting with default
	val, err = service.GetSetting(ctx, "nonexistent", "Default")
	if err != nil {
		t.Fatalf("GetSetting failed: %v", err)
	}
	if val != "Default" {
		t.Errorf("expected Default, got %s", val)
	}

	// Test GetAllSettings
	settings, err := service.GetAllSettings(ctx)
	if err != nil {
		t.Fatalf("GetAllSettings failed: %v", err)
	}
	if settings["site_title"] != "My Blog" {
		t.Errorf("expected site_title My Blog, got %s", settings["site_title"])
	}
}

func TestSettingsService_GetConfigSettingEnvValue(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	svc := NewSettingsService(repo)
	v := svc.GetConfigSetting(ctx, "some_key", 42, 0)
	if v != 42 {
		t.Errorf("expected 42, got %d", v)
	}

	_ = svc.SetSetting(ctx, "port_key", "8080", "string")
	v2 := svc.GetConfigSetting(ctx, "port_key", 0, 9999)
	if v2 != 8080 {
		t.Errorf("expected 8080, got %d", v2)
	}
}

func TestSettingsService_GetSetting_Error(t *testing.T) {
	repo := setupTestDB(t)
	svc := NewSettingsService(repo)
	ctx := context.Background()

	_ = repo.Close()

	val, _ := svc.GetSetting(ctx, "any_key", "default")
	if val != "default" {
		t.Errorf("expected default, got %q", val)
	}
}

func TestSettingsService_GetSetting_NullValue(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	svc := NewSettingsService(repo)
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO blog_settings (key, value, value_type) VALUES ('nullkey', NULL, 'string')`)

	val, _ := svc.GetSetting(ctx, "nullkey", "fallback")
	if val != "fallback" {
		t.Errorf("GetSetting NULL value: expected fallback, got %q", val)
	}
}

func TestSettingsService_Secrets(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	svc := NewSettingsService(repo)
	ctx := context.Background()

	// SetSecret / GetSecret round-trip.
	if err := svc.SetSecret(ctx, "gemini_api_key", "abc123"); err != nil {
		t.Fatalf("SetSecret: %v", err)
	}
	val, err := svc.GetSecret(ctx, "gemini_api_key")
	if err != nil {
		t.Fatalf("GetSecret: %v", err)
	}
	if val != "abc123" {
		t.Errorf("expected abc123, got %q", val)
	}

	// SecretIsSet returns true when value is non-empty.
	if !svc.SecretIsSet(ctx, "gemini_api_key") {
		t.Error("SecretIsSet should be true")
	}

	// SecretIsSet returns false for unknown key.
	if svc.SecretIsSet(ctx, "no_such_key") {
		t.Error("SecretIsSet should be false for missing key")
	}

	// GetSecret on missing key returns empty string, not error.
	missing, err := svc.GetSecret(ctx, "no_such_key")
	if err == nil && missing != "" {
		t.Errorf("expected empty for missing key, got %q", missing)
	}

	// Upsert overwrites.
	_ = svc.SetSecret(ctx, "gemini_api_key", "new_val")
	v2, _ := svc.GetSecret(ctx, "gemini_api_key")
	if v2 != "new_val" {
		t.Errorf("expected new_val after upsert, got %q", v2)
	}
}

func TestSettingsService_EnsureSecretKey_Generate(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	svc := NewSettingsService(repo)
	ctx := context.Background()

	cfg := &config.Config{} // SecretKey is empty
	if err := svc.EnsureSecretKey(ctx, cfg); err != nil {
		t.Fatalf("EnsureSecretKey: %v", err)
	}
	if cfg.SecretKey == "" {
		t.Error("expected cfg.SecretKey to be populated")
	}
	if len(cfg.SecretKey) != 64 { // 32 bytes → 64 hex chars
		t.Errorf("expected 64-char key, got %d", len(cfg.SecretKey))
	}
	// Persisted in blog_secrets.
	stored, _ := svc.GetSecret(ctx, "_secret_key")
	if stored != cfg.SecretKey {
		t.Error("stored key does not match cfg.SecretKey")
	}
}

func TestSettingsService_EnsureSecretKey_LoadExisting(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	svc := NewSettingsService(repo)
	ctx := context.Background()

	_ = svc.SetSecret(ctx, "_secret_key", "existing_key_value")

	cfg := &config.Config{}
	if err := svc.EnsureSecretKey(ctx, cfg); err != nil {
		t.Fatalf("EnsureSecretKey: %v", err)
	}
	if cfg.SecretKey != "existing_key_value" {
		t.Errorf("expected existing_key_value, got %q", cfg.SecretKey)
	}
}

func TestSettingsService_EnsureSecretKey_EnvWins(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	svc := NewSettingsService(repo)
	ctx := context.Background()

	cfg := &config.Config{SecretKey: "env_key"}
	if err := svc.EnsureSecretKey(ctx, cfg); err != nil {
		t.Fatalf("EnsureSecretKey: %v", err)
	}
	if cfg.SecretKey != "env_key" {
		t.Errorf("env key should win, got %q", cfg.SecretKey)
	}
}
