package pageview

import (
	"context"
	"sort"

	"point-api/internal/models"
)

// DirectoryParams is the request scope the tags directory is built for.
type DirectoryParams struct {
	PublicOnly bool
}

// DirectoryView is the tags directory: every tag the viewer may see, with the
// neighbours and location each entry renders from, sorted by name.
type DirectoryView struct {
	Tags []DirectoryTag

	// ExcludeTagIDs is carried so the serialiser can prune the same tags out of
	// the nested tag references each entry contains.
	ExcludeTagIDs map[int64]bool
}

// DirectoryTag is one entry of the tags directory.
type DirectoryTag struct {
	Tag      models.Tag
	Parents  []models.Tag
	Children []models.Tag
	Location *models.TagLocation

	// PostCount is scoped to the viewer: the public count for an anonymous
	// reader, the full one for the owner.
	PostCount           int64
	EffectiveHidden     bool
	EffectiveHidesPosts bool

	// HiddenVia names the ancestor responsible when hiding was inherited, and is
	// nil when the tag is hidden in its own right. Owner-only.
	HiddenVia *int64
}

// BuildDirectoryView composes the tags directory page.
func (b *Builder) BuildDirectoryView(ctx context.Context, settings map[string]string, p DirectoryParams) (*DirectoryView, error) {
	g, err := b.tags.GetTagSnapshot(ctx)
	if err != nil {
		return nil, err
	}

	// Locations for all tags in one query.
	tagIDs := make([]int64, 0, len(g.ByID))
	for id := range g.ByID {
		tagIDs = append(tagIDs, id)
	}
	locMap, _ := b.tags.GetTagLocationsByTagIDs(ctx, tagIDs)

	excluded := map[int64]bool{}
	if p.PublicOnly {
		excluded = g.PublicHiddenTagIDs(MinTagPostsSetting(settings))
	}

	view := &DirectoryView{Tags: make([]DirectoryTag, 0, len(g.ByID)), ExcludeTagIDs: excluded}
	for id, t := range g.ByID {
		if excluded[id] {
			continue
		}

		parents := make([]models.Tag, 0)
		for _, pid := range g.Parents[id] {
			parents = append(parents, g.ByID[pid])
		}
		children := make([]models.Tag, 0)
		for _, cid := range g.Children[id] {
			if excluded[cid] {
				continue
			}
			children = append(children, g.ByID[cid])
		}

		entry := DirectoryTag{
			Tag:                 t,
			Parents:             parents,
			Children:            children,
			PostCount:           g.CountsAdmin[id],
			EffectiveHidden:     g.EffectiveHidden[id],
			EffectiveHidesPosts: g.EffectiveHidesPosts[id],
		}
		if l, ok := locMap[id]; ok {
			entry.Location = &l
		}
		if p.PublicOnly {
			entry.PostCount = g.CountsPublic[id]
		} else if via, ok := g.HiddenVia[id]; ok {
			entry.HiddenVia = &via
		}
		view.Tags = append(view.Tags, entry)
	}

	// Stable sort by name — the snapshot is a map, so without this the directory
	// would reorder itself on every request.
	sort.Slice(view.Tags, func(i, j int) bool {
		return view.Tags[i].Tag.Name < view.Tags[j].Tag.Name
	})

	return view, nil
}
