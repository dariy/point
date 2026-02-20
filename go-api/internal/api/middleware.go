package api

import (
	"net/http"

	"github.com/labstack/echo/v4"
	"point-api/internal/models"
	"point-api/internal/services"
)

// extractUserID pulls the user ID from the session stored in echo context.
func extractUserID(v interface{}) int64 {
	if v == nil {
		return 0
	}
	if s, ok := v.(models.GetSessionByTokenRow); ok {
		return s.UserID
	}
	return 0
}

// extractSessionID pulls the session ID from the session stored in echo context.
func extractSessionID(v interface{}) int64 {
	if v == nil {
		return 0
	}
	if s, ok := v.(models.GetSessionByTokenRow); ok {
		return s.ID
	}
	return 0
}

func AuthMiddleware(authService *services.AuthService) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			cookie, err := c.Cookie("session")
			if err != nil {
				return echo.NewHTTPError(http.StatusUnauthorized, "session cookie missing")
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

func OptionalAuthMiddleware(authService *services.AuthService) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
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
