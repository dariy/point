package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"testing"

	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/services"
)

func newRepoWithUser(t *testing.T, rawPassword []byte) *repository.Repository {
	t.Helper()
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatalf("NewRepository: %v", err)
	}
	t.Cleanup(func() { _ = repo.Close() })

	// AuthenticatePassword does sha256(rawPassword) → hex, then checks argon2id(hex).
	h := sha256.Sum256(rawPassword)
	hexPass := hex.EncodeToString(h[:])
	hash, err := services.HashPassword(hexPass)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}

	_, err = repo.CreateUser(context.Background(), models.CreateUserParams{
		Username:     "owner",
		Email:        "owner@test.com",
		PasswordHash: hash,
		DisplayName:  "Test Owner",
	})
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	return repo
}

func TestExecCreateAPIKey_Success(t *testing.T) {
	rawPass := []byte("supersecret")
	repo := newRepoWithUser(t, rawPass)
	cfg := &config.Config{StoragePath: t.TempDir()}
	svcs := initServices(cfg, repo)

	if err := execCreateAPIKey(svcs, "my-key", rawPass); err != nil {
		t.Fatalf("execCreateAPIKey returned unexpected error: %v", err)
	}
}

func TestExecCreateAPIKey_WrongPassword(t *testing.T) {
	rawPass := []byte("supersecret")
	repo := newRepoWithUser(t, rawPass)
	cfg := &config.Config{StoragePath: t.TempDir()}
	svcs := initServices(cfg, repo)

	err := execCreateAPIKey(svcs, "my-key", []byte("wrongpassword"))
	if err == nil {
		t.Fatal("expected error for wrong password, got nil")
	}
}

func TestExecCreateAPIKey_KeyStoredAfterCreate(t *testing.T) {
	rawPass := []byte("supersecret")
	repo := newRepoWithUser(t, rawPass)
	cfg := &config.Config{StoragePath: t.TempDir()}
	svcs := initServices(cfg, repo)

	if err := execCreateAPIKey(svcs, "ci-key", rawPass); err != nil {
		t.Fatalf("execCreateAPIKey: %v", err)
	}

	// Confirm the key appears in the list for the user.
	user, err := repo.GetFirstUser(context.Background())
	if err != nil {
		t.Fatalf("GetFirstUser: %v", err)
	}
	keys, err := svcs.ApiKey.ListKeys(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("ListKeys: %v", err)
	}
	if len(keys) != 1 {
		t.Fatalf("expected 1 key, got %d", len(keys))
	}
	if keys[0].Name != "ci-key" {
		t.Errorf("expected key name %q, got %q", "ci-key", keys[0].Name)
	}
}
