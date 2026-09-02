package pageview

import (
	"context"
	"strconv"

	"point-api/internal/repository"
)

// TagNode is a tag as the graph views draw it.
type TagNode struct {
	ID   int64
	Name string
	Slug string
	Kind string

	// Latitude and Longitude are set only for a tag that has coordinates; they
	// are what let the frontend classify a node as a place.
	Latitude  *float64
	Longitude *float64

	// IsHidden marks a tag an owner only sees because revelio is on, so the
	// atlas can render it as a visible difference rather than a silently longer
	// marker list. Never set for an anonymous viewer, who is not sent the tag
	// in the first place.
	IsHidden bool

	// PostCount is the count the view is scoped to. The atlas cloud carries no
	// counts and leaves it zero.
	PostCount int64
}

// PostNode is a post as the graph views draw it: a "shadow" node wired to the
// tags it carries.
type PostNode struct {
	ID    int64
	Slug  string
	Title string

	// MediaURL is the chip's preview image, already rewritten to the atlas
	// thumbnail rung. Empty when the post has no usable media.
	MediaURL string

	// Status is set only for an owner looking at a post the public cannot see —
	// a draft, a hidden post, one still scheduled — so the cloud shows *why* it
	// thins out with revelio off.
	Status string
}

// HierarchyEdge is a parent→child link between two tags.
type HierarchyEdge struct{ Parent, Child int64 }

// MembershipEdge links a post to a tag it carries.
type MembershipEdge struct{ Post, Tag int64 }

// GraphParams is the request scope the /tags force-graph is built for.
type GraphParams struct {
	PublicOnly bool

	// YearFrom/YearTo scope the graph to a timeline range when HasYearRange is
	// set. The caller decides what counts as a usable range: the endpoints
	// differ on it, and a malformed one must widen rather than empty the view.
	YearFrom     int
	YearTo       int
	HasYearRange bool

	// IncludePosts asks for the post shadow-nodes and their membership edges.
	// The atlas opts out — it loads a place's posts on tap instead — and would
	// otherwise be shipped the whole post set up front.
	IncludePosts bool
}

// GraphView is the /tags force-graph: tag nodes, post shadow nodes, hierarchy
// edges and post→tag membership edges.
type GraphView struct {
	Tags           []TagNode
	HierarchyEdges []HierarchyEdge

	// IncludePosts mirrors the request: false means Posts and MembershipEdges
	// were not built, which is different from their being empty.
	IncludePosts    bool
	Posts           []PostNode
	MembershipEdges []MembershipEdge
}

// BuildGraphView composes the /tags force-graph. Anonymous viewers see only
// published posts and visible tags; authenticated users see everything.
//
// With a timeline scope active the graph describes only the posts inside it:
// every tag's count is its in-range count, and a tag left with nothing drops out
// entirely — which is what makes the atlas's markers (and their radii) track the
// timeline. Counts are hierarchical, so a country whose posts hang off its
// cities stays on the map.
//
// It returns ErrNotVisible when no tag-visualization module is available to this
// viewer.
func (b *Builder) BuildGraphView(ctx context.Context, settings map[string]string, p GraphParams) (*GraphView, error) {
	// One payload, two consumers: the force graph on /tags and the atlas on
	// /map, so either plugin being enabled opens this endpoint.
	if !TagVizAccessible(settings, []string{"tags-atlas", "tags-graph"}, p.PublicOnly) {
		return nil, ErrNotVisible
	}

	g, err := b.tags.GetTagSnapshot(ctx)
	if err != nil {
		return nil, err
	}

	var scopedCounts map[int64]int64 // nil = no timeline scope
	if p.HasYearRange {
		scopedCounts, err = b.repo.GetHierarchicalPostCountsInYearRange(ctx, p.PublicOnly, p.YearFrom, p.YearTo)
		if err != nil {
			return nil, err
		}
	}

	// Tags this payload omits: hidden from public viewers (effective-hidden or
	// below the min post count), and — for every viewer — those the active
	// timeline scope leaves empty.
	excluded := map[int64]bool{}
	if p.PublicOnly {
		excluded = g.PublicHiddenTagIDs(MinTagPostsSetting(settings))
	}
	if scopedCounts != nil {
		for id := range g.ByID {
			if scopedCounts[id] == 0 {
				excluded[id] = true
			}
		}
	}

	view := &GraphView{
		Tags:         make([]TagNode, 0, len(g.ByID)),
		IncludePosts: p.IncludePosts,
	}

	for id, t := range g.ByID {
		if excluded[id] {
			continue
		}
		node := TagNode{
			ID:        id,
			Name:      t.Name,
			Slug:      t.Slug,
			Kind:      t.Kind,
			Latitude:  floatPtr(t.Latitude),
			Longitude: floatPtr(t.Longitude),
			IsHidden:  !p.PublicOnly && g.EffectiveHidden[id],
		}
		switch {
		case scopedCounts != nil:
			node.PostCount = scopedCounts[id]
		case p.PublicOnly:
			node.PostCount = g.CountsPublic[id]
		default:
			node.PostCount = g.CountsAdmin[id]
		}
		view.Tags = append(view.Tags, node)
	}

	// Hierarchy edges, skipping any edge that touches an omitted tag.
	rels, err := b.tags.GetAllTagRelationships(ctx)
	if err != nil {
		return nil, err
	}
	view.HierarchyEdges = make([]HierarchyEdge, 0, len(rels))
	for _, rel := range rels {
		if excluded[rel.ParentID] || excluded[rel.ChildID] {
			continue
		}
		view.HierarchyEdges = append(view.HierarchyEdges, HierarchyEdge{Parent: rel.ParentID, Child: rel.ChildID})
	}

	if !p.IncludePosts {
		return view, nil
	}

	postNodes, err := b.repo.ListPostNodesForGraph(ctx, p.PublicOnly)
	if err != nil {
		return nil, err
	}
	postIDs := make([]int64, len(postNodes))
	for i, n := range postNodes {
		postIDs[i] = n.ID
	}
	tagsByPost, err := b.tags.GetTagsByPostIDs(ctx, postIDs)
	if err != nil {
		return nil, err
	}

	gen := b.media.ThumbnailGeneration(ctx)
	view.Posts = make([]PostNode, 0, len(postNodes))
	view.MembershipEdges = make([]MembershipEdge, 0)
	for _, n := range postNodes {
		// A timeline scope covers a post when it carries a year tag inside the
		// range — the same rule the scoped counts above are built from. Read off
		// the tags already loaded rather than re-querying.
		if scopedCounts != nil && !postInYearRange(tagsByPost[n.ID], p.YearFrom, p.YearTo) {
			continue
		}
		edges := 0
		for _, pt := range tagsByPost[n.ID] {
			if excluded[pt.ID] {
				continue
			}
			view.MembershipEdges = append(view.MembershipEdges, MembershipEdge{Post: n.ID, Tag: pt.ID})
			edges++
		}
		// Drop posts that connect to no visible tag (orphans under hidden tags).
		if edges == 0 {
			continue
		}
		node := PostNode{ID: n.ID, Slug: n.Slug, Title: n.Title}
		if u := ExtractMediaURL(n.ThumbnailPath, n.Content); u != nil {
			node.MediaURL = atlasThumbURL(*u, gen)
		}
		view.Posts = append(view.Posts, node)
	}

	return view, nil
}

// postInYearRange reports whether a post's tags place it inside a timeline
// range: it must carry a year tag (kind='year', slug the bare year) that falls
// within [from, to]. A post with no year tag at all is outside every range.
func postInYearRange(tags []repository.PostTagInfo, from, to int) bool {
	for _, t := range tags {
		if t.Kind != "year" {
			continue
		}
		if y, err := strconv.Atoi(t.Slug); err == nil && y >= from && y <= to {
			return true
		}
	}
	return false
}
