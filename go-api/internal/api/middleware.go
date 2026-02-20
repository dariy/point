package api

import (
	"net/http"

	"github.com/labstack/echo/v4"
	"point-api/internal/services"
)

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
