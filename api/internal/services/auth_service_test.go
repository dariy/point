package services

import (
	"context"
	"errors"
	"testing"

	"point-api/internal/models"
)

func TestAuthService_Authenticate_Mock(t *testing.T) {
	ctx := context.Background()
	
	t.Run("Successful authentication", func(t *testing.T) {
		password := "correct-password"
		hashed, _ := HashPassword(password)
		
		mockRepo := &mockRepository{
			MockGetUserByUsername: func(ctx context.Context, username string) (models.User, error) {
				if username == "testuser" {
					return models.User{
						ID:           123,
						Username:     "testuser",
						PasswordHash: hashed,
					}, nil
				}
				return models.User{}, errors.New("not found")
			},
			MockUpdateUserLogin: func(ctx context.Context, id int64) error {
				if id != 123 {
					t.Errorf("expected update for user 123, got %d", id)
				}
				return nil
			},
		}
		
		svc := NewAuthService(mockRepo)
		user, err := svc.Authenticate(ctx, "testuser", password)
		
		if err != nil {
			t.Fatalf("Authenticate failed: %v", err)
		}
		if user.ID != 123 {
			t.Errorf("expected user ID 123, got %d", user.ID)
		}
	})

	t.Run("Invalid password", func(t *testing.T) {
		hashed, _ := HashPassword("correct-password")
		
		mockRepo := &mockRepository{
			MockGetUserByUsername: func(ctx context.Context, username string) (models.User, error) {
				return models.User{
					ID:           123,
					Username:     "testuser",
					PasswordHash: hashed,
				}, nil
			},
		}
		
		svc := NewAuthService(mockRepo)
		_, err := svc.Authenticate(ctx, "testuser", "wrong-password")
		
		if err == nil || err.Error() != "invalid username or password" {
			t.Errorf("expected invalid password error, got %v", err)
		}
	})
}
