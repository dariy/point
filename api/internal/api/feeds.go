package api

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"point-api/internal/repository"
	"point-api/internal/services"
)

type FeedsHandler struct {
	repo            *repository.Repository
	postService     *services.PostService
	settingsService *services.SettingsService
	tagService      *services.TagService
}

func NewFeedsHandler(repo *repository.Repository, postService *services.PostService, tagService *services.TagService, settingsService *services.SettingsService) *FeedsHandler {
	return &FeedsHandler{
		repo:            repo,
		postService:     postService,
		settingsService: settingsService,
		tagService:      tagService,
	}
}

func xmlEscape(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, `"`, "&quot;")
	s = strings.ReplaceAll(s, "'", "&apos;")
	return s
}

func baseURL(c echo.Context) string {
	scheme := "http"
	if c.Request().TLS != nil {
		scheme = "https"
	}
	if proto := c.Request().Header.Get("X-Forwarded-Proto"); proto != "" {
		scheme = proto
	}
	host := c.Request().Host
	if fwdHost := c.Request().Header.Get("X-Forwarded-Host"); fwdHost != "" {
		host = fwdHost
	}
	return scheme + "://" + host
}

func (h *FeedsHandler) RSSFeed(c echo.Context) error {
	ctx := c.Request().Context()

	settings, _ := h.settingsService.GetAllSettings(ctx)
	blogTitle := getSettingOr(settings, "blog_title", "Blog")
	blogDesc := getSettingOr(settings, "blog_subtitle", "")
	authorName := getSettingOr(settings, "author_name", "Author")
	authorEmail := getSettingOr(settings, "author_email", "")
	language := getSettingOr(settings, "default_language", "en")

	posts, err := h.repo.GetPublishedPostsForFeed(ctx, 20)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	base := baseURL(c)
	buildDate := time.Now().UTC().Format("Mon, 02 Jan 2006 15:04:05 GMT")

	var items strings.Builder
	for _, post := range posts {
		pubDate := post.CreatedAt
		if post.PublishedAt.Valid {
			pubDate = post.PublishedAt.Time
		}

		htmlContent, _ := h.postService.RenderContent(post.Content)
		excerpt := ""
		if post.Excerpt.Valid {
			excerpt = post.Excerpt.String
		}

		fmt.Fprintf(&items, "    <item>\n")
		fmt.Fprintf(&items, "      <title>%s</title>\n", xmlEscape(post.Title))
		fmt.Fprintf(&items, "      <link>%s/posts/%s</link>\n", base, post.Slug)
		fmt.Fprintf(&items, "      <guid isPermaLink=\"true\">%s/posts/%s</guid>\n", base, post.Slug)
		fmt.Fprintf(&items, "      <pubDate>%s</pubDate>\n", pubDate.UTC().Format("Mon, 02 Jan 2006 15:04:05 GMT"))
		fmt.Fprintf(&items, "      <description>%s</description>\n", xmlEscape(excerpt))
		fmt.Fprintf(&items, "      <content:encoded><![CDATA[%s]]></content:encoded>\n", htmlContent)
		fmt.Fprintf(&items, "    </item>\n")
	}

	xml := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>%s</title>
    <link>%s</link>
    <description>%s</description>
    <language>%s</language>
    <lastBuildDate>%s</lastBuildDate>
    <managingEditor>%s (%s)</managingEditor>
%s  </channel>
</rss>`,
		xmlEscape(blogTitle),
		base,
		xmlEscape(blogDesc),
		xmlEscape(language),
		buildDate,
		xmlEscape(authorEmail),
		xmlEscape(authorName),
		items.String(),
	)

	return c.Blob(http.StatusOK, "application/rss+xml; charset=utf-8", []byte(xml))
}

func (h *FeedsHandler) Sitemap(c echo.Context) error {
	ctx := c.Request().Context()
	base := baseURL(c)
	today := time.Now().Format("2006-01-02")

	posts, err := h.repo.GetPublishedPostsForSitemap(ctx)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	tags, err := h.repo.GetPublicTagsForSitemap(ctx)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	effectivelyHidden, _ := h.tagService.EffectivelyHiddenIDs(ctx)

	var urls strings.Builder
	writeURL := func(loc, lastmod, priority string) {
		fmt.Fprintf(&urls, "  <url>\n")
		fmt.Fprintf(&urls, "    <loc>%s</loc>\n", loc)
		fmt.Fprintf(&urls, "    <lastmod>%s</lastmod>\n", lastmod)
		fmt.Fprintf(&urls, "    <priority>%s</priority>\n", priority)
		fmt.Fprintf(&urls, "  </url>\n")
	}

	writeURL(base+"/", today, "1.0")

	for _, post := range posts {
		writeURL(base+"/posts/"+post.Slug, post.UpdatedAt.Format("2006-01-02"), "0.8")
	}

	for _, tag := range tags {
		if !effectivelyHidden[tag.ID] {
			writeURL(base+"/tag/"+tag.Slug, today, "0.6")
		}
	}

	xml := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
%s</urlset>`, urls.String())

	return c.Blob(http.StatusOK, "application/xml; charset=utf-8", []byte(xml))
}

func (h *FeedsHandler) RobotsTxt(c echo.Context) error {
	base := baseURL(c)
	content := fmt.Sprintf("User-agent: *\nAllow: /\nDisallow: /light/\nDisallow: /api/\nSitemap: %s/sitemap.xml\n", base)
	return c.String(http.StatusOK, content)
}

func getSettingOr(settings map[string]string, key, fallback string) string {
	if v, ok := settings[key]; ok && v != "" {
		return v
	}
	return fallback
}
