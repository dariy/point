package mcp

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// The three resources answer the same questions as their sibling tools, but a
// client reads them by URI and gets one content block back. These tests pin
// that shape — URI echoed, JSON MIME type, decodable body — as well as the
// content, because the resource handlers are a second implementation rather
// than a call into the tools.

// read fetches a resource and returns its single content block.
func (env *toolEnv) read(uri string) *sdk.ResourceContents {
	env.t.Helper()
	res, err := env.cs.ReadResource(context.Background(), &sdk.ReadResourceParams{URI: uri})
	if err != nil {
		env.t.Fatalf("read %s: %v", uri, err)
	}
	if len(res.Contents) != 1 {
		env.t.Fatalf("read %s: got %d content blocks, want 1", uri, len(res.Contents))
	}
	c := res.Contents[0]
	if c.URI != uri {
		env.t.Errorf("read %s: content URI = %q", uri, c.URI)
	}
	if c.MIMEType != "application/json" {
		env.t.Errorf("read %s: MIME type = %q, want application/json", uri, c.MIMEType)
	}
	return c
}

// readObject fetches a resource and decodes its body as a JSON object.
func (env *toolEnv) readObject(uri string) map[string]any {
	env.t.Helper()
	var out map[string]any
	if err := json.Unmarshal([]byte(env.read(uri).Text), &out); err != nil {
		env.t.Fatalf("read %s: body is not a JSON object (%v)", uri, err)
	}
	return out
}

func TestResources_AreListedWithTheirURIs(t *testing.T) {
	env := newToolEnv(t)

	res, err := env.cs.ListResources(context.Background(), nil)
	if err != nil {
		t.Fatalf("list resources: %v", err)
	}
	got := map[string]bool{}
	for _, r := range res.Resources {
		got[r.URI] = true
	}
	for _, uri := range []string{"point://context", "point://theme/active", "point://posts/recent"} {
		if !got[uri] {
			t.Errorf("resource %s is not listed", uri)
		}
	}
}

func TestContextResource_ReportsBlogIdentityAndCounts(t *testing.T) {
	env := newToolEnv(t)
	env.call("point_update_settings", map[string]any{
		"updates": map[string]string{
			"blog_title": "My Blog", "blog_subtitle": "Notes", "author_name": "Ada", "posts_per_page": "7",
		},
	})
	id := env.createPost(map[string]any{"title": "One", "content": "x"})
	env.call("point_publish_post", map[string]any{"id": id})

	out := env.readObject("point://context")
	if s := str(t, out, "base_url"); s != testBaseURL {
		t.Errorf("base_url = %q, want %q", s, testBaseURL)
	}
	if s := str(t, out, "blog_title"); s != "My Blog" {
		t.Errorf("blog_title = %q, want My Blog", s)
	}
	if s := str(t, out, "subtitle"); s != "Notes" {
		t.Errorf("subtitle = %q, want Notes", s)
	}
	if s := str(t, out, "author_name"); s != "Ada" {
		t.Errorf("author_name = %q, want Ada", s)
	}
	if n, _ := out["posts_per_page"].(float64); n != 7 {
		t.Errorf("posts_per_page = %v, want 7", out["posts_per_page"])
	}
	theme, _ := out["active_theme"].(map[string]any)
	if theme["name"] != "Daylight" {
		t.Errorf("active_theme = %v, want the active theme's metadata", out["active_theme"])
	}
	// stats is embedded raw, so a broken splice shows up as a string or as null
	// rather than as an object.
	stats, ok := out["stats"].(map[string]any)
	if !ok {
		t.Fatalf("stats = %v (%T), want an object", out["stats"], out["stats"])
	}
	if n, _ := stats["published_posts"].(float64); n != 1 {
		t.Errorf("published_posts = %v, want 1", stats["published_posts"])
	}
}

func TestThemeResource_TracksTheActiveTheme(t *testing.T) {
	env := newToolEnv(t)

	out := env.readObject("point://theme/active")
	css := str(t, out, "css")
	if !strings.Contains(css, "--color-accent: #336699") {
		t.Errorf("css = %q, want the theme's accent", css)
	}
	if !strings.Contains(css, "--color-scheme: light") {
		t.Errorf("css = %q, want a light scheme for a theme without a dark block", css)
	}
	vars, _ := out["variables"].(map[string]any)
	if vars["color-accent"] != "#336699" {
		t.Errorf("variables = %v, want the accent as a variable too", out["variables"])
	}

	writeFile(t, filepath.Join(env.themesDir, "midnight.css"), testDarkThemeCSS)
	env.call("point_set_active_theme", map[string]any{"name": "midnight"})

	vars, _ = env.readObject("point://theme/active")["variables"].(map[string]any)
	if vars["color-scheme"] != "dark" {
		t.Errorf("color-scheme = %v, want dark once a dark-capable theme is active", vars["color-scheme"])
	}
}

// The recent-posts resource is the published feed: a draft must not leak into
// it even though the MCP caller is authenticated.
func TestRecentPostsResource_PublishedOnly(t *testing.T) {
	env := newToolEnv(t)
	id := env.createPost(map[string]any{"title": "Published one", "content": "x"})
	env.call("point_publish_post", map[string]any{"id": id})
	env.createPost(map[string]any{"title": "Still a draft", "content": "y"})

	out := env.readObject("point://posts/recent")
	posts, _ := out["posts"].([]any)
	if len(posts) != 1 {
		t.Fatalf("recent posts returned %d entries, want only the published one", len(posts))
	}
	first, _ := posts[0].(map[string]any)
	if s := str(t, first, "title"); s != "Published one" {
		t.Errorf("recent posts returned %q", s)
	}
}

// A resource whose underlying handler fails has to surface as an error, not as
// an empty document.
func TestContextResource_SurfacesHandlerFailures(t *testing.T) {
	env := newToolEnv(t)
	_ = env.repo.Close()

	if _, err := env.cs.ReadResource(context.Background(), &sdk.ReadResourceParams{URI: "point://context"}); err == nil {
		t.Error("reading point://context with a dead database succeeded")
	}
}
