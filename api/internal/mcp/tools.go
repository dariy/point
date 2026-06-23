package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// addTool registers a tool whose result is the handler's JSON returned as text.
// Out is `any` so the SDK skips output-schema reflection; the typed In still
// drives the input schema the model sees.
func addTool[In any](s *sdk.Server, t *sdk.Tool, fn func(In) (json.RawMessage, error)) {
	sdk.AddTool(s, t, func(_ context.Context, _ *sdk.CallToolRequest, in In) (*sdk.CallToolResult, any, error) {
		data, err := fn(in)
		if err != nil {
			return nil, nil, err
		}
		if len(data) == 0 {
			data = json.RawMessage(`{"success":true}`)
		}
		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: string(data)}}}, nil, nil
	})
}

func itoa(id int64) string               { return strconv.FormatInt(id, 10) }
func idParam(id int64) map[string]string { return map[string]string{"id": itoa(id)} }

type noArgs struct{}

func registerTools(s *sdk.Server, inv *invoker) {
	registerContextTools(s, inv)
	registerPostTools(s, inv)
	registerTagTools(s, inv)
	registerMediaTools(s, inv)
	registerThemeAndSettingsTools(s, inv)
	registerAnalyticsTools(s, inv)
	registerGuidelinesTool(s)
}

// ── context ──────────────────────────────────────────────────────────────────

type themeMeta struct {
	Name         string `json:"name"`
	Description  string `json:"description"`
	PreviewColor string `json:"preview_color"`
	HasDarkMode  bool   `json:"has_dark_mode"`
}

func registerContextTools(s *sdk.Server, inv *invoker) {
	addTool(s, &sdk.Tool{
		Name:        "point_get_context",
		Description: "Returns blog context for writing content: base URL, title, subtitle, author name, posts per page, active theme metadata, and content counts.",
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true},
	}, func(noArgs) (json.RawMessage, error) {
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
		var stats json.RawMessage
		if data, err := inv.call(inv.h.system.GetStats, "GET", "/api/system/stats", nil, nil); err != nil {
			return nil, err
		} else {
			stats = data
		}
		postsPerPage, _ := strconv.Atoi(settings["posts_per_page"])
		return json.Marshal(map[string]any{
			"base_url":       settings["url"],
			"blog_title":     settings["title"],
			"subtitle":       settings["subtitle"],
			"author_name":    settings["author_name"],
			"posts_per_page": postsPerPage,
			"active_theme":   theme,
			"stats":          stats,
		})
	})

	addTool(s, &sdk.Tool{
		Name:        "point_get_theme_css",
		Description: "Returns the active theme's CSS custom properties so generated post CSS harmonizes with the blog theme.",
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true},
	}, func(noArgs) (json.RawMessage, error) {
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
		return json.Marshal(map[string]any{
			"variables": map[string]string{"color-accent": theme.PreviewColor, "color-scheme": scheme},
			"css":       css,
		})
	})
}

// ── posts ────────────────────────────────────────────────────────────────────

type listPostsInput struct {
	Page    int    `json:"page,omitempty" jsonschema:"page number"`
	PerPage int    `json:"per_page,omitempty" jsonschema:"items per page"`
	Status  string `json:"status,omitempty" jsonschema:"filter by status: draft, published, scheduled, all"`
	Tag     string `json:"tag,omitempty" jsonschema:"filter by tag slug"`
	Search  string `json:"search,omitempty" jsonschema:"full-text search query"`
	Sort    string `json:"sort,omitempty" jsonschema:"sort order, e.g. views"`
}

type getPostInput struct {
	ID   int64  `json:"id,omitempty" jsonschema:"post ID"`
	Slug string `json:"slug,omitempty" jsonschema:"post slug (used if id is 0)"`
}

type createPostInput struct {
	Title           string   `json:"title" jsonschema:"post title"`
	Content         string   `json:"content" jsonschema:"post body; use formatter to indicate markdown or html"`
	CSS             string   `json:"css,omitempty" jsonschema:"custom CSS injected into the post page"`
	ImmersiveMode   string   `json:"immersive_mode,omitempty" jsonschema:"immersive layout variant"`
	Formatter       string   `json:"formatter,omitempty" jsonschema:"content format: markdown or html"`
	Status          string   `json:"status,omitempty" jsonschema:"draft (default), published, or scheduled"`
	Excerpt         string   `json:"excerpt,omitempty" jsonschema:"short summary shown in listings"`
	Slug            string   `json:"slug,omitempty" jsonschema:"URL slug; auto-generated from title if omitted"`
	IsFeatured      bool     `json:"is_featured,omitempty" jsonschema:"pin post to featured slot"`
	ThumbnailPath   string   `json:"thumbnail_path,omitempty" jsonschema:"media path returned by point_upload_media"`
	MetaDescription string   `json:"meta_description,omitempty" jsonschema:"SEO meta description"`
	Tags            []string `json:"tags,omitempty" jsonschema:"list of tag slugs to attach"`
	ScheduledAt     *string  `json:"scheduled_at,omitempty" jsonschema:"RFC3339 publish time for scheduled posts"`
}

type updatePostInput struct {
	ID              int64     `json:"id" jsonschema:"post ID to update"`
	Title           *string   `json:"title,omitempty"`
	Content         *string   `json:"content,omitempty"`
	CSS             *string   `json:"css,omitempty"`
	ImmersiveMode   *string   `json:"immersive_mode,omitempty"`
	Formatter       *string   `json:"formatter,omitempty"`
	Status          *string   `json:"status,omitempty"`
	Excerpt         *string   `json:"excerpt,omitempty"`
	Slug            *string   `json:"slug,omitempty"`
	IsFeatured      *bool     `json:"is_featured,omitempty"`
	ThumbnailPath   *string   `json:"thumbnail_path,omitempty"`
	MetaDescription *string   `json:"meta_description,omitempty"`
	Tags            *[]string `json:"tags,omitempty"`
	ScheduledAt     *string   `json:"scheduled_at,omitempty"`
}

type postIDInput struct {
	ID int64 `json:"id" jsonschema:"post ID"`
}

type setPostTagsInput struct {
	ID   int64    `json:"id" jsonschema:"post ID"`
	Tags []string `json:"tags" jsonschema:"complete list of tag slugs to set (replaces existing)"`
}

type replaceInPostInput struct {
	ID            int64  `json:"id" jsonschema:"post ID"`
	Field         string `json:"field" jsonschema:"field to update: content, css, or excerpt"`
	OldString     string `json:"old_string" jsonschema:"exact literal text to find"`
	NewString     string `json:"new_string" jsonschema:"replacement text"`
	AllowMultiple bool   `json:"allow_multiple,omitempty" jsonschema:"if true replace all occurrences; if false fail on multiple matches"`
}

// postState decodes the fields of a current post needed to perform a
// non-destructive update (the backend PUT replaces the whole post).
type postState struct {
	Title           string     `json:"title"`
	Content         string     `json:"content"`
	CSS             string     `json:"css"`
	ImmersiveMode   string     `json:"immersive_mode"`
	Formatter       string     `json:"formatter"`
	Status          string     `json:"status"`
	Slug            string     `json:"slug"`
	IsFeatured      bool       `json:"is_featured"`
	Excerpt         *string    `json:"excerpt"`
	ThumbnailPath   *string    `json:"thumbnail_path"`
	MetaDescription *string    `json:"meta_description"`
	ScheduledAt     *time.Time `json:"scheduled_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
	Tags            []struct {
		Slug string `json:"slug"`
	} `json:"tags"`
}

type postWriteBody struct {
	Title           string   `json:"title"`
	Content         string   `json:"content"`
	CSS             string   `json:"css"`
	ImmersiveMode   string   `json:"immersive_mode"`
	Excerpt         string   `json:"excerpt"`
	Slug            string   `json:"slug"`
	Formatter       string   `json:"formatter"`
	Status          string   `json:"status"`
	IsFeatured      bool     `json:"is_featured"`
	ThumbnailPath   string   `json:"thumbnail_path"`
	MetaDescription string   `json:"meta_description"`
	Tags            []string `json:"tags"`
	ScheduledAt     *string  `json:"scheduled_at"`
}

func (inv *invoker) currentPost(id int64) (postState, error) {
	var p postState
	data, err := inv.call(inv.h.post.GetPostByID, "GET", "/api/posts/"+itoa(id), nil, idParam(id))
	if err != nil {
		return p, err
	}
	return p, json.Unmarshal(data, &p)
}

// body returns a full write body seeded from the current post so omitted fields
// are preserved across the replace-all PUT.
func (p postState) body() postWriteBody {
	b := postWriteBody{
		Title: p.Title, Content: p.Content, CSS: p.CSS, ImmersiveMode: p.ImmersiveMode,
		Formatter: p.Formatter, Status: p.Status, Slug: p.Slug, IsFeatured: p.IsFeatured,
	}
	if p.Excerpt != nil {
		b.Excerpt = *p.Excerpt
	}
	if p.ThumbnailPath != nil {
		b.ThumbnailPath = *p.ThumbnailPath
	}
	if p.MetaDescription != nil {
		b.MetaDescription = *p.MetaDescription
	}
	if p.ScheduledAt != nil {
		v := p.ScheduledAt.Format(time.RFC3339)
		b.ScheduledAt = &v
	}
	b.Tags = make([]string, len(p.Tags))
	for i, t := range p.Tags {
		b.Tags[i] = t.Slug
	}
	return b
}

func fixFences(s string) string { return strings.ReplaceAll(s, "::: {", ":::{") }

func registerPostTools(s *sdk.Server, inv *invoker) {
	addTool(s, &sdk.Tool{
		Name:        "point_list_posts",
		Description: "List posts with optional filters for status, tag, search query, and sort order.",
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true},
	}, func(in listPostsInput) (json.RawMessage, error) {
		q := url.Values{}
		if in.Page > 0 {
			q.Set("page", strconv.Itoa(in.Page))
		}
		if in.PerPage > 0 {
			q.Set("per_page", strconv.Itoa(in.PerPage))
		}
		if in.Status != "" {
			q.Set("status", in.Status)
		}
		if in.Tag != "" {
			q.Set("tag", in.Tag)
		}
		if in.Search != "" {
			q.Set("q", in.Search)
		}
		if in.Sort != "" {
			q.Set("sort", in.Sort)
		}
		return inv.call(inv.h.post.ListPosts, "GET", "/api/posts?"+q.Encode(), nil, nil)
	})

	addTool(s, &sdk.Tool{
		Name:        "point_get_post",
		Description: "Fetch a single post by ID or slug.",
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true},
	}, func(in getPostInput) (json.RawMessage, error) {
		if in.ID != 0 {
			return inv.call(inv.h.post.GetPostByID, "GET", "/api/posts/"+itoa(in.ID), nil, idParam(in.ID))
		}
		if in.Slug != "" {
			return inv.call(inv.h.post.GetPostBySlug, "GET", "/api/posts/slug/"+url.PathEscape(in.Slug), nil, map[string]string{"slug": in.Slug})
		}
		return nil, fmt.Errorf("provide id or slug")
	})

	addTool(s, &sdk.Tool{
		Name:        "point_create_post",
		Description: "Create a new post (default status draft). Call point_get_syntax_guidelines first for markdown/HTML/CSS rules. The css_warnings field flags invalid CSS rules.",
	}, func(in createPostInput) (json.RawMessage, error) {
		if in.Status == "" {
			in.Status = "draft"
		}
		in.Content = fixFences(in.Content)
		body, _ := json.Marshal(in)
		return inv.call(inv.h.post.CreatePost, "POST", "/api/posts", body, nil)
	})

	addTool(s, &sdk.Tool{
		Name:        "point_update_post",
		Description: "Update an existing post by ID. Only provided fields change; omitted fields keep their current values.",
	}, func(in updatePostInput) (json.RawMessage, error) {
		cur, err := inv.currentPost(in.ID)
		if err != nil {
			return nil, fmt.Errorf("fetching post for update: %w", err)
		}
		b := cur.body()
		if in.Title != nil {
			b.Title = *in.Title
		}
		if in.Content != nil {
			b.Content = *in.Content
		}
		if in.CSS != nil {
			b.CSS = *in.CSS
		}
		if in.ImmersiveMode != nil {
			b.ImmersiveMode = *in.ImmersiveMode
		}
		if in.Formatter != nil {
			b.Formatter = *in.Formatter
		}
		if in.Status != nil {
			b.Status = *in.Status
		}
		if in.Excerpt != nil {
			b.Excerpt = *in.Excerpt
		}
		if in.Slug != nil {
			b.Slug = *in.Slug
		}
		if in.IsFeatured != nil {
			b.IsFeatured = *in.IsFeatured
		}
		if in.ThumbnailPath != nil {
			b.ThumbnailPath = *in.ThumbnailPath
		}
		if in.MetaDescription != nil {
			b.MetaDescription = *in.MetaDescription
		}
		if in.Tags != nil {
			b.Tags = *in.Tags
		}
		if in.ScheduledAt != nil {
			b.ScheduledAt = in.ScheduledAt
		}
		b.Content = fixFences(b.Content)
		body, _ := json.Marshal(b)
		return inv.call(inv.h.post.UpdatePost, "PUT", "/api/posts/"+itoa(in.ID), body, idParam(in.ID))
	})

	addTool(s, &sdk.Tool{
		Name:        "point_publish_post",
		Description: "Publish a post immediately, making it visible on the live site.",
	}, func(in postIDInput) (json.RawMessage, error) {
		return inv.call(inv.h.post.PublishPost, "POST", "/api/posts/"+itoa(in.ID)+"/publish", nil, idParam(in.ID))
	})

	addTool(s, &sdk.Tool{
		Name:        "point_withdraw_post",
		Description: "Withdraw (unpublish) a post, reverting it to draft status.",
	}, func(in postIDInput) (json.RawMessage, error) {
		return inv.call(inv.h.post.WithdrawPost, "POST", "/api/posts/"+itoa(in.ID)+"/withdraw", nil, idParam(in.ID))
	})

	addTool(s, &sdk.Tool{
		Name:        "point_delete_post",
		Description: "Delete a post (moves it to trash).",
	}, func(in postIDInput) (json.RawMessage, error) {
		return inv.call(inv.h.post.DeletePost, "DELETE", "/api/posts/"+itoa(in.ID), nil, idParam(in.ID))
	})

	addTool(s, &sdk.Tool{
		Name:        "point_generate_preview_link",
		Description: "Generate a temporary preview URL for a draft post.",
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true},
	}, func(in postIDInput) (json.RawMessage, error) {
		return inv.call(inv.h.post.GeneratePreviewLink, "POST", "/api/posts/"+itoa(in.ID)+"/preview", nil, idParam(in.ID))
	})

	addTool(s, &sdk.Tool{
		Name:        "point_set_post_tags",
		Description: "Replace all tags on a post. The list is the new complete set; tags not listed are removed.",
	}, func(in setPostTagsInput) (json.RawMessage, error) {
		body, _ := json.Marshal(map[string][]string{"tags": in.Tags})
		return inv.call(inv.h.post.UpdatePostTags, "PATCH", "/api/posts/"+itoa(in.ID)+"/tags", body, idParam(in.ID))
	})

	addTool(s, &sdk.Tool{
		Name:        "point_replace_in_post",
		Description: "Targeted string replacement within a post field (content, css, or excerpt). More token-efficient than rewriting the whole field.",
	}, func(in replaceInPostInput) (json.RawMessage, error) {
		cur, err := inv.currentPost(in.ID)
		if err != nil {
			return nil, fmt.Errorf("fetching post for replacement: %w", err)
		}
		var current string
		switch strings.ToLower(in.Field) {
		case "content":
			current = cur.Content
		case "css":
			current = cur.CSS
		case "excerpt":
			if cur.Excerpt != nil {
				current = *cur.Excerpt
			}
		default:
			return nil, fmt.Errorf("invalid field: %s (must be content, css, or excerpt)", in.Field)
		}

		count := strings.Count(current, in.OldString)
		if count == 0 {
			return nil, fmt.Errorf("old_string not found in field %s", in.Field)
		}
		if !in.AllowMultiple && count > 1 {
			return nil, fmt.Errorf("found %d occurrences of old_string but allow_multiple is false", count)
		}
		updated := strings.ReplaceAll(current, in.OldString, in.NewString)

		b := cur.body()
		switch strings.ToLower(in.Field) {
		case "content":
			b.Content = updated
		case "css":
			b.CSS = updated
		case "excerpt":
			b.Excerpt = updated
		}
		body, _ := json.Marshal(b)
		return inv.call(inv.h.post.UpdatePost, "PUT", "/api/posts/"+itoa(in.ID), body, idParam(in.ID))
	})
}

// ── tags ─────────────────────────────────────────────────────────────────────

type tagLocation struct {
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
}

type tagInput struct {
	Name          string        `json:"name,omitempty" jsonschema:"tag display name"`
	Slug          string        `json:"slug,omitempty" jsonschema:"URL slug; auto-generated from name if omitted"`
	Description   string        `json:"description,omitempty" jsonschema:"tag description"`
	Kind          string        `json:"kind,omitempty" jsonschema:"tag kind, e.g. topic or place"`
	Hidden        bool          `json:"hidden,omitempty" jsonschema:"hide the tag itself from listings"`
	HidesPosts    bool          `json:"hides_posts,omitempty" jsonschema:"hide posts carrying this tag"`
	NavOrder      *int64        `json:"nav_order,omitempty" jsonschema:"manual sort order"`
	InBreadcrumbs bool          `json:"in_breadcrumbs,omitempty" jsonschema:"show in breadcrumbs"`
	ParentIDs     []int64       `json:"parent_ids,omitempty" jsonschema:"parent tag IDs (replaces existing)"`
	ChildIDs      []int64       `json:"child_ids,omitempty" jsonschema:"child tag IDs (replaces existing)"`
	Locations     []tagLocation `json:"locations,omitempty" jsonschema:"map coordinates"`
}

type getTagInput struct {
	ID   int64  `json:"id,omitempty" jsonschema:"tag ID"`
	Slug string `json:"slug,omitempty" jsonschema:"tag slug (used if id is 0)"`
}

type updateTagInput struct {
	ID int64 `json:"id" jsonschema:"tag ID to update"`
	tagInput
}

type tagIDInput struct {
	ID int64 `json:"id" jsonschema:"tag ID"`
}

func registerTagTools(s *sdk.Server, inv *invoker) {
	addTool(s, &sdk.Tool{
		Name:        "point_list_tags",
		Description: "List all tags with their slugs and post counts.",
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true},
	}, func(noArgs) (json.RawMessage, error) {
		return inv.call(inv.h.tag.ListTags, "GET", "/api/tags", nil, nil)
	})

	addTool(s, &sdk.Tool{
		Name:        "point_get_tag",
		Description: "Fetch a single tag by ID or slug, including parents, children, and map coordinates.",
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true},
	}, func(in getTagInput) (json.RawMessage, error) {
		if in.ID != 0 {
			return inv.call(inv.h.tag.GetTagByID, "GET", "/api/tags/id/"+itoa(in.ID), nil, idParam(in.ID))
		}
		if in.Slug != "" {
			return inv.call(inv.h.tag.GetTagBySlug, "GET", "/api/tags/slug/"+url.PathEscape(in.Slug), nil, map[string]string{"slug": in.Slug})
		}
		return nil, fmt.Errorf("provide id or slug")
	})

	addTool(s, &sdk.Tool{
		Name:        "point_create_tag",
		Description: "Create a new tag with optional description, hierarchy, and map coordinates.",
	}, func(in tagInput) (json.RawMessage, error) {
		body, _ := json.Marshal(in)
		return inv.call(inv.h.tag.CreateTag, "POST", "/api/tags", body, nil)
	})

	addTool(s, &sdk.Tool{
		Name:        "point_update_tag",
		Description: "Update tag properties. parent_ids and child_ids replace the existing hierarchy; locations set map coordinates.",
	}, func(in updateTagInput) (json.RawMessage, error) {
		body, _ := json.Marshal(in.tagInput)
		return inv.call(inv.h.tag.UpdateTag, "PUT", "/api/tags/"+itoa(in.ID), body, idParam(in.ID))
	})

	addTool(s, &sdk.Tool{
		Name:        "point_delete_tag",
		Description: "Delete a tag. Posts keep their content but lose the tag.",
	}, func(in tagIDInput) (json.RawMessage, error) {
		return inv.call(inv.h.tag.DeleteTag, "DELETE", "/api/tags/"+itoa(in.ID), nil, idParam(in.ID))
	})

	addTool(s, &sdk.Tool{
		Name:        "point_geocode_tag",
		Description: "Look up and store map coordinates for a tag from its name (OpenStreetMap Nominatim).",
	}, func(in tagIDInput) (json.RawMessage, error) {
		return inv.call(inv.h.tag.GeocodeTag, "POST", "/api/tags/"+itoa(in.ID)+"/geocode", nil, idParam(in.ID))
	})
}

// ── media ────────────────────────────────────────────────────────────────────

type uploadMediaInput struct {
	FilePath string `json:"file_path" jsonschema:"path to a file inside the server's configured upload directory"`
}

type listMediaInput struct {
	Page    int `json:"page,omitempty" jsonschema:"page number"`
	PerPage int `json:"per_page,omitempty" jsonschema:"items per page"`
}

type analyzeMediaInput struct {
	ID int64 `json:"id" jsonschema:"media item ID to analyze"`
}

func registerMediaTools(s *sdk.Server, inv *invoker) {
	addTool(s, &sdk.Tool{
		Name:        "point_upload_media",
		Description: "Upload a file from the server's configured upload directory to the media library. Returns the media item including its path for use as thumbnail_path or in post content.",
	}, func(in uploadMediaInput) (json.RawMessage, error) {
		return inv.uploadFile(in.FilePath)
	})

	addTool(s, &sdk.Tool{
		Name:        "point_list_media",
		Description: "List media items in the library with optional pagination.",
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true},
	}, func(in listMediaInput) (json.RawMessage, error) {
		q := url.Values{}
		if in.Page > 0 {
			q.Set("page", strconv.Itoa(in.Page))
		}
		if in.PerPage > 0 {
			q.Set("per_page", strconv.Itoa(in.PerPage))
		}
		return inv.call(inv.h.media.ListMedia, "GET", "/api/media?"+q.Encode(), nil, nil)
	})

	addTool(s, &sdk.Tool{
		Name:        "point_analyze_media",
		Description: "Analyze a media image with AI to suggest a title, tags, and excerpt.",
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true},
	}, func(in analyzeMediaInput) (json.RawMessage, error) {
		return inv.call(inv.h.media.AnalyzeImageByID, "POST", "/api/media/"+itoa(in.ID)+"/analyze", nil, idParam(in.ID))
	})
}

// ── themes & settings ────────────────────────────────────────────────────────

type setActiveThemeInput struct {
	Name string `json:"name" jsonschema:"name of the theme to activate"`
}

type updateSettingsInput struct {
	Updates map[string]string `json:"updates" jsonschema:"setting key-value pairs to apply"`
}

func registerThemeAndSettingsTools(s *sdk.Server, inv *invoker) {
	addTool(s, &sdk.Tool{
		Name:        "point_list_themes",
		Description: "List all themes available for the blog.",
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true},
	}, func(noArgs) (json.RawMessage, error) {
		return inv.call(inv.h.theme.ListThemes, "GET", "/api/themes", nil, nil)
	})

	addTool(s, &sdk.Tool{
		Name:        "point_set_active_theme",
		Description: "Activate a theme by name. WARNING: changes the live site's appearance immediately.",
	}, func(in setActiveThemeInput) (json.RawMessage, error) {
		body, _ := json.Marshal(map[string]string{"name": in.Name})
		return inv.call(inv.h.theme.SetActiveTheme, "PUT", "/api/themes/active", body, nil)
	})

	addTool(s, &sdk.Tool{
		Name:        "point_get_settings",
		Description: "Return all current blog settings as a flat key-value map.",
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true},
	}, func(noArgs) (json.RawMessage, error) {
		return inv.call(inv.h.settings.GetSettings, "GET", "/api/settings", nil, nil)
	})

	addTool(s, &sdk.Tool{
		Name:        "point_update_settings",
		Description: "Update blog settings with the provided key-value pairs. WARNING: changes apply immediately to the live site.",
	}, func(in updateSettingsInput) (json.RawMessage, error) {
		body, _ := json.Marshal(in.Updates)
		return inv.call(inv.h.settings.UpdateSettings, "PATCH", "/api/settings", body, nil)
	})
}

// ── analytics ────────────────────────────────────────────────────────────────

type topPostsInput struct {
	Limit int `json:"limit,omitempty" jsonschema:"number of top posts to return (default 10)"`
}

func registerAnalyticsTools(s *sdk.Server, inv *invoker) {
	addTool(s, &sdk.Tool{
		Name:        "point_analytics_top_posts",
		Description: "Retrieve top-performing published posts sorted by view count.",
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true},
	}, func(in topPostsInput) (json.RawMessage, error) {
		limit := in.Limit
		if limit <= 0 {
			limit = 10
		}
		q := url.Values{}
		q.Set("per_page", strconv.Itoa(limit))
		q.Set("status", "published")
		q.Set("sort", "views")
		return inv.call(inv.h.post.ListPosts, "GET", "/api/posts?"+q.Encode(), nil, nil)
	})

	addTool(s, &sdk.Tool{
		Name:        "point_analytics_summary",
		Description: "Retrieve aggregated post statistics including total and average view counts.",
		Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true},
	}, func(noArgs) (json.RawMessage, error) {
		return inv.call(inv.h.post.GetPostAnalytics, "GET", "/api/posts/analytics", nil, nil)
	})
}
