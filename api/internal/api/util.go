package api

import (
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/labstack/echo/v4"
)

// URL coordinate extraction patterns, applied in priority order.
// @lat,lng    — Google Maps path format (/@48.8566,2.3522,15z)
// ll=lat,lng  — Google & Apple Maps pin location
// q=lat,lng   — Google Maps query / Apple Maps pin when q is raw coords
// sll=lat,lng — Apple Maps screen/viewport centre (fallback)
var urlCoordPatterns = []*regexp.Regexp{
	regexp.MustCompile(`/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)`),
	regexp.MustCompile(`[?&]ll=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)`),
	regexp.MustCompile(`[?&]q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)`),
	regexp.MustCompile(`[?&]sll=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)`),
}

// Page body patterns for Apple Maps place pages (maps.apple.com/place?auid=...).
// Coordinates are embedded in the page JSON as "lat":45.5077734,"lng":-73.5544607.
var rePageLat = regexp.MustCompile(`"lat":(-?\d+(?:\.\d+)?)`)
var rePageLng = regexp.MustCompile(`"lng":(-?\d+(?:\.\d+)?)`)

// Degree notation: "45.50777° N, 73.55446° W" (copied from maps.apple.com).
// Accepts optional degree symbol and any separator between the two parts.
var reDegree = regexp.MustCompile(
	`(\d+(?:\.\d+)?)°?\s*([NSns])[,\s]+(\d+(?:\.\d+)?)°?\s*([EWew])`,
)

// shortLinkHosts must be resolved via HTTP before coordinate extraction.
var shortLinkHosts = map[string]bool{
	"maps.app.goo.gl": true,
	"maps.apple":      true, // iOS 17+ short links: https://maps.apple/p/...
}

// allowedHosts restricts URL input to known map services (SSRF prevention).
var allowedHosts = map[string]bool{
	"maps.app.goo.gl": true,
	"maps.google.com": true,
	"www.google.com":  true,
	"google.com":      true,
	"maps.apple.com":  true,
	"maps.apple":      true,
}

var httpClient = &http.Client{
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return http.ErrUseLastResponse
		}
		return nil
	},
}

func parseCoordsFromURL(u string) (lat, lng float64, ok bool) {
	for _, re := range urlCoordPatterns {
		m := re.FindStringSubmatch(u)
		if m == nil {
			continue
		}
		la, err1 := strconv.ParseFloat(m[1], 64)
		lo, err2 := strconv.ParseFloat(m[2], 64)
		if err1 == nil && err2 == nil {
			return la, lo, true
		}
	}
	return 0, 0, false
}

// parseCoordsFromPageBody fetches the URL and extracts coordinates from the
// embedded JSON. Used for Apple Maps place pages (maps.apple.com/place?auid=...)
// where coordinates are not present in the URL itself.
func parseCoordsFromPageBody(pageURL string) (lat, lng float64, ok bool) {
	resp, err := httpClient.Get(pageURL)
	if err != nil {
		return 0, 0, false
	}
	defer func() {
		_ = resp.Body.Close()
	}()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 512*1024))
	if err != nil {
		return 0, 0, false
	}

	mLat := rePageLat.FindSubmatch(body)
	mLng := rePageLng.FindSubmatch(body)
	if mLat == nil || mLng == nil {
		return 0, 0, false
	}

	la, err1 := strconv.ParseFloat(string(mLat[1]), 64)
	lo, err2 := strconv.ParseFloat(string(mLng[1]), 64)
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return la, lo, true
}

// parseCoordsFromDegreeString parses notations like "45.50777° N, 73.55446° W".
func parseCoordsFromDegreeString(s string) (lat, lng float64, ok bool) {
	m := reDegree.FindStringSubmatch(s)
	if m == nil {
		return 0, 0, false
	}
	la, err1 := strconv.ParseFloat(m[1], 64)
	lo, err2 := strconv.ParseFloat(m[3], 64)
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	if strings.ToUpper(m[2]) == "S" {
		la = -la
	}
	if strings.ToUpper(m[4]) == "W" {
		lo = -lo
	}
	return la, lo, true
}

// ParseMapsCoords extracts coordinates from a Google/Apple Maps URL, short
// link, or a degree-notation string (e.g. "45.50777° N, 73.55446° W").
// Short links are resolved via HTTP before coordinate extraction.
// Apple Maps place pages (auid-based) are fetched to extract embedded JSON coords.
//
// GET /api/util/parse-maps-coords?q=<input>
// Response: { "lat": float64, "lng": float64 }
func ParseMapsCoords(c echo.Context) error {
	q := strings.TrimSpace(c.QueryParam("q"))
	if q == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "q query parameter is required")
	}

	// If the input looks like a URL, treat it as a maps URL.
	if strings.HasPrefix(q, "http://") || strings.HasPrefix(q, "https://") {
		parsed, err := url.Parse(q)
		if err != nil || parsed.Host == "" {
			return echo.NewHTTPError(http.StatusBadRequest, "invalid url")
		}

		if !allowedHosts[parsed.Host] {
			return echo.NewHTTPError(http.StatusBadRequest, "only Google Maps and Apple Maps URLs are supported")
		}

		urlToParse := q

		// Resolve short links before parsing.
		if shortLinkHosts[parsed.Host] {
			resp, err := httpClient.Head(q)
			if err != nil {
				return echo.NewHTTPError(http.StatusBadGateway, "failed to resolve url")
			}
			_ = resp.Body.Close()

			urlToParse = resp.Request.URL.String()
			if i := strings.Index(urlToParse, "data=!"); i != -1 {
				urlToParse = urlToParse[:i]
			}
		}

		// Try extracting coordinates from the URL string first.
		if lat, lng, ok := parseCoordsFromURL(urlToParse); ok {
			return c.JSON(http.StatusOK, map[string]float64{"lat": lat, "lng": lng})
		}

		// Fallback: fetch page body (Apple Maps place pages embed coords in JSON).
		if lat, lng, ok := parseCoordsFromPageBody(urlToParse); ok {
			return c.JSON(http.StatusOK, map[string]float64{"lat": lat, "lng": lng})
		}

		return echo.NewHTTPError(http.StatusUnprocessableEntity, "no coordinates found in url")
	}

	// Otherwise try degree notation: "45.50777° N, 73.55446° W".
	lat, lng, ok := parseCoordsFromDegreeString(q)
	if !ok {
		return echo.NewHTTPError(http.StatusUnprocessableEntity, "unrecognised input: provide a Google/Apple Maps URL or a coordinate string")
	}
	return c.JSON(http.StatusOK, map[string]float64{"lat": lat, "lng": lng})
}
