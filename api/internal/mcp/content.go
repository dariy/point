package mcp

import (
	"context"
	"encoding/json"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// syntaxGuidelines is the static authoring contract for Point content. It mirrors
// the server's markdown extensions, bluemonday allowlist, and CSS sanitizer.
var syntaxGuidelines = map[string]any{
	"markdown": map[string]any{
		"base": "GitHub Flavored Markdown (GFM)",
		"extensions": []string{
			"Attributes: add classes/IDs with {.class #id} after links or images.",
			"Fenced divs: wrap content in ::: {.class} ... ::: to create <div class=\"class\"> containers.",
			"Bare media: a local media path on its own line renders as <img>, <video>, or <audio>.",
			"Auto heading IDs for deep linking; code blocks support syntax highlighting.",
		},
	},
	"html": map[string]any{
		"policy": "bluemonday (strict allowlist)",
		"allowed_tags": []string{
			"Text: br, h1-h6, p, span, em, strong, i, b, u, s, del, ins, mark",
			"Lists/code: ul, ol, li, blockquote, code, pre, hr",
			"Layout: header, section, div, article, aside, main, nav, figure, figcaption",
			"Links: a (href, title, target, rel)",
			"Images: img (src, alt, title, width, height, loading)",
			"Video: video (src, controls, autoplay, muted, loop, playsinline, poster, preload, width, height)",
			"Audio: audio (src, controls, autoplay, loop, preload), source (src, type)",
			"SVG: svg, g, path, circle, rect, line, polyline, polygon, ellipse, text, tspan",
		},
		"global_attributes": []string{"class", "id", "role", "aria-*"},
		"allowed_inline_styles": []string{
			"color", "background-color", "background",
			"font-size", "font-weight", "font-style", "font-family", "font-variant",
			"text-align", "text-decoration", "text-transform", "text-indent",
			"line-height", "letter-spacing", "word-spacing",
			"margin", "padding (and -top/-right/-bottom/-left)",
			"border", "border-radius", "border-color", "border-width", "border-style",
			"width", "max-width", "min-width", "height", "max-height", "min-height",
			"display", "flex-direction", "flex-wrap", "justify-content", "align-items", "align-self", "flex", "gap", "grid-template-columns",
			"float", "clear", "overflow (and -x/-y)", "opacity", "vertical-align", "list-style", "white-space",
		},
	},
	"css": map[string]any{
		"scope": "Per-post scoped CSS field",
		"restricted_patterns": []string{
			"@import is forbidden",
			"url() with external HTTPS URLs is forbidden (use uploaded media paths)",
			"position: fixed and position: sticky are stripped",
			"z-index is stripped",
			"content property is stripped",
			"<script> tags are forbidden",
		},
	},
}

func registerGuidelinesTool(s *sdk.Server) {
	sdk.AddTool(s, &sdk.Tool{
		Name:        "point_get_syntax_guidelines",
		Description: "Returns guidelines for authoring Point content: markdown extensions, allowed HTML tags, and restricted CSS.",
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true},
	}, func(_ context.Context, _ *sdk.CallToolRequest, _ noArgs) (*sdk.CallToolResult, any, error) {
		data, _ := json.Marshal(syntaxGuidelines)
		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: string(data)}}}, nil, nil
	})
}
