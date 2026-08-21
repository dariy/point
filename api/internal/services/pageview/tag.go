package pageview

import (
	"context"
	"strings"

	"point-api/internal/models"
	"point-api/internal/services"
)

// TagParams is the request scope a tag archive is built for.
type TagParams struct {
	FeedParams

	Slug string

	// Path is the slug chain (root → … → immediate parent) the user drilled
	// through to reach this tag. Tags form a DAG, so an explicit path is the
	// only way to know which branch produced the breadcrumb they expect to see.
	Path []string
}

// TagView is everything a tag archive page renders from.
type TagView struct {
	Tag      models.Tag
	Parents  []models.Tag
	Children []models.Tag
	Location *models.TagLocation

	Breadcrumbs []Crumb
	Posts       []PostEntry
	Pagination  Pagination

	// Menu is the site-wide root nav; NavChildren is this tag's sub-nav, which
	// is either its hierarchical children or — under a show_related tag — the
	// tags co-occurring with it on real posts.
	Menu        []services.NavTagNode
	NavChildren []services.NavTagNode

	Visibility     Visibility
	ShowViewCounts bool
}

// Crumb is one step of a breadcrumb trail. Href is set only when the request
// carried an explicit path: each crumb then links to itself with its own
// truncated path, so clicking back up the trail preserves the navigated branch.
// Left empty, the client falls back to the tag's plain URL.
type Crumb struct {
	Tag  models.Tag
	Href string
}

// BuildTagView composes a tag archive: the tag itself, its breadcrumb trail,
// its sub-nav and a page of the posts filed under it.
//
// It returns ErrNotVisible when an anonymous reader asks for a tag the public
// is not shown.
func (b *Builder) BuildTagView(ctx context.Context, settings map[string]string, p TagParams) (*TagView, error) {
	snap, _ := b.tags.GetTagSnapshot(ctx)
	tag, err := b.tags.GetTagBySlug(ctx, p.Slug)
	if err != nil {
		return nil, err
	}

	minPosts := MinTagPostsSetting(settings)
	vis := visibilityFrom(snap, minPosts, p.PublicOnly)
	if vis.ExcludeTagIDs[tag.ID] {
		return nil, ErrNotVisible
	}

	var withRelated, inBreadcrumbs map[int64]bool
	if snap != nil {
		withRelated = snap.WithRelatedIDs()
		inBreadcrumbs = snap.InBreadcrumbsIDs()
	}

	parents, _ := b.tags.GetTagParents(ctx, tag.ID)

	// Direct children for the tag detail response, minus the effectively hidden
	// ones.
	allChildren, _ := b.tags.GetTagChildren(ctx, tag.ID, p.PublicOnly, minPosts)
	children := make([]models.Tag, 0, len(allChildren))
	for _, ch := range allChildren {
		if !p.PublicOnly || (vis.EffectiveHidden != nil && !vis.EffectiveHidden[ch.ID]) {
			children = append(children, ch)
		}
	}

	// Posts for this tag. Like the home feed, an owner's tag page runs left of
	// page 1 into the posts tagged this way that are still waiting to publish —
	// see resolveScheduledPage. The queue is read separately (its ordering is
	// the opposite of the feed's and the two never share a page), but `total`
	// and `pages` keep describing the published half so the paginator still
	// spans both.
	page, minPage := p.Page, int32(1)
	if !p.PublicOnly && !p.HasYearFilter() {
		n, _ := b.tags.CountScheduledPostsByTag(ctx, tag.ID)
		page, minPage = resolveScheduledPage(p.FeedParams, n)
	}
	scheduledView := page < 1

	var posts []models.Post
	var total int64
	if scheduledView {
		total, err = b.tags.CountPostsByTag(ctx, tag.ID, p.PublicOnly, p.YearFrom, p.YearTo)
		if err != nil {
			return nil, err
		}
		// Page 0 is the queue's first page, -1 its second, and so on.
		posts, err = b.tags.GetScheduledPostsByTag(ctx, tag.ID, 1-page, p.PerPage)
	} else {
		posts, total, err = b.tags.GetPostsByTag(ctx, tag.ID, page, p.PerPage, p.PublicOnly, false, p.YearFrom, p.YearTo)
	}
	if err != nil {
		return nil, err
	}

	rootNav, _ := b.tags.GetHierarchicalNavTags(ctx, nil, p.PublicOnly, minPosts)
	navChildren := b.subNav(ctx, tag, parents, p, vis, withRelated, minPosts)
	crumbs := b.breadcrumbs(ctx, snap, tag, p, vis, inBreadcrumbs)
	entries := b.visiblePosts(ctx, posts, p.PublicOnly, vis)

	locMap, _ := b.tags.GetTagLocationsByTagIDs(ctx, []int64{tag.ID})
	var loc *models.TagLocation
	if l, ok := locMap[tag.ID]; ok {
		loc = &l
	}

	return &TagView{
		Tag:            tag,
		Parents:        parents,
		Children:       children,
		Location:       loc,
		Breadcrumbs:    crumbs,
		Posts:          entries,
		Menu:           rootNav,
		NavChildren:    navChildren,
		Visibility:     vis,
		ShowViewCounts: settings["show_view_counts"] == "true",
		Pagination: Pagination{
			Page:      page,
			PerPage:   p.PerPage,
			Total:     total,
			Pages:     pageCount(total, p.PerPage),
			MinPage:   minPage,
			Scheduled: scheduledView,
		},
	}, nil
}

// subNav builds the tag's sub-navigation. Normally that is its hierarchical
// children; when the tag — or any of its parents — is marked show_related, it
// is instead the tags this one co-occurs with on real posts, flagged so the
// frontend can say so.
func (b *Builder) subNav(
	ctx context.Context,
	tag models.Tag,
	parents []models.Tag,
	p TagParams,
	vis Visibility,
	withRelated map[int64]bool,
	minPosts int64,
) []services.NavTagNode {
	useCoOccurrence := withRelated[tag.ID]
	for _, parent := range parents {
		if withRelated[parent.ID] {
			useCoOccurrence = true
			break
		}
	}
	if !useCoOccurrence {
		items, _ := b.tags.GetHierarchicalNavTags(ctx, &tag.ID, p.PublicOnly, minPosts)
		return items
	}

	coTags, _ := b.repo.GetCoOccurringTags(ctx, tag.ID, p.PublicOnly)
	var items []services.NavTagNode
	for _, t := range coTags {
		if p.PublicOnly && vis.EffectiveHidden[t.ID] {
			continue
		}
		items = append(items, services.NavTagNode{
			ID:        t.ID,
			Name:      t.Name,
			Slug:      t.Slug,
			PostCount: t.PostCount,
			IsRelated: true,
			Children:  []services.NavTagNode{},
		})
	}
	return items
}

// breadcrumbs builds the trail above a tag. An explicit `path` that really is a
// root→…→parent chain in the tag graph ending at a parent of this tag is
// honoured verbatim, so the trail matches the branch the user navigated;
// otherwise it falls back to the server-computed ancestor chain, which is
// filtered to the tags marked as showing in breadcrumbs.
func (b *Builder) breadcrumbs(
	ctx context.Context,
	snap *services.TagGraph,
	tag models.Tag,
	p TagParams,
	vis Visibility,
	inBreadcrumbs map[int64]bool,
) []Crumb {
	if pathTags, ok := resolveBreadcrumbPath(snap, p.Path, tag); ok {
		crumbs := make([]Crumb, 0, len(pathTags))
		for i, a := range pathTags {
			if vis.ExcludeTagIDs[a.ID] {
				continue
			}
			crumbs = append(crumbs, Crumb{Tag: a, Href: tagPathHref(a.Slug, p.Path[:i])})
		}
		return crumbs
	}

	ancestors, _ := b.repo.GetTagAncestors(ctx, tag.ID)
	crumbs := make([]Crumb, 0, len(ancestors))
	for _, a := range ancestors {
		if !vis.ExcludeTagIDs[a.ID] && inBreadcrumbs[a.ID] {
			crumbs = append(crumbs, Crumb{Tag: a})
		}
	}
	return crumbs
}

// resolveBreadcrumbPath validates that pathSlugs form a real connected
// parent→child chain in the tag graph whose last element is a parent of `tag`,
// and returns the resolved tags in order. Returns ok=false (caller falls back
// to the computed ancestor chain) when the path is empty, unknown, or broken.
func resolveBreadcrumbPath(snap *services.TagGraph, pathSlugs []string, tag models.Tag) ([]models.Tag, bool) {
	if snap == nil || len(pathSlugs) == 0 {
		return nil, false
	}
	isChild := func(parentID, childID int64) bool {
		for _, c := range snap.Children[parentID] {
			if c == childID {
				return true
			}
		}
		return false
	}
	resolved := make([]models.Tag, 0, len(pathSlugs))
	for i, s := range pathSlugs {
		t, ok := snap.BySlug[s]
		if !ok {
			return nil, false
		}
		if i > 0 && !isChild(resolved[i-1].ID, t.ID) {
			return nil, false
		}
		resolved = append(resolved, t)
	}
	// The last crumb must actually be a parent of the current tag.
	if !isChild(resolved[len(resolved)-1].ID, tag.ID) {
		return nil, false
	}
	return resolved, true
}

// tagPathHref builds a tag URL whose `path` query carries the given ancestor
// prefix (empty prefix → no query).
func tagPathHref(slug string, prefix []string) string {
	if len(prefix) == 0 {
		return "/tags/" + slug
	}
	return "/tags/" + slug + "?path=" + strings.Join(prefix, "/")
}

// SplitPathParam parses a `path` query value ("a/b/c") into a slice of
// non-empty slugs, preserving order.
func SplitPathParam(raw string) []string {
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, "/")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
