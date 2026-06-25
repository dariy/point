package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// registerResources wires the three read-only MCP resources, reusing the same
// in-process handler dispatch as the tools.
func registerResources(s *sdk.Server, inv *invoker) {
	s.AddResource(&sdk.Resource{
		URI:         "point://context",
		Name:        "point_context",
		Description: "Blog context: base URL, title, subtitle, author, posts-per-page, active theme, and content counts.",
		MIMEType:    "application/json",
	}, func(_ context.Context, req *sdk.ReadResourceRequest) (*sdk.ReadResourceResult, error) {
		settings := map[string]string{}
		if data, err := inv.call(inv.h.settings.GetPublicSettings, "GET", "/api/settings/public", nil, nil); err != nil {
			return nil, err
		} else {
			_ = json.Unmarshal(data, &settings)
		}
		var theme themeMeta
		if data, err := inv.call(inv.h.theme.GetActiveTheme, "GET", "/api/themes/active", nil, nil); err != nil {
			return nil, err
		} else {
			_ = json.Unmarshal(data, &theme)
		}
		stats, err := inv.call(inv.h.system.GetStats, "GET", "/api/system/stats", nil, nil)
		if err != nil {
			return nil, err
		}
		postsPerPage, _ := strconv.Atoi(settings["posts_per_page"])
		return jsonResource(req.Params.URI, map[string]any{
			"base_url":       settings["url"],
			"blog_title":     settings["title"],
			"subtitle":       settings["subtitle"],
			"author_name":    settings["author_name"],
			"posts_per_page": postsPerPage,
			"active_theme":   theme,
			"stats":          json.RawMessage(stats),
		})
	})

	s.AddResource(&sdk.Resource{
		URI:         "point://theme/active",
		Name:        "point_theme_active",
		Description: "Active theme CSS custom properties as a :root block and a key-value map.",
		MIMEType:    "application/json",
	}, func(_ context.Context, req *sdk.ReadResourceRequest) (*sdk.ReadResourceResult, error) {
		var theme themeMeta
		data, err := inv.call(inv.h.theme.GetActiveTheme, "GET", "/api/themes/active", nil, nil)
		if err != nil {
			return nil, err
		}
		_ = json.Unmarshal(data, &theme)
		scheme := "light"
		if theme.HasDarkMode {
			scheme = "dark"
		}
		css := fmt.Sprintf(":root {\n  --color-accent: %s;\n  --color-scheme: %s;\n}\n", theme.PreviewColor, scheme)
		return jsonResource(req.Params.URI, map[string]any{
			"variables": map[string]string{"color-accent": theme.PreviewColor, "color-scheme": scheme},
			"css":       css,
		})
	})

	s.AddResource(&sdk.Resource{
		URI:         "point://posts/recent",
		Name:        "point_posts_recent",
		Description: "Most recent published posts (first page).",
		MIMEType:    "application/json",
	}, func(_ context.Context, req *sdk.ReadResourceRequest) (*sdk.ReadResourceResult, error) {
		data, err := inv.call(inv.h.post.ListPosts, "GET", "/api/posts?status=published", nil, nil)
		if err != nil {
			return nil, err
		}
		return &sdk.ReadResourceResult{Contents: []*sdk.ResourceContents{{
			URI: req.Params.URI, MIMEType: "application/json", Text: string(data),
		}}}, nil
	})
}

func jsonResource(uri string, v any) (*sdk.ReadResourceResult, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return &sdk.ReadResourceResult{Contents: []*sdk.ResourceContents{{
		URI: uri, MIMEType: "application/json", Text: string(b),
	}}}, nil
}
