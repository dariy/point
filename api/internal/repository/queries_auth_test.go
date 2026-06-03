package repository

import (
	"context"
	"testing"

	"point-api/internal/models"
)

func TestRepository_DeleteSession(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	uid, _ := insertUserAndPost(t, repo, "sess-post", "published")
	// Insert session (ip_address and user_agent are NOT NULL in schema)
	_, err := repo.DB().Exec(`INSERT INTO sessions (id, user_id, token, ip_address, user_agent, expires_at) VALUES (10, ?, 'tok99', '127.0.0.1', 'test-agent', datetime('now','+1 hour'))`, uid)
	if err != nil {
		t.Fatalf("insert session failed: %v", err)
	}

	// Delete with wrong user_id — session not found
	err = repo.DeleteSession(ctx, models.DeleteSessionParams{ID: 10, UserID: 99999})
	if err == nil {
		t.Error("expected error for wrong user_id")
	}

	// Delete correctly
	err = repo.DeleteSession(ctx, models.DeleteSessionParams{ID: 10, UserID: uid})
	if err != nil {
		t.Fatalf("DeleteSession failed: %v", err)
	}
}

func TestRepository_DeleteSessionPaths(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	err := repo.DeleteSession(ctx, models.DeleteSessionParams{ID: 9999, UserID: 1})
	if err == nil {
		t.Error("expected error for non-existent session")
	}

	_, _ = repo.DB().Exec(`INSERT INTO users (id,username,email,password_hash,display_name) VALUES (1,'u','u@t.com','h','U')`)
	res, _ := repo.DB().Exec(`INSERT INTO sessions (user_id,token,ip_address,user_agent,expires_at) VALUES (1,'tok','127.0.0.1','ua',datetime('now','+1 hour'))`)
	sessionID, _ := res.LastInsertId()
	err = repo.DeleteSession(ctx, models.DeleteSessionParams{ID: sessionID, UserID: 1})
	if err != nil {
		t.Errorf("DeleteSession (found): %v", err)
	}
}

func TestRepository_APIKeys(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	ctx := context.Background()

	user, _ := repo.CreateUser(ctx, models.CreateUserParams{
		Username:     "keyuser",
		Email:        "keyuser@example.com",
		PasswordHash: "hash",
		DisplayName:  "Key User",
	})

	// Create
	apiKey, err := repo.CreateAPIKey(ctx, models.CreateAPIKeyParams{
		UserID:  user.ID,
		Name:    "Test Key",
		KeyHash: "testhash123",
	})
	if err != nil {
		t.Fatalf("CreateAPIKey failed: %v", err)
	}

	// List
	keys, err := repo.ListAPIKeysByUser(ctx, user.ID)
	if err != nil || len(keys) != 1 {
		t.Fatalf("ListAPIKeysByUser failed or returned wrong count: %v", err)
	}

	// Get by hash
	gotKey, err := repo.GetAPIKeyByHash(ctx, "testhash123")
	if err != nil || gotKey.ID != apiKey.ID {
		t.Fatalf("GetAPIKeyByHash failed or returned wrong key: %v", err)
	}

	// Touch
	err = repo.TouchAPIKeyLastUsed(ctx, apiKey.ID)
	if err != nil {
		t.Fatalf("TouchAPIKeyLastUsed failed: %v", err)
	}

	// Revoke
	err = repo.RevokeAPIKey(ctx, models.RevokeAPIKeyParams{ID: apiKey.ID, UserID: user.ID})
	if err != nil {
		t.Fatalf("RevokeAPIKey failed: %v", err)
	}

	// Delete
	err = repo.DeleteAPIKey(ctx, models.DeleteAPIKeyParams{ID: apiKey.ID, UserID: user.ID})
	if err != nil {
		t.Fatalf("DeleteAPIKey failed: %v", err)
	}
}

func TestRepository_DeleteSecret(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO blog_secrets (key, value) VALUES ('k1', 'v1')`)
	if err := repo.DeleteSecret(ctx, "k1"); err != nil {
		t.Fatalf("DeleteSecret failed: %v", err)
	}
}

func TestRepository_WebAuthnCredentials(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	uid, _ := insertUserAndPost(t, repo, "wa-post", "published")

	// Create
	credID := []byte("cred1")
	pubKey := []byte("pub1")
	aaguid := []byte("aaguid1")
	cred, err := repo.CreateWebAuthnCredential(ctx, uid, credID, pubKey, aaguid, 1, true, true)
	if err != nil {
		t.Fatalf("CreateWebAuthnCredential failed: %v", err)
	}
	if cred.UserID != uid {
		t.Errorf("expected userID %d, got %d", uid, cred.UserID)
	}

	// Get by user
	creds, err := repo.GetWebAuthnCredentialsByUserID(ctx, uid)
	if err != nil || len(creds) != 1 {
		t.Fatalf("GetWebAuthnCredentialsByUserID failed: %v", err)
	}

	// Get by credID
	got, err := repo.GetWebAuthnCredentialByCredentialID(ctx, credID)
	if err != nil || got.ID != cred.ID {
		t.Fatalf("GetWebAuthnCredentialByCredentialID failed: %v", err)
	}

	// Update
	if err := repo.UpdateWebAuthnCredential(ctx, credID, 2, false); err != nil {
		t.Fatalf("UpdateWebAuthnCredential failed: %v", err)
	}

	// Delete
	if err := repo.DeleteWebAuthnCredentialByUserID(ctx, uid); err != nil {
		t.Fatalf("DeleteWebAuthnCredentialByUserID failed: %v", err)
	}
}
