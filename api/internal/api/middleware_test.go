package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"point-api/internal/models"
	"point-api/internal/plugins"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

func TestMiddleware_ExtractIDNil(t *testing.T) {
	if id := extractUserID(nil); id != 0 {
		t.Errorf("expected 0, got %d", id)
	}
	if id := extractSessionID(nil); id != 0 {
		t.Errorf("expected 0, got %d", id)
	}
}

func TestRequirePlugin(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	svc := services.NewSettingsService(repo)
	e := echo.New()
	hit := false
	handler := func(c echo.Context) error {
		hit = true
		return c.NoContent(http.StatusOK)
	}

	call := func(id string) int {
		hit = false
		req := httptest.NewRequest(http.MethodGet, "/api/instagram", nil)
		rec := httptest.NewRecorder()
		mw := RequirePlugin(svc, id)
		err := mw(handler)(e.NewContext(req, rec))
		if err != nil {
			e.HTTPErrorHandler(err, e.NewContext(req, rec))
			var he *echo.HTTPError
			if errors.As(err, &he) {
				return he.Code
			}
			return http.StatusInternalServerError
		}
		return rec.Code
	}

	// With no setting stored, the gate falls back to the descriptor's
	// DefaultEnabled — in both directions. The subjects come from the registry
	// rather than being named here: which plugins ship on is retuned per
	// release, and this test is about the fallback, not about the tuning.
	defaultOn, defaultOff := registryDefaultIDs(t)
	if code := call(defaultOn); code != http.StatusOK || !hit {
		t.Errorf("enabled-by-default plugin %q should pass: code=%d hit=%v", defaultOn, code, hit)
	}
	if code := call(defaultOff); code != http.StatusNotFound || hit {
		t.Errorf("disabled-by-default plugin %q should 404: code=%d hit=%v", defaultOff, code, hit)
	}

	// Explicitly disabled → 404, inner handler not reached.
	if err := svc.SetSetting(ctx, plugins.EnabledKey("instagram"), "false", "boolean"); err != nil {
		t.Fatal(err)
	}
	if code := call("instagram"); code != http.StatusNotFound || hit {
		t.Errorf("disabled plugin should 404 without reaching handler: code=%d hit=%v", code, hit)
	}

	// Re-enabled → passes again.
	if err := svc.SetSetting(ctx, plugins.EnabledKey("instagram"), "true", "boolean"); err != nil {
		t.Fatal(err)
	}
	if code := call("instagram"); code != http.StatusOK || !hit {
		t.Errorf("re-enabled plugin should pass: code=%d hit=%v", code, hit)
	}
}

// enableAPIKeysPlugin turns the api-keys plugin on. It ships disabled, and
// ValidateAPIKey refuses every key while it is off, so any test that means to
// exercise bearer auth has to say so.
func enableAPIKeysPlugin(t *testing.T, settings *services.SettingsService) {
	t.Helper()
	if err := settings.SetSetting(context.Background(), plugins.EnabledKey("api-keys"), "true", "string"); err != nil {
		t.Fatalf("enable api-keys plugin: %v", err)
	}
}

// RequirePlugin only guards the /api/api-keys management routes. The toggle has
// to reach the authentication path as well, or a key minted while the plugin
// was on keeps opening the whole admin API after the admin turns it off.
func TestAuthMiddleware_APIKeyRefusedWhenPluginDisabled(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	settingsSvc := services.NewSettingsService(repo)
	apiKeySvc := services.NewApiKeyService(repo, settingsSvc)
	middleware := AuthMiddleware(services.NewAuthService(repo), apiKeySvc)

	user, err := repo.CreateUser(ctx, models.CreateUserParams{
		Username: "keyed", Email: "keyed@t.com", PasswordHash: "h", DisplayName: "Keyed",
	})
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	enableAPIKeysPlugin(t, settingsSvc)
	rawKey, _, err := apiKeySvc.GenerateAPIKey(ctx, user.ID, "admin-key", "", nil)
	if err != nil {
		t.Fatalf("GenerateAPIKey: %v", err)
	}

	e := echo.New()
	call := func() (int, bool) {
		reached := false
		req := httptest.NewRequest(http.MethodGet, "/api/posts", nil)
		req.Header.Set("Authorization", "Bearer "+rawKey)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		err := middleware(func(c echo.Context) error {
			reached = true
			return c.NoContent(http.StatusOK)
		})(c)
		if err != nil {
			var he *echo.HTTPError
			if errors.As(err, &he) {
				return he.Code, reached
			}
			t.Fatalf("unexpected non-HTTP error: %v", err)
		}
		return rec.Code, reached
	}

	if code, reached := call(); code != http.StatusOK || !reached {
		t.Fatalf("enabled plugin: expected the key to authenticate, got %d (handler reached: %v)", code, reached)
	}

	if err := settingsSvc.SetSetting(ctx, plugins.EnabledKey("api-keys"), "false", "string"); err != nil {
		t.Fatalf("disable api-keys plugin: %v", err)
	}
	code, reached := call()
	if code != http.StatusUnauthorized {
		t.Errorf("disabled plugin: expected 401, got %d", code)
	}
	if reached {
		t.Error("disabled plugin: the handler must not run for an API-key request")
	}
}

// A lightroom key may only create posts, tags and media; everything else,
// including reads, is refused with 403 before the handler runs.
func TestAuthMiddleware_LightroomScope(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	settingsSvc := services.NewSettingsService(repo)
	apiKeySvc := services.NewApiKeyService(repo, settingsSvc)
	middleware := AuthMiddleware(services.NewAuthService(repo), apiKeySvc)

	user, err := repo.CreateUser(ctx, models.CreateUserParams{
		Username: "lr", Email: "lr@t.com", PasswordHash: "h", DisplayName: "LR",
	})
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	enableAPIKeysPlugin(t, settingsSvc)
	lrKey, _, err := apiKeySvc.GenerateAPIKey(ctx, user.ID, "lr", services.ScopeLightroom, nil)
	if err != nil {
		t.Fatalf("GenerateAPIKey: %v", err)
	}
	genKey, _, err := apiKeySvc.GenerateAPIKey(ctx, user.ID, "gen", services.ScopeGeneral, nil)
	if err != nil {
		t.Fatalf("GenerateAPIKey: %v", err)
	}

	e := echo.New()
	call := func(key, method, path string) int {
		req := httptest.NewRequest(method, path, nil)
		req.Header.Set("Authorization", "Bearer "+key)
		c := e.NewContext(req, httptest.NewRecorder())
		c.SetPath(path)
		err := middleware(func(c echo.Context) error { return c.NoContent(http.StatusOK) })(c)
		var he *echo.HTTPError
		if errors.As(err, &he) {
			return he.Code
		}
		return http.StatusOK
	}

	cases := []struct {
		method, path string
		want         int
	}{
		{http.MethodPost, "/api/posts", http.StatusOK},
		{http.MethodPost, "/api/tags", http.StatusOK},
		{http.MethodPost, "/api/media/upload", http.StatusOK},
		{http.MethodPost, "/api/media/upload/multiple", http.StatusOK},
		{http.MethodGet, "/api/posts", http.StatusForbidden},
		{http.MethodPut, "/api/posts/:id", http.StatusForbidden},
		{http.MethodDelete, "/api/posts/:id", http.StatusForbidden},
		{http.MethodDelete, "/api/tags/:id", http.StatusForbidden},
		{http.MethodPost, "/api/posts/:id/publish", http.StatusForbidden},
		{http.MethodPost, "/api/media/bulk-delete", http.StatusForbidden},
	}
	for _, tc := range cases {
		if got := call(lrKey, tc.method, tc.path); got != tc.want {
			t.Errorf("lightroom %s %s = %d, want %d", tc.method, tc.path, got, tc.want)
		}
		if got := call(genKey, tc.method, tc.path); got != http.StatusOK {
			t.Errorf("general %s %s = %d, want 200", tc.method, tc.path, got)
		}
	}
}
