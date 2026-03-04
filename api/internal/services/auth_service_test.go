package services

import (
	"context"
	"testing"
	"time"

	"point-api/internal/models"
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
	expiresAt := time.Now().Add(1 * time.Hour)
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
	_, _ = service.CreateSession(ctx, user.ID, "127.0.0.1", "test-agent", time.Now().Add(-1*time.Hour), expiredToken)
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
