package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"golang.org/x/crypto/bcrypt"
	"point-api/internal/models"
	"point-api/internal/repository"
)

type AuthService struct {
	repo *repository.Repository
}

func NewAuthService(repo *repository.Repository) *AuthService {
	return &AuthService{repo: repo}
}

func HashPassword(password string) (string, error) {
	bytes, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	return string(bytes), err
}

func VerifyPassword(password, hash string) bool {
	err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
	return err == nil
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
