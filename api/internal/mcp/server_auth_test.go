package mcp

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"point-api/internal/mcp/oauth"
	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

// The OAuth provider is well covered by internal/mcp/oauth; what was not
// covered is the wiring in this package that decides who gets to reach /mcp at
// all. These tests pin that layer. See point-mcp-oauth-tests.

func newAuthTestDeps(t *testing.T) (Deps, repository.Repository) {
	t.Helper()
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatalf("NewRepository: %v", err)
	}
	t.Cleanup(func() { _ = repo.Close() })

	auth := services.NewAuthService(repo)
	apiKey := services.NewApiKeyService(repo)
	settings := services.NewSettingsService(repo)
	return Deps{
		Echo:            echo.New(),
		Auth:            auth,
		ApiKey:          apiKey,
		SettingsService: settings,
		OwnerUserID:     1,
		BaseURL:         "https://point.test",
		Version:         "test",
	}, repo
}

// okHandler records that the request got past the middleware and reports which
// principal it was given.
func okHandler(seen *interface{}) echo.HandlerFunc {
	return func(c echo.Context) error {
		*seen = c.Request().Context().Value(principalKey{})
		return c.NoContent(http.StatusOK)
	}
}

// An unauthenticated request must be refused, and must be told where to find
// the OAuth metadata — that header is how an MCP client discovers it needs to
// start an OAuth flow.
func TestAuthMiddleware_UnauthenticatedGets401WithDiscoveryHint(t *testing.T) {
	d, _ := newAuthTestDeps(t)
	provider := oauth.New(oauth.Config{BaseURL: d.BaseURL})

	e := echo.New()
	var seen interface{}
	e.GET("/mcp", okHandler(&seen), d.authMiddleware(provider))

	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/mcp", nil))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	wa := rec.Header().Get(echo.HeaderWWWAuthenticate)
	if !strings.Contains(wa, "/.well-known/oauth-protected-resource") {
		t.Errorf("WWW-Authenticate does not point at OAuth discovery: %q", wa)
	}
	if !strings.Contains(wa, d.BaseURL) {
		t.Errorf("WWW-Authenticate does not use the configured BaseURL: %q", wa)
	}
	if seen != nil {
		t.Error("handler ran despite failed authentication")
	}
}

// A bearer token that is neither a point API key nor a live OAuth token must
// not be treated as either.
func TestAuthMiddleware_RejectsUnknownBearer(t *testing.T) {
	d, _ := newAuthTestDeps(t)
	provider := oauth.New(oauth.Config{BaseURL: d.BaseURL})

	e := echo.New()
	var seen interface{}
	e.GET("/mcp", okHandler(&seen), d.authMiddleware(provider))

	req := httptest.NewRequest(http.MethodGet, "/mcp", nil)
	req.Header.Set("Authorization", "Bearer not-a-real-token")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if seen != nil {
		t.Error("an unknown bearer was accepted")
	}
}

// A valid OAuth access token authenticates, and resolves to the blog owner —
// OAuth tokens carry no point identity of their own.
func TestAuthMiddleware_OAuthTokenActsAsOwner(t *testing.T) {
	d, _ := newAuthTestDeps(t)
	d.OwnerUserID = 42
	provider := oauth.New(oauth.Config{
		BaseURL:          d.BaseURL,
		ValidatePassword: func(context.Context, string) bool { return true },
	})
	token := issueOAuthToken(t, provider)

	e := echo.New()
	var seen interface{}
	e.GET("/mcp", okHandler(&seen), d.authMiddleware(provider))

	req := httptest.NewRequest(http.MethodGet, "/mcp", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	row, ok := seen.(models.GetAPIKeyByHashRow)
	if !ok {
		t.Fatalf("principal = %T, want models.GetAPIKeyByHashRow", seen)
	}
	if row.UserID != d.OwnerUserID {
		t.Errorf("OAuth principal UserID = %d, want the owner %d", row.UserID, d.OwnerUserID)
	}
}

// issueOAuthToken drives the full authorization-code + PKCE flow against
// provider and returns the resulting access token.
func issueOAuthToken(t *testing.T, provider *oauth.Provider) string {
	t.Helper()
	mux := http.NewServeMux()
	provider.Register(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	const redirectURI = "https://client.test/cb"
	body, _ := json.Marshal(map[string]any{"redirect_uris": []string{redirectURI}})
	resp, err := http.Post(srv.URL+"/oauth/register", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	var reg struct {
		ClientID string `json:"client_id"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&reg)
	_ = resp.Body.Close()

	verifier := "verifier-abc123_this-is-long-enough-for-pkce-0123456789"
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])

	noRedirect := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	authResp, err := noRedirect.PostForm(srv.URL+"/oauth/authorize", url.Values{
		"client_id":             {reg.ClientID},
		"redirect_uri":          {redirectURI},
		"code_challenge":        {challenge},
		"code_challenge_method": {"S256"},
		"submitted_password":    {"anything"},
	})
	if err != nil {
		t.Fatalf("authorize: %v", err)
	}
	_ = authResp.Body.Close()
	loc, err := url.Parse(authResp.Header.Get("Location"))
	if err != nil || loc.Query().Get("code") == "" {
		t.Fatalf("authorize did not return a code (status %d, location %q)",
			authResp.StatusCode, authResp.Header.Get("Location"))
	}

	tokResp, err := http.PostForm(srv.URL+"/oauth/token", url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {loc.Query().Get("code")},
		"client_id":     {reg.ClientID},
		"redirect_uri":  {redirectURI},
		"code_verifier": {verifier},
	})
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	defer func() { _ = tokResp.Body.Close() }()
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(tokResp.Body).Decode(&tok); err != nil {
		t.Fatalf("decode token: %v", err)
	}
	if tok.AccessToken == "" {
		t.Fatalf("token endpoint returned no access_token (status %d)", tokResp.StatusCode)
	}
	return tok.AccessToken
}

// A revoked/expired OAuth token stops working immediately.
func TestAuthMiddleware_RejectsExpiredOAuthToken(t *testing.T) {
	d, _ := newAuthTestDeps(t)
	provider := oauth.New(oauth.Config{
		BaseURL:          d.BaseURL,
		AccessTokenTTL:   -time.Second, // already expired when issued
		ValidatePassword: func(context.Context, string) bool { return true },
	})
	token := issueOAuthToken(t, provider)

	e := echo.New()
	var seen interface{}
	e.GET("/mcp", okHandler(&seen), d.authMiddleware(provider))

	req := httptest.NewRequest(http.MethodGet, "/mcp", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expired OAuth token was accepted: status = %d", rec.Code)
	}
	if seen != nil {
		t.Error("expired OAuth token produced a principal")
	}
}

// A bogus session cookie must not authenticate.
func TestAuthMiddleware_RejectsBadSessionCookie(t *testing.T) {
	d, _ := newAuthTestDeps(t)
	provider := oauth.New(oauth.Config{BaseURL: d.BaseURL})

	e := echo.New()
	var seen interface{}
	e.GET("/mcp", okHandler(&seen), d.authMiddleware(provider))

	req := httptest.NewRequest(http.MethodGet, "/mcp", nil)
	req.AddCookie(&http.Cookie{Name: "session", Value: "nope"})
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
	if seen != nil {
		t.Error("a bogus session cookie was accepted")
	}
}

// A point API key is the third way in, and it authenticates as its own user
// rather than as the OAuth owner.
func TestAuthMiddleware_APIKeyAuthenticatesAsItsOwner(t *testing.T) {
	d, repo := newAuthTestDeps(t)
	d.OwnerUserID = 1
	ctx := context.Background()
	if _, err := repo.DB().ExecContext(ctx,
		`INSERT INTO users (id,username,email,password_hash,display_name) VALUES (7,'u','u@t.com','h','U')`); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	raw, _, err := d.ApiKey.GenerateAPIKey(ctx, 7, "mcp", nil)
	if err != nil {
		t.Fatalf("GenerateAPIKey: %v", err)
	}

	provider := oauth.New(oauth.Config{BaseURL: d.BaseURL})
	e := echo.New()
	var seen interface{}
	e.GET("/mcp", okHandler(&seen), d.authMiddleware(provider))

	req := httptest.NewRequest(http.MethodGet, "/mcp", nil)
	req.Header.Set("Authorization", "Bearer "+raw)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	row, ok := seen.(models.GetAPIKeyByHashRow)
	if !ok {
		t.Fatalf("principal = %T, want models.GetAPIKeyByHashRow", seen)
	}
	if row.UserID != 7 {
		t.Errorf("API-key principal UserID = %d, want 7 (its own user, not the OAuth owner)", row.UserID)
	}
}

// A revoked API key must stop working.
func TestAuthMiddleware_RejectsRevokedAPIKey(t *testing.T) {
	d, repo := newAuthTestDeps(t)
	ctx := context.Background()
	if _, err := repo.DB().ExecContext(ctx,
		`INSERT INTO users (id,username,email,password_hash,display_name) VALUES (7,'u','u@t.com','h','U')`); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	raw, key, err := d.ApiKey.GenerateAPIKey(ctx, 7, "mcp", nil)
	if err != nil {
		t.Fatalf("GenerateAPIKey: %v", err)
	}
	if err := d.ApiKey.RevokeKey(ctx, key.ID, 7); err != nil {
		t.Fatalf("RevokeKey: %v", err)
	}

	provider := oauth.New(oauth.Config{BaseURL: d.BaseURL})
	e := echo.New()
	var seen interface{}
	e.GET("/mcp", okHandler(&seen), d.authMiddleware(provider))

	req := httptest.NewRequest(http.MethodGet, "/mcp", nil)
	req.Header.Set("Authorization", "Bearer "+raw)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("revoked API key was accepted: status = %d", rec.Code)
	}
	if seen != nil {
		t.Error("revoked API key produced a principal")
	}
}

// TestRepoOAuthStoreSurvivesRestart exercises the adapter against a real
// database rather than a fake: a token issued by one provider must still
// authenticate against a second provider built over the same repository, which
// is what a redeploy looks like from the client's side.
func TestRepoOAuthStoreSurvivesRestart(t *testing.T) {
	_, repo := newAuthTestDeps(t)
	ctx := context.Background()
	store := repoOAuthStore{repo}

	expires := time.Now().Add(time.Hour)
	before := oauth.New(oauth.Config{Store: store})
	if err := store.SaveClient(ctx, "client-1", []string{"https://claude.ai/api/mcp/auth_callback"}, time.Now()); err != nil {
		t.Fatalf("SaveClient: %v", err)
	}
	if err := store.SaveToken(ctx, sha256Hex("live-token"), "client-1", expires); err != nil {
		t.Fatalf("SaveToken: %v", err)
	}
	if !before.ValidateToken(ctx, "live-token") {
		t.Fatal("token rejected by the provider that stored it")
	}

	after := oauth.New(oauth.Config{Store: store})
	if !after.ValidateToken(ctx, "live-token") {
		t.Error("token rejected after restart — the store round-trip is broken")
	}
	if after.ValidateToken(ctx, "other-token") {
		t.Error("unrelated token accepted")
	}

	uris, _, found, err := store.LoadClient(ctx, "client-1")
	if err != nil || !found || len(uris) != 1 {
		t.Errorf("LoadClient after restart: uris=%v found=%v err=%v", uris, found, err)
	}
}

// sha256Hex mirrors how the provider keys tokens in the store.
func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}
