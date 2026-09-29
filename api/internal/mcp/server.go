package mcp

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"point-api/internal/api"
	"point-api/internal/mcp/oauth"
	"point-api/internal/metrics"
	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"golang.org/x/time/rate"
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

	// Repo backs the OAuth provider's durable state (registered clients, issued
	// tokens). Nil keeps that state in memory, so a restart forces every MCP
	// client to re-authorize.
	Repo repository.Repository

	// OwnerUserID is the user OAuth-authenticated callers act as: OAuth tokens
	// carry no point identity, so writes are attributed to the blog owner.
	OwnerUserID int64

	BaseURL    string // public HTTPS base URL for OAuth discovery metadata
	Version    string
	UploadRoot string // sandbox for point_upload_media; empty disables path uploads

	// Metrics counts rejections from the OAuth password throttle below. Nil is
	// valid and counts nothing. Tool calls themselves are NOT counted: they
	// dispatch to handlers through invoker.serve, which builds a synthetic
	// context and never enters the Echo middleware chain, so the request
	// middleware cannot see them. See docs/features/observability.md.
	Metrics *metrics.Registry
}

type principalKey struct{}

// refreshTokenTTL bounds an OAuth refresh token. Each refresh issues a new one
// (rotation), so a client in use stays connected; a stolen token dies within it.
const refreshTokenTTL = 30 * 24 * time.Hour

// Register mounts the OAuth 2.1 discovery/token endpoints and the streamable MCP
// endpoint at /mcp on e, all gated by the "mcp" plugin so the surface 404s when
// disabled. The endpoint accepts point's API-key/session auth or an OAuth bearer.
func Register(e *echo.Echo, d Deps) {
	var store oauth.Store
	if d.Repo != nil {
		store = repoOAuthStore{d.Repo}
	}
	if d.Repo != nil {
		// Refresh tokens issued before refreshTokenTTL existed never expire.
		// Bound them once; later runs match no rows.
		if err := d.Repo.ExpireUnboundedOAuthTokens(context.Background(), time.Now().Add(refreshTokenTTL)); err != nil {
			slog.Error("mcp-oauth: bound legacy refresh tokens", "err", err)
		}
	}
	provider := oauth.New(oauth.Config{
		BaseURL:         d.BaseURL,
		Store:           store,
		RefreshTokenTTL: refreshTokenTTL,
		// OAuth login validates against point's admin password: empty username
		// resolves to the first/owner user, the same identity OAuth tokens act as.
		ValidatePassword: func(ctx context.Context, pw string) bool {
			_, err := d.Auth.AuthenticatePassword(ctx, "", []byte(pw))
			return err == nil
		},
	})
	// A credential change must reach the memory tier too, not only the rows.
	if d.Auth != nil {
		d.Auth.SetOAuthRevoker(provider.RevokeAll)
	}
	oauthMux := http.NewServeMux()
	provider.Register(oauthMux)
	oauthH := echo.WrapHandler(oauthMux)
	gate := api.RequirePlugin(d.SettingsService, "mcp")

	// Throttle the interactive password POST (the brute-force surface), keyed by
	// client IP: ~10 burst, refilling 1 every 6s.
	oauthLoginLimiter := middleware.RateLimiterWithConfig(middleware.RateLimiterConfig{
		Store: middleware.NewRateLimiterMemoryStoreWithConfig(middleware.RateLimiterMemoryStoreConfig{
			Rate:      rate.Every(6 * time.Second),
			Burst:     10,
			ExpiresIn: 10 * time.Minute,
		}),
		DenyHandler: func(c echo.Context, identifier string, err error) error {
			d.Metrics.RateLimited(metrics.LimiterMCPOAuth)
			return &echo.HTTPError{
				Code:     http.StatusTooManyRequests,
				Message:  "rate limit exceeded",
				Internal: err,
			}
		},
	})

	e.GET("/.well-known/oauth-protected-resource", oauthH, gate)
	e.GET("/.well-known/oauth-authorization-server", oauthH, gate)
	e.POST("/oauth/register", oauthH, gate)
	e.GET("/oauth/authorize", oauthH, gate)
	e.POST("/oauth/authorize", oauthH, gate, oauthLoginLimiter)
	e.POST("/oauth/token", oauthH, gate)

	if d.Repo != nil {
		owner := []echo.MiddlewareFunc{api.AuthMiddleware(d.Auth, d.ApiKey), api.SessionOnlyMiddleware, gate}
		e.GET("/api/auth/oauth-clients", d.listOAuthClients, owner...)
		e.DELETE("/api/auth/oauth-clients/:id", revokeOAuthClient(provider), owner...)
	}

	// One server is built per session; strip request-context cancellation (the
	// `initialize` request is done by the time a `tools/call` runs) while keeping
	// the resolved principal.
	streamable := sdk.NewStreamableHTTPHandler(func(r *http.Request) *sdk.Server {
		inv := &invoker{
			ctx:        context.WithoutCancel(r.Context()),
			principal:  r.Context().Value(principalKey{}),
			e:          d.Echo,
			uploadRoot: d.UploadRoot,
			baseURL:    d.BaseURL,
			// Tools whose REST route is plugin-gated re-check the gate here:
			// the dispatch below skips route middleware entirely.
			settingsSvc: d.SettingsService,
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
				} else if provider.ValidateToken(ctx, token) {
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

// oauthClientResponse is one connected app in the API Keys panel. The redirect
// hosts name where the app sends its authorization codes.
type oauthClientResponse struct {
	ClientID      string    `json:"client_id"`
	RedirectHosts []string  `json:"redirect_hosts"`
	RegisteredAt  time.Time `json:"registered_at"`
	LiveTokens    int       `json:"live_tokens"`
}

// listOAuthClients answers GET /api/auth/oauth-clients.
func (d Deps) listOAuthClients(c echo.Context) error {
	clients, err := d.Repo.ListOAuthClients(c.Request().Context(), time.Now())
	if err != nil {
		return err
	}
	out := make([]oauthClientResponse, 0, len(clients))
	for _, cl := range clients {
		hosts := []string{}
		for _, u := range cl.RedirectURIs {
			if h := redirectHost(u); h != "" && !slices.Contains(hosts, h) {
				hosts = append(hosts, h)
			}
		}
		out = append(out, oauthClientResponse{
			ClientID: cl.ClientID, RedirectHosts: hosts,
			RegisteredAt: cl.RegisteredAt, LiveTokens: cl.LiveTokens,
		})
	}
	return c.JSON(http.StatusOK, map[string]any{"clients": out})
}

// revokeOAuthClient answers DELETE /api/auth/oauth-clients/:id. The provider
// clears its memory tier and the Store together, so the revoke is immediate.
func revokeOAuthClient(provider *oauth.Provider) echo.HandlerFunc {
	return func(c echo.Context) error {
		if err := provider.RevokeClient(c.Request().Context(), c.Param("id")); err != nil {
			return err
		}
		return c.NoContent(http.StatusNoContent)
	}
}

// redirectHost returns the host of a redirect URI, or "" when it does not parse.
func redirectHost(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Host
}
