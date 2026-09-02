package pageview

import (
	"context"

	"point-api/internal/models"
)

// CloudParams is the request scope an atlas cloud is built for.
type CloudParams struct {
	PublicOnly bool

	// TagID is the place that was tapped; the cloud covers it and its whole
	// sub-tree (country → cities → …).
	TagID int64

	YearFrom     int
	YearTo       int
	HasYearRange bool
}

// CloudView is the on-tap cloud for a single place on the atlas: the place's
// sub-tree's most recent posts and most popular co-occurring tags, plus the
// edges wiring that subset together, so the frontend can render the cloud
// without loading the whole graph.
type CloudView struct {
	Tags            []TagNode
	Posts           []PostNode
	MembershipEdges []MembershipEdge
	HierarchyEdges  []HierarchyEdge
}

// BuildCloudView composes the atlas cloud for one place. Visibility mirrors
// BuildGraphView; it returns ErrNotVisible when the module is unavailable to
// this viewer, or when the place itself is one they may not see.
func (b *Builder) BuildCloudView(ctx context.Context, settings map[string]string, p CloudParams) (*CloudView, error) {
	if !TagVizAccessible(settings, []string{"tags-atlas", "tags-graph"}, p.PublicOnly) {
		return nil, ErrNotVisible
	}

	g, err := b.tags.GetTagSnapshot(ctx)
	if err != nil {
		return nil, err
	}
	if _, ok := g.ByID[p.TagID]; !ok {
		return nil, ErrNotVisible
	}

	minPosts := MinTagPostsSetting(settings)
	excluded := func(id int64) bool {
		if !p.PublicOnly {
			return false
		}
		if g.EffectiveHidden[id] {
			return true
		}
		return minPosts > 0 && g.CountsPublic[id] < minPosts
	}
	if excluded(p.TagID) {
		return nil, ErrNotVisible
	}

	// The place and its whole sub-tree feed the slice.
	subtree := append([]int64{p.TagID}, g.GetDescendantIDs(p.TagID)...)

	// Recent posts: published-only for anonymous viewers, everything for admins
	// (includeDrafts mirrors ListPostNodesForGraph's all-non-deleted behaviour).
	postLimit := AtlasPostLimitSetting(settings)
	var postModels []models.Post
	if p.HasYearRange {
		postModels, err = b.repo.GetPostsByTagIDsInYearRange(ctx, subtree, p.YearFrom, p.YearTo, p.PublicOnly, !p.PublicOnly, false, postLimit, 0)
	} else {
		postModels, err = b.repo.GetPostsByTagIDs(ctx, subtree, p.PublicOnly, !p.PublicOnly, false, postLimit, 0)
	}
	if err != nil {
		return nil, err
	}

	gen := b.media.ThumbnailGeneration(ctx)
	view := &CloudView{
		Posts: make([]PostNode, 0, len(postModels)),
		Tags:  make([]TagNode, 0, AtlasCloudLimit),
	}
	postIDs := make([]int64, 0, len(postModels))
	for _, post := range postModels {
		postIDs = append(postIDs, post.ID)
		node := PostNode{ID: post.ID, Slug: post.Slug, Title: post.Title}
		if u := ExtractMediaURL(post.ThumbnailPath, post.Content); u != nil {
			node.MediaURL = atlasThumbURL(*u, gen)
		}
		if !p.PublicOnly && !IsPubliclyReadableStatus(post.Status) {
			node.Status = post.Status
		}
		view.Posts = append(view.Posts, node)
	}

	// Popular related tags. Over-fetch for anonymous viewers so dropping
	// effective-hidden / below-min tags still leaves a full set of visible ones.
	fetch := int64(AtlasCloudLimit)
	if p.PublicOnly {
		fetch = AtlasCloudLimit * 4
	}
	coTags, err := b.repo.GetTopCoOccurringTagsForTagIDs(ctx, subtree, p.TagID, p.PublicOnly, fetch)
	if err != nil {
		return nil, err
	}
	wired := map[int64]bool{p.TagID: true} // the centre is always part of the wired set
	for _, t := range coTags {
		if len(view.Tags) >= AtlasCloudLimit {
			break
		}
		if excluded(t.ID) {
			continue
		}
		view.Tags = append(view.Tags, TagNode{
			ID:        t.ID,
			Name:      t.Name,
			Slug:      t.Slug,
			Kind:      t.Kind,
			Latitude:  floatPtr(t.Latitude),
			Longitude: floatPtr(t.Longitude),
			IsHidden:  !p.PublicOnly && g.EffectiveHidden[t.ID],
		})
		wired[t.ID] = true
	}

	// Membership edges: each returned post → the returned tags it carries (plus
	// the centre). Derived from the loaded posts only, so the cloud is wired
	// entirely from this payload.
	view.MembershipEdges = make([]MembershipEdge, 0)
	if len(postIDs) > 0 {
		tagsByPost, err := b.tags.GetTagsByPostIDs(ctx, postIDs)
		if err != nil {
			return nil, err
		}
		for _, pid := range postIDs {
			for _, pt := range tagsByPost[pid] {
				if !wired[pt.ID] {
					continue
				}
				view.MembershipEdges = append(view.MembershipEdges, MembershipEdge{Post: pid, Tag: pt.ID})
			}
		}
	}

	// Hierarchy edges among the returned tag set (e.g. centre country → a city
	// chip), so the cloud draws their parent/child links.
	rels, err := b.tags.GetAllTagRelationships(ctx)
	if err != nil {
		return nil, err
	}
	view.HierarchyEdges = make([]HierarchyEdge, 0)
	for _, rel := range rels {
		if wired[rel.ParentID] && wired[rel.ChildID] {
			view.HierarchyEdges = append(view.HierarchyEdges, HierarchyEdge{Parent: rel.ParentID, Child: rel.ChildID})
		}
	}

	return view, nil
}
