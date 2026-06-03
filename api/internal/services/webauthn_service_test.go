package services

import (
	"point-api/internal/models"
	"point-api/internal/repository"
	"testing"
)

func TestNewWebAuthnService_EmptyRPID(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	_, err := NewWebAuthnService(repo, "", "Test Blog", "https://example.com")
	if err == nil {
		t.Error("expected error for empty rpID")
	}
}

func TestNewWebAuthnService_Success(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	svc, err := NewWebAuthnService(repo, "example.com", "Test Blog", "https://example.com")
	if err != nil {
		t.Fatalf("NewWebAuthnService: %v", err)
	}
	_ = svc
}

func TestWebAuthnUser_Methods(t *testing.T) {
	u := WebAuthnUser{
		User: models.User{
			ID:          42,
			Username:    "testuser",
			DisplayName: "Test User",
		},
		Credentials: []repository.WebAuthnCredential{
			{
				CredentialID: []byte("credid"),
				PublicKey:    []byte("pubkey"),
				AAGUID:       []byte("aaguid"),
				SignCount:    5,
			},
		},
	}

	id := u.WebAuthnID()
	if len(id) != 8 {
		t.Errorf("WebAuthnID should be 8 bytes, got %d", len(id))
	}

	if u.WebAuthnName() != "testuser" {
		t.Errorf("WebAuthnName: expected 'testuser', got %q", u.WebAuthnName())
	}

	if u.WebAuthnDisplayName() != "Test User" {
		t.Errorf("WebAuthnDisplayName: expected 'Test User', got %q", u.WebAuthnDisplayName())
	}

	u2 := WebAuthnUser{User: models.User{ID: 1, Username: "u", DisplayName: ""}}
	if u2.WebAuthnDisplayName() != "u" {
		t.Errorf("expected fallback to username, got %q", u2.WebAuthnDisplayName())
	}

	creds := u.WebAuthnCredentials()
	if len(creds) != 1 {
		t.Errorf("expected 1 credential, got %d", len(creds))
	}
}
