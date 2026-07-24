package oauth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// newTestProvider returns a Provider whose ValidatePassword accepts exactly
// "hunter2", mounted on a fresh mux served by an httptest.Server. The janitor
// goroutine is harmless in tests (its 10-minute tick never fires).
func newTestProvider(t *testing.T, cfg Config) (*Provider, *httptest.Server) {
	t.Helper()
	if cfg.ValidatePassword == nil {
		cfg.ValidatePassword = func(_ context.Context, pw string) bool { return pw == "hunter2" }
	}
	p := New(cfg)
	mux := http.NewServeMux()
	p.Register(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	if cfg.BaseURL == "" {
		p.cfg.BaseURL = srv.URL
	}
	return p, srv
}

// pkcePair returns a verifier and its S256 challenge.
func pkcePair() (verifier, challenge string) {
	verifier = "verifier-abc123_this-is-long-enough-for-pkce-0123456789"
	sum := sha256.Sum256([]byte(verifier))
	challenge = base64.RawURLEncoding.EncodeToString(sum[:])
	return verifier, challenge
}

// registerClient hits POST /oauth/register and returns the new client_id.
func registerClient(t *testing.T, srv *httptest.Server, redirectURIs ...string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"redirect_uris": redirectURIs})
	resp, err := http.Post(srv.URL+"/oauth/register", "application/json", strings.NewReader(string(body)))
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register status = %d, want 201", resp.StatusCode)
	}
	var out struct {
		ClientID string `json:"client_id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode register: %v", err)
	}
	if out.ClientID == "" {
		t.Fatal("register returned empty client_id")
	}
	return out.ClientID
}

// noRedirectClient never follows redirects, so the 302 from /oauth/authorize is
// returned to the caller instead of chased.
func noRedirectClient() *http.Client {
	return &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// --- discovery endpoints ---

func TestDiscoveryEndpoints(t *testing.T) {
	_, srv := newTestProvider(t, Config{BaseURL: "https://example.test"})

	t.Run("protected-resource", func(t *testing.T) {
		resp, err := http.Get(srv.URL + "/.well-known/oauth-protected-resource")
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		var m map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
			t.Fatal(err)
		}
		if m["resource"] != "https://example.test" {
			t.Errorf("resource = %v", m["resource"])
		}
		servers, _ := m["authorization_servers"].([]any)
		if len(servers) != 1 || servers[0] != "https://example.test" {
			t.Errorf("authorization_servers = %v", m["authorization_servers"])
		}
	})

	t.Run("authorization-server", func(t *testing.T) {
		resp, err := http.Get(srv.URL + "/.well-known/oauth-authorization-server")
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		var m map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
			t.Fatal(err)
		}
		if m["issuer"] != "https://example.test" {
			t.Errorf("issuer = %v", m["issuer"])
		}
		if m["authorization_endpoint"] != "https://example.test/oauth/authorize" {
			t.Errorf("authorization_endpoint = %v", m["authorization_endpoint"])
		}
		if m["token_endpoint"] != "https://example.test/oauth/token" {
			t.Errorf("token_endpoint = %v", m["token_endpoint"])
		}
		methods, _ := m["code_challenge_methods_supported"].([]any)
		if len(methods) != 1 || methods[0] != "S256" {
			t.Errorf("code_challenge_methods_supported = %v", m["code_challenge_methods_supported"])
		}
	})
}

// --- dynamic client registration ---

func TestRegister(t *testing.T) {
	_, srv := newTestProvider(t, Config{})

	t.Run("valid", func(t *testing.T) {
		id := registerClient(t, srv, "https://app.test/cb")
		if len(id) != 32 { // randHex(16)
			t.Errorf("client_id length = %d, want 32", len(id))
		}
	})

	t.Run("empty-redirect-uris", func(t *testing.T) {
		resp, err := http.Post(srv.URL+"/oauth/register", "application/json",
			strings.NewReader(`{"redirect_uris":[]}`))
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", resp.StatusCode)
		}
	})

	t.Run("malformed-json", func(t *testing.T) {
		resp, err := http.Post(srv.URL+"/oauth/register", "application/json",
			strings.NewReader(`{not json`))
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", resp.StatusCode)
		}
	})
}

// --- authorize GET (login page rendering + validation) ---

func TestAuthorizeGET(t *testing.T) {
	_, srv := newTestProvider(t, Config{})
	clientID := registerClient(t, srv, "https://app.test/cb")
	_, challenge := pkcePair()

	base := func() url.Values {
		return url.Values{
			"response_type":         {"code"},
			"client_id":             {clientID},
			"redirect_uri":          {"https://app.test/cb"},
			"code_challenge":        {challenge},
			"code_challenge_method": {"S256"},
			"state":                 {"xyz"},
		}
	}

	cases := []struct {
		name   string
		mutate func(url.Values)
		want   int
	}{
		{"success", func(url.Values) {}, http.StatusOK},
		{"wrong-response-type", func(q url.Values) { q.Set("response_type", "token") }, http.StatusBadRequest},
		{"unknown-client", func(q url.Values) { q.Set("client_id", "deadbeef") }, http.StatusBadRequest},
		{"redirect-uri-mismatch", func(q url.Values) { q.Set("redirect_uri", "https://evil.test/cb") }, http.StatusBadRequest},
		{"non-s256-method", func(q url.Values) { q.Set("code_challenge_method", "plain") }, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			q := base()
			tc.mutate(q)
			resp, err := http.Get(srv.URL + "/oauth/authorize?" + q.Encode())
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = resp.Body.Close() }()
			if resp.StatusCode != tc.want {
				t.Errorf("status = %d, want %d", resp.StatusCode, tc.want)
			}
			if tc.want == http.StatusOK {
				body, _ := io.ReadAll(resp.Body)
				// The login form must carry the PKCE challenge + state forward as
				// hidden fields so the POST can preserve them.
				if !strings.Contains(string(body), challenge) {
					t.Error("login page missing code_challenge")
				}
				if !strings.Contains(string(body), `name="submitted_password"`) {
					t.Error("login page missing password field")
				}
			}
		})
	}
}

// --- authorize POST (password check + code issuance) ---

// doAuthorizePOST submits the login form and returns the raw (unfollowed) response.
func doAuthorizePOST(t *testing.T, srv *httptest.Server, form url.Values) *http.Response {
	t.Helper()
	resp, err := noRedirectClient().PostForm(srv.URL+"/oauth/authorize", form)
	if err != nil {
		t.Fatalf("authorize POST: %v", err)
	}
	return resp
}

func TestAuthorizePOST(t *testing.T) {
	_, challenge := pkcePair()

	baseForm := func(clientID string) url.Values {
		return url.Values{
			"client_id":             {clientID},
			"redirect_uri":          {"https://app.test/cb"},
			"state":                 {"xyz"},
			"code_challenge":        {challenge},
			"code_challenge_method": {"S256"},
			"submitted_password":    {"hunter2"},
		}
	}

	t.Run("success-issues-code-and-redirects", func(t *testing.T) {
		_, srv := newTestProvider(t, Config{})
		clientID := registerClient(t, srv, "https://app.test/cb")
		resp := doAuthorizePOST(t, srv, baseForm(clientID))
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusFound {
			t.Fatalf("status = %d, want 302", resp.StatusCode)
		}
		loc, err := url.Parse(resp.Header.Get("Location"))
		if err != nil {
			t.Fatal(err)
		}
		if loc.Scheme+"://"+loc.Host+loc.Path != "https://app.test/cb" {
			t.Errorf("redirect base = %q", loc.String())
		}
		if loc.Query().Get("code") == "" {
			t.Error("redirect missing authorization code")
		}
		if loc.Query().Get("state") != "xyz" {
			t.Errorf("state = %q, want xyz", loc.Query().Get("state"))
		}
	})

	t.Run("wrong-password-re-renders-login", func(t *testing.T) {
		_, srv := newTestProvider(t, Config{})
		clientID := registerClient(t, srv, "https://app.test/cb")
		form := baseForm(clientID)
		form.Set("submitted_password", "nope")
		resp := doAuthorizePOST(t, srv, form)
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200 (re-render)", resp.StatusCode)
		}
		body, _ := io.ReadAll(resp.Body)
		if !strings.Contains(string(body), "Wrong password") {
			t.Error("expected wrong-password error on re-rendered page")
		}
	})

	t.Run("nil-validator-disables-login", func(t *testing.T) {
		// Fail-closed: a nil ValidatePassword must reject every submission.
		p := New(Config{})
		p.cfg.ValidatePassword = nil
		mux := http.NewServeMux()
		p.Register(mux)
		srv := httptest.NewServer(mux)
		t.Cleanup(srv.Close)
		clientID := registerClient(t, srv, "https://app.test/cb")
		resp := doAuthorizePOST(t, srv, baseForm(clientID))
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200 (disabled notice)", resp.StatusCode)
		}
		body, _ := io.ReadAll(resp.Body)
		if !strings.Contains(string(body), "OAuth login is disabled") {
			t.Error("expected disabled notice")
		}
	})

	t.Run("unknown-client", func(t *testing.T) {
		_, srv := newTestProvider(t, Config{})
		form := baseForm("deadbeef")
		resp := doAuthorizePOST(t, srv, form)
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", resp.StatusCode)
		}
	})

	t.Run("redirect-uri-mismatch-rejected-before-password", func(t *testing.T) {
		// An unregistered redirect_uri must be refused so an attacker can never
		// receive an auth code, even with the correct password.
		_, srv := newTestProvider(t, Config{})
		clientID := registerClient(t, srv, "https://app.test/cb")
		form := baseForm(clientID)
		form.Set("redirect_uri", "https://evil.test/cb")
		resp := doAuthorizePOST(t, srv, form)
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", resp.StatusCode)
		}
	})

	t.Run("no-state-omits-state-param", func(t *testing.T) {
		_, srv := newTestProvider(t, Config{})
		clientID := registerClient(t, srv, "https://app.test/cb")
		form := baseForm(clientID)
		form.Del("state")
		resp := doAuthorizePOST(t, srv, form)
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusFound {
			t.Fatalf("status = %d, want 302", resp.StatusCode)
		}
		loc, _ := url.Parse(resp.Header.Get("Location"))
		if loc.Query().Has("state") {
			t.Errorf("state should be absent, got %q", loc.Query().Get("state"))
		}
	})
}

// --- full authorization_code + refresh flow ---

// getCode drives register+authorize and returns (clientID, code).
func getCode(t *testing.T, srv *httptest.Server, challenge string) (clientID, code string) {
	t.Helper()
	clientID = registerClient(t, srv, "https://app.test/cb")
	form := url.Values{
		"client_id":             {clientID},
		"redirect_uri":          {"https://app.test/cb"},
		"state":                 {"s"},
		"code_challenge":        {challenge},
		"code_challenge_method": {"S256"},
		"submitted_password":    {"hunter2"},
	}
	resp := doAuthorizePOST(t, srv, form)
	defer func() { _ = resp.Body.Close() }()
	loc, _ := url.Parse(resp.Header.Get("Location"))
	code = loc.Query().Get("code")
	if code == "" {
		t.Fatal("no code issued")
	}
	return clientID, code
}

// postToken hits the token endpoint and returns the decoded body + status.
func postToken(t *testing.T, srv *httptest.Server, form url.Values) (map[string]any, int) {
	t.Helper()
	resp, err := http.PostForm(srv.URL+"/oauth/token", form)
	if err != nil {
		t.Fatalf("token POST: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode token response: %v", err)
	}
	return out, resp.StatusCode
}

func TestTokenFromCode(t *testing.T) {
	verifier, challenge := pkcePair()

	t.Run("happy-path", func(t *testing.T) {
		_, srv := newTestProvider(t, Config{})
		clientID, code := getCode(t, srv, challenge)
		out, status := postToken(t, srv, url.Values{
			"grant_type":    {"authorization_code"},
			"code":          {code},
			"client_id":     {clientID},
			"redirect_uri":  {"https://app.test/cb"},
			"code_verifier": {verifier},
		})
		if status != http.StatusOK {
			t.Fatalf("status = %d, want 200 (%v)", status, out)
		}
		if out["access_token"] == "" || out["refresh_token"] == "" {
			t.Errorf("missing tokens: %v", out)
		}
		if out["token_type"] != "Bearer" {
			t.Errorf("token_type = %v", out["token_type"])
		}
	})

	t.Run("code-is-single-use", func(t *testing.T) {
		_, srv := newTestProvider(t, Config{})
		clientID, code := getCode(t, srv, challenge)
		form := url.Values{
			"grant_type":    {"authorization_code"},
			"code":          {code},
			"client_id":     {clientID},
			"redirect_uri":  {"https://app.test/cb"},
			"code_verifier": {verifier},
		}
		if _, status := postToken(t, srv, form); status != http.StatusOK {
			t.Fatalf("first exchange status = %d, want 200", status)
		}
		if _, status := postToken(t, srv, form); status != http.StatusBadRequest {
			t.Errorf("replayed code status = %d, want 400", status)
		}
	})

	t.Run("wrong-pkce-verifier", func(t *testing.T) {
		_, srv := newTestProvider(t, Config{})
		clientID, code := getCode(t, srv, challenge)
		_, status := postToken(t, srv, url.Values{
			"grant_type":    {"authorization_code"},
			"code":          {code},
			"client_id":     {clientID},
			"redirect_uri":  {"https://app.test/cb"},
			"code_verifier": {"wrong-verifier"},
		})
		if status != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", status)
		}
	})

	t.Run("unknown-code", func(t *testing.T) {
		_, srv := newTestProvider(t, Config{})
		_, status := postToken(t, srv, url.Values{
			"grant_type":    {"authorization_code"},
			"code":          {"nope"},
			"client_id":     {"c"},
			"redirect_uri":  {"https://app.test/cb"},
			"code_verifier": {verifier},
		})
		if status != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", status)
		}
	})

	t.Run("client-id-mismatch", func(t *testing.T) {
		_, srv := newTestProvider(t, Config{})
		_, code := getCode(t, srv, challenge)
		_, status := postToken(t, srv, url.Values{
			"grant_type":    {"authorization_code"},
			"code":          {code},
			"client_id":     {"different"},
			"redirect_uri":  {"https://app.test/cb"},
			"code_verifier": {verifier},
		})
		if status != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", status)
		}
	})

	t.Run("redirect-uri-mismatch", func(t *testing.T) {
		_, srv := newTestProvider(t, Config{})
		clientID, code := getCode(t, srv, challenge)
		_, status := postToken(t, srv, url.Values{
			"grant_type":    {"authorization_code"},
			"code":          {code},
			"client_id":     {clientID},
			"redirect_uri":  {"https://app.test/other"},
			"code_verifier": {verifier},
		})
		if status != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", status)
		}
	})

	t.Run("expired-code", func(t *testing.T) {
		p, srv := newTestProvider(t, Config{})
		clientID, code := getCode(t, srv, challenge)
		// Force the code past its expiry via the internal map (white-box).
		p.mu.Lock()
		p.codes[code].ExpiresAt = time.Now().Add(-time.Second)
		p.mu.Unlock()
		_, status := postToken(t, srv, url.Values{
			"grant_type":    {"authorization_code"},
			"code":          {code},
			"client_id":     {clientID},
			"redirect_uri":  {"https://app.test/cb"},
			"code_verifier": {verifier},
		})
		if status != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", status)
		}
		// Expired code must be evicted, not left lingering.
		p.mu.RLock()
		_, still := p.codes[code]
		p.mu.RUnlock()
		if still {
			t.Error("expired code was not deleted")
		}
	})
}

func TestTokenGrantErrors(t *testing.T) {
	_, srv := newTestProvider(t, Config{})

	t.Run("unsupported-grant-type", func(t *testing.T) {
		_, status := postToken(t, srv, url.Values{"grant_type": {"password"}})
		if status != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", status)
		}
	})

	t.Run("missing-grant-type", func(t *testing.T) {
		_, status := postToken(t, srv, url.Values{})
		if status != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", status)
		}
	})
}

func TestTokenFromRefresh(t *testing.T) {
	verifier, challenge := pkcePair()

	// exchangeCode runs the full code→token exchange and returns the token set.
	exchange := func(t *testing.T, srv *httptest.Server) map[string]any {
		clientID, code := getCode(t, srv, challenge)
		out, status := postToken(t, srv, url.Values{
			"grant_type":    {"authorization_code"},
			"code":          {code},
			"client_id":     {clientID},
			"redirect_uri":  {"https://app.test/cb"},
			"code_verifier": {verifier},
		})
		if status != http.StatusOK {
			t.Fatalf("code exchange status = %d", status)
		}
		return out
	}

	t.Run("rotates-refresh-token", func(t *testing.T) {
		_, srv := newTestProvider(t, Config{})
		first := exchange(t, srv)
		oldRefresh := first["refresh_token"].(string)

		out, status := postToken(t, srv, url.Values{
			"grant_type":    {"refresh_token"},
			"refresh_token": {oldRefresh},
		})
		if status != http.StatusOK {
			t.Fatalf("refresh status = %d (%v)", status, out)
		}
		newRefresh := out["refresh_token"].(string)
		if newRefresh == "" || newRefresh == oldRefresh {
			t.Errorf("refresh token not rotated: old=%q new=%q", oldRefresh, newRefresh)
		}
		if out["access_token"] == "" {
			t.Error("no new access token")
		}

		// Old refresh token must be revoked (single-use).
		if _, status := postToken(t, srv, url.Values{
			"grant_type":    {"refresh_token"},
			"refresh_token": {oldRefresh},
		}); status != http.StatusBadRequest {
			t.Errorf("reused old refresh status = %d, want 400", status)
		}
	})

	t.Run("unknown-refresh-token", func(t *testing.T) {
		_, srv := newTestProvider(t, Config{})
		_, status := postToken(t, srv, url.Values{
			"grant_type":    {"refresh_token"},
			"refresh_token": {"nope"},
		})
		if status != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", status)
		}
	})

	t.Run("expired-refresh-token", func(t *testing.T) {
		p, srv := newTestProvider(t, Config{RefreshTokenTTL: time.Hour})
		first := exchange(t, srv)
		refresh := first["refresh_token"].(string)
		p.mu.Lock()
		p.tokens[refresh].ExpiresAt = time.Now().Add(-time.Second)
		p.mu.Unlock()
		_, status := postToken(t, srv, url.Values{
			"grant_type":    {"refresh_token"},
			"refresh_token": {refresh},
		})
		if status != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", status)
		}
		p.mu.RLock()
		_, still := p.tokens[refresh]
		p.mu.RUnlock()
		if still {
			t.Error("expired refresh token was not deleted")
		}
	})
}

// --- bearer validation ---

func TestRequireBearer(t *testing.T) {
	p, _ := newTestProvider(t, Config{})
	// Seed a valid and an expired token directly.
	p.mu.Lock()
	p.tokens["good"] = &tokenRecord{ClientID: "c", ExpiresAt: time.Now().Add(time.Hour)}
	p.tokens["stale"] = &tokenRecord{ClientID: "c", ExpiresAt: time.Now().Add(-time.Hour)}
	p.tokens["forever"] = &tokenRecord{ClientID: "c"} // zero ExpiresAt = never expires
	p.mu.Unlock()

	protected := p.RequireBearer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))

	cases := []struct {
		name   string
		header string
		want   int
	}{
		{"valid", "Bearer good", http.StatusOK},
		{"never-expires", "Bearer forever", http.StatusOK},
		{"expired", "Bearer stale", http.StatusUnauthorized},
		{"unknown", "Bearer bogus", http.StatusUnauthorized},
		{"empty-token", "Bearer ", http.StatusUnauthorized},
		{"no-bearer-prefix", "good", http.StatusUnauthorized},
		{"missing-header", "", http.StatusUnauthorized},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/protected", nil)
			if tc.header != "" {
				req.Header.Set("Authorization", tc.header)
			}
			rec := httptest.NewRecorder()
			protected.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Errorf("status = %d, want %d", rec.Code, tc.want)
			}
			if tc.want == http.StatusUnauthorized {
				if !strings.Contains(rec.Header().Get("WWW-Authenticate"), "invalid_token") {
					t.Errorf("missing WWW-Authenticate challenge: %q", rec.Header().Get("WWW-Authenticate"))
				}
			}
		})
	}
}

func TestValidateToken(t *testing.T) {
	p, _ := newTestProvider(t, Config{})
	p.mu.Lock()
	p.tokens["good"] = &tokenRecord{ClientID: "c", ExpiresAt: time.Now().Add(time.Hour)}
	p.tokens["stale"] = &tokenRecord{ClientID: "c", ExpiresAt: time.Now().Add(-time.Hour)}
	p.tokens["forever"] = &tokenRecord{ClientID: "c"}
	p.mu.Unlock()

	cases := []struct {
		token string
		want  bool
	}{
		{"good", true},
		{"forever", true},
		{"stale", false},
		{"unknown", false},
		{"", false},
	}
	for _, tc := range cases {
		if got := p.ValidateToken(tc.token); got != tc.want {
			t.Errorf("ValidateToken(%q) = %v, want %v", tc.token, got, tc.want)
		}
	}
}

// --- config defaults + helpers ---

func TestNewDefaultsAccessTokenTTL(t *testing.T) {
	p := New(Config{})
	if p.cfg.AccessTokenTTL != time.Hour {
		t.Errorf("default AccessTokenTTL = %v, want 1h", p.cfg.AccessTokenTTL)
	}
}

func TestAccessTokenTTLReflectedInResponse(t *testing.T) {
	verifier, challenge := pkcePair()
	_, srv := newTestProvider(t, Config{AccessTokenTTL: 42 * time.Minute})
	clientID, code := getCode(t, srv, challenge)
	out, status := postToken(t, srv, url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"client_id":     {clientID},
		"redirect_uri":  {"https://app.test/cb"},
		"code_verifier": {verifier},
	})
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if got := out["expires_in"].(float64); int(got) != int((42 * time.Minute).Seconds()) {
		t.Errorf("expires_in = %v, want %d", got, int((42 * time.Minute).Seconds()))
	}
}

func TestRefreshExpiry(t *testing.T) {
	t.Run("zero-ttl-never-expires", func(t *testing.T) {
		p := New(Config{})
		if got := p.refreshExpiry(); !got.IsZero() {
			t.Errorf("refreshExpiry() = %v, want zero", got)
		}
	})
	t.Run("nonzero-ttl-in-future", func(t *testing.T) {
		p := New(Config{RefreshTokenTTL: time.Hour})
		got := p.refreshExpiry()
		if got.IsZero() || got.Before(time.Now()) {
			t.Errorf("refreshExpiry() = %v, want future time", got)
		}
	})
}

func TestS256(t *testing.T) {
	// Known RFC 7636 Appendix B vector.
	const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	const want = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
	if got := s256(verifier); got != want {
		t.Errorf("s256() = %q, want %q", got, want)
	}
}

func TestRandHexLengthAndUniqueness(t *testing.T) {
	a, b := randHex(16), randHex(16)
	if len(a) != 32 {
		t.Errorf("randHex(16) length = %d, want 32", len(a))
	}
	if a == b {
		t.Error("randHex produced identical values")
	}
}

// End-to-end: register → authorize → exchange code → use bearer on a protected route.
func TestFullFlow(t *testing.T) {
	verifier, challenge := pkcePair()
	p, srv := newTestProvider(t, Config{})

	clientID, code := getCode(t, srv, challenge)
	out, status := postToken(t, srv, url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"client_id":     {clientID},
		"redirect_uri":  {"https://app.test/cb"},
		"code_verifier": {verifier},
	})
	if status != http.StatusOK {
		t.Fatalf("token exchange failed: %d", status)
	}
	access := out["access_token"].(string)

	protected := p.RequireBearer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("secret"))
	}))
	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	req.Header.Set("Authorization", "Bearer "+access)
	rec := httptest.NewRecorder()
	protected.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Body.String() != "secret" {
		t.Errorf("protected route: status=%d body=%q", rec.Code, rec.Body.String())
	}
	if !p.ValidateToken(access) {
		t.Error("issued access token failed ValidateToken")
	}
}
