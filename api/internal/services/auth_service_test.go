package services

import (
	"context"
	"strings"
	"testing"
	"time"

	"point-api/internal/models"
	"point-api/internal/repository"
)



func TestAuthService_Authenticate(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	service := NewAuthService(repo)
	ctx := context.Background()

	// Create a test user
	password := "password123"
	hash, _ := HashPassword(password)
	user, err := repo.CreateUser(ctx, models.CreateUserParams{
		Username:     "testuser",
		Email:        "test@example.com",
		PasswordHash: hash,
		DisplayName:  "Test User",
	})
	if err != nil {
		t.Fatalf("failed to create test user: %v", err)
	}

	// Test successful authentication by username
	authenticatedUser, err := service.Authenticate(ctx, "testuser", password)
	if err != nil {
		t.Errorf("Authenticate failed: %v", err)
	}
	if authenticatedUser.ID != user.ID {
		t.Errorf("expected user ID %d, got %d", user.ID, authenticatedUser.ID)
	}

	// Test successful authentication (first user)
	authenticatedUser, err = service.Authenticate(ctx, "", password)
	if err != nil {
		t.Errorf("Authenticate (first user) failed: %v", err)
	}
	if authenticatedUser.ID != user.ID {
		t.Errorf("expected user ID %d, got %d", user.ID, authenticatedUser.ID)
	}

	// Test invalid password
	_, err = service.Authenticate(ctx, "testuser", "wrongpassword")
	if err == nil {
		t.Error("Authenticate should have failed with wrong password")
	}

	// Test invalid username
	_, err = service.Authenticate(ctx, "nonexistent", password)
	if err == nil {
		t.Error("Authenticate should have failed with nonexistent username")
	}
}

func TestAuthService_Sessions(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	service := NewAuthService(repo)
	ctx := context.Background()

	// Create a test user
	user, _ := repo.CreateUser(ctx, models.CreateUserParams{
		Username:     "testuser",
		Email:        "test@example.com",
		PasswordHash: "hash",
		DisplayName:  "Test User",
	})

	token := "testtoken123"
	expiresAt := time.Now().Add(1 * time.Hour).UTC().Round(0)
	session, err := service.CreateSession(ctx, user.ID, "127.0.0.1", "test-agent", expiresAt, token)
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	// Test ValidateSession
	validated, err := service.ValidateSession(ctx, token)
	if err != nil {
		t.Errorf("ValidateSession failed: %v", err)
	}
	if validated.ID != session.ID {
		t.Errorf("expected session ID %d, got %d", session.ID, validated.ID)
	}

	// Test ValidateSession (expired)
	expiredToken := "expiredtoken"
	_, _ = service.CreateSession(ctx, user.ID, "127.0.0.1", "test-agent", time.Now().Add(-1*time.Hour).UTC().Round(0), expiredToken)
	_, err = service.ValidateSession(ctx, expiredToken)
	if err == nil || err.Error() != "session expired" {
		t.Errorf("expected session expired error, got %v", err)
	}

	// Test ListSessions
	sessions, err := service.ListSessions(ctx, user.ID)
	if err != nil {
		t.Errorf("ListSessions failed: %v", err)
	}
	if len(sessions) != 1 { // One active, one expired was deleted by ValidateSession
		t.Errorf("expected 1 session, got %d", len(sessions))
	}

	// Test TerminateSession
	err = service.TerminateSession(ctx, session.ID, user.ID)
	if err != nil {
		t.Errorf("TerminateSession failed: %v", err)
	}

	// Test TerminateOtherSessions
	session1, _ := service.CreateSession(ctx, user.ID, "127.0.0.1", "agent1", expiresAt, "token1")
	session2, _ := service.CreateSession(ctx, user.ID, "127.0.0.1", "agent2", expiresAt, "token2")
	err = service.TerminateOtherSessions(ctx, user.ID, session2.ID)
	if err != nil {
		t.Errorf("TerminateOtherSessions failed: %v", err)
	}

	sessions, _ = service.ListSessions(ctx, user.ID)
	foundSession1 := false
	for _, s := range sessions {
		if s.ID == session1.ID {
			foundSession1 = true
		}
	}
	if foundSession1 {
		t.Error("session1 should have been terminated")
	}
}

func TestAuthService_ChangePassword(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	service := NewAuthService(repo)
	ctx := context.Background()

	oldPassword := "oldpassword"
	hash, _ := HashPassword(oldPassword)
	user, _ := repo.CreateUser(ctx, models.CreateUserParams{
		Username:     "testuser",
		Email:        "test@example.com",
		PasswordHash: hash,
		DisplayName:  "Test User",
	})

	newPassword := "newpassword"
	err := service.ChangePassword(ctx, user.ID, oldPassword, newPassword)
	if err != nil {
		t.Errorf("ChangePassword failed: %v", err)
	}

	// Verify new password works
	_, err = service.Authenticate(ctx, "testuser", newPassword)
	if err != nil {
		t.Errorf("Authenticate with new password failed: %v", err)
	}

	// Test wrong current password
	err = service.ChangePassword(ctx, user.ID, "wrongpassword", "anotherpassword")
	if err == nil || err.Error() != "current password incorrect" {
		t.Errorf("expected current password incorrect error, got %v", err)
	}
}

func setupAuthService(t *testing.T) (*AuthService, *repository.Repository) {
	repo := setupTestDB(t)
	return NewAuthService(repo), repo
}

// TestAuthService_ChangePassword_Error covers the ChangePassword error paths.
func TestAuthService_ChangePassword_Error(t *testing.T) {
	svc, repo := setupAuthService(t)
	ctx := context.Background()

	// Insert user with known password.
	hash, _ := HashPassword("oldpass")
	_, _ = repo.DB().Exec(`INSERT INTO users (id,username,email,password_hash,display_name) VALUES (1,'u','u@t.com',?,'U')`, hash)

	// Wrong old password → should fail verification.
	err := svc.ChangePassword(ctx, 1, "wrongpass", "newpass")
	if err == nil {
		t.Error("ChangePassword with wrong old password: expected error")
	}

	_ = repo.Close()
}

// TestAuthService_ValidateSession_DBError covers the ValidateSession DB error path.
func TestAuthService_ValidateSession_DBError(t *testing.T) {
	svc, repo := setupAuthService(t)
	ctx := context.Background()

	_ = repo.Close()

	if _, err := svc.ValidateSession(ctx, "sometoken"); err == nil {
		t.Error("ValidateSession DB closed: expected error")
	}
}

// TestAuthService_ChangePassword_LongPassword covers HashPassword bcrypt error.
func TestAuthService_ChangePassword_LongPassword(t *testing.T) {
	svc, repo := setupAuthService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	hash, _ := HashPassword("correct")
	_, _ = repo.DB().Exec(`INSERT INTO users (id,username,email,password_hash,display_name) VALUES (1,'u','u@t.com',?,'U')`, hash)

	// Password > 72 bytes triggers bcrypt.ErrPasswordTooLong
	err := svc.ChangePassword(ctx, 1, "correct", strings.Repeat("x", 73))
	if err == nil {
		t.Error("ChangePassword long password: expected bcrypt error")
	}
}

func TestAuthService_CleanupExpiredSessions(t *testing.T) {
	svc, repo := setupAuthService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	// Should not error on empty DB
	if err := svc.CleanupExpiredSessions(ctx); err != nil {
		t.Fatalf("CleanupExpiredSessions failed: %v", err)
	}

	// Insert a user and an expired session, then verify cleanup
	hash, _ := HashPassword("pw")
	_, _ = repo.DB().Exec(`INSERT INTO users (id,username,email,password_hash,display_name) VALUES (1,'u','u@t.com',?,'U')`, hash)
	_, _ = repo.DB().Exec(
		`INSERT INTO sessions (user_id,token,expires_at,ip_address,user_agent) VALUES (1,'hashed',datetime('now','-1 hour'),'127.0.0.1','agent')`,
	)

	if err := svc.CleanupExpiredSessions(ctx); err != nil {
		t.Fatalf("CleanupExpiredSessions with expired session failed: %v", err)
	}

	var count int
	_ = repo.DB().QueryRow(`SELECT COUNT(*) FROM sessions WHERE token = 'hashed'`).Scan(&count)
	if count != 0 {
		t.Errorf("expected expired session to be deleted, got count=%d", count)
	}
}

func TestAuthService_PasswordReset(t *testing.T) {
	svc, repo := setupAuthService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	hash, _ := HashPassword("oldpass")
	user, _ := repo.CreateUser(ctx, models.CreateUserParams{
		Username:     "reset-user",
		Email:        "reset@test.com",
		PasswordHash: hash,
		DisplayName:  "Reset User",
	})

	// CreatePasswordResetToken
	token, err := svc.CreatePasswordResetToken(ctx, user.ID)
	if err != nil {
		t.Fatalf("CreatePasswordResetToken failed: %v", err)
	}
	if token == "" {
		t.Error("expected non-empty reset token")
	}

	// ValidatePasswordResetToken — valid
	userID, err := svc.ValidatePasswordResetToken(ctx, token)
	if err != nil {
		t.Fatalf("ValidatePasswordResetToken failed: %v", err)
	}
	if userID != user.ID {
		t.Errorf("expected user ID %d, got %d", user.ID, userID)
	}

	// Token should still be valid after validation (not consumed yet)
	_, err = svc.ValidatePasswordResetToken(ctx, token)
	if err != nil {
		t.Fatalf("ValidatePasswordResetToken second call failed: %v", err)
	}

	// ResetPassword
	if err := svc.ResetPassword(ctx, token, "newpassword"); err != nil {
		t.Fatalf("ResetPassword failed: %v", err)
	}

	// Token should be invalidated after use
	_, err = svc.ValidatePasswordResetToken(ctx, token)
	if err == nil {
		t.Error("expected error on used reset token")
	}

	// New password works
	if _, err := svc.Authenticate(ctx, "reset-user", "newpassword"); err != nil {
		t.Fatalf("Authenticate with new password failed: %v", err)
	}
}

func TestAuthService_ValidatePasswordResetToken_Invalid(t *testing.T) {
	svc, repo := setupAuthService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	// Non-existent token
	_, err := svc.ValidatePasswordResetToken(ctx, "badtoken")
	if err == nil {
		t.Error("expected error for non-existent token")
	}
}

func TestAuthService_ResetPassword_BadToken(t *testing.T) {
	svc, repo := setupAuthService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	err := svc.ResetPassword(ctx, "invalid-token", "newpass")
	if err == nil {
		t.Error("expected error for invalid reset token")
	}
}

