//go:build integration

package services

import (
	"context"
	"testing"
	"time"

	"point-api/internal/models"
)

func TestApiKeyService_Lifecycle(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	service := NewApiKeyService(repo)
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

	service := NewApiKeyService(repo)
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
