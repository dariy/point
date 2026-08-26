// Package pageview composes the payloads behind the BFF page endpoints — the
// one-round-trip aggregates the SPA asks for, one per screen: the home feed, a
// tag archive, the tag graph, the atlas cloud for a tapped place, and the map.
//
// The composition lives here rather than inline in the handlers because it is
// where the site's reading rules actually are: which posts a viewer may see,
// which tags are hidden out from under them, how an owner's scheduled queue
// extends a feed to the left of page 1, and which settings are safe to ship to
// a browser. Those rules deserve tests that do not need an HTTP request to run,
// and handlers short enough to read in one sitting — the cache-key bug that
// prompted this split lived two hundred lines inside one of them.
//
// Each builder returns a typed view. Turning that view into a JSON body — the
// map shapes the frontend is coded against — stays in internal/api, so the wire
// format keeps exactly one owner and this package keeps none.
package pageview

import (
	"context"
	"errors"
	"math"

	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/services"
)

// ErrNotVisible means the thing asked for exists but this viewer may not have
// it: a tag hidden from the public, or a view whose module is switched off.
// Handlers turn it into the 404 their endpoint has always answered with — the
// wording belongs to the endpoint, not to this package.
var ErrNotVisible = errors.New("pageview: not visible to this viewer")

// Builder composes page views out of the services that own the underlying data.
type Builder struct {
	repo  repository.Repository
	posts *services.PostService
	tags  *services.TagService
	media *services.MediaService
}

// New wires a Builder. Settings are not held: every builder takes the settings
// snapshot as an argument, because the handler has already loaded it to decide
// whether the response can be cached at all.
func New(repo repository.Repository, posts *services.PostService, tags *services.TagService, media *services.MediaService) *Builder {
	return &Builder{repo: repo, posts: posts, tags: tags, media: media}
}

// FeedParams is the request scope a paginated view is built for.
type FeedParams struct {
	// PublicOnly is true for an anonymous reader: no drafts, no hidden posts,
	// no scheduled queue, and hidden tags omitted from every response.
	PublicOnly bool

	Page    int32
	PerPage int32

	// RawPage is the `page` query value as the client sent it, and RawPageOK
	// whether it parsed at all. Page has already been clamped to >= 1 by the
	// time it reaches here, so this is what a request for the scheduled queue —
	// page 0 and below — has to be recognised by. See resolveScheduledPage.
	RawPage   int32
	RawPageOK bool

	YearFrom int
	YearTo   int
}

// HasYearFilter reports whether the request carries a usable timeline scope. A
// malformed range is read as "no scope", widening to everything rather than
// filtering to nothing.
func (p FeedParams) HasYearFilter() bool {
	return p.YearFrom > 0 && p.YearTo > 0 && p.YearFrom <= p.YearTo
}

// Pagination is the paginator block a feed view carries.
//
// Page and MinPage span both halves of the feed: MinPage drops below 1 for an
// owner whose scheduled queue extends it to the left, and Scheduled says which
// half the page in hand came from. Total and Pages always describe the
// published half, so swiping right off the queue lands on page 1 already
// knowing how many pages follow it.
type Pagination struct {
	Page      int32
	PerPage   int32
	Total     int64
	Pages     int
	MinPage   int32
	Scheduled bool
}

// PostEntry is one post that survived a view's visibility filter, carried with
// the ancestor-expanded tag set its response is built from.
type PostEntry struct {
	Post models.Post
	Tags []repository.PostTagInfo
}

// Visibility is the slice of the tag snapshot a serialised view needs: which
// tags to drop from responses, which are hidden, and which hide the posts
// beneath them.
//
// The maps are nil when the snapshot could not be built, which reads as
// "nothing is hidden" — the same fallback the handlers have always had, and the
// reason every lookup here goes through a plain map index rather than a method.
type Visibility struct {
	ExcludeTagIDs        map[int64]bool
	EffectiveHidden      map[int64]bool
	EffectiveHiddenPosts map[int64]bool
}

// visibilityFrom projects a tag snapshot down to the sets a view needs.
// ExcludeTagIDs stays nil for an authenticated viewer: they are shown
// everything, and an empty exclusion set says so.
func visibilityFrom(snap *services.TagGraph, minPosts int64, publicOnly bool) Visibility {
	if snap == nil {
		return Visibility{}
	}
	v := Visibility{
		EffectiveHidden:      snap.EffectiveHidden,
		EffectiveHiddenPosts: snap.EffectiveHidesPosts,
	}
	if publicOnly {
		v.ExcludeTagIDs = snap.PublicHiddenTagIDs(minPosts)
	}
	return v
}

// resolveScheduledPage opens a feed to the left of page 1, where the owner's
// scheduled posts live: page 0 is the first "future" page, then -1, -2 … for a
// queue of `count` posts. It returns the page to serve and the feed's left edge
// (`min_page`), which is 1 whenever the queue is empty.
//
// The caller has already clamped a non-positive page away, so the value as sent
// is read back from FeedParams rather than loosening the parse for everyone. A
// page past the end of the queue clamps to its last one instead of 404ing — the
// same forgiveness the right-hand side of the feed gets.
func resolveScheduledPage(p FeedParams, count int64) (page, minPage int32) {
	page, minPage = p.Page, int32(1)
	if count > 0 {
		minPage = 1 - int32(math.Ceil(float64(count)/float64(p.PerPage)))
	}
	if p.RawPageOK && p.RawPage < 1 {
		page = p.RawPage
		if page < minPage {
			page = minPage
		}
	}
	return page, minPage
}

// pageCount is the paginator's page total, floored at 1 so an empty feed still
// reads as "page 1 of 1" rather than "page 1 of 0".
func pageCount(total int64, perPage int32) int {
	n := int(math.Ceil(float64(total) / float64(perPage)))
	if n == 0 {
		return 1
	}
	return n
}

// visiblePosts expands each post's tags with their ancestors and drops the ones
// an anonymous reader may not see — a post sitting under a hides_posts subtree.
func (b *Builder) visiblePosts(ctx context.Context, posts []models.Post, publicOnly bool, vis Visibility) []PostEntry {
	ids := make([]int64, len(posts))
	for i, p := range posts {
		ids[i] = p.ID
	}
	tagsMap, _ := b.repo.GetTagsByPostIDs(ctx, ids)
	tagsMap = b.ExpandPostTagsWithAncestors(ctx, tagsMap, publicOnly)

	out := make([]PostEntry, 0, len(posts))
	for _, p := range posts {
		if publicOnly && !IsPostVisibleToPublic(tagsMap[p.ID], vis.EffectiveHiddenPosts) {
			continue
		}
		out = append(out, PostEntry{Post: p, Tags: tagsMap[p.ID]})
	}
	return out
}
