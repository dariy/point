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
