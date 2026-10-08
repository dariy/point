package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"point-api/internal/services"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
)

// remarkSiteID must match SITE=remark set by entrypoint.sh for the sidecar.
const remarkSiteID = "remark"

// remarkConfigPath is the engine endpoint (post-rewrite) the widget reads to
// decide, among other things, which login buttons to render.
const remarkConfigPath = "/api/v1/config"

// pointProviderName is the auth provider RemarkSupervisor registers purely so
// go-pkgz/auth accepts Point's bridge tokens — its middleware rejects any token
// whose provider (the prefix in a point_<id> subject) is not registered. The
// provider has no working login flow: its OAuth URLs point back into remark42,
// so its button 404s. Registration is server-side only, so stripping the name
// from the config the widget reads hides the button without touching auth.
const pointProviderName = "point"

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
			// Point's global CSP (frame-ancestors 'none') and X-Frame-Options
			// DENY are pre-set on the response by earlier middleware and would
			// stack with remark42's own CSP — browsers enforce the stricter
			// set, which blocks the widget iframe. Drop those; remark42 sets
			// its own per-path CSP, and Point's remaining headers (nosniff,
			// Referrer-Policy, Permissions-Policy) coexist harmlessly with
			// remark42's equivalents.
			//
			// The Trusted Types policy goes with them. It is a statement about
			// code Point wrote — the widget is a third-party document that
			// happens to be served through this origin, and it sets script.src
			// from a plain string, so leaving the directive on would report a
			// violation for every widget load today and break the widget
			// outright the day the policy is enforced.
			h := c.Response().Header()
			h.Del("Content-Security-Policy")
			h.Del("Content-Security-Policy-Report-Only")
			h.Del("X-Frame-Options")
			// stripPointProvider has to read the config body as JSON; asking the
			// engine not to compress this one small response keeps it from
			// having to gunzip/regzip just to drop a list entry.
			if strings.HasSuffix(c.Request().URL.Path, remarkConfigPath) {
				c.Request().Header.Del("Accept-Encoding")
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
		ModifyResponse: stripPointProvider,
	}))
}

// stripPointProvider removes the internal "point" provider from the engine's
// config response, so the widget never renders a login button for a provider
// that cannot complete a login. The engine still accepts point_<id> tokens —
// that check reads its own registered providers, not this response.
//
// Anything unexpected (non-JSON, compressed, no auth_providers) is passed
// through untouched: hiding a button is never worth breaking the widget.
func stripPointProvider(res *http.Response) error {
	if res.Request == nil || res.Request.URL.Path != remarkConfigPath || res.StatusCode != http.StatusOK {
		return nil
	}

	body, err := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if err != nil {
		return err
	}
	passThrough := func() error {
		res.Body = io.NopCloser(bytes.NewReader(body))
		return nil
	}

	var cfg map[string]any
	if err := json.Unmarshal(body, &cfg); err != nil {
		return passThrough()
	}
	providers, ok := cfg["auth_providers"].([]any)
	if !ok {
		return passThrough()
	}
	kept := make([]any, 0, len(providers))
	for _, p := range providers {
		if name, ok := p.(string); ok && name == pointProviderName {
			continue
		}
		kept = append(kept, p)
	}
	if len(kept) == len(providers) {
		return passThrough()
	}

	cfg["auth_providers"] = kept
	out, err := json.Marshal(cfg)
	if err != nil {
		return passThrough()
	}
	res.Body = io.NopCloser(bytes.NewReader(out))
	res.ContentLength = int64(len(out))
	res.Header.Set("Content-Length", strconv.Itoa(len(out)))
	return nil
}

// CommentsAdminHandler backs the /light/comments moderation page: it translates
// Point-authenticated /api/admin/comments/* calls into remark42 admin API calls
// on the loopback sidecar, authenticated with basic auth admin:ADMIN_PASSWD
// (generated and exported to both processes by entrypoint.sh). remark42's JSON
// responses pass through unchanged.
type CommentsAdminHandler struct {
	base   *url.URL
	passwd string
	client *http.Client
}

func NewCommentsAdminHandler(base *url.URL, passwd string) *CommentsAdminHandler {
	return &CommentsAdminHandler{base: base, passwd: passwd, client: &http.Client{Timeout: 15 * time.Second}}
}

func (h *CommentsAdminHandler) forward(c echo.Context, method, path string, q url.Values) error {
	if h.passwd == "" {
		return echo.NewHTTPError(http.StatusServiceUnavailable, "comments moderation unavailable: ADMIN_PASSWD not set")
	}
	u := *h.base
	u.Path = path
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(c.Request().Context(), method, u.String(), nil)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to build remark42 request")
	}
	req.SetBasicAuth("admin", h.passwd)
	resp, err := h.client.Do(req)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, "remark42 unreachable")
	}
	defer func() { _ = resp.Body.Close() }()
	return c.Stream(resp.StatusCode, resp.Header.Get("Content-Type"), resp.Body)
}

// Recent handles GET /api/admin/comments/recent?limit=N — the newest comments
// across the site (remark42 GET /api/v1/last/{limit}).
func (h *CommentsAdminHandler) Recent(c echo.Context) error {
	limit := c.QueryParam("limit")
	if limit == "" {
		limit = "50"
	}
	if _, err := strconv.Atoi(limit); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "limit must be a number")
	}
	return h.forward(c, http.MethodGet, "/api/v1/last/"+limit, url.Values{"site": {remarkSiteID}})
}

// DeleteComment handles DELETE /api/admin/comments/comment/:id?url=<post-url>.
// remark42 locates a comment by (site, url, id), so url is required.
func (h *CommentsAdminHandler) DeleteComment(c echo.Context) error {
	postURL := c.QueryParam("url")
	if postURL == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "url query param required")
	}
	return h.forward(c, http.MethodDelete, "/api/v1/admin/comment/"+c.Param("id"),
		url.Values{"site": {remarkSiteID}, "url": {postURL}})
}

// SetBlock handles PUT /api/admin/comments/user/:id/block?block=1&ttl=24h.
// block=1 with no ttl blocks permanently (remark42 also soft-deletes the
// user's comments in that case); block=0 unblocks.
func (h *CommentsAdminHandler) SetBlock(c echo.Context) error {
	block := c.QueryParam("block")
	if block != "0" && block != "1" {
		return echo.NewHTTPError(http.StatusBadRequest, "block must be 0 or 1")
	}
	q := url.Values{"site": {remarkSiteID}, "block": {block}}
	if ttl := c.QueryParam("ttl"); ttl != "" {
		if _, err := time.ParseDuration(ttl); err != nil {
			return echo.NewHTTPError(http.StatusBadRequest, "ttl must be a Go duration (e.g. 24h)")
		}
		q.Set("ttl", ttl)
	}
	return h.forward(c, http.MethodPut, "/api/v1/admin/user/"+c.Param("id"), q)
}

// Blocked handles GET /api/admin/comments/blocked — the blocked users list.
func (h *CommentsAdminHandler) Blocked(c echo.Context) error {
	return h.forward(c, http.MethodGet, "/api/v1/admin/blocked", url.Values{"site": {remarkSiteID}})
}
