package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

const testRemarkSecret = "test-remark-secret-value"

// remarkTestCookie returns the named cookie from a recorded response, or nil.
func remarkTestCookie(rec *httptest.ResponseRecorder, name string) *http.Cookie {
	for _, ck := range rec.Result().Cookies() {
		if ck.Name == name {
			return ck
		}
	}
	return nil
}

func newRemarkTestContext(method string) (echo.Context, *httptest.ResponseRecorder) {
	e := echo.New()
	req := httptest.NewRequest(method, "/", nil)
	rec := httptest.NewRecorder()
	return e.NewContext(req, rec), rec
}

// The bridge is the only way the owner authenticates to remark42, so the token
// has to be one the engine accepts: signed with REMARK_SECRET, audience matching
// SITE, and a point_<id> subject that lines up with ADMIN_SHARED_ID.
func TestIssueRemark42Cookies(t *testing.T) {
	t.Setenv("REMARK_SECRET", testRemarkSecret)

	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	c, rec := newRemarkTestContext(http.MethodPost)
	expiresAt := time.Now().Add(24 * time.Hour).UTC().Round(time.Second)
	IssueRemark42Cookies(c, repo, 7, "Display Name", "username", expiresAt, true)

	jwtCookie := remarkTestCookie(rec, "JWT")
	if jwtCookie == nil {
		t.Fatal("JWT cookie not set")
	}
	if !jwtCookie.HttpOnly || !jwtCookie.Secure {
		t.Errorf("JWT cookie should be HttpOnly and Secure, got HttpOnly=%v Secure=%v", jwtCookie.HttpOnly, jwtCookie.Secure)
	}

	xsrfCookie := remarkTestCookie(rec, "XSRF-TOKEN")
	if xsrfCookie == nil {
		t.Fatal("XSRF-TOKEN cookie not set")
	}
	if xsrfCookie.HttpOnly {
		t.Error("XSRF-TOKEN must stay readable by the widget (not HttpOnly)")
	}

	claims, err := remark42TokenService(testRemarkSecret, time.Hour).Parse(jwtCookie.Value)
	if err != nil {
		t.Fatalf("token does not verify under REMARK_SECRET: %v", err)
	}
	if claims.User == nil {
		t.Fatal("token carries no user")
	}
	if claims.User.ID != "point_7" {
		t.Errorf("subject: want point_7, got %q", claims.User.ID)
	}
	if claims.User.Name != "Display Name" {
		t.Errorf("name: want %q, got %q", "Display Name", claims.User.Name)
	}
	if !claims.User.IsAdmin() {
		t.Error("owner must be admin in the widget")
	}
	if len(claims.Audience) != 1 || claims.Audience[0] != remarkSiteID {
		t.Errorf("audience: want [%s], got %v", remarkSiteID, claims.Audience)
	}
	// Double-submit CSRF: the readable cookie must match the token's jti, or
	// remark42 rejects every write the widget makes.
	if claims.ID != xsrfCookie.Value {
		t.Errorf("XSRF cookie %q does not match token jti %q", xsrfCookie.Value, claims.ID)
	}
}

func TestIssueRemark42Cookies_FallsBackToUsername(t *testing.T) {
	t.Setenv("REMARK_SECRET", testRemarkSecret)

	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	c, rec := newRemarkTestContext(http.MethodPost)
	IssueRemark42Cookies(c, repo, 1, "", "username", time.Now().Add(time.Hour), false)

	claims, err := remark42TokenService(testRemarkSecret, time.Hour).Parse(remarkTestCookie(rec, "JWT").Value)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if claims.User.Name != "username" {
		t.Errorf("empty display name should fall back to username, got %q", claims.User.Name)
	}
}

// Comments unconfigured: no secret to sign with, so nothing should be set.
func TestIssueRemark42Cookies_NoSecret(t *testing.T) {
	t.Setenv("REMARK_SECRET", "")

	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	c, rec := newRemarkTestContext(http.MethodPost)
	IssueRemark42Cookies(c, repo, 1, "Name", "username", time.Now().Add(time.Hour), false)

	if len(rec.Result().Cookies()) != 0 {
		t.Errorf("expected no cookies when REMARK_SECRET is unset, got %v", rec.Result().Cookies())
	}
}

func TestClearRemark42Cookies(t *testing.T) {
	c, rec := newRemarkTestContext(http.MethodPost)
	ClearRemark42Cookies(c, true)

	for _, name := range []string{"JWT", "XSRF-TOKEN"} {
		ck := remarkTestCookie(rec, name)
		if ck == nil {
			t.Fatalf("%s cookie not cleared", name)
		}
		if ck.Value != "" || !ck.Expires.Before(time.Now()) {
			t.Errorf("%s should be emptied and expired, got value=%q expires=%v", name, ck.Value, ck.Expires)
		}
	}
}

func TestRemark42CookieStale(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	// issue mints a bridge cookie with the given secret and lifetime.
	issue := func(t *testing.T, secret string, ttl time.Duration) *http.Cookie {
		t.Helper()
		t.Setenv("REMARK_SECRET", secret)
		c, rec := newRemarkTestContext(http.MethodPost)
		IssueRemark42Cookies(c, repo, 1, "Name", "username", time.Now().Add(ttl), false)
		return remarkTestCookie(rec, "JWT")
	}

	staleWith := func(t *testing.T, secret string, ck *http.Cookie) bool {
		t.Helper()
		t.Setenv("REMARK_SECRET", secret)
		c, _ := newRemarkTestContext(http.MethodGet)
		if ck != nil {
			c.Request().AddCookie(ck)
		}
		return remark42CookieStale(c)
	}

	t.Run("comments unconfigured", func(t *testing.T) {
		if staleWith(t, "", nil) {
			t.Error("without REMARK_SECRET there is nothing to reissue")
		}
	})

	t.Run("cookie missing", func(t *testing.T) {
		if !staleWith(t, testRemarkSecret, nil) {
			t.Error("missing cookie must be reissued")
		}
	})

	t.Run("fresh cookie", func(t *testing.T) {
		ck := issue(t, testRemarkSecret, 24*time.Hour)
		if staleWith(t, testRemarkSecret, ck) {
			t.Error("a cookie well short of expiry should be left alone")
		}
	})

	t.Run("near expiry", func(t *testing.T) {
		ck := issue(t, testRemarkSecret, remark42RefreshWindow/2)
		if !staleWith(t, testRemarkSecret, ck) {
			t.Error("a cookie inside the refresh window must be reissued")
		}
	})

	t.Run("signed with a rotated-away secret", func(t *testing.T) {
		ck := issue(t, "old-secret", 24*time.Hour)
		if !staleWith(t, testRemarkSecret, ck) {
			t.Error("a cookie remark42 would reject must be reissued")
		}
	})
}

// Sessions predating the bridge — and passkey logins from before they issued it —
// leave the owner anonymous in the widget with no login button to recover with.
// /api/auth/me is the admin SPA's every-load call, so it heals them.
func TestMe_ReissuesStaleRemark42Cookie(t *testing.T) {
	t.Setenv("REMARK_SECRET", testRemarkSecret)

	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	handler := NewAuthHandler(services.NewAuthService(repo), &config.Config{}, repo)
	session := models.GetSessionByTokenRow{
		ID:          1,
		UserID:      42,
		Username:    "owner",
		DisplayName: "Owner",
		Email:       "owner@example.com",
		ExpiresAt:   time.Now().Add(24 * time.Hour),
	}

	t.Run("missing cookie is reissued", func(t *testing.T) {
		c, rec := newRemarkTestContext(http.MethodGet)
		c.Set("user", session)
		if err := handler.Me(c); err != nil {
			t.Fatalf("Me: %v", err)
		}
		ck := remarkTestCookie(rec, "JWT")
		if ck == nil {
			t.Fatal("JWT cookie not reissued")
		}
		claims, err := remark42TokenService(testRemarkSecret, time.Hour).Parse(ck.Value)
		if err != nil {
			t.Fatalf("reissued token does not verify: %v", err)
		}
		if claims.User.ID != "point_42" {
			t.Errorf("subject: want point_42, got %q", claims.User.ID)
		}
	})

	t.Run("fresh cookie is left alone", func(t *testing.T) {
		mint, mintRec := newRemarkTestContext(http.MethodPost)
		IssueRemark42Cookies(mint, repo, 42, "Owner", "owner", time.Now().Add(24*time.Hour), false)
		fresh := remarkTestCookie(mintRec, "JWT")

		c, rec := newRemarkTestContext(http.MethodGet)
		c.Request().AddCookie(fresh)
		c.Set("user", session)
		if err := handler.Me(c); err != nil {
			t.Fatalf("Me: %v", err)
		}
		if ck := remarkTestCookie(rec, "JWT"); ck != nil {
			t.Error("a fresh cookie should not be rewritten on every /me call")
		}
	})

	t.Run("api key principals are skipped", func(t *testing.T) {
		c, rec := newRemarkTestContext(http.MethodGet)
		c.Set("user", models.GetAPIKeyByHashRow{ID: 1, UserID: 42, Username: "owner", DisplayName: "Owner"})
		if err := handler.Me(c); err != nil {
			t.Fatalf("Me: %v", err)
		}
		if ck := remarkTestCookie(rec, "JWT"); ck != nil {
			t.Error("API-key auth has no browser session to bridge")
		}
	})
}
