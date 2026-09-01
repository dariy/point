package main

// Server-rendered document metadata: the <head> a crawler, an unfurler or the
// tab strip sees *before* any JS runs.
//
// The SPA sets its own title after hydration (frontend/src/utils/
// documentTitle.js), which is far too late for a client that does not execute
// scripts — a link shared into a chat app would unfurl as "Loading…" with no
// description and no card image. So the shell handler asks shellMeta() what the
// requested URL is about and splices the answer into the shell it was going to
// serve anyway.
//
// Three route families are covered: the homepage, a tag archive and a post —
// the last of which is also reachable *as* a tag archive URL, since a post
// opened from inside one is served at /tags/<tag>?slug=<post>. Everything else
// — the admin section, /search, a 404 — gets nothing and keeps the shell's
// placeholder head, because guessing is worse than staying quiet.
//
// Two rules hold across all of them:
//
//   - Nothing is described that an anonymous reader could not already read. A
//     draft, a scheduled post, a post withheld by a hides_posts tag and a tag
//     the public is not shown all resolve to the zero value, i.e. to the
//     generic shell.
//   - The <title> is composed exactly the way setPageTitle() composes it on the
//     client, so hydration is not a visible title change.

import (
	"fmt"
	"html"
	"regexp"
	"strconv"
	"strings"

	"point-api/internal/models"
	"point-api/internal/services"
	"point-api/internal/services/pageview"

	"github.com/labstack/echo/v4"
)

// seoMeta is what one URL is worth telling a crawler. The zero value means
// "nothing to say" and renders as the empty string, which is what keeps the
// caller branch-free.
type seoMeta struct {
	// Title is the whole <title>, site name included; CardTitle is the bare
	// page name for og:/twitter:, where og:site_name carries the site instead.
	Title       string
	CardTitle   string
	Description string
	SiteName    string
	OGType      string // "website" or "article"

	// CanonicalURL is absolute and doubles as og:url. It is the URL this page
	// wants to be indexed as, which is not always the one that was requested —
	// see canonicalURL.
	CanonicalURL string

	// ImageURL is absolute; empty means the plain summary card. LargeCard picks
	// the wide twitter card, which suits a photograph and not a site logo.
	ImageURL  string
	LargeCard bool
}

// head renders the metadata as a fragment to splice in before </head>.
func (m seoMeta) head() string {
	if m == (seoMeta{}) {
		return ""
	}
	esc := html.EscapeString
	var sb strings.Builder

	if m.Title != "" {
		fmt.Fprintf(&sb, "\n  <title>%s</title>", esc(m.Title))
	}
	if m.CanonicalURL != "" {
		fmt.Fprintf(&sb, "\n  <link rel=\"canonical\" href=\"%s\">", esc(m.CanonicalURL))
		fmt.Fprintf(&sb, "\n  <meta property=\"og:url\" content=\"%s\">", esc(m.CanonicalURL))
	}
	if desc := metaText(m.Description); desc != "" {
		fmt.Fprintf(&sb, "\n  <meta name=\"description\" content=\"%s\">", esc(desc))
		fmt.Fprintf(&sb, "\n  <meta property=\"og:description\" content=\"%s\">", esc(desc))
		fmt.Fprintf(&sb, "\n  <meta name=\"twitter:description\" content=\"%s\">", esc(desc))
	}
	if m.OGType != "" {
		fmt.Fprintf(&sb, "\n  <meta property=\"og:type\" content=\"%s\">", esc(m.OGType))
	}
	if m.CardTitle != "" {
		fmt.Fprintf(&sb, "\n  <meta property=\"og:title\" content=\"%s\">", esc(m.CardTitle))
		fmt.Fprintf(&sb, "\n  <meta name=\"twitter:title\" content=\"%s\">", esc(m.CardTitle))
	}
	if m.SiteName != "" {
		fmt.Fprintf(&sb, "\n  <meta property=\"og:site_name\" content=\"%s\">", esc(m.SiteName))
	}
	if m.ImageURL != "" {
		card := "summary"
		if m.LargeCard {
			card = "summary_large_image"
		}
		fmt.Fprintf(&sb, "\n  <meta name=\"twitter:card\" content=\"%s\">", card)
		fmt.Fprintf(&sb, "\n  <meta property=\"og:image\" content=\"%s\">", esc(m.ImageURL))
		fmt.Fprintf(&sb, "\n  <meta name=\"twitter:image\" content=\"%s\">", esc(m.ImageURL))
	} else if m.CardTitle != "" {
		sb.WriteString("\n  <meta name=\"twitter:card\" content=\"summary\">")
	}
	return sb.String()
}

// emptyDescriptionPlaceholder matches the blank description meta the shell ships
// with (frontend/index.html), which the SPA fills in after it boots. A crawler
// reads the FIRST description element, so leaving the empty one in front of the
// injected one is the same as injecting nothing at all.
var emptyDescriptionPlaceholder = regexp.MustCompile(`(?i)<meta\s+name=["']description["']\s+content=["']["']\s*/?>`)

// rewriteShell removes the placeholders this metadata replaces. Both are left
// alone when there is nothing to replace them with: an undescribed route keeps
// the shell exactly as the SPA expects to find it.
func (m seoMeta) rewriteShell(shell string) string {
	if m.Title != "" {
		shell = strings.Replace(shell, "<title>Loading…</title>", "", 1)
	}
	// metaText, not the raw field: a description that normalises away to
	// nothing renders nothing, and the placeholder has to survive for the SPA
	// to fill in.
	if metaText(m.Description) != "" {
		shell = emptyDescriptionPlaceholder.ReplaceAllString(shell, "")
	}
	return shell
}

// shellMeta resolves the requested URL to the metadata its document should
// carry. It returns the zero value for every route it does not know, for an
// entity it cannot find, and for anything the public may not see.
func shellMeta(c echo.Context, svcs *AppServices) seoMeta {
	path := c.Request().URL.Path
	// The admin section describes nothing to the outside world, and its pages
	// name their own tabs client-side.
	if isAdminPath(path) {
		return seoMeta{}
	}

	settings, err := svcs.Settings.Snapshot(c.Request().Context())
	if err != nil {
		settings = map[string]string{}
	}

	if path == "/" {
		return homeMeta(c, settings)
	}
	if slug, ok := strings.CutPrefix(path, "/posts/"); ok {
		return postMeta(c, svcs, settings, slug)
	}
	if slug, ok := strings.CutPrefix(path, "/tags/"); ok {
		return tagMeta(c, svcs, settings, slug)
	}
	return seoMeta{}
}

// homeMeta describes the site itself: the blog's own name and subtitle, which
// is what a bare domain shared in a chat should unfurl as. A pinned home page
// (home_page_post_id) does not override this — the card for "/" is the site's
// identity, not whichever page happens to be pinned behind it today.
func homeMeta(c echo.Context, settings map[string]string) seoMeta {
	site := pageview.SettingOr(settings, "blog_title", "")
	return seoMeta{
		Title:        site,
		CardTitle:    site,
		SiteName:     site,
		Description:  pageview.SettingOr(settings, "blog_subtitle", ""),
		OGType:       "website",
		CanonicalURL: canonicalURL(c, "/"),
		ImageURL:     siteCardImage(c, settings),
	}
}

// tagMeta describes a tag archive.
//
// The visibility gate is the same one BuildTagView applies (pageview/tag.go):
// a tag marked hidden, or one under the min_tag_posts_to_show floor, is not
// described at all. The snapshot failing is treated as "hidden" rather than
// "visible" — an unreadable graph must not become a leak.
func tagMeta(c echo.Context, svcs *AppServices, settings map[string]string, slug string) seoMeta {
	ctx := c.Request().Context()
	tag, err := svcs.Tag.GetTagBySlug(ctx, slug)
	if err != nil {
		return seoMeta{}
	}
	snap, err := svcs.Tag.GetTagSnapshot(ctx)
	if err != nil || snap == nil {
		return seoMeta{}
	}
	if snap.PublicHiddenTagIDs(pageview.MinTagPostsSetting(settings))[tag.ID] {
		return seoMeta{}
	}

	// A post opened from inside the archive is served at the archive's URL:
	// ViewContext serialises that view as /tags/<tag>?slug=<post>
	// (frontend/src/utils/viewContext.js), and it is what a reader copies out of
	// the address bar while reading. The document is about the post then, so it
	// is described as one — and canonicalises to the post's own URL, which is
	// where TagPage.js points the canonical after it hydrates.
	if openPost := c.QueryParam("slug"); openPost != "" {
		if pm := postMeta(c, svcs, settings, openPost); pm != (seoMeta{}) {
			// TagPage.js titles this view "<post> — <tag>", not "<post> —
			// <site>": the tab keeps naming the archive being read through.
			pm.Title = titleWithSite(pm.CardTitle, tag.Name)
			return pm
		}
	}

	site := pageview.SettingOr(settings, "blog_title", "")
	// Mirrors TagPage.js's setPageTitle(`${name} — Posts`), so the tab does not
	// rename itself the moment the bundle boots.
	name := tag.Name + " — Posts"
	desc := strings.TrimSpace(tag.Description.String)
	if desc == "" {
		desc = fmt.Sprintf("Posts tagged “%s”", tag.Name)
		if site != "" {
			desc += " on " + site
		}
	}
	return seoMeta{
		Title:       titleWithSite(name, site),
		CardTitle:   name,
		SiteName:    site,
		Description: desc,
		OGType:      "website",
		// Without the path chain: a tag reached through three different
		// breadcrumb branches is three URLs for one archive, and ?path= is a
		// navigation aid, not a different page. Same for ?per_page=.
		CanonicalURL: canonicalURL(c, "/tags/"+tag.Slug),
		// The site image, not a post's: an archive has no one photograph, and
		// picking one would mean running the per-post visibility gate
		// (postHiddenByTag — a post withheld by a hides_posts tag is still
		// filed under this one) over candidates until one passes.
		ImageURL: siteCardImage(c, settings),
	}
}

// postMeta describes a single post, and is the one card that carries a
// photograph. Only a published post is described: a draft, a post withdrawn to
// hidden and a scheduled post whose time has not come all fall through to the
// generic shell, so a guessed or leaked URL unfurls as nothing.
func postMeta(c echo.Context, svcs *AppServices, settings map[string]string, slug string) seoMeta {
	ctx := c.Request().Context()
	post, err := svcs.Post.GetPostBySlug(ctx, slug)
	if err != nil || !strings.EqualFold(post.Status, "published") {
		return seoMeta{}
	}
	if postHiddenByTag(c, svcs, post.ID) {
		return seoMeta{}
	}

	desc := post.MetaDescription.String
	if !post.MetaDescription.Valid || desc == "" {
		desc = post.Excerpt.String
	}
	site := pageview.SettingOr(settings, "blog_title", "")

	m := seoMeta{
		Title:       titleWithSite(post.Title, site),
		CardTitle:   post.Title,
		SiteName:    site,
		Description: desc,
		OGType:      "article",
		// The post's own URL, page number and all else dropped: a post is one
		// document however the reader got to it, and ?page= belongs to the feed
		// they came through. PostPage.js sets the same canonical after it
		// hydrates.
		CanonicalURL: requestOrigin(c) + "/posts/" + post.Slug,
	}
	if img := postCardImage(c, svcs, settings, post); img != "" {
		m.ImageURL = img
		m.LargeCard = true
	}
	return m
}

// postHiddenByTag reports whether a published post is one the public may not
// read after all: a post filed under a tag carrying hides_posts (or under a
// descendant of one) is 404'd to an anonymous reader by the post API itself
// (GetPostBySlug in internal/api/posts.go), so describing it here would put a
// title, an excerpt and a private photograph in front of a crawler that cannot
// fetch the post behind them.
//
// A graph that fails to load counts as hidden, the same way tagMeta treats an
// unreadable snapshot: staying quiet costs a card, guessing costs the rule.
func postHiddenByTag(c echo.Context, svcs *AppServices, postID int64) bool {
	ctx := c.Request().Context()
	snap, err := svcs.Tag.GetTagSnapshot(ctx)
	if err != nil || snap == nil {
		return true
	}
	tags, err := svcs.Post.GetTagsForPost(ctx, postID)
	if err != nil {
		return true
	}
	for _, t := range tags {
		if snap.EffectiveHidesPosts[t.ID] {
			return true
		}
	}
	return false
}

// postCardImage picks the post's first media that can actually render a card. A
// video without a captured poster has no still behind it, so it is skipped
// rather than pointed at: the crawler would fetch the whole stream and show
// nothing.
func postCardImage(c echo.Context, svcs *AppServices, settings map[string]string, post models.Post) string {
	ctx := c.Request().Context()
	media, _ := svcs.Media.GetMediaByContent(ctx, post.Content, post.ThumbnailPath.String)
	for _, m := range media {
		if !strings.EqualFold(m.FileType, "image") && (!m.ThumbnailPath.Valid || m.ThumbnailPath.String == "") {
			continue
		}
		bare := "/" + strings.TrimPrefix(m.OriginalPath, "originals/")
		// The 1024 rung, never the original: a camera JPEG is megabytes and
		// past every card renderer's size ceiling, which renders as no card.
		gen := services.ThumbnailGenerationFrom(settings)
		return requestOrigin(c) + services.VariantURL(bare, services.SocialCardVariantSize, gen)
	}
	return ""
}

// siteCardImage is the card image for pages that are about the site rather than
// about one photograph: the blog's logo. It is used as configured — no variant
// rung — because logo_url may be an SVG or an off-site URL, neither of which
// the media ladder can resize, and a logo is small to begin with.
func siteCardImage(c echo.Context, settings map[string]string) string {
	logo := strings.TrimSpace(pageview.SettingOr(settings, "logo_url", ""))
	if logo == "" {
		return ""
	}
	if strings.HasPrefix(logo, "http://") || strings.HasPrefix(logo, "https://") {
		return logo
	}
	return requestOrigin(c) + "/" + strings.TrimPrefix(logo, "/")
}

// metaDescriptionMax is where a description is cut. Every consumer stops well
// short of this — a search snippet at ~160 characters, a chat card at ~200 —
// and the rest is bytes on every document that nothing ever shows.
const metaDescriptionMax = 200

// metaText normalises prose into something an attribute should hold: whitespace
// collapsed to single spaces (an excerpt carries the post's own line breaks, and
// a raw newline inside content="" is legal but reads badly in every tool that
// prints it back), then cut on a word boundary rather than mid-word.
func metaText(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	r := []rune(s)
	if len(r) <= metaDescriptionMax {
		return s
	}
	cut := string(r[:metaDescriptionMax])
	if i := strings.LastIndexByte(cut, ' '); i > 0 {
		cut = cut[:i]
	}
	return strings.TrimRight(cut, " ,.;:-—") + "…"
}

// titleWithSite composes "<page> — <site>" exactly as setPageTitle() does on
// the client (frontend/src/utils/documentTitle.js), including its refusal to
// produce "Blog — Blog". The client's "Point" fallback is deliberately not
// mirrored: an install with no blog title yet should say nothing, not invent a
// name a crawler would then index.
func titleWithSite(part, site string) string {
	part = strings.TrimSpace(part)
	if site == "" {
		return part
	}
	if part == "" || part == site {
		return site
	}
	return part + " — " + site
}

// canonicalURL is the absolute URL a paginated page — the feed, a tag archive —
// asks to be indexed as: the clean path plus the page number, and nothing else.
// Dropping the rest of the query string is the point — ?path=, ?per_page= and
// every campaign parameter address the same archive, and each one left in would
// be a duplicate of it.
//
// Page 2 canonicalises to itself, not to page 1: a self-referencing canonical
// keeps the deeper pages crawlable instead of asking for them to be collapsed
// into the first.
func canonicalURL(c echo.Context, path string) string {
	url := requestOrigin(c) + path
	if n, err := strconv.Atoi(c.QueryParam("page")); err == nil && n > 1 {
		url += "?page=" + strconv.Itoa(n)
	}
	return url
}

// requestOrigin is the scheme://host this document was asked for under.
//
// X-Forwarded-Proto is honoured (a TLS-terminating proxy is the normal
// deployment, and without it every absolute URL here would claim http://).
// X-Forwarded-Host deliberately is not: a guest GET of the shell is stamped
// public, max-age=60, shared caches key on Host, and honouring a header they do
// not key on is how one visitor's spoofed request poisons everyone else's
// canonical and og:url.
func requestOrigin(c echo.Context) string {
	scheme := c.Scheme()
	// Read as an enum, not as a string. A chain of proxies appends to this
	// header rather than replacing it ("https, http"), and nothing stops a
	// client from sending one directly — so the only two values a browser could
	// have arrived under are recognised, and every other one leaves the scheme
	// echo already derived from the connection alone.
	if fwd := c.Request().Header.Get("X-Forwarded-Proto"); fwd != "" {
		first, _, _ := strings.Cut(fwd, ",")
		switch strings.ToLower(strings.TrimSpace(first)) {
		case "https":
			scheme = "https"
		case "http":
			scheme = "http"
		}
	}
	return scheme + "://" + c.Request().Host
}
