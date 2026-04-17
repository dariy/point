package services

import (
	"context"
	"testing"
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
