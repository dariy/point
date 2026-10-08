package pageview

import (
	"context"
	"strings"

	"point-api/internal/repository"
	"point-api/internal/services"
)

// MapParams is the request scope the /map page is built for.
type MapParams struct {
	PublicOnly bool

	YearFrom     int
	YearTo       int
	HasYearRange bool
}

// MapView is every tag with coordinates, categorised for the public /map page.
type MapView struct {
	Places []MapPlace
}

// MapPlace is one marker: a tag that has coordinates.
type MapPlace struct {
	Name      string
	Slug      string
	PostCount int64
	Latitude  float64
	Longitude float64

	// Type is "country", "city" or "other", derived from where the tag sits
	// under the site's own country/city category tags.
	Type string

	// Years are the year tags the place's posts carry, so the timeline can
	// filter markers without another round trip.
	Years []repository.PostTagInfo

	// IsHidden and HiddenVia are owner-only: which markers are hidden, and the
	// ancestor responsible when the hiding was inherited. HiddenVia is nil when
	// the tag is hidden in its own right.
	IsHidden  bool
	HiddenVia *int64
}

// BuildMapView composes the /map page. It returns ErrNotVisible when the map
// module is unavailable to this viewer.
func (b *Builder) BuildMapView(ctx context.Context, settings map[string]string, p MapParams) (*MapView, error) {
	g, err := b.tags.GetTagSnapshot(ctx)
	if err != nil {
		return nil, err
	}
	if !TagVizAccessible(settings, []string{"tags-map"}, p.PublicOnly) {
		return nil, ErrNotVisible
	}

	// With a timeline scope active, only the places it leaves non-empty appear,
	// and each carries its in-range count.
	var scopedCounts map[int64]int64 // nil = no timeline scope
	if p.HasYearRange {
		rangeResults, _ := b.repo.ListMapTagsForYearRange(ctx, p.YearFrom, p.YearTo)
		scopedCounts = make(map[int64]int64, len(rangeResults))
		for _, r := range rangeResults {
			scopedCounts[r.TagID] = r.PostCount
		}
	}

	var minPosts int64
	if p.PublicOnly {
		minPosts = MinTagPostsSetting(settings)
	}

	countries, cities := categoryDescendants(g)

	tagIDs := make([]int64, 0, len(g.ByID))
	for id := range g.ByID {
		tagIDs = append(tagIDs, id)
	}
	locMap, _ := b.tags.GetTagLocationsByTagIDs(ctx, tagIDs)
	yearMap, _ := b.repo.GetYearTagsByLocationTagIDs(ctx, tagIDs)

	view := &MapView{Places: []MapPlace{}}
	for id, t := range g.ByID {
		if p.PublicOnly && g.EffectiveHidden[id] {
			continue
		}
		if p.PublicOnly && minPosts > 0 && g.CountsPublic[id] < minPosts {
			continue
		}
		loc, ok := locMap[id]
		if !ok {
			continue
		}
		if scopedCounts != nil {
			if _, inRange := scopedCounts[id]; !inRange {
				continue
			}
		}

		place := MapPlace{
			Name:      t.Name,
			Slug:      t.Slug,
			Latitude:  loc.Latitude,
			Longitude: loc.Longitude,
			Type:      "other",
			Years:     yearMap[id],
		}
		if place.Years == nil {
			place.Years = []repository.PostTagInfo{}
		}
		switch {
		case cities[id]:
			place.Type = "city"
		case countries[id]:
			place.Type = "country"
		}
		switch {
		case scopedCounts != nil:
			place.PostCount = scopedCounts[id]
		case p.PublicOnly:
			place.PostCount = g.CountsPublic[id]
		default:
			place.PostCount = g.CountsAdmin[id]
		}
		if !p.PublicOnly {
			place.IsHidden = g.EffectiveHidden[id]
			if via, ok := g.HiddenVia[id]; ok {
				place.HiddenVia = &via
			}
		}
		view.Places = append(view.Places, place)
	}

	return view, nil
}

// categoryDescendants finds the tags sitting under the site's own "country" /
// "city" category tags, which is how a place's type is decided: the taxonomy is
// the author's, not a fixed list, so the categories are located by name and
// everything below them inherits the type.
func categoryDescendants(g *services.TagGraph) (countries, cities map[int64]bool) {
	countries = make(map[int64]bool)
	cities = make(map[int64]bool)

	descend := func(root int64, into map[int64]bool) {
		queue := []int64{root}
		for len(queue) > 0 {
			cur := queue[0]
			queue = queue[1:]
			for _, cid := range g.Children[cur] {
				if !into[cid] {
					into[cid] = true
					queue = append(queue, cid)
				}
			}
		}
	}

	for id, t := range g.ByID {
		switch strings.ToLower(t.Name) {
		case "country", "countries":
			descend(id, countries)
		case "city", "cities":
			descend(id, cities)
		}
	}
	return countries, cities
}
