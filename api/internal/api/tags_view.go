package api

// Response shaping for the tag endpoints.
//
// Every tag payload is filtered and annotated the same way: guests never see
// effectively-hidden tags or tags below the min_tag_posts_to_show threshold,
// counts are public or admin depending on who is asking, and each tag carries
// a "Name — Ancestor / Ancestor · 12" label. That policy used to be copied
// into every handler; it lives here once, in tagView.

import (
	"context"
	"net/http"
	"strconv"

	"point-api/internal/models"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

// tagView pairs a tag graph snapshot with the visibility rules of whoever is
// asking for it. Handlers build one per request and render everything through
// it, so a tag hidden from a guest is hidden the same way in the list, in the
// single-tag payload, and in the parents/children of some other tag.
type tagView struct {
	g          *services.TagGraph
	publicOnly bool
	minPosts   int64
}

// tagView loads the graph snapshot and pairs it with the caller's visibility
// rules. Callers get the mapped HTTP error, so a failed snapshot is one
// `return err` rather than a MapError call at every use site.
func (h *TagHandler) tagView(c echo.Context) (tagView, error) {
	g, err := h.tagService.GetTagSnapshot(c.Request().Context())
	if err != nil {
		return tagView{}, MapError(err)
	}
	publicOnly := c.Get("user") == nil
	return tagView{
		g:          g,
		publicOnly: publicOnly,
		minPosts:   h.minTagPosts(c.Request().Context(), publicOnly),
	}, nil
}

// minTagPosts reads the min_tag_posts_to_show threshold guests are held to.
// Admins see every tag regardless, so for them it is always 0.
func (h *TagHandler) minTagPosts(ctx context.Context, publicOnly bool) int64 {
	if !publicOnly {
		return 0
	}
	raw, _ := h.settingsService.GetSetting(ctx, "min_tag_posts_to_show", "0")
	n, _ := strconv.ParseInt(raw, 10, 64)
	if n < 0 {
		return 0
	}
	return n
}

// hidden reports whether the tag must be withheld from this viewer, either
// because it (or an ancestor) is hidden or because it sits below the guest
// post-count threshold.
func (v tagView) hidden(id int64) bool {
	if !v.publicOnly {
		return false
	}
	return v.g.EffectiveHidden[id] || (v.minPosts > 0 && v.g.CountsPublic[id] < v.minPosts)
}

// count is the post count this viewer is allowed to see.
func (v tagView) count(id int64) int64 {
	if v.publicOnly {
		return v.g.CountsPublic[id]
	}
	return v.g.CountsAdmin[id]
}

// excluded is the set of tag IDs to strip from embedded tag lists — a tag's
// parents and children, a post's own tags. Empty for admins.
func (v tagView) excluded() map[int64]bool {
	if !v.publicOnly {
		return map[int64]bool{}
	}
	return v.g.PublicHiddenTagIDs(v.minPosts)
}

// namePath is the disambiguating label the tag pickers show: the tag's name,
// its ancestor path when it has one, and its post count.
func (v tagView) namePath(t models.Tag) string {
	s := t.Name
	if path := v.g.GetDisplayPath(t.ID); path != "" {
		s += " — " + path
	}
	return s + " · " + strconv.FormatInt(v.count(t.ID), 10)
}

// tagsByID resolves neighbour IDs to their full records.
func (v tagView) tagsByID(ids []int64) []models.Tag {
	out := make([]models.Tag, 0, len(ids))
	for _, id := range ids {
		out = append(out, v.g.ByID[id])
	}
	return out
}

// neighbourStubs renders neighbour IDs as the {id, name, slug} stubs the list
// endpoint embeds — lighter than the full list items fullResponse uses.
func (v tagView) neighbourStubs(ids []int64) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(ids))
	for _, id := range ids {
		t := v.g.ByID[id]
		out = append(out, map[string]interface{}{
			"id":   t.ID,
			"name": t.Name,
			"slug": t.Slug,
		})
	}
	return out
}

// listItem is the per-tag payload of GET /api/tags.
func (v tagView) listItem(t models.Tag, loc *models.TagLocation) map[string]interface{} {
	resp := map[string]interface{}{
		"id":                    t.ID,
		"name":                  t.Name,
		"name_path":             v.namePath(t),
		"slug":                  t.Slug,
		"description":           nullString(t.Description),
		"kind":                  t.Kind,
		"hidden":                t.Hidden,
		"hides_posts":           t.HidesPosts,
		"nav_order":             nullInt64(t.NavOrder),
		"in_breadcrumbs":        t.InBreadcrumbs,
		"show_related":          t.ShowRelated,
		"in_ancestor_flyout":    t.InAncestorFlyout,
		"effective_hidden":      v.g.EffectiveHidden[t.ID],
		"effective_hides_posts": v.g.EffectiveHidesPosts[t.ID],
		"post_count":            v.count(t.ID),
		"parents":               v.neighbourStubs(v.g.Parents[t.ID]),
		"children":              v.neighbourStubs(v.g.Children[t.ID]),
		"locations":             tagLocationsResponse(loc),
	}
	v.annotateHiddenVia(resp, t.ID)
	return resp
}

// fullResponse is the single-tag payload: the whole tag record plus its
// neighbours, its siblings and the graph-derived annotations.
func (v tagView) fullResponse(t models.Tag, loc *models.TagLocation) map[string]interface{} {
	resp := tagToFullResponse(t, v.tagsByID(v.g.Parents[t.ID]), v.tagsByID(v.g.Children[t.ID]), loc, v.excluded())
	resp["effective_hidden"] = v.g.EffectiveHidden[t.ID]
	resp["effective_hides_posts"] = v.g.EffectiveHidesPosts[t.ID]
	resp["post_count"] = v.count(t.ID)
	resp["name_path"] = v.namePath(t)

	all := v.g.GetSiblings(t.ID)
	siblings := make([]map[string]interface{}, 0, len(all))
	for _, s := range all {
		if v.hidden(s.ID) {
			continue
		}
		siblings = append(siblings, tagToListItem(s))
	}
	resp["siblings"] = siblings

	v.annotateHiddenVia(resp, t.ID)
	return resp
}

// annotateHiddenVia names the ancestor a tag inherits its hiding from. It is
// an editor affordance ("hidden because of X"), so guests never get it.
func (v tagView) annotateHiddenVia(resp map[string]interface{}, id int64) {
	if v.publicOnly {
		return
	}
	if via, ok := v.g.HiddenVia[id]; ok {
		resp["hidden_via"] = via
	}
}

// renderTag writes a single-tag payload, fetching its location on the way.
func (h *TagHandler) renderTag(c echo.Context, v tagView, tag models.Tag, status int) error {
	return c.JSON(status, v.fullResponse(tag, h.tagLocation(c, tag.ID)))
}

// renderSavedTag renders a tag through a snapshot taken after the save, so the
// response reflects the relationship and location writes that followed it.
func (h *TagHandler) renderSavedTag(c echo.Context, id int64, status int) error {
	v, err := h.tagView(c)
	if err != nil {
		return err
	}
	tag, ok := v.g.ByID[id]
	if !ok {
		return tagNotFound()
	}
	return h.renderTag(c, v, tag, status)
}

// tagLocation fetches the location for a single tag, returning nil if none.
func (h *TagHandler) tagLocation(c echo.Context, tagID int64) *models.TagLocation {
	locs, err := h.tagService.GetTagLocationsByTagIDs(c.Request().Context(), []int64{tagID})
	if err != nil {
		return nil
	}
	if l, ok := locs[tagID]; ok {
		return &l
	}
	return nil
}

// tagNotFound is the 404 returned both for a tag that does not exist and for
// one the viewer may not see — the two are deliberately indistinguishable.
func tagNotFound() error {
	return echo.NewHTTPError(http.StatusNotFound, "Tag not found")
}

// badTagRequest is the 400 for an unparseable request body.
func badTagRequest() error {
	return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
}
