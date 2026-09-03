package metrics

import (
	"net/http"
	"testing"
)

// TestClassifyRouteTable pins the mapping for one representative of every
// class, plus the boundaries that are easy to get wrong: the public settings
// read that must not be filed as admin, the post reads that must not be filed
// as writes, and the empty template an unmatched request leaves behind.
func TestClassifyRouteTable(t *testing.T) {
	cases := []struct {
		method string
		path   string
		want   RouteClass
	}{
		{http.MethodGet, "/health", ClassHealth},
		{http.MethodGet, "/feed.xml", ClassFeed},
		{http.MethodGet, "/robots.txt", ClassFeed},
		{http.MethodGet, "/sitemap.xml", ClassFeed},
		{http.MethodGet, "/assets/js*", ClassAssets},
		{http.MethodGet, "/assets/css/light.css", ClassAssets},
		{http.MethodGet, "/sw.js", ClassAssets},
		{http.MethodGet, "/manifest.webmanifest", ClassAssets},
		{http.MethodGet, "/:year/:month/:filename", ClassMedia},
		{http.MethodGet, "/*", ClassSPA},
		{http.MethodGet, "/api/pages/home", ClassHome},
		{http.MethodGet, "/api/pages/tags/:slug", ClassTag},
		{http.MethodGet, "/api/pages/graph/tag/:id", ClassTag},
		{http.MethodGet, "/api/pages/map", ClassTag},
		{http.MethodGet, "/api/tags/slug/:slug", ClassTag},
		{http.MethodPost, "/api/tags", ClassTag},
		{http.MethodGet, "/api/posts/:slug/page", ClassPost},
		{http.MethodGet, "/api/posts/slug/:slug", ClassPost},
		{http.MethodGet, "/api/posts/preview/:token", ClassPost},
		{http.MethodGet, "/api/posts/:id/navigation", ClassPost},
		{http.MethodPost, "/api/auth/login", ClassAuth},
		{http.MethodPost, "/api/setup", ClassAuth},
		{http.MethodPost, "/oauth/token", ClassAuth},
		{http.MethodGet, "/.well-known/oauth-protected-resource", ClassAuth},
		{http.MethodPost, "/mcp", ClassMCP},
		{http.MethodGet, "/mcp/*", ClassMCP},
		{http.MethodGet, "/api/system/stats", ClassAdmin},
		{http.MethodPost, "/api/system/backup", ClassAdmin},
		{http.MethodGet, "/api/admin/comments/recent", ClassAdmin},
		{http.MethodGet, "/api/instagram/status", ClassAdmin},
		{http.MethodGet, "/api/timeline", ClassAPIRead},
		{http.MethodGet, "/api/plugins", ClassAPIRead},
		{http.MethodPatch, "/api/plugins/:id", ClassAPIWrite},
		{http.MethodPut, "/api/themes/active", ClassAPIWrite},
		{http.MethodPost, "/api/posts", ClassAPIWrite},
		{http.MethodDelete, "/api/media/:id", ClassAPIWrite},
		{http.MethodOptions, "/api/posts", ClassAPIRead},
		// The public settings read happens on every page load. Filing it under
		// admin would put the busiest public read in the admin class.
		{http.MethodGet, "/api/settings/public", ClassAPIRead},
		{http.MethodPut, "/api/settings", ClassAPIWrite},
		// Nothing matched at all.
		{http.MethodGet, "", ClassOther},
	}
	for _, c := range cases {
		if got := ClassifyRoute(c.method, c.path); got != c.want {
			t.Errorf("ClassifyRoute(%q, %q) = %s, want %s", c.method, c.path, got, c.want)
		}
	}
}

// TestRouteClassSetIsClosed is the cardinality guarantee stated as a test: the
// label can only ever take these values, and every one of them has a name.
func TestRouteClassSetIsClosed(t *testing.T) {
	want := []string{
		"home", "post", "tag", "media", "assets", "spa", "feed",
		"api_read", "api_write", "admin", "mcp", "auth", "health", "other",
	}
	got := RouteClasses()
	if len(got) != len(want) {
		t.Fatalf("route class count = %d, want %d: %v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("route class %d = %q, want %q", i, got[i], want[i])
		}
	}
	// A class with no name would expose an empty label value, which is a
	// different series from the one anyone querying would expect.
	for i, name := range got {
		if name == "" {
			t.Errorf("route class %d has no name", i)
		}
	}
}

// TestClassifyRouteIsTotal checks that no input escapes the enum — including
// the shapes a future route could take.
func TestClassifyRouteIsTotal(t *testing.T) {
	paths := []string{
		"", "/", "/api", "/api/", "/nope", "/API/POSTS", "/apiary/x",
		"/assets", "/mcp", "/mcpx", "/oauth", "/api/postsomething",
		"/api/pages", "/api/pagesx/y", "\x00", "/../../etc/passwd",
	}
	for _, p := range paths {
		for _, m := range []string{http.MethodGet, http.MethodPost, "WEIRD"} {
			c := ClassifyRoute(m, p)
			if c >= numRouteClass {
				t.Fatalf("ClassifyRoute(%q, %q) returned out-of-range class %d", m, p, c)
			}
			if c.String() == "" {
				t.Fatalf("ClassifyRoute(%q, %q) has no name", m, p)
			}
		}
	}
}
