package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"point-api/internal/models"
	"point-api/internal/plugins"
)

// TestOAuthClientRoutes: the owner lists connected apps and revokes one from
// the API Keys panel; a credential change goes through the provider.
func TestOAuthClientRoutes(t *testing.T) {
	d, repo := newAuthTestDeps(t)
	d.Repo = repo
	ctx := context.Background()
	if err := d.SettingsService.SetSetting(ctx, plugins.EnabledKey("mcp"), "true", "string"); err != nil {
		t.Fatal(err)
	}
	user, err := repo.CreateUser(ctx, models.CreateUserParams{Username: "o", Email: "o@x.test", PasswordHash: "x", DisplayName: "O"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Auth.CreateSession(ctx, user.ID, "127.0.0.1", "test", time.Now().Add(time.Hour), "sess"); err != nil {
		t.Fatal(err)
	}
	Register(d.Echo, d)

	for _, id := range []string{"a", "b"} {
		if err := repo.SaveOAuthClient(ctx, id, []string{"https://" + id + ".test/cb", "https://" + id + ".test/cb2"}, time.Now()); err != nil {
			t.Fatal(err)
		}
		if err := repo.SaveOAuthToken(ctx, "tok-"+id, id, time.Now().Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
	}

	do := func(method, path string, cookie bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, nil)
		if cookie {
			req.AddCookie(&http.Cookie{Name: "session", Value: "sess"})
		}
		rec := httptest.NewRecorder()
		d.Echo.ServeHTTP(rec, req)
		return rec
	}

	if rec := do(http.MethodGet, "/api/auth/oauth-clients", false); rec.Code != http.StatusUnauthorized {
		t.Errorf("list without a session = %d, want 401", rec.Code)
	}

	rec := do(http.MethodGet, "/api/auth/oauth-clients", true)
	if rec.Code != http.StatusOK {
		t.Fatalf("list = %d %s", rec.Code, rec.Body)
	}
	var body struct{ Clients []oauthClientResponse }
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Clients) != 2 {
		t.Fatalf("clients = %+v, want 2", body.Clients)
	}
	for _, c := range body.Clients {
		if len(c.RedirectHosts) != 1 || c.RedirectHosts[0] != c.ClientID+".test" || c.LiveTokens != 1 {
			t.Errorf("client %+v: want one host %s.test and one live token", c, c.ClientID)
		}
	}

	if rec := do(http.MethodDelete, "/api/auth/oauth-clients/a", true); rec.Code != http.StatusNoContent {
		t.Fatalf("revoke = %d %s", rec.Code, rec.Body)
	}
	if _, _, found, _ := repo.GetOAuthClient(ctx, "a"); found {
		t.Error("revoked client still stored")
	}
	if _, _, found, _ := repo.GetOAuthToken(ctx, "tok-b"); !found {
		t.Error("revoke removed another client's token")
	}

	// Register installed the provider as the AuthService revoker.
	if err := d.Auth.TerminateOtherSessions(ctx, user.ID, 0); err != nil {
		t.Fatal(err)
	}
	if _, _, found, _ := repo.GetOAuthToken(ctx, "tok-b"); found {
		t.Error("token survives a sign-out of all other sessions")
	}

	// With the mcp plugin off, the routes do not exist.
	if err := d.SettingsService.SetSetting(ctx, plugins.EnabledKey("mcp"), "false", "string"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Auth.CreateSession(ctx, user.ID, "127.0.0.1", "test", time.Now().Add(time.Hour), "sess"); err != nil {
		t.Fatal(err)
	}
	if rec := do(http.MethodGet, "/api/auth/oauth-clients", true); rec.Code != http.StatusNotFound {
		t.Errorf("list with mcp off = %d, want 404", rec.Code)
	}
}
