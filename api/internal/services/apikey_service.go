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
	"point-api/internal/plugins"
	"point-api/internal/repository"
	"point-api/internal/utils"
)

type ApiKeyService struct {
	repo repository.Repository
	// settings resolves the api-keys plugin toggle on every validation. The
	// dependency is required rather than optional (WithX) on purpose: an
	// unset collaborator would fail open, and this one guards authentication.
	settings *SettingsService
}

func NewApiKeyService(repo repository.Repository, settings *SettingsService) *ApiKeyService {
	return &ApiKeyService{repo: repo, settings: settings}
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
//
// The api-keys plugin toggle is enforced here rather than in AuthMiddleware
// because three callers reach this method — AuthMiddleware, OptionalAuthMiddleware
// and the MCP bearer path — and disabling the plugin must close all three.
// RequirePlugin only 404s the /api/api-keys management routes, so without this
// check a key minted while the plugin was on kept authenticating after it was
// turned off.
func (s *ApiKeyService) ValidateAPIKey(ctx context.Context, rawKey string) (models.GetAPIKeyByHashRow, error) {
	// Checked before the hash lookup: a disabled plugin should cost nothing and
	// touch nothing, not even the key's last-used timestamp.
	if err := s.apiKeysEnabled(ctx); err != nil {
		return models.GetAPIKeyByHashRow{}, err
	}

	hash := sha256.Sum256([]byte(rawKey))
	keyHash := hex.EncodeToString(hash[:])

	apiKey, err := s.repo.GetAPIKeyByHash(ctx, keyHash)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return models.GetAPIKeyByHashRow{}, wrapKind(ErrUnauthenticated, errors.New("invalid API key"))
		}
		return models.GetAPIKeyByHashRow{}, err
	}

	// Check expiry
	if apiKey.ExpiresAt.Valid && time.Now().After(apiKey.ExpiresAt.Time) {
		return models.GetAPIKeyByHashRow{}, wrapKind(ErrUnauthenticated, errors.New("API key expired"))
	}

	// Revoked check is handled by the SQL query (revoked_at IS NULL),
	// but we double check here if it was somehow bypassed.
	if apiKey.RevokedAt.Valid {
		return models.GetAPIKeyByHashRow{}, errors.New("API key revoked")
	}

	// Update last used timestamp
	utils.SafeGo("apikey: touch last-used", func() {
		// Using a background context for the async update to not block the current request
		// or fail if the request context is cancelled.
		_ = s.repo.TouchAPIKeyLastUsed(context.Background(), apiKey.ID)
	})

	return apiKey, nil
}

// apiKeysEnabled reports whether the api-keys plugin is on, as an error so the
// caller can return it unchanged. A settings read that fails closes the door:
// every caller maps a non-nil error to 401, which is the safe direction for an
// authentication gate.
func (s *ApiKeyService) apiKeysEnabled(ctx context.Context) error {
	// Snapshot, not GetAllSettings: this runs on every authenticated request
	// and only reads. Same choice as api.RequirePlugin.
	all, err := s.settings.Snapshot(ctx)
	if err != nil {
		return wrapKind(ErrUnauthenticated, errors.New("cannot resolve plugin state"))
	}
	if !plugins.IsEnabled("api-keys", all) {
		return wrapKind(ErrUnauthenticated, errors.New("API keys are disabled"))
	}
	return nil
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
