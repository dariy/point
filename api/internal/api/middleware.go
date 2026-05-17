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
