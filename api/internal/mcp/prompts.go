package mcp

import (
	"context"
	"fmt"
	"strings"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// registerPrompts wires the create_landing_page workflow prompt.
func registerPrompts(s *sdk.Server) {
	s.AddPrompt(&sdk.Prompt{
		Name:        "create_landing_page",
		Description: "Guides the model through authoring a theme-aware immersive landing page as a draft post.",
		Arguments: []*sdk.PromptArgument{
			{Name: "topic", Description: "Subject, product, or service the landing page should promote.", Required: true},
			{Name: "media_paths", Description: "Optional comma-separated file paths (in the server upload directory) to upload as hero/section media.", Required: false},
		},
	}, func(_ context.Context, req *sdk.GetPromptRequest) (*sdk.GetPromptResult, error) {
		topic := strings.TrimSpace(req.Params.Arguments["topic"])
		if topic == "" {
			return nil, fmt.Errorf("topic argument is required")
		}
		body := landingPageBody(topic, mediaStep(strings.TrimSpace(req.Params.Arguments["media_paths"])))
		return &sdk.GetPromptResult{
			Description: fmt.Sprintf("Create a theme-aware immersive landing page about: %s", topic),
			Messages: []*sdk.PromptMessage{
				{Role: "user", Content: &sdk.TextContent{Text: body}},
			},
		}, nil
	})
}

func mediaStep(mediaPaths string) string {
	const fallback = "If you have image or video files in the server's upload directory, call **point_upload_media** for each and record the returned `path` values. Otherwise skip this step."
	if mediaPaths == "" {
		return fallback
	}
	var lines []string
	for _, p := range strings.Split(mediaPaths, ",") {
		if p = strings.TrimSpace(p); p != "" {
			lines = append(lines, "- `"+p+"`")
		}
	}
	if len(lines) == 0 {
		return fallback
	}
	return "Call **point_upload_media** once for each file below and record the returned `path` for use in content and as `thumbnail_path`.\n\n" + strings.Join(lines, "\n")
}

func landingPageBody(topic, media string) string {
	const bt = "`"
	raw := `You are creating a polished, theme-aware immersive landing page about: **§TOPIC§**

Follow these steps in order.

## Step 1 — Discover context and theme
Call **point_get_context**, **point_get_theme_css**, and **point_get_syntax_guidelines**. Note the base URL, blog title, author, the theme accent color (` + bt + `--color-accent` + bt + `), dark-mode support, and the markdown/HTML/CSS rules.

## Step 2 — Upload media
§MEDIA§

## Step 3 — Author the page
Use markdown (` + bt + `formatter: "markdown"` + bt + `). Wrap sections with fenced divs (` + bt + `::: {.hero} ... :::` + bt + `) and attach classes with ` + bt + `{.class}` + bt + `. Reference theme variables in the per-post ` + bt + `css` + bt + ` field (e.g. ` + bt + `var(--color-accent)` + bt + `). Respect the CSS restrictions from the guidelines (no ` + bt + `position: fixed/sticky` + bt + `, ` + bt + `z-index` + bt + `, ` + bt + `@import` + bt + `, external ` + bt + `url()` + bt + `, or ` + bt + `content` + bt + `). A typical structure: hero, features/benefits, social proof, call to action.

## Step 4 — Create the draft
Call **point_create_post** with title, the markdown content, the scoped css, ` + bt + `formatter: "markdown"` + bt + `, ` + bt + `immersive_mode: "true"` + bt + `, ` + bt + `status: "draft"` + bt + `, an excerpt, and ` + bt + `thumbnail_path` + bt + ` (hero image if uploaded). If ` + bt + `css_warnings` + bt + ` is non-empty, remove the flagged declarations and call **point_update_post**.

## Step 5 — Return the preview
Call **point_generate_preview_link** with the new post ID and return the preview URL so the user can review before publishing.`

	body := strings.ReplaceAll(raw, "§TOPIC§", topic)
	return strings.ReplaceAll(body, "§MEDIA§", media)
}
