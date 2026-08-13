package mcp

import (
	"context"
	"time"

	"point-api/internal/repository"
)

// repoOAuthStore adapts point's repository to oauth.Store. It exists so the
// oauth package stays free of any database dependency — it declares the narrow
// interface it needs, and this is the only place that knows both sides.
type repoOAuthStore struct{ repo repository.Repository }

func (s repoOAuthStore) SaveClient(ctx context.Context, clientID string, redirectURIs []string, registeredAt time.Time) error {
	return s.repo.SaveOAuthClient(ctx, clientID, redirectURIs, registeredAt)
}

func (s repoOAuthStore) LoadClient(ctx context.Context, clientID string) ([]string, time.Time, bool, error) {
	return s.repo.GetOAuthClient(ctx, clientID)
}

func (s repoOAuthStore) SaveToken(ctx context.Context, tokenHash, clientID string, expiresAt time.Time) error {
	return s.repo.SaveOAuthToken(ctx, tokenHash, clientID, expiresAt)
}

func (s repoOAuthStore) LoadToken(ctx context.Context, tokenHash string) (string, time.Time, bool, error) {
	return s.repo.GetOAuthToken(ctx, tokenHash)
}

func (s repoOAuthStore) DeleteToken(ctx context.Context, tokenHash string) error {
	return s.repo.DeleteOAuthToken(ctx, tokenHash)
}

func (s repoOAuthStore) DeleteExpiredTokens(ctx context.Context, now time.Time) error {
	return s.repo.DeleteExpiredOAuthTokens(ctx, now)
}
