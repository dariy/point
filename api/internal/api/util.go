package api

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/labstack/echo/v4"
)

// ResolveURL follows redirect(s) for a URL and returns the final destination.
// Only maps.app.goo.gl short links are accepted to prevent SSRF abuse.
//
// GET /api/util/resolve-url?url=<short_url>
// Response: { "url": "<final_url>" }
func ResolveURL(c echo.Context) error {
	raw := c.QueryParam("url")
	if raw == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "url query parameter is required")
	}

	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid url")
	}

	// Restrict to Google Maps short links only (SSRF prevention).
	if parsed.Host != "maps.app.goo.gl" {
		return echo.NewHTTPError(http.StatusBadRequest, "only maps.app.goo.gl short links are supported")
	}

	client := &http.Client{
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return http.ErrUseLastResponse
			}
			return nil
		},
	}

	resp, err := client.Head(raw)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, "failed to resolve url")
	}
	defer resp.Body.Close()

	finalURL := resp.Request.URL.String()
	if i := strings.Index(finalURL, "data=!"); i != -1 {
		finalURL = finalURL[:i]
	}

	return c.JSON(http.StatusOK, map[string]string{
		"url": finalURL,
	})
}
