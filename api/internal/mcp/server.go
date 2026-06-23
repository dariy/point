package mcp

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"point-api/internal/api"
	"point-api/internal/mcp/oauth"
	"point-api/internal/models"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// Deps is everything Register needs to mount the MCP server. The REST handlers
// double as the data layer (tools dispatch to them in-process).
type Deps struct {
	Echo *echo.Echo // used to build synthetic contexts for handler dispatch

	Post     *api.PostHandler
	Tag      *api.TagHandler
	Media    *api.MediaHandler
	Theme    *api.ThemeHandler
	Settings *api.SettingsHandler
	System   *api.SystemHandler

	Auth            *services.AuthService
	ApiKey          *services.ApiKeyService
	SettingsService *services.SettingsService

	// OwnerUserID is the user OAuth-authenticated callers act as: OAuth tokens
	// carry no point identity, so writes are attributed to the blog owner.
	OwnerUserID int64

	BaseURL       string   // public HTTPS base URL for OAuth discovery metadata
	OAuthPassword string   // password for the OAuth login page
	StaticTokens  []string // optional static bearer tokens for programmatic clients
	Version       string
	UploadRoot    string // sandbox for point_upload_media; empty disables path uploads
}

type principalKey struct{}

// Register mounts the OAuth 2.1 discovery/token endpoints and the streamable MCP
// endpoint at /mcp on e, all gated by the "mcp" plugin so the surface 404s when
// disabled. The endpoint accepts point's API-key/session auth or an OAuth bearer.
func Register(e *echo.Echo, d Deps) {
	provider := oauth.New(oauth.Config{
		BaseURL:      d.BaseURL,
		Password:     d.OAuthPassword,
		StaticTokens: d.StaticTokens,
	})
	oauthMux := http.NewServeMux()
	provider.Register(oauthMux)
	oauthH := echo.WrapHandler(oauthMux)
	gate := api.RequirePlugin(d.SettingsService, "mcp")

	e.GET("/.well-known/oauth-protected-resource", oauthH, gate)
	e.GET("/.well-known/oauth-authorization-server", oauthH, gate)
	e.POST("/oauth/register", oauthH, gate)
	e.GET("/oauth/authorize", oauthH, gate)
	e.POST("/oauth/authorize", oauthH, gate)
	e.POST("/oauth/token", oauthH, gate)

	// One server is built per session; strip request-context cancellation (the
	// `initialize` request is done by the time a `tools/call` runs) while keeping
	// the resolved principal.
	streamable := sdk.NewStreamableHTTPHandler(func(r *http.Request) *sdk.Server {
		inv := &invoker{
			ctx:        context.WithoutCancel(r.Context()),
			principal:  r.Context().Value(principalKey{}),
			e:          d.Echo,
			uploadRoot: d.UploadRoot,
			h: handlers{
				post: d.Post, tag: d.Tag, media: d.Media,
				theme: d.Theme, settings: d.Settings, system: d.System,
			},
		}
		srv := sdk.NewServer(&sdk.Implementation{Name: "point-mcp", Version: d.Version}, nil)
		registerTools(srv, inv)
		registerResources(srv, inv)
		registerPrompts(srv)
		return srv
	}, nil)

	mcpH := echo.WrapHandler(streamable)
	auth := d.authMiddleware(provider)
	e.Any("/mcp", mcpH, gate, auth)
	e.Any("/mcp/", mcpH, gate, auth)
	e.Any("/mcp/*", mcpH, gate, auth)
}

// authMiddleware resolves the caller from a point API key, an OAuth bearer, or a
// session cookie, stashing the principal in the request context. A failed lookup
// returns 401 with a WWW-Authenticate pointing at OAuth discovery.
func (d Deps) authMiddleware(provider *oauth.Provider) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			ctx := c.Request().Context()
			var principal interface{}

			if h := c.Request().Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
				token := strings.TrimPrefix(h, "Bearer ")
				if key, err := d.ApiKey.ValidateAPIKey(ctx, token); err == nil {
					principal = key
				} else if provider.ValidateToken(token) {
					principal = models.GetAPIKeyByHashRow{UserID: d.OwnerUserID}
				}
			}
			if principal == nil {
				if cookie, err := c.Cookie("session"); err == nil {
					if sess, err := d.Auth.ValidateSession(ctx, cookie.Value); err == nil {
						principal = sess
					}
				}
			}
			if principal == nil {
				c.Response().Header().Set(echo.HeaderWWWAuthenticate,
					fmt.Sprintf(`Bearer resource_metadata="%s/.well-known/oauth-protected-resource"`, d.BaseURL))
				return echo.NewHTTPError(http.StatusUnauthorized, "authentication required")
			}
			c.SetRequest(c.Request().WithContext(context.WithValue(ctx, principalKey{}, principal)))
			return next(c)
		}
	}
}
