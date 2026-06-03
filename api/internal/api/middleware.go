package api

import (
	"net/http"

	"point-api/internal/models"
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

func OptionalAuthMiddleware(authService *services.AuthService, apiKeyService *services.ApiKeyService) echo.MiddlewareFunc {
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
				}
			}

			// 2. Fall back to session cookie
			cookie, err := c.Cookie("session")
			if err != nil {
				return next(c)
			}

			session, err := authService.ValidateSession(c.Request().Context(), cookie.Value)
			if err == nil {
				c.Set("user", session)
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

// CustomHTTPErrorHandler handles Echo errors and returns them in a format
// compatible with the frontend (JSON with a "detail" key).
func CustomHTTPErrorHandler(err error, c echo.Context) {
	code := http.StatusInternalServerError
	var detail interface{}
	detail = err.Error()

	if he, ok := err.(*echo.HTTPError); ok {
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
			c.Logger().Error(err)
		}
	}
}
