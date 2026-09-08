//go:build !unit

package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"point-api/internal/models"
	"point-api/internal/plugins"
	"point-api/internal/repository"
)

// newAPIKeyServiceWithPlugin builds the service with the api-keys plugin turned
// on, which is what the lifecycle tests below assume. The plugin ships disabled
// (DefaultEnabled: false), and ValidateAPIKey refuses every key while it is off
// — see TestApiKeyService_ValidateRefusedWhenPluginDisabled.
func newAPIKeyServiceWithPlugin(t *testing.T, repo repository.Repository) *ApiKeyService {
	t.Helper()
	settings := NewSettingsService(repo)
	if err := settings.SetSetting(context.Background(), plugins.EnabledKey("api-keys"), "true", "string"); err != nil {
		t.Fatalf("enable api-keys plugin: %v", err)
	}
	return NewApiKeyService(repo, settings)
}

func TestApiKeyService_Lifecycle(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	service := newAPIKeyServiceWithPlugin(t, repo)
	ctx := context.Background()

	// Create a test user
	user, _ := repo.CreateUser(ctx, models.CreateUserParams{
		Username:     "testuser",
		Email:        "test@example.com",
		PasswordHash: "hash",
		DisplayName:  "Test User",
	})

	// 1. Generate API Key
	rawKey, apiKey, err := service.GenerateAPIKey(ctx, user.ID, "test-key", nil)
	if err != nil {
		t.Fatalf("GenerateAPIKey failed: %v", err)
	}
	if rawKey == "" {
		t.Error("expected non-empty raw key")
	}
	if apiKey.Name != "test-key" {
		t.Errorf("expected key name test-key, got %s", apiKey.Name)
	}

	// 2. Validate API Key
	validated, err := service.ValidateAPIKey(ctx, rawKey)
	if err != nil {
		t.Errorf("ValidateAPIKey failed: %v", err)
	}
	if validated.ID != apiKey.ID {
		t.Errorf("expected key ID %d, got %d", apiKey.ID, validated.ID)
	}
	if validated.UserID != user.ID {
		t.Errorf("expected user ID %d, got %d", user.ID, validated.UserID)
	}

	// 3. List Keys
	keys, err := service.ListKeys(ctx, user.ID)
	if err != nil {
		t.Errorf("ListKeys failed: %v", err)
	}
	if len(keys) != 1 {
		t.Errorf("expected 1 key, got %d", len(keys))
	}

	// 4. Revoke Key
	err = service.RevokeKey(ctx, apiKey.ID, user.ID)
	if err != nil {
		t.Errorf("RevokeKey failed: %v", err)
	}

	// 5. Validate Revoked Key
	// Our SQL query filters by revoked_at IS NULL, so it should return ErrNoRows -> "invalid API key"
	_, err = service.ValidateAPIKey(ctx, rawKey)
	if err == nil {
		t.Error("expected error for revoked key, got nil")
	}

	// 6. Delete Key
	err = service.DeleteKey(ctx, apiKey.ID, user.ID)
	if err != nil {
		t.Errorf("DeleteKey failed: %v", err)
	}
	keys, _ = service.ListKeys(ctx, user.ID)
	if len(keys) != 0 {
		t.Errorf("expected 0 keys after deletion, got %d", len(keys))
	}
}

func TestApiKeyService_Expiry(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	service := newAPIKeyServiceWithPlugin(t, repo)
	ctx := context.Background()

	user, _ := repo.CreateUser(ctx, models.CreateUserParams{
		Username: "u", Email: "e", PasswordHash: "h", DisplayName: "D",
	})

	// Expired key
	expiresAt := time.Now().Add(-1 * time.Hour)
	rawKey, _, _ := service.GenerateAPIKey(ctx, user.ID, "expired", &expiresAt)

	_, err := service.ValidateAPIKey(ctx, rawKey)
	if err == nil || err.Error() != "API key expired" {
		t.Errorf("expected API key expired error, got %v", err)
	}
}

// Disabling the api-keys plugin must stop existing keys from authenticating,
// not merely hide the management routes: a key minted while the plugin was on
// used to keep working after the admin turned it off.
func TestApiKeyService_ValidateRefusedWhenPluginDisabled(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	settings := NewSettingsService(repo)
	service := NewApiKeyService(repo, settings)

	user, _ := repo.CreateUser(ctx, models.CreateUserParams{
		Username: "toggle", Email: "toggle@example.com", PasswordHash: "h", DisplayName: "Toggle",
	})

	if err := settings.SetSetting(ctx, plugins.EnabledKey("api-keys"), "true", "string"); err != nil {
		t.Fatalf("enable api-keys plugin: %v", err)
	}
	rawKey, _, err := service.GenerateAPIKey(ctx, user.ID, "toggle-key", nil)
	if err != nil {
		t.Fatalf("GenerateAPIKey: %v", err)
	}
	if _, err := service.ValidateAPIKey(ctx, rawKey); err != nil {
		t.Fatalf("key must validate while the plugin is enabled: %v", err)
	}

	if err := settings.SetSetting(ctx, plugins.EnabledKey("api-keys"), "false", "string"); err != nil {
		t.Fatalf("disable api-keys plugin: %v", err)
	}
	if _, err := service.ValidateAPIKey(ctx, rawKey); err == nil {
		t.Fatal("a key must stop authenticating once the api-keys plugin is disabled")
	} else if !errors.Is(err, ErrUnauthenticated) {
		t.Errorf("expected ErrUnauthenticated, got %v", err)
	}

	// And turning it back on restores the key: the gate reads the toggle on
	// every call, so nothing about the key itself was invalidated.
	if err := settings.SetSetting(ctx, plugins.EnabledKey("api-keys"), "true", "string"); err != nil {
		t.Fatalf("re-enable api-keys plugin: %v", err)
	}
	if _, err := service.ValidateAPIKey(ctx, rawKey); err != nil {
		t.Errorf("key must validate again once the plugin is re-enabled: %v", err)
	}
}
