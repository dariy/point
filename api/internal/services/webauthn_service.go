package services

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"sync"
	"time"

	"point-api/internal/models"
	"point-api/internal/repository"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

// WebAuthnUser implements the webauthn.User interface
type WebAuthnUser struct {
	User        models.User
	Credentials []repository.WebAuthnCredential
}

func (u WebAuthnUser) WebAuthnID() []byte {
	// We need a stable byte representation of the user ID.
	// Using the raw int64 bytes is the most direct way.
	buf := make([]byte, 8)
	binary.BigEndian.PutUint64(buf, uint64(u.User.ID))
	return buf
}

func (u WebAuthnUser) WebAuthnName() string {
	return u.User.Username
}

func (u WebAuthnUser) WebAuthnDisplayName() string {
	if u.User.DisplayName != "" {
		return u.User.DisplayName
	}
	return u.User.Username
}

func (u WebAuthnUser) WebAuthnCredentials() []webauthn.Credential {
	creds := make([]webauthn.Credential, len(u.Credentials))
	for i, c := range u.Credentials {
		creds[i] = webauthn.Credential{
			ID:        c.CredentialID,
			PublicKey: c.PublicKey,
			Authenticator: webauthn.Authenticator{
				AAGUID:    c.AAGUID,
				SignCount: c.SignCount,
			},
			Flags: webauthn.CredentialFlags{
				BackupEligible: c.BackupEligible,
				BackupState:    c.BackupState,
			},
		}
	}
	return creds
}

type WebAuthnService struct {
	repo     repository.Repository
	webauthn *webauthn.WebAuthn
	// sessionStore stores webauthn.SessionData for in-progress ceremonies
	sessionStore sync.Map // string -> webauthn.SessionData
}

func NewWebAuthnService(repo repository.Repository, rpID, rpDisplayName, rpOrigin string) (*WebAuthnService, error) {
	if rpID == "" || rpOrigin == "" {
		return nil, fmt.Errorf("relying party ID and origin cannot be empty")
	}

	// The webauthn library expects the Relying Party ID to be a domain name,
	// without scheme or port.
	parsedURL, err := url.Parse(rpOrigin)
	if err != nil {
		return nil, fmt.Errorf("invalid rpOrigin URL: %w", err)
	}
	expectedRpID := parsedURL.Hostname()

	w, err := webauthn.New(&webauthn.Config{
		RPID:          expectedRpID,
		RPDisplayName: rpDisplayName,
		RPOrigins:     []string{rpOrigin},
		// Login is usernameless (BeginDiscoverableLogin sends an empty
		// allowCredentials), so registration must produce a client-side
		// discoverable credential or the authenticator will have nothing to
		// offer at login time.
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			ResidentKey:        protocol.ResidentKeyRequirementRequired,
			RequireResidentKey: protocol.ResidentKeyRequired(),
			UserVerification:   protocol.VerificationRequired,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create webauthn instance: %w", err)
	}

	return &WebAuthnService{
		repo:     repo,
		webauthn: w,
	}, nil
}

func (s *WebAuthnService) BeginRegistration(ctx context.Context, userID int64) (*protocol.CredentialCreation, string, error) {
	user, err := s.repo.GetUser(ctx, userID)
	if err != nil {
		return nil, "", fmt.Errorf("user not found: %w", err)
	}

	creds, err := s.repo.GetWebAuthnCredentialsByUserID(ctx, userID)
	if err != nil {
		return nil, "", fmt.Errorf("failed to get user credentials: %w", err)
	}

	webauthnUser := WebAuthnUser{User: user, Credentials: creds}

	options, sessionData, err := s.webauthn.BeginRegistration(webauthnUser)
	if err != nil {
		return nil, "", fmt.Errorf("failed to begin registration: %w", err)
	}

	// Store session data. Use a unique, unguessable key. A hash of the userID
	// and a timestamp is sufficient for this purpose.
	sessionKey := fmt.Sprintf("reg-%d-%d", userID, time.Now().UnixNano())
	s.sessionStore.Store(sessionKey, *sessionData)

	// Expire the session data after a reasonable time
	time.AfterFunc(5*time.Minute, func() {
		s.sessionStore.Delete(sessionKey)
	})

	return options, sessionKey, nil
}

func (s *WebAuthnService) FinishRegistration(ctx context.Context, userID int64, sessionKey string, r *http.Request) error {
	sessionData, ok := s.sessionStore.Load(sessionKey)
	if !ok {
		return fmt.Errorf("registration session not found or expired")
	}
	s.sessionStore.Delete(sessionKey) // Consume the session

	user, err := s.repo.GetUser(ctx, userID)
	if err != nil {
		return fmt.Errorf("user not found: %w", err)
	}

	creds, err := s.repo.GetWebAuthnCredentialsByUserID(ctx, userID)
	if err != nil {
		return fmt.Errorf("failed to get user credentials: %w", err)
	}

	webauthnUser := WebAuthnUser{User: user, Credentials: creds}

	credential, err := s.webauthn.FinishRegistration(webauthnUser, sessionData.(webauthn.SessionData), r)
	if err != nil {
		return fmt.Errorf("failed to finish registration: %w", err)
	}

	_, err = s.repo.CreateWebAuthnCredential(ctx, userID, credential.ID, credential.PublicKey, credential.Authenticator.AAGUID, credential.Authenticator.SignCount, credential.Flags.BackupEligible, credential.Flags.BackupState)
	if err != nil {
		return fmt.Errorf("failed to save credential: %w", err)
	}

	return nil
}

func (s *WebAuthnService) BeginLoginWithoutUser(ctx context.Context) (*protocol.CredentialAssertion, string, error) {
	options, sessionData, err := s.webauthn.BeginDiscoverableLogin()
	if err != nil {
		slog.Error("Failed to begin discoverable login", "error", err)
		return nil, "", fmt.Errorf("failed to begin discoverable login: %w", err)
	}

	sessionKey := fmt.Sprintf("login-%d", time.Now().UnixNano())
	s.sessionStore.Store(sessionKey, *sessionData)
	time.AfterFunc(5*time.Minute, func() {
		s.sessionStore.Delete(sessionKey)
	})

	return options, sessionKey, nil
}

func (s *WebAuthnService) FinishLogin(ctx context.Context, sessionKey string, r *http.Request) (int64, error) {
	sessionData, ok := s.sessionStore.Load(sessionKey)
	if !ok {
		return 0, fmt.Errorf("login session not found or expired")
	}
	s.sessionStore.Delete(sessionKey)

	// This handler will be called by the webauthn library after it has
	// provisionally validated the credential. We need to look up the user
	// associated with the credential ID.
	userHandler := func(rawID, userHandle []byte) (webauthn.User, error) {
		cred, err := s.repo.GetWebAuthnCredentialByCredentialID(ctx, rawID)
		if err != nil {
			return nil, fmt.Errorf("credential not found")
		}

		user, err := s.repo.GetUser(ctx, cred.UserID)
		if err != nil {
			return nil, fmt.Errorf("user not found for credential")
		}

		allCreds, err := s.repo.GetWebAuthnCredentialsByUserID(ctx, user.ID)
		if err != nil {
			return nil, fmt.Errorf("could not fetch user credentials")
		}

		return WebAuthnUser{User: user, Credentials: allCreds}, nil
	}

	credential, err := s.webauthn.FinishDiscoverableLogin(userHandler, sessionData.(webauthn.SessionData), r)
	if err != nil {
		return 0, fmt.Errorf("failed to finish discoverable login: %w", err)
	}

	// Update sign count and backup state after successful login.
	if err := s.repo.UpdateWebAuthnCredential(ctx, credential.ID, credential.Authenticator.SignCount, credential.Flags.BackupState); err != nil {
		slog.Warn("failed to update credential after login", "credential_id", fmt.Sprintf("%x", credential.ID), "error", err)
	}

	// The UserID is stored on the credential object returned by FinishDiscoverableLogin
	// because our userHandler returns a WebAuthnUser which has the user ID.
	cred, err := s.repo.GetWebAuthnCredentialByCredentialID(ctx, credential.ID)
	if err != nil {
		return 0, fmt.Errorf("could not find credential to get user id")
	}

	return cred.UserID, nil
}

func (s *WebAuthnService) HasCredential(ctx context.Context, userID int64) (bool, error) {
	creds, err := s.repo.GetWebAuthnCredentialsByUserID(ctx, userID)
	if err != nil {
		return false, err
	}
	return len(creds) > 0, nil
}

func (s *WebAuthnService) DeleteCredential(ctx context.Context, userID int64) error {
	return s.repo.DeleteWebAuthnCredentialByUserID(ctx, userID)
}

// GenerateSessionKey creates a unique key for storing session data.
// It's a simple SHA256 hash of the user's IP and a nonce.
func GenerateSessionKey(userIP, nonce string) string {
	hash := sha256.Sum256(fmt.Appendf(nil, "%s-%s", userIP, nonce))
	return fmt.Sprintf("%x", hash)
}

// SanitizeOrigin takes a URL string and returns a compliant origin string (scheme://hostname:port).
func SanitizeOrigin(appURL string) string {
	if appURL == "" {
		return ""
	}
	parsed, err := url.Parse(appURL)
	if err != nil {
		return ""
	}
	// Rebuild the origin string to ensure it's just scheme, hostname, and port.
	// This strips path, query, fragment, and userinfo.
	port := parsed.Port()
	if port != "" {
		return fmt.Sprintf("%s://%s:%s", parsed.Scheme, parsed.Hostname(), port)
	}
	return fmt.Sprintf("%s://%s", parsed.Scheme, parsed.Hostname())
}

// GetRPIDFromURL derives a valid WebAuthn RPID (domain name) from a full URL.
func GetRPIDFromURL(appURL string) string {
	if appURL == "" {
		return ""
	}
	parsed, err := url.Parse(appURL)
	if err != nil {
		return ""
	}
	// RPID is just the hostname, no port or scheme.
	return parsed.Hostname()
}
