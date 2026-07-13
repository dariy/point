package oauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"html/template"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"
)

type Config struct {
	BaseURL string
	// ValidatePassword checks the password submitted on the OAuth login page.
	// It validates against point's admin credential (see wiring in mcp.Register),
	// so there is one password for the whole site. Nil disables interactive login.
	ValidatePassword func(ctx context.Context, password string) bool
	AccessTokenTTL   time.Duration // default: 1 hour
	RefreshTokenTTL  time.Duration // 0 = never expires
}

type clientRecord struct {
	ClientID     string
	RedirectURIs []string
	RegisteredAt time.Time
}

type codeRecord struct {
	ClientID            string
	RedirectURI         string
	CodeChallenge       string
	CodeChallengeMethod string
	ExpiresAt           time.Time
}

type tokenRecord struct {
	ClientID  string
	ExpiresAt time.Time // zero = never expires
}

// Provider is a self-contained in-memory OAuth 2.1 authorization server.
type Provider struct {
	cfg     Config
	mu      sync.RWMutex
	clients map[string]*clientRecord
	codes   map[string]*codeRecord
	tokens  map[string]*tokenRecord
}

// New creates a Provider and starts a background sweep of expired codes/tokens.
func New(cfg Config) *Provider {
	if cfg.AccessTokenTTL == 0 {
		cfg.AccessTokenTTL = time.Hour
	}
	p := &Provider{
		cfg:     cfg,
		clients: make(map[string]*clientRecord),
		codes:   make(map[string]*codeRecord),
		tokens:  make(map[string]*tokenRecord),
	}
	go p.janitor()
	return p
}

// janitor evicts expired authorization codes and access tokens every 10 minutes
// so the in-memory maps don't grow without bound on a long-running server.
// (Expired access tokens are otherwise never removed, only rejected on use.)
func (p *Provider) janitor() {
	for range time.Tick(10 * time.Minute) {
		now := time.Now()
		p.mu.Lock()
		for k, c := range p.codes {
			if now.After(c.ExpiresAt) {
				delete(p.codes, k)
			}
		}
		for k, t := range p.tokens {
			if !t.ExpiresAt.IsZero() && now.After(t.ExpiresAt) {
				delete(p.tokens, k)
			}
		}
		p.mu.Unlock()
	}
}

// Register mounts all OAuth 2.1 and discovery endpoints onto mux.
func (p *Provider) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /.well-known/oauth-protected-resource", p.handleProtectedResource)
	mux.HandleFunc("GET /.well-known/oauth-authorization-server", p.handleAuthorizationServer)
	mux.HandleFunc("POST /oauth/register", p.handleRegister)
	mux.HandleFunc("GET /oauth/authorize", p.handleAuthorizeGET)
	mux.HandleFunc("POST /oauth/authorize", p.handleAuthorizePOST)
	mux.HandleFunc("POST /oauth/token", p.handleToken)
}

// RequireBearer validates Authorization: Bearer <token> for protected routes.
func (p *Provider) RequireBearer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || token == "" {
			p.tokenError(w)
			return
		}
		p.mu.RLock()
		rec, exists := p.tokens[token]
		p.mu.RUnlock()
		if !exists || (!rec.ExpiresAt.IsZero() && time.Now().After(rec.ExpiresAt)) {
			p.tokenError(w)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ValidateToken reports whether token is a currently valid (unexpired) bearer
// token issued by this provider (or a configured static token).
func (p *Provider) ValidateToken(token string) bool {
	if token == "" {
		return false
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	rec, ok := p.tokens[token]
	if !ok {
		return false
	}
	return rec.ExpiresAt.IsZero() || time.Now().Before(rec.ExpiresAt)
}

func (p *Provider) tokenError(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("WWW-Authenticate", `Bearer realm="MCP", error="invalid_token"`)
	w.WriteHeader(http.StatusUnauthorized)
	_, _ = w.Write([]byte(`{"error":"invalid_token"}`))
}

func (p *Provider) handleProtectedResource(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"resource":                 p.cfg.BaseURL,
		"authorization_servers":    []string{p.cfg.BaseURL},
		"bearer_methods_supported": []string{"header"},
	})
}

func (p *Provider) handleAuthorizationServer(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"issuer":                                p.cfg.BaseURL,
		"authorization_endpoint":                p.cfg.BaseURL + "/oauth/authorize",
		"token_endpoint":                        p.cfg.BaseURL + "/oauth/token",
		"registration_endpoint":                 p.cfg.BaseURL + "/oauth/register",
		"response_types_supported":              []string{"code"},
		"grant_types_supported":                 []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":      []string{"S256"},
		"token_endpoint_auth_methods_supported": []string{"none"},
	})
}

func (p *Provider) handleRegister(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RedirectURIs []string `json:"redirect_uris"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.RedirectURIs) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_client_metadata"})
		return
	}
	id := randHex(16) // 32 hex chars
	now := time.Now()
	p.mu.Lock()
	p.clients[id] = &clientRecord{ClientID: id, RedirectURIs: body.RedirectURIs, RegisteredAt: now}
	p.mu.Unlock()
	writeJSON(w, http.StatusCreated, map[string]any{
		"client_id":                  id,
		"client_id_issued_at":        now.Unix(),
		"redirect_uris":              body.RedirectURIs,
		"grant_types":                []string{"authorization_code", "refresh_token"},
		"response_types":             []string{"code"},
		"token_endpoint_auth_method": "none",
	})
}

func (p *Provider) handleAuthorizeGET(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if q.Get("response_type") != "code" {
		http.Error(w, "response_type must be code", http.StatusBadRequest)
		return
	}
	clientID := q.Get("client_id")
	p.mu.RLock()
	client, exists := p.clients[clientID]
	p.mu.RUnlock()
	if !exists {
		http.Error(w, "unknown client_id", http.StatusBadRequest)
		return
	}
	// OAuth 2.1 §2.3.1: redirect_uri must exactly match a registered URI.
	if !slices.Contains(client.RedirectURIs, q.Get("redirect_uri")) {
		http.Error(w, "invalid redirect_uri", http.StatusBadRequest)
		return
	}
	if q.Get("code_challenge_method") != "S256" {
		http.Error(w, "code_challenge_method must be S256", http.StatusBadRequest)
		return
	}
	renderLogin(w, loginData{
		ClientID:            clientID,
		RedirectURI:         q.Get("redirect_uri"),
		State:               q.Get("state"),
		CodeChallenge:       q.Get("code_challenge"),
		CodeChallengeMethod: q.Get("code_challenge_method"),
	})
}

func (p *Provider) handleAuthorizePOST(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	clientID := r.FormValue("client_id")
	p.mu.RLock()
	client, exists := p.clients[clientID]
	p.mu.RUnlock()
	if !exists {
		http.Error(w, "unknown client_id", http.StatusBadRequest)
		return
	}
	redirectURI := r.FormValue("redirect_uri")
	state := r.FormValue("state")
	codeChallenge := r.FormValue("code_challenge")
	ccMethod := r.FormValue("code_challenge_method")

	// Normalize and canonicalize user input before validation/redirect decisions.
	normalizedRedirectURI := strings.ReplaceAll(redirectURI, "\\", "/")
	parsedRedirectURI, err := url.Parse(normalizedRedirectURI)
	if err != nil {
		http.Error(w, "invalid redirect_uri", http.StatusBadRequest)
		return
	}
	canonicalRedirectURI := parsedRedirectURI.String()

	// OAuth 2.1 §2.3.1: redirect_uri must exactly match a registered URI before
	// we ever redirect to it, so an attacker cannot exfiltrate an auth code.
	var matchedRedirectURI string
	for _, registered := range client.RedirectURIs {
		normalizedRegistered := strings.ReplaceAll(registered, "\\", "/")
		parsedRegistered, err := url.Parse(normalizedRegistered)
		if err != nil {
			continue
		}
		if parsedRegistered.String() == canonicalRedirectURI {
			matchedRedirectURI = parsedRegistered.String()
			break
		}
	}
	if matchedRedirectURI == "" {
		http.Error(w, "invalid redirect_uri", http.StatusBadRequest)
		return
	}
	redirectURI = matchedRedirectURI

	// Fail closed: a nil validator disables interactive OAuth login entirely
	// rather than accepting any submission. The validator checks against point's
	// admin password (constant-time Argon2id verify in the auth service).
	submitted := r.FormValue("submitted_password")
	if p.cfg.ValidatePassword == nil || !p.cfg.ValidatePassword(r.Context(), submitted) {
		msg := "Wrong password. Try again."
		if p.cfg.ValidatePassword == nil {
			msg = "OAuth login is disabled."
		}
		renderLogin(w, loginData{
			ClientID:            clientID,
			RedirectURI:         redirectURI,
			State:               state,
			CodeChallenge:       codeChallenge,
			CodeChallengeMethod: ccMethod,
			Error:               msg,
		})
		return
	}

	code := randHex(24) // 48 hex chars
	p.mu.Lock()
	p.codes[code] = &codeRecord{
		ClientID:            clientID,
		RedirectURI:         redirectURI,
		CodeChallenge:       codeChallenge,
		CodeChallengeMethod: ccMethod,
		ExpiresAt:           time.Now().Add(2 * time.Minute),
	}
	p.mu.Unlock()
	slog.Info("mcp-oauth: password accepted, issuing code", "client_id", clientID)

	dest, _ := url.Parse(redirectURI)
	qs := dest.Query()
	qs.Set("code", code)
	if state != "" {
		qs.Set("state", state)
	}
	dest.RawQuery = qs.Encode()
	http.Redirect(w, r, dest.String(), http.StatusFound)
}

func (p *Provider) handleToken(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}
	switch r.FormValue("grant_type") {
	case "authorization_code":
		p.tokenFromCode(w, r)
	case "refresh_token":
		p.tokenFromRefresh(w, r)
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported_grant_type"})
	}
}

func (p *Provider) tokenFromCode(w http.ResponseWriter, r *http.Request) {
	code := r.FormValue("code")
	clientID := r.FormValue("client_id")
	redirectURI := r.FormValue("redirect_uri")
	verifier := r.FormValue("code_verifier")

	p.mu.Lock()
	defer p.mu.Unlock()

	rec, exists := p.codes[code]
	if !exists {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant"})
		return
	}
	if time.Now().After(rec.ExpiresAt) {
		delete(p.codes, code)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant"})
		return
	}
	if rec.ClientID != clientID || rec.RedirectURI != redirectURI {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant"})
		return
	}
	if s256(verifier) != rec.CodeChallenge {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant"})
		return
	}
	delete(p.codes, code)

	access, refresh := randHex(32), randHex(32)
	p.tokens[access] = &tokenRecord{ClientID: clientID, ExpiresAt: time.Now().Add(p.cfg.AccessTokenTTL)}
	p.tokens[refresh] = &tokenRecord{ClientID: clientID, ExpiresAt: p.refreshExpiry()}
	slog.Info("mcp-oauth: issued token pair", "client_id", clientID)

	writeJSON(w, http.StatusOK, map[string]any{
		"access_token":  access,
		"token_type":    "Bearer",
		"expires_in":    int(p.cfg.AccessTokenTTL.Seconds()),
		"refresh_token": refresh,
	})
}

func (p *Provider) tokenFromRefresh(w http.ResponseWriter, r *http.Request) {
	refreshToken := r.FormValue("refresh_token")

	p.mu.Lock()
	defer p.mu.Unlock()

	rec, exists := p.tokens[refreshToken]
	if !exists {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant"})
		return
	}
	if !rec.ExpiresAt.IsZero() && time.Now().After(rec.ExpiresAt) {
		delete(p.tokens, refreshToken)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant"})
		return
	}
	clientID := rec.ClientID
	delete(p.tokens, refreshToken)

	access, newRefresh := randHex(32), randHex(32)
	p.tokens[access] = &tokenRecord{ClientID: clientID, ExpiresAt: time.Now().Add(p.cfg.AccessTokenTTL)}
	p.tokens[newRefresh] = &tokenRecord{ClientID: clientID, ExpiresAt: p.refreshExpiry()}

	writeJSON(w, http.StatusOK, map[string]any{
		"access_token":  access,
		"token_type":    "Bearer",
		"expires_in":    int(p.cfg.AccessTokenTTL.Seconds()),
		"refresh_token": newRefresh,
	})
}

// refreshExpiry returns the expiry time for refresh tokens (zero = never).
func (p *Provider) refreshExpiry() time.Time {
	if p.cfg.RefreshTokenTTL != 0 {
		return time.Now().Add(p.cfg.RefreshTokenTTL)
	}
	return time.Time{}
}

// --- helpers ---

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func s256(verifier string) string {
	h := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(h[:])
}

// --- login page ---

type loginData struct {
	ClientID            string
	RedirectURI         string
	State               string
	CodeChallenge       string
	CodeChallengeMethod string
	Error               string
}

var loginTmpl = template.Must(template.New("login").Parse(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MCP Login</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d0d0d;color:#e0e0e0;font-family:'Courier New',Courier,monospace;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#161616;border:1px solid #2a2a2a;border-radius:4px;padding:2.5rem 3rem;width:100%;max-width:380px}
h1{color:#c9a96e;font-size:1.1rem;letter-spacing:.12em;text-transform:uppercase;margin-bottom:2rem;text-align:center}
label{display:block;font-size:.75rem;color:#888;letter-spacing:.08em;text-transform:uppercase;margin-bottom:.4rem}
input[type=password]{width:100%;background:#0d0d0d;border:1px solid #333;color:#e0e0e0;font-family:inherit;font-size:.95rem;padding:.6rem .8rem;border-radius:2px;outline:none;margin-bottom:1.5rem}
input[type=password]:focus{border-color:#c9a96e}
.error{color:#e06e6e;font-size:.82rem;margin-bottom:1rem;text-align:center}
button{width:100%;background:#c9a96e;color:#0d0d0d;border:none;font-family:inherit;font-size:.85rem;font-weight:bold;letter-spacing:.1em;text-transform:uppercase;padding:.65rem;border-radius:2px;cursor:pointer}
button:hover{background:#d4b87a}
</style>
</head>
<body>
<div class="card">
<h1>MCP Access</h1>
<form method="POST" action="/oauth/authorize">
<input type="hidden" name="client_id" value="{{.ClientID}}">
<input type="hidden" name="redirect_uri" value="{{.RedirectURI}}">
<input type="hidden" name="state" value="{{.State}}">
<input type="hidden" name="code_challenge" value="{{.CodeChallenge}}">
<input type="hidden" name="code_challenge_method" value="{{.CodeChallengeMethod}}">
<label for="pw">Password</label>
<input type="password" id="pw" name="submitted_password" autofocus>
{{if .Error}}<p class="error">{{.Error}}</p>{{end}}
<button type="submit">Authenticate</button>
</form>
</div>
</body>
</html>`))

func renderLogin(w http.ResponseWriter, data loginData) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = loginTmpl.Execute(w, data)
}
