package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

// OAuth state for the MCP authorization server lives here rather than in the
// provider's memory so that a redeploy does not silently sign every MCP client
// out: the tokens a client holds stay valid, and a client registered before the
// restart can still authorize. Tokens are stored as SHA-256 hashes, the same
// at-rest treatment api_keys gets, so a copy of the database is not itself a set
// of bearer credentials.

// SaveOAuthClient records a dynamically registered client. Re-registering the
// same id overwrites the previous redirect URIs.
func (r *sqliteRepository) SaveOAuthClient(ctx context.Context, clientID string, redirectURIs []string, registeredAt time.Time) error {
	uris, err := json.Marshal(redirectURIs)
	if err != nil {
		return err
	}
	_, err = r.db.ExecContext(ctx, `
INSERT INTO oauth_clients (client_id, redirect_uris, registered_at)
VALUES (?, ?, ?)
ON CONFLICT(client_id) DO UPDATE SET redirect_uris = excluded.redirect_uris`,
		clientID, string(uris), utcStamp(registeredAt))
	return err
}

// utcStamp normalizes a timestamp before it is written. The driver renders a
// time.Time with its zone attached, so a local time lands in the column as
// "-0400 EDT" — and DeleteExpiredOAuthTokens compares expiry as text, which
// makes those rows sort wrongly against "-0500 EST" ones written on the other
// side of a DST change. In UTC, text order and chronological order agree.
// UTC also drops the monotonic clock reading, meaningless once stored.
//
// That comparison only drives garbage collection, never access: whether a token
// is still valid is decided in Go, against the parsed expiry (see
// oauth.Provider.ValidateToken). A sweep that is off by a sub-second rounding
// therefore costs a row, not an authorization.
func utcStamp(t time.Time) time.Time { return t.UTC() }

// GetOAuthClient returns a registered client's redirect URIs. found is false
// (with a nil error) when no such client exists.
func (r *sqliteRepository) GetOAuthClient(ctx context.Context, clientID string) (redirectURIs []string, registeredAt time.Time, found bool, err error) {
	var raw string
	err = r.db.QueryRowContext(ctx,
		`SELECT redirect_uris, registered_at FROM oauth_clients WHERE client_id = ?`, clientID,
	).Scan(&raw, &registeredAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, time.Time{}, false, nil
	}
	if err != nil {
		return nil, time.Time{}, false, err
	}
	if err := json.Unmarshal([]byte(raw), &redirectURIs); err != nil {
		return nil, time.Time{}, false, err
	}
	return redirectURIs, registeredAt, true, nil
}

// SaveOAuthToken stores an issued token by hash. A zero expiresAt means the
// token never expires and is written as NULL.
func (r *sqliteRepository) SaveOAuthToken(ctx context.Context, tokenHash, clientID string, expiresAt time.Time) error {
	var expires any
	if !expiresAt.IsZero() {
		expires = utcStamp(expiresAt)
	}
	_, err := r.db.ExecContext(ctx, `
INSERT INTO oauth_tokens (token_hash, client_id, expires_at)
VALUES (?, ?, ?)
ON CONFLICT(token_hash) DO UPDATE SET client_id = excluded.client_id, expires_at = excluded.expires_at`,
		tokenHash, clientID, expires)
	return err
}

// GetOAuthToken looks a token up by hash. A NULL expires_at comes back as the
// zero time, which the caller reads as "never expires".
func (r *sqliteRepository) GetOAuthToken(ctx context.Context, tokenHash string) (clientID string, expiresAt time.Time, found bool, err error) {
	var expires sql.NullTime
	err = r.db.QueryRowContext(ctx,
		`SELECT client_id, expires_at FROM oauth_tokens WHERE token_hash = ?`, tokenHash,
	).Scan(&clientID, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return "", time.Time{}, false, nil
	}
	if err != nil {
		return "", time.Time{}, false, err
	}
	return clientID, expires.Time, true, nil
}

// DeleteOAuthToken removes a single token (refresh rotation, revocation).
func (r *sqliteRepository) DeleteOAuthToken(ctx context.Context, tokenHash string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM oauth_tokens WHERE token_hash = ?`, tokenHash)
	return err
}

// DeleteExpiredOAuthTokens drops every token whose expiry has passed. Rows with
// a NULL expires_at never expire and are always kept.
func (r *sqliteRepository) DeleteExpiredOAuthTokens(ctx context.Context, now time.Time) error {
	_, err := r.db.ExecContext(ctx,
		`DELETE FROM oauth_tokens WHERE expires_at IS NOT NULL AND expires_at <= ?`, utcStamp(now))
	return err
}
