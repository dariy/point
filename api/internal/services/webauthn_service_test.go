package services

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"point-api/internal/models"
	"point-api/internal/repository"

	"github.com/go-webauthn/webauthn/protocol"
)

// Login is usernameless (BeginDiscoverableLogin sends an empty allowCredentials
// list), which only works if registration created a client-side discoverable
// credential. Without residentKey=required the authenticator stores a
// server-side credential and reports "no passkey found" at login.
func TestBeginRegistration_RequestsDiscoverableCredential(t *testing.T) {
	repo := &mockRepository{
		MockGetUser: func(_ context.Context, id int64) (models.User, error) {
			return models.User{ID: id, Username: "admin", DisplayName: "Admin"}, nil
		},
		MockGetWebAuthnCredentialsByUserID: func(_ context.Context, _ int64) ([]repository.WebAuthnCredential, error) {
			return nil, nil
		},
	}

	svc, err := NewWebAuthnService(repo, "example.com", "Test Blog", "https://example.com")
	if err != nil {
		t.Fatalf("NewWebAuthnService: %v", err)
	}

	options, sessionKey, err := svc.BeginRegistration(context.Background(), 1)
	if err != nil {
		t.Fatalf("BeginRegistration: %v", err)
	}
	if sessionKey == "" {
		t.Error("expected a non-empty session key")
	}

	sel := options.Response.AuthenticatorSelection
	if sel.ResidentKey != protocol.ResidentKeyRequirementRequired {
		t.Errorf("ResidentKey = %q, want %q", sel.ResidentKey, protocol.ResidentKeyRequirementRequired)
	}
	if sel.RequireResidentKey == nil || !*sel.RequireResidentKey {
		t.Error("RequireResidentKey should be true for backwards compatibility with CTAP1 authenticators")
	}
	if sel.UserVerification != protocol.VerificationRequired {
		t.Errorf("UserVerification = %q, want %q", sel.UserVerification, protocol.VerificationRequired)
	}

	// The browser only sees the serialized form; residentKey is omitempty, so
	// guard against it being dropped on the wire.
	encoded, err := json.Marshal(options)
	if err != nil {
		t.Fatalf("marshal options: %v", err)
	}
	if !strings.Contains(string(encoded), `"residentKey":"required"`) {
		t.Errorf("serialized options missing residentKey=required: %s", encoded)
	}
}

func TestGenerateSessionKey(t *testing.T) {
	// Deterministic: identical inputs must produce the same key so a session can
	// be looked up again on the finish call.
	if a, b := GenerateSessionKey("1.2.3.4", "nonce"), GenerateSessionKey("1.2.3.4", "nonce"); a != b {
		t.Errorf("same inputs should yield same key: %q != %q", a, b)
	}

	// SHA-256 rendered as hex is always 64 characters.
	if key := GenerateSessionKey("1.2.3.4", "nonce"); len(key) != 64 {
		t.Errorf("expected 64-char hex hash, got %d chars: %q", len(key), key)
	}

	// Different IPs (same nonce) must not collide.
	if GenerateSessionKey("1.2.3.4", "nonce") == GenerateSessionKey("1.2.3.5", "nonce") {
		t.Error("different IPs should yield different keys")
	}

	// The "-" separator keeps the field boundary unambiguous, so ("ab","c") and
	// ("a","bc") — which would concatenate to the same string without it — differ.
	if GenerateSessionKey("ab", "c") == GenerateSessionKey("a", "bc") {
		t.Error("separator should prevent field-boundary collisions")
	}
}

func TestWebAuthnService_HasAndDeleteCredential(t *testing.T) {
	repo := &mockRepository{
		MockGetWebAuthnCredentialsByUserID: func(_ context.Context, id int64) ([]repository.WebAuthnCredential, error) {
			if id == 1 {
				return []repository.WebAuthnCredential{{CredentialID: []byte("cred")}}, nil
			}
			return nil, nil
		},
		MockDeleteWebAuthnCredentialByUserID: func(_ context.Context, id int64) error {
			return nil
		},
	}

	svc, err := NewWebAuthnService(repo, "example.com", "Test Blog", "https://example.com")
	if err != nil {
		t.Fatalf("NewWebAuthnService: %v", err)
	}

	has, err := svc.HasCredential(context.Background(), 1)
	if err != nil {
		t.Fatalf("HasCredential: %v", err)
	}
	if !has {
		t.Error("expected true")
	}

	has, err = svc.HasCredential(context.Background(), 2)
	if err != nil {
		t.Fatalf("HasCredential: %v", err)
	}
	if has {
		t.Error("expected false")
	}

	err = svc.DeleteCredential(context.Background(), 1)
	if err != nil {
		t.Fatalf("DeleteCredential: %v", err)
	}
}

func TestWebAuthnService_SessionNotFound(t *testing.T) {
	repo := &mockRepository{}
	svc, err := NewWebAuthnService(repo, "example.com", "Test", "https://example.com")
	if err != nil {
		t.Fatalf("NewWebAuthnService: %v", err)
	}

	err = svc.FinishRegistration(context.Background(), 1, "invalid-key", nil)
	if err == nil {
		t.Error("expected error for missing session")
	}

	_, err = svc.FinishLogin(context.Background(), "invalid-key", nil)
	if err == nil {
		t.Error("expected error for missing session")
	}
}

func TestWebAuthnService_BeginLoginWithoutUser(t *testing.T) {
	repo := &mockRepository{}
	svc, err := NewWebAuthnService(repo, "example.com", "Test", "https://example.com")
	if err != nil {
		t.Fatalf("NewWebAuthnService: %v", err)
	}

	_, key, err := svc.BeginLoginWithoutUser(context.Background())
	if err != nil {
		t.Fatalf("BeginLoginWithoutUser: %v", err)
	}
	if key == "" {
		t.Error("expected a session key")
	}
}
