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
	"time"

	"point-api/internal/models"
	"point-api/internal/repository"
)

type AuthService struct {
	repo *repository.Repository
}

func NewAuthService(repo *repository.Repository) *AuthService {
	return &AuthService{repo: repo}
}

func HashToken(token string) string {
	hash := sha256.Sum256([]byte(token))
	return hex.EncodeToString(hash[:])
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

// CreatePasswordResetToken generates a one-time reset token valid for 1 hour.
// The token is stored hashed in blog_secrets. Returns the raw token for emailing.
func (s *AuthService) CreatePasswordResetToken(ctx context.Context, userID int64) (string, error) {
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
	return nil
}

func (s *AuthService) GetUserByID(ctx context.Context, userID int64) (models.User, error) {
	return s.repo.GetUser(ctx, userID)
}

func (s *AuthService) ChangePassword(ctx context.Context, userID int64, currentPassword, newPassword string) error {
	user, err := s.repo.GetUser(ctx, userID)
	if err != nil {
		return err
	}

	if !VerifyPassword(currentPassword, user.PasswordHash) {
		return errors.New("current password incorrect")
	}

	hashed, err := HashPassword(newPassword)
	if err != nil {
		return err
	}

	return s.repo.UpdateUserPassword(ctx, models.UpdateUserPasswordParams{
		PasswordHash: hashed,
		ID:           userID,
	})
}
