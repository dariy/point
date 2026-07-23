package services

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/mail"
	"strconv"
	"time"

	"point-api/internal/models"
	"point-api/internal/repository"
)

type AuthService struct {
	repo repository.Repository
}

// dummyPasswordHash is a valid Argon2id hash. When a user lookup misses we still
// run a verify against it so the response time doesn't reveal whether the
// username exists (timing-based user enumeration).
var dummyPasswordHash, _ = HashPassword("0000000000000000000000000000000000000000000000000000000000000000")

func NewAuthService(repo repository.Repository) *AuthService {
	return &AuthService{repo: repo}
}

func HashToken(token string) string {
	hash := sha256.Sum256([]byte(token))
	return hex.EncodeToString(hash[:])
}

// AuthenticatePassword is for callers that have the raw password bytes (e.g. CLI).
// It applies the same SHA-256 pre-hash the web frontend performs before calling Authenticate,
// so all authentication paths use the same stored credential format.
//
// Note on Security: We use SHA-256 here strictly as a pre-hashing step to prevent
// truncation issues (like those inherent to bcrypt) and to allow the frontend to
// avoid sending plaintext passwords. The result of this SHA-256 hash is NEVER stored
// directly; it is subsequently hashed using the computationally expensive Argon2id
// algorithm in the actual storage layer. This approach is cryptographically secure.
func (s *AuthService) AuthenticatePassword(ctx context.Context, username string, rawPassword []byte) (models.User, error) {
	// codeql[go/weak-crypto] - false positive: pre-hash to avoid truncation; securely hashed with Argon2id later
	h := sha256.Sum256(rawPassword)
	return s.Authenticate(ctx, username, hex.EncodeToString(h[:]))
}

func (s *AuthService) Authenticate(ctx context.Context, username, password string) (models.User, error) {
	var user models.User
	var err error

	if username != "" {
		user, err = s.repo.GetUserByUsername(ctx, username)
	} else {
		user, err = s.repo.GetFirstUser(ctx)
	}

	if err != nil {
		// Equalize timing with the found-user path to avoid leaking which
		// usernames exist; the result is discarded.
		_ = VerifyPassword(password, dummyPasswordHash)
		return models.User{}, errors.New("invalid username or password")
	}

	if !VerifyPassword(password, user.PasswordHash) {
		return models.User{}, errors.New("invalid username or password")
	}

	// Upgrade hash to Argon2id if it's still bcrypt
	if IsBcryptHash(user.PasswordHash) {
		newHash, err := HashPassword(password)
		if err == nil {
			_ = s.repo.UpdateUserPassword(ctx, models.UpdateUserPasswordParams{
				PasswordHash: newHash,
				ID:           user.ID,
			})
			user.PasswordHash = newHash
		}
	}

	// Update last login
	_ = s.repo.UpdateUserLogin(ctx, user.ID)

	return user, nil
}

func (s *AuthService) CreateSession(ctx context.Context, userID int64, ip, userAgent string, expiresAt time.Time, token string) (models.Session, error) {
	hashedToken := HashToken(token)

	params := models.CreateSessionParams{
		UserID:    userID,
		Token:     hashedToken,
		IpAddress: ip,
		UserAgent: userAgent,
		ExpiresAt: expiresAt.UTC().Round(0),
	}

	return s.repo.CreateSession(ctx, params)
}

func (s *AuthService) ValidateSession(ctx context.Context, token string) (models.GetSessionByTokenRow, error) {
	hashedToken := HashToken(token)
	session, err := s.repo.GetSessionByToken(ctx, hashedToken)
	if err != nil {
		return models.GetSessionByTokenRow{}, err
	}

	// Check expiry
	if time.Now().After(session.ExpiresAt) {
		_ = s.repo.DeleteSession(ctx, models.DeleteSessionParams{ID: session.ID, UserID: session.UserID})
		return models.GetSessionByTokenRow{}, errors.New("session expired")
	}

	// Update activity
	_ = s.repo.UpdateSessionActivity(ctx, session.ID)

	return session, nil
}

func (s *AuthService) TerminateSession(ctx context.Context, sessionID, userID int64) error {
	return s.repo.DeleteSession(ctx, models.DeleteSessionParams{ID: sessionID, UserID: userID})
}

func (s *AuthService) TerminateOtherSessions(ctx context.Context, userID, currentSessionID int64) error {
	return s.repo.DeleteUserSessions(ctx, models.DeleteUserSessionsParams{UserID: userID, ID: currentSessionID})
}

func (s *AuthService) ListSessions(ctx context.Context, userID int64) ([]models.Session, error) {
	return s.repo.GetUserSessions(ctx, userID)
}

func (s *AuthService) CleanupExpiredSessions(ctx context.Context) error {
	return s.repo.DeleteExpiredSessions(ctx)
}

func generateSecureToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

type resetTokenPayload struct {
	UserID    int64  `json:"user_id"`
	ExpiresAt string `json:"expires_at"`
}

// resetPtrKey is the per-user slot holding the current reset token's hash, so a
// newly issued token invalidates any previous outstanding one for that user.
func resetPtrKey(userID int64) string { return "pw_reset_uid:" + strconv.FormatInt(userID, 10) }

// CreatePasswordResetToken generates a one-time reset token valid for 1 hour.
// The token is stored hashed in blog_secrets. Returns the raw token for emailing.
// Any previously issued, still-valid token for the same user is invalidated.
func (s *AuthService) CreatePasswordResetToken(ctx context.Context, userID int64) (string, error) {
	// Invalidate a prior outstanding token for this user, if any.
	if prev, err := s.repo.GetSecret(ctx, resetPtrKey(userID)); err == nil && prev.Value.Valid {
		_ = s.repo.DeleteSecret(ctx, "pw_reset:"+prev.Value.String)
	}

	token := generateSecureToken()
	tokenHash := HashToken(token)

	payload, _ := json.Marshal(resetTokenPayload{
		UserID:    userID,
		ExpiresAt: time.Now().Add(1 * time.Hour).UTC().Format(time.RFC3339),
	})

	err := s.repo.UpsertSecret(ctx, models.UpsertSecretParams{
		Key:   "pw_reset:" + tokenHash,
		Value: sql.NullString{String: string(payload), Valid: true},
	})
	if err != nil {
		return "", fmt.Errorf("store reset token: %w", err)
	}
	_ = s.repo.UpsertSecret(ctx, models.UpsertSecretParams{
		Key:   resetPtrKey(userID),
		Value: sql.NullString{String: tokenHash, Valid: true},
	})
	return token, nil
}

// ValidatePasswordResetToken returns the user ID for a valid, unexpired token.
func (s *AuthService) ValidatePasswordResetToken(ctx context.Context, token string) (int64, error) {
	tokenHash := HashToken(token)
	secret, err := s.repo.GetSecret(ctx, "pw_reset:"+tokenHash)
	if err != nil {
		return 0, errors.New("invalid or expired reset token")
	}

	var p resetTokenPayload
	if err := json.Unmarshal([]byte(secret.Value.String), &p); err != nil {
		return 0, errors.New("invalid reset token")
	}

	expiresAt, err := time.Parse(time.RFC3339, p.ExpiresAt)
	if err != nil || time.Now().After(expiresAt) {
		_ = s.repo.DeleteSecret(ctx, "pw_reset:"+tokenHash)
		return 0, errors.New("reset token has expired")
	}

	return p.UserID, nil
}

// ResetPassword validates the token, updates the password, and invalidates the token.
func (s *AuthService) ResetPassword(ctx context.Context, token, newPassword string) error {
	tokenHash := HashToken(token)
	userID, err := s.ValidatePasswordResetToken(ctx, token)
	if err != nil {
		return err
	}

	hashed, err := HashPassword(newPassword)
	if err != nil {
		return err
	}

	if err := s.repo.UpdateUserPassword(ctx, models.UpdateUserPasswordParams{
		PasswordHash: hashed,
		ID:           userID,
	}); err != nil {
		return err
	}

	_ = s.repo.DeleteSecret(ctx, "pw_reset:"+tokenHash)
	_ = s.repo.DeleteSecret(ctx, resetPtrKey(userID))

	// A reset is a recovery action: kill every existing session so a previously
	// compromised session can't survive the password change (ID 0 matches none).
	_ = s.repo.DeleteUserSessions(ctx, models.DeleteUserSessionsParams{UserID: userID, ID: 0})
	return nil
}

func (s *AuthService) GetUserByID(ctx context.Context, userID int64) (models.User, error) {
	return s.repo.GetUser(ctx, userID)
}

// VerifyUserPassword re-verifies a user's current password, the guard used to
// gate sensitive actions (changing credentials, exporting/importing a full
// backup). currentPassword is the SHA-256-hex the frontend sends, exactly as at
// login — never plaintext. Returns nil when it matches.
func (s *AuthService) VerifyUserPassword(ctx context.Context, userID int64, currentPassword string) error {
	user, err := s.repo.GetUser(ctx, userID)
	if err != nil {
		return err
	}
	if !VerifyPassword(currentPassword, user.PasswordHash) {
		return errors.New("current password incorrect")
	}
	return nil
}

// ChangePassword updates the password and terminates all of the user's other
// sessions (keeping currentSessionID), so a stale or stolen session elsewhere is
// invalidated. Pass currentSessionID 0 to terminate every session.
func (s *AuthService) ChangePassword(ctx context.Context, userID, currentSessionID int64, currentPassword, newPassword string) error {
	if err := s.VerifyUserPassword(ctx, userID, currentPassword); err != nil {
		return err
	}

	hashed, err := HashPassword(newPassword)
	if err != nil {
		return err
	}

	if err := s.repo.UpdateUserPassword(ctx, models.UpdateUserPasswordParams{
		PasswordHash: hashed,
		ID:           userID,
	}); err != nil {
		return err
	}

	_ = s.repo.DeleteUserSessions(ctx, models.DeleteUserSessionsParams{UserID: userID, ID: currentSessionID})
	return nil
}

// ChangeEmail updates the account email after re-verifying the current
// password. The email is where password-reset links go, so it gets the same
// protection as a password change; sessions stay intact.
func (s *AuthService) ChangeEmail(ctx context.Context, userID int64, currentPassword, newEmail string) error {
	if err := s.VerifyUserPassword(ctx, userID, currentPassword); err != nil {
		return err
	}

	addr, err := mail.ParseAddress(newEmail)
	if err != nil || addr.Address != newEmail {
		return errors.New("invalid email address")
	}

	return s.repo.UpdateUserEmail(ctx, models.UpdateUserEmailParams{
		Email: newEmail,
		ID:    userID,
	})
}
