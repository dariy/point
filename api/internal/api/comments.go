package api

import (
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
			// set, which blocks the widget iframe. Drop only those two;
			// remark42 sets its own per-path CSP, and Point's remaining
			// headers (nosniff, Referrer-Policy, Permissions-Policy) coexist
			// harmlessly with remark42's equivalents.
			h := c.Response().Header()
			h.Del("Content-Security-Policy")
			h.Del("X-Frame-Options")
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
