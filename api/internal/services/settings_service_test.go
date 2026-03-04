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
