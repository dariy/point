package repository

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestRepository_OAuthClientRoundTrip(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	registeredAt := time.Now().UTC().Truncate(time.Second)
	uris := []string{"https://claude.ai/api/mcp/auth_callback", "http://127.0.0.1:9000/cb"}
	if err := repo.SaveOAuthClient(ctx, "client-1", uris, registeredAt); err != nil {
		t.Fatalf("SaveOAuthClient: %v", err)
	}

	got, gotAt, found, err := repo.GetOAuthClient(ctx, "client-1")
	if err != nil || !found {
		t.Fatalf("GetOAuthClient: found=%v err=%v", found, err)
	}
	if len(got) != 2 || got[0] != uris[0] || got[1] != uris[1] {
		t.Errorf("redirect URIs = %v, want %v", got, uris)
	}
	if !gotAt.Equal(registeredAt) {
		t.Errorf("registered_at = %v, want %v", gotAt, registeredAt)
	}

	// An unknown id is not an error — the caller renders "unknown client_id".
	if _, _, found, err = repo.GetOAuthClient(ctx, "nope"); err != nil || found {
		t.Errorf("unknown client: found=%v err=%v, want false/nil", found, err)
	}

	// Re-registering the same id replaces its redirect URIs rather than failing
	// on the primary key.
	if err := repo.SaveOAuthClient(ctx, "client-1", []string{"https://other.test/cb"}, registeredAt); err != nil {
		t.Fatalf("re-save: %v", err)
	}
	got, _, _, _ = repo.GetOAuthClient(ctx, "client-1")
	if len(got) != 1 || got[0] != "https://other.test/cb" {
		t.Errorf("after re-save redirect URIs = %v", got)
	}
}

func TestRepository_OAuthTokenRoundTrip(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	expires := time.Now().UTC().Add(time.Hour).Truncate(time.Second)
	if err := repo.SaveOAuthToken(ctx, "hash-access", "client-1", expires); err != nil {
		t.Fatalf("SaveOAuthToken: %v", err)
	}
	// A zero expiry is the "never expires" case (refresh token, no refresh TTL).
	if err := repo.SaveOAuthToken(ctx, "hash-refresh", "client-1", time.Time{}); err != nil {
		t.Fatalf("SaveOAuthToken (no expiry): %v", err)
	}

	clientID, gotExp, found, err := repo.GetOAuthToken(ctx, "hash-access")
	if err != nil || !found {
		t.Fatalf("GetOAuthToken: found=%v err=%v", found, err)
	}
	if clientID != "client-1" || !gotExp.Equal(expires) {
		t.Errorf("token = (%q, %v), want (client-1, %v)", clientID, gotExp, expires)
	}

	_, gotExp, found, err = repo.GetOAuthToken(ctx, "hash-refresh")
	if err != nil || !found {
		t.Fatalf("GetOAuthToken refresh: found=%v err=%v", found, err)
	}
	if !gotExp.IsZero() {
		t.Errorf("NULL expires_at read back as %v, want zero time", gotExp)
	}

	if err := repo.DeleteOAuthToken(ctx, "hash-access"); err != nil {
		t.Fatalf("DeleteOAuthToken: %v", err)
	}
	if _, _, found, _ = repo.GetOAuthToken(ctx, "hash-access"); found {
		t.Error("token still present after delete")
	}
}

func TestRepository_DeleteExpiredOAuthTokens(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	now := time.Now().UTC()
	mustSave := func(hash string, exp time.Time) {
		t.Helper()
		if err := repo.SaveOAuthToken(ctx, hash, "c", exp); err != nil {
			t.Fatalf("save %s: %v", hash, err)
		}
	}
	mustSave("stale", now.Add(-time.Minute))
	mustSave("live", now.Add(time.Hour))
	mustSave("eternal", time.Time{})

	if err := repo.DeleteExpiredOAuthTokens(ctx, now); err != nil {
		t.Fatalf("DeleteExpiredOAuthTokens: %v", err)
	}

	for _, tc := range []struct {
		hash string
		want bool
	}{
		{"stale", false},
		{"live", true},
		// A never-expiring token must survive every sweep.
		{"eternal", true},
	} {
		if _, _, found, _ := repo.GetOAuthToken(ctx, tc.hash); found != tc.want {
			t.Errorf("%s: found = %v, want %v", tc.hash, found, tc.want)
		}
	}
}

// TestRepository_OAuthTimestampsStoredUTC pins the on-disk format. Expiry is
// compared as text by DeleteExpiredOAuthTokens, so a row written in local time
// ("-0400 EDT") would sort wrongly against one written after a DST change
// ("-0500 EST") and the sweep would delete the wrong tokens. Writing UTC keeps
// text order and chronological order the same, and matches sessions.expires_at.
func TestRepository_OAuthTimestampsStoredUTC(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	// A deliberately non-UTC input, as time.Now() produces in the handlers.
	local := time.Date(2026, 8, 13, 15, 42, 3, 0, time.FixedZone("EDT", -4*60*60))
	if err := repo.SaveOAuthClient(ctx, "c", []string{"https://app.test/cb"}, local); err != nil {
		t.Fatalf("SaveOAuthClient: %v", err)
	}
	if err := repo.SaveOAuthToken(ctx, "h", "c", local); err != nil {
		t.Fatalf("SaveOAuthToken: %v", err)
	}

	for _, q := range []string{
		`SELECT registered_at FROM oauth_clients WHERE client_id = 'c'`,
		`SELECT expires_at FROM oauth_tokens WHERE token_hash = 'h'`,
	} {
		var raw string
		if err := repo.DB().QueryRowContext(ctx, q).Scan(&raw); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		if !strings.HasSuffix(raw, "Z") && !strings.Contains(raw, "+0000") {
			t.Errorf("%s stored as %q, want a UTC timestamp", q, raw)
		}
		// The monotonic clock reading is meaningless once stored.
		if strings.Contains(raw, "m=") {
			t.Errorf("%s stored a monotonic clock reading: %q", q, raw)
		}
	}

	// The value must still survive the round trip as the same instant.
	_, gotAt, found, err := repo.GetOAuthClient(ctx, "c")
	if err != nil || !found {
		t.Fatalf("GetOAuthClient: found=%v err=%v", found, err)
	}
	if !gotAt.Equal(local) {
		t.Errorf("registered_at round-tripped to %v, want the same instant as %v", gotAt, local)
	}
}
