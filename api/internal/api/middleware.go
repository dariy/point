package api

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"point-api/internal/models"
	"point-api/internal/plugins"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

// extractUserID pulls the user ID from the session or API key stored in echo context.
func extractUserID(v interface{}) int64 {
	if v == nil {
		return 0
	}
	if s, ok := v.(models.GetSessionByTokenRow); ok {
		return s.UserID
	}
	if k, ok := v.(models.GetAPIKeyByHashRow); ok {
		return k.UserID
	}
	return 0
}

// extractSessionID pulls the session ID (or API key ID) from the principal stored in echo context.
func extractSessionID(v interface{}) int64 {
	if v == nil {
		return 0
	}
	if s, ok := v.(models.GetSessionByTokenRow); ok {
		return s.ID
	}
	if k, ok := v.(models.GetAPIKeyByHashRow); ok {
		return k.ID
	}
	return 0
}

func AuthMiddleware(authService *services.AuthService, apiKeyService *services.ApiKeyService) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			// 1. Try Bearer token (API Key)
			if h := c.Request().Header.Get("Authorization"); h != "" {
				const prefix = "Bearer "
				if len(h) > len(prefix) && h[:len(prefix)] == prefix {
					key := h[len(prefix):]
					apiKey, err := apiKeyService.ValidateAPIKey(c.Request().Context(), key)
					if err == nil {
						c.Set("user", apiKey)
						return next(c)
					}
					// If Authorization header is present but invalid, reject.
					return echo.NewHTTPError(http.StatusUnauthorized, "invalid or expired API key")
				}
			}

			// 2. Fall back to session cookie
			cookie, err := c.Cookie("session")
			if err != nil {
				return echo.NewHTTPError(http.StatusUnauthorized, "authentication required")
			}

			session, err := authService.ValidateSession(c.Request().Context(), cookie.Value)
			if err != nil {
				return echo.NewHTTPError(http.StatusUnauthorized, "invalid or expired session")
			}

			// Store user in context
			c.Set("user", session)
			return next(c)
		}
	}
}

// RevelioHeader is the request header the public SPA sends to turn the
// admin's "revelio" switch off: `X-Point-Revelio: off` asks every public read
// to answer as if the request were anonymous, so the owner can see the site the
// way a guest sees it. Anything else (absent, "on") leaves the request alone.
const RevelioHeader = "X-Point-Revelio"

// guestViewRequested reports whether the caller asked to be treated as an
// anonymous visitor for this read. It is a *narrowing* of what the principal
// may see and never grants anything, so honouring an unauthenticated client's
// header costs nothing — a guest is already a guest.
func guestViewRequested(c echo.Context) bool {
	return strings.EqualFold(c.Request().Header.Get(RevelioHeader), "off")
}

// IsGuestView reports whether this request is an authenticated principal
// deliberately browsing as a guest (see RevelioHeader). Handlers use it for the
// side effects a real guest would cause but the owner should not — currently
// the post view counter.
func IsGuestView(c echo.Context) bool {
	v, _ := c.Get(guestViewKey).(bool)
	return v
}

// guestViewKey is the echo-context key IsGuestView reads. Set only by
// OptionalAuthMiddleware, and only when a genuine principal was dropped.
const guestViewKey = "guest_view"

func OptionalAuthMiddleware(authService *services.AuthService, apiKeyService *services.ApiKeyService) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			// Revelio off: resolve the principal as usual, then withhold it, so
			// every downstream `c.Get("user") == nil` visibility test takes the
			// public branch. Only the routes behind OptionalAuth are affected —
			// the admin API (AuthMiddleware) keeps working, which is what lets
			// the switch be turned back on.
			guestView := guestViewRequested(c)
			// Records that a real principal was withheld, so handlers can skip
			// the side effects a guest would cause but the owner should not.
			setUser := func(v interface{}) {
				if guestView {
					c.Set(guestViewKey, true)
					return
				}
				c.Set("user", v)
			}

			// 1. Try Bearer token (API Key)
			if h := c.Request().Header.Get("Authorization"); h != "" {
				const prefix = "Bearer "
				if len(h) > len(prefix) && h[:len(prefix)] == prefix {
					key := h[len(prefix):]
					apiKey, err := apiKeyService.ValidateAPIKey(c.Request().Context(), key)
					if err == nil {
						setUser(apiKey)
						return next(c)
					}
				}
			}

			// 2. Fall back to session cookie
			cookie, err := c.Cookie("session")
			if err != nil {
				return next(c)
			}

			session, err := authService.ValidateSession(c.Request().Context(), cookie.Value)
			if err == nil {
				setUser(session)
			}
			return next(c)
		}
	}
}

// SessionOnlyMiddleware rejects requests authenticated via API keys, ensuring
// certain actions (like password changes or key management) are only performed
// via a traditional session cookie.
func SessionOnlyMiddleware(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		user := c.Get("user")
		if _, ok := user.(models.GetSessionByTokenRow); !ok {
			return echo.NewHTTPError(http.StatusForbidden, "this action requires a session cookie (API keys not allowed)")
		}
		return next(c)
	}
}

// RequirePlugin returns middleware that 404s when the named plugin is disabled,
// keeping disabled backend capabilities indistinguishable from non-existent
// routes. It wraps no routes in Phase 1; per-plugin route groups adopt it during
// extraction (Phase 4).
func RequirePlugin(settingsService *services.SettingsService, id string) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			// Snapshot, not GetAllSettings: this runs on every request to a
			// plugin-gated route and only reads.
			all, err := settingsService.Snapshot(c.Request().Context())
			if err != nil {
				return echo.NewHTTPError(http.StatusInternalServerError, "failed to resolve plugin state")
			}
			if !plugins.IsEnabled(id, all) {
				return echo.NewHTTPError(http.StatusNotFound, "not found")
			}
			return next(c)
		}
	}
}

// CustomHTTPErrorHandler handles Echo errors and returns them in a format
// compatible with the frontend (JSON with a "detail" key).
func CustomHTTPErrorHandler(err error, c echo.Context) {
	code := http.StatusInternalServerError
	var detail interface{}
	detail = err.Error()

	var he *echo.HTTPError
	if errors.As(err, &he) {
		code = he.Code
		detail = he.Message
	}

	// For non-JSON requests (like direct browser navigation to a missing page),
	// Echo's default behavior might be preferred, but here we enforce JSON
	// for consistency across the API.
	if !c.Response().Committed {
		if c.Request().Method == http.MethodHead {
			err = c.NoContent(code)
		} else {
			err = c.JSON(code, map[string]interface{}{
				"detail": detail,
			})
		}
		if err != nil {
			slog.Error("error handler failed to send response", "error", err)
		}
	}
}
