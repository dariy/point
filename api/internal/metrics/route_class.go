package metrics

import (
	"net/http"
	"strings"
)

// ClassifyRoute maps a matched route *template* — Echo's c.Path(), e.g.
// "/api/tags/slug/:slug", never the concrete URL — onto one of the fourteen
// route classes.
//
// It is total and it is closed: every string maps to a class, and the set of
// classes cannot grow without editing the enum. That is the whole point. The
// alternative, a `path` label, would turn ~190 registered method+path pairs
// into thousands of series per instance; here the engine can grow routes
// indefinitely and the exposition does not move.
//
// The rules are ordered and first-match-wins, so the more specific prefix has
// to come first. Reading them top to bottom is the definition of each class:
//
//	health     the liveness probe, which uptime monitors hit on a timer and
//	           which would otherwise dominate whatever class it landed in
//	feed       RSS, sitemap, robots — the crawler surface
//	assets     built CSS/JS/images and the PWA files
//	media      the stored image and video bytes
//	auth       every credential endpoint, including OAuth's, so the class is
//	           the thing you alert on when 4xx rises
//	mcp        the MCP transport (see the middleware note about tool calls)
//	admin      surfaces only an authenticated owner reaches
//	home/post/tag  the public read path, split because these are the three
//	           page aggregates the on-disk cache serves and the ones whose
//	           latency a visitor feels
//	api_read / api_write  everything else under /api (and the /comments proxy),
//	           split by method
//	spa        the HTML shell the fallback route serves for every public URL
//	other      unmatched requests. A registered route reaching this is a bug,
//	           and route_class_test.go fails on one.
func ClassifyRoute(method, routePath string) RouteClass {
	switch routePath {
	case "":
		// Echo leaves the template empty when nothing matched at all.
		return ClassOther
	case "/health":
		return ClassHealth
	case "/feed", "/feed.xml", "/sitemap.xml", "/robots.txt":
		return ClassFeed
	case "/sw.js", "/manifest.webmanifest":
		return ClassAssets
	case "/:year/:month/:filename":
		return ClassMedia
	case "/*":
		return ClassSPA
	case "/api/pages/home":
		return ClassHome
	// Public settings is read on every page load; grouping it with the rest of
	// /api/settings would put the busiest public read inside the admin class.
	case "/api/settings/public":
		return ClassAPIRead
	}

	switch {
	case strings.HasPrefix(routePath, "/assets/"):
		return ClassAssets
	case strings.HasPrefix(routePath, "/api/auth"),
		strings.HasPrefix(routePath, "/api/setup"),
		strings.HasPrefix(routePath, "/oauth/"),
		strings.HasPrefix(routePath, "/.well-known/oauth"):
		return ClassAuth
	case strings.HasPrefix(routePath, "/mcp"):
		return ClassMCP
	// Deliberately short: only the surfaces that are admin-only end to end.
	// /api/settings, /api/themes and /api/plugins are read by every visitor and
	// written by the owner, and the method split already says which happened.
	case strings.HasPrefix(routePath, "/api/system"),
		strings.HasPrefix(routePath, "/api/admin"),
		strings.HasPrefix(routePath, "/api/instagram"):
		return ClassAdmin
	case strings.HasPrefix(routePath, "/api/pages/tags"),
		strings.HasPrefix(routePath, "/api/pages/graph"),
		strings.HasPrefix(routePath, "/api/pages/map"),
		strings.HasPrefix(routePath, "/api/tags"):
		return ClassTag
	case strings.HasPrefix(routePath, "/api/posts"):
		// The three read-a-post routes are the visitor-facing ones; everything
		// else under /api/posts is the editor writing.
		switch routePath {
		case "/api/posts/:slug/page", "/api/posts/slug/:slug",
			"/api/posts/preview/:token", "/api/posts/:id/navigation":
			return ClassPost
		}
	}

	// The remark42 proxy is not under /api, but it is the same kind of surface —
	// JSON in, JSON out, driven by the public comment widget — so it splits by
	// method with the rest of the API rather than earning a class of its own.
	if strings.HasPrefix(routePath, "/api/") || routePath == "/api" ||
		strings.HasPrefix(routePath, "/comments") {
		if isReadMethod(method) {
			return ClassAPIRead
		}
		return ClassAPIWrite
	}
	// A group's own 404 route ("/api/pages/*") is caught above; anything left is
	// a path nothing registered.
	return ClassOther
}

// isReadMethod reports whether the method is one that only reads. OPTIONS
// counts: a CORS preflight is not a write, and putting it in api_write would
// make every browser write look like two.
func isReadMethod(method string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	}
	return false
}
