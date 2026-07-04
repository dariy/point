package api

import (
	"net/url"
	"strings"

	"point-api/internal/services"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
)

// RegisterCommentsProxy mounts the reverse proxy to the remark42 sidecar at
// /comments, gated by the "comments" plugin (disabled ⇒ 404, indistinguishable
// from a non-existent route). remark42 binds loopback-only inside the
// container, so this proxy is its sole external access path.
//
// The /comments prefix is stripped: remark42 serves its routes at root and
// uses the subpath in REMARK_URL only to build absolute links (same contract
// as upstream's documented subfolder nginx setup).
func RegisterCommentsProxy(e *echo.Echo, settingsService *services.SettingsService, target *url.URL) {
	g := e.Group("/comments")
	g.Use(RequirePlugin(settingsService, "comments"))
	// Strip basic-auth credentials: remark42's /api/v1/admin/* accepts
	// admin:ADMIN_PASSWD basic auth intended for server-to-server calls on
	// loopback, which must not be brute-forceable from the public internet.
	// Widget auth (JWT cookie / X-JWT header) passes through untouched.
	g.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			if auth := c.Request().Header.Get("Authorization"); len(auth) >= 5 && strings.EqualFold(auth[:5], "Basic") {
				c.Request().Header.Del("Authorization")
			}
			return next(c)
		}
	})
	g.Use(middleware.ProxyWithConfig(middleware.ProxyConfig{
		Balancer: middleware.NewRoundRobinBalancer([]*middleware.ProxyTarget{{URL: target}}),
		Rewrite: map[string]string{
			"/comments":   "/",
			"/comments/*": "/$1",
		},
	}))
}
