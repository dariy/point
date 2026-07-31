package api

import (
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"point-api/internal/repository"

	"github.com/go-pkgz/auth/v2/token"
	"github.com/golang-jwt/jwt/v5"
	"github.com/labstack/echo/v4"
)

// remark42Issuer is the iss claim go-pkgz/auth stamps on remark42's own tokens;
// ours have to look the same to the engine.
const remark42Issuer = "remark42"

// remark42RefreshWindow is how close to expiry the bridge token may drift before
// Me reissues it, so a long-lived admin session never silently loses comment
// auth partway through.
const remark42RefreshWindow = time.Hour

// IssueRemark42Cookies signs a go-pkgz/auth token with REMARK_SECRET and sets the
// JWT + XSRF-TOKEN cookie pair the embedded remark42 engine reads.
//
// This shared-secret bridge is the *only* way the site owner authenticates to
// comments: remark42 offers Point no login provider (the engine's providers are
// anonymous/GitHub/Google/email, all for visitors), so any path that establishes
// a Point session must call this or the owner ends up logged into Point and
// anonymous in the widget. The subject, point_<id>, is what RemarkSupervisor
// lists in ADMIN_SHARED_ID, which is what grants moderation rights in the widget.
//
// No-op when REMARK_SECRET is unset, i.e. comments are not configured.
func IssueRemark42Cookies(c echo.Context, repo repository.Repository, userID int64, displayName, username string, expiresAt time.Time, secure bool) {
	secret := os.Getenv("REMARK_SECRET")
	if secret == "" {
		return
	}
	svc := remark42TokenService(secret, time.Until(expiresAt))

	name := displayName
	if name == "" {
		name = username
	}

	var authorName string
	err := repo.DB().QueryRowContext(c.Request().Context(), "SELECT value FROM blog_settings WHERE key = 'author_name'").Scan(&authorName)
	if err == nil && authorName != "" {
		name = authorName
	}

	var logoURL string
	_ = repo.DB().QueryRowContext(c.Request().Context(), "SELECT value FROM blog_settings WHERE key = 'logo_url'").Scan(&logoURL)

	u := &token.User{
		ID:      fmt.Sprintf("point_%d", userID),
		Name:    name,
		Picture: logoURL,
	}
	u.SetAdmin(true)

	xsrf := GenerateToken()[:20]

	claims := token.Claims{
		User: u,
	}
	claims.Audience = jwt.ClaimStrings{remarkSiteID}
	claims.Issuer = remark42Issuer
	claims.ExpiresAt = jwt.NewNumericDate(expiresAt)
	claims.ID = xsrf

	tokenStr, err := svc.Token(claims)
	if err != nil {
		slog.Error("Failed to generate remark42 token", "err", err)
		return
	}

	c.SetCookie(&http.Cookie{
		Name:     "JWT",
		Value:    tokenStr,
		Expires:  expiresAt,
		HttpOnly: true,
		Path:     "/",
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
	})
	// Deliberately not HttpOnly: this is the readable half of the double-submit
	// CSRF pattern — the SPA has to read it to echo the value back in a header.
	// Its secrecy is not what protects anything; matching it is.
	//nolint:gosec // G124: HttpOnly is intentionally off, see above
	c.SetCookie(&http.Cookie{
		Name:     "XSRF-TOKEN",
		Value:    xsrf,
		Expires:  expiresAt,
		Path:     "/",
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
	})
}

// ClearRemark42Cookies expires the bridge cookie pair, so logging out of Point
// also logs the owner out of comments.
func ClearRemark42Cookies(c echo.Context, secure bool) {
	past := time.Now().Add(-1 * time.Hour).UTC().Round(0)
	c.SetCookie(&http.Cookie{
		Name:     "JWT",
		Value:    "",
		Expires:  past,
		HttpOnly: true,
		Path:     "/",
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
	})
	// Cleared counterpart of the readable double-submit cookie set above; it
	// carries no value and is likewise not HttpOnly.
	//nolint:gosec // G124: HttpOnly intentionally off, see IssueRemark42Cookies
	c.SetCookie(&http.Cookie{
		Name:     "XSRF-TOKEN",
		Value:    "",
		Expires:  past,
		Path:     "/",
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
	})
}

// remark42CookieStale reports whether the request's bridge cookie needs
// reissuing: absent, unreadable under the current REMARK_SECRET (so the engine
// would reject it too — e.g. after a secret rotation), or about to expire.
// Returns false when comments are not configured, so callers do no work.
func remark42CookieStale(c echo.Context) bool {
	secret := os.Getenv("REMARK_SECRET")
	if secret == "" {
		return false
	}
	ck, err := c.Cookie("JWT")
	if err != nil || ck.Value == "" {
		return true
	}
	// Parse verifies the signature but tolerates expiry, which is what we want:
	// an expired-but-valid token is exactly the case worth refreshing.
	claims, err := remark42TokenService(secret, remark42RefreshWindow).Parse(ck.Value)
	if err != nil || claims.ExpiresAt == nil {
		return true
	}
	return time.Until(claims.ExpiresAt.Time) < remark42RefreshWindow
}

func remark42TokenService(secret string, cookieDuration time.Duration) *token.Service {
	return token.NewService(token.Opts{
		SecretReader: token.SecretFunc(func(string) (string, error) {
			return secret, nil
		}),
		CookieDuration: cookieDuration,
		Issuer:         remark42Issuer,
	})
}
