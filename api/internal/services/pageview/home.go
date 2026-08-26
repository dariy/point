package pageview

import (
	"context"

	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/services"
)

// HomeView is everything the public homepage renders from.
type HomeView struct {
	// CustomPage is set when the blog pins a page as its homepage and this
	// request is the one that shows it. Posts and Pagination are then empty:
	// the pinned page replaces the feed rather than heading it.
	CustomPage *CustomHomePage

	Posts      []PostEntry
	Pagination Pagination

	// Settings is the public subset, shipped so the SPA can render without a
	// second round trip.
	Settings map[string]string

	Visibility     Visibility
	ShowViewCounts bool

	// Nav is non-nil only on the first, unfiltered page. The client retains the
	// last-seen tag cloud and menu across pagination and prev/next preloads, so
	// later pages skip the work entirely.
	Nav *HomeNav
}

// HomeNav is the page-independent furniture the homepage ships once.
type HomeNav struct {
	TagCloud []services.TagCloudItem
	Menu     []services.NavTagNode
}

// CustomHomePage is a pinned page standing in for the feed. ContentHTML is the
// rendered markdown before srcset injection — the caller owns that step,
// because it owns the wire format the img tags end up in.
type CustomHomePage struct {
	Post                models.Post
	Tags                []repository.PostTagInfo
	ContentHTML         string
	Media               []models.Medium
	ThumbnailGeneration string
}

// BuildHomeView composes the homepage: the pinned page if the blog has one, and
// otherwise a page of the feed with the tag cloud and menu attached to its
// first, unfiltered page.
func (b *Builder) BuildHomeView(ctx context.Context, settings map[string]string, p FeedParams) (*HomeView, error) {
	hasYearFilter := p.HasYearFilter()

	// Scheduled posts extend the feed to the left of page 1 — see
	// resolveScheduledPage. Only the owner has them, and only outside a timeline
	// scope: an unpublished post has no year to be scoped by.
	page, minPage := p.Page, int32(1)
	if !p.PublicOnly && !hasYearFilter {
		n, _ := b.posts.CountScheduledPosts(ctx)
		page, minPage = resolveScheduledPage(p, n)
	}
	scheduledView := page < 1

	snap, _ := b.tags.GetTagSnapshot(ctx)
	minPosts := MinTagPostsSetting(settings)
	vis := visibilityFrom(snap, minPosts, p.PublicOnly)

	view := &HomeView{
		Settings:       PublicSettings(settings),
		Visibility:     vis,
		ShowViewCounts: settings["show_view_counts"] == "true",
	}

	// A pinned home page stands in for the feed, but only on the first page and
	// only with no filter active — anything else is a reader who has navigated
	// past it and wants the posts.
	if page == 1 && !hasYearFilter {
		if cp := b.customHomePage(ctx, settings, p.PublicOnly); cp != nil {
			view.CustomPage = cp
			return view, nil
		}
	}

	listParams := services.ListPostsParams{
		Page:          page,
		PerPage:       p.PerPage,
		IncludeDrafts: false,
		IncludeHidden: !p.PublicOnly,
	}
	if hasYearFilter {
		listParams.YearFrom = p.YearFrom
		listParams.YearTo = p.YearTo
	}

	var posts []models.Post
	var total int64
	var err error
	if scheduledView {
		// The queue, not the feed. `total` still describes the published feed:
		// the paginator spans both halves, and swiping right has to land back
		// on page 1 knowing how many pages follow it.
		total, err = b.posts.CountPostsOnly(ctx, listParams)
		if err != nil {
			return nil, err
		}
		// Page 0 is the queue's first page, -1 its second, and so on.
		posts, _, err = b.posts.ListScheduledPosts(ctx, 1-page, p.PerPage)
	} else {
		posts, total, err = b.posts.ListPosts(ctx, listParams)
	}
	if err != nil {
		return nil, err
	}

	view.Posts = b.visiblePosts(ctx, posts, p.PublicOnly, vis)
	view.Pagination = Pagination{
		Page:      page,
		PerPage:   p.PerPage,
		Total:     total,
		Pages:     pageCount(total, p.PerPage),
		MinPage:   minPage,
		Scheduled: scheduledView,
	}

	if page == 1 && !hasYearFilter {
		cloud, _ := b.tags.GetTagCloud(ctx, homeTagCloudLimit, p.PublicOnly, minPosts)
		menu, _ := b.tags.GetHierarchicalNavTags(ctx, nil, p.PublicOnly, minPosts)
		view.Nav = &HomeNav{TagCloud: cloud, Menu: menu}
	}

	return view, nil
}

// homeTagCloudLimit is how many tags the homepage's cloud carries.
const homeTagCloudLimit = 20

// customHomePage resolves the blog's pinned home page. It returns nil — meaning
// "serve the ordinary feed" — when nothing is pinned, when the pinned slug does
// not resolve, when the viewer may not read it, or when it turns out not to be
// a page at all. None of those is an error worth failing the request over.
func (b *Builder) customHomePage(ctx context.Context, settings map[string]string, publicOnly bool) *CustomHomePage {
	slug := settings["home_page_post_id"]
	if slug == "" {
		return nil
	}
	post, err := b.posts.GetPostBySlug(ctx, slug)
	if err != nil {
		return nil
	}
	if publicOnly && post.Status != "published" && post.Status != "page" {
		return nil
	}
	if post.Type != "page" {
		return nil
	}

	tagsMap, _ := b.repo.GetTagsByPostIDs(ctx, []int64{post.ID})
	tagsMap = b.ExpandPostTagsWithAncestors(ctx, tagsMap, publicOnly)

	html, _ := b.posts.RenderContent(post.Content)
	media, _ := b.media.GetMediaByContent(ctx, post.Content, post.ThumbnailPath.String)

	return &CustomHomePage{
		Post:        post,
		Tags:        tagsMap[post.ID],
		ContentHTML: html,
		Media:       media,
		// The settings snapshot is already loaded here, so the generation token
		// costs nothing extra.
		ThumbnailGeneration: services.ThumbnailGenerationFrom(settings),
	}
}
