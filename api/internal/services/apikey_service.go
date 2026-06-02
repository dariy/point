package services

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"point-api/internal/models"
	"point-api/internal/repository"
)

type ApiKeyService struct {
	repo *repository.Repository
}

func NewApiKeyService(repo *repository.Repository) *ApiKeyService {
	return &ApiKeyService{repo: repo}
}

// GenerateAPIKey generates a new high-entropy API key, stores its hash, and returns the raw key.
func (s *ApiKeyService) GenerateAPIKey(ctx context.Context, userID int64, name string, expiresAt *time.Time) (string, models.ApiKey, error) {
	// Generate raw key: point_pat_ + 32 random bytes hex
	// 32 bytes hex = 64 chars. Total length = 10 + 64 = 74 chars.
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", models.ApiKey{}, fmt.Errorf("failed to generate random bytes: %w", err)
	}
	rawKey := "point_pat_" + hex.EncodeToString(b)

	hash := sha256.Sum256([]byte(rawKey))
	keyHash := hex.EncodeToString(hash[:])

	// Prefix: first 16 chars of the raw key (point_pat_ + 6 chars)
	prefix := rawKey[:16]

	var expiresAtNull sql.NullTime
	if expiresAt != nil {
		expiresAtNull = sql.NullTime{Time: *expiresAt, Valid: true}
	}

	params := models.CreateAPIKeyParams{
		UserID:    userID,
		Name:      name,
		KeyHash:   keyHash,
		Prefix:    prefix,
		ExpiresAt: expiresAtNull,
	}

	apiKey, err := s.repo.CreateAPIKey(ctx, params)
	if err != nil {
		return "", models.ApiKey{}, err
	}

	return rawKey, apiKey, nil
}

// ValidateAPIKey verifies a raw API key and returns the associated principal.
func (s *ApiKeyService) ValidateAPIKey(ctx context.Context, rawKey string) (models.GetAPIKeyByHashRow, error) {
	hash := sha256.Sum256([]byte(rawKey))
	keyHash := hex.EncodeToString(hash[:])

	apiKey, err := s.repo.GetAPIKeyByHash(ctx, keyHash)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return models.GetAPIKeyByHashRow{}, errors.New("invalid API key")
		}
		return models.GetAPIKeyByHashRow{}, err
	}

	// Check expiry
	if apiKey.ExpiresAt.Valid && time.Now().After(apiKey.ExpiresAt.Time) {
		return models.GetAPIKeyByHashRow{}, errors.New("API key expired")
	}

	// Revoked check is handled by the SQL query (revoked_at IS NULL),
	// but we double check here if it was somehow bypassed.
	if apiKey.RevokedAt.Valid {
		return models.GetAPIKeyByHashRow{}, errors.New("API key revoked")
	}

	// Update last used timestamp
	go func() {
		// Using a background context for the async update to not block the current request
		// or fail if the request context is cancelled.
		_ = s.repo.TouchAPIKeyLastUsed(context.Background(), apiKey.ID)
	}()

	return apiKey, nil
}

func (s *ApiKeyService) ListKeys(ctx context.Context, userID int64) ([]models.ApiKey, error) {
	return s.repo.ListAPIKeysByUser(ctx, userID)
}

func (s *ApiKeyService) RevokeKey(ctx context.Context, id, userID int64) error {
	return s.repo.RevokeAPIKey(ctx, models.RevokeAPIKeyParams{
		ID:     id,
		UserID: userID,
	})
}

func (s *ApiKeyService) DeleteKey(ctx context.Context, id, userID int64) error {
	return s.repo.DeleteAPIKey(ctx, models.DeleteAPIKeyParams{
		ID:     id,
		UserID: userID,
	})
}
