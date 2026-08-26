package pageview

import (
	"context"
	"database/sql"
	"strings"

	"point-api/internal/repository"
	"point-api/internal/services"
	"point-api/internal/utils"
)

// IsPubliclyReadableStatus reports whether a post in this status may be served
// to an anonymous reader who asks for it by slug or id.
//
// The listing queries already filter by status, but a direct fetch bypasses
// them, so this is the gate that decides what a leaked URL is worth. Anything
// that is not live is withheld: a draft, a post withdrawn to hidden, and a
// scheduled post — which is finished writing and merely waiting for its
// publish time, and would otherwise be readable by anyone who guessed the slug
// before it went out.
func IsPubliclyReadableStatus(status string) bool {
	switch strings.ToLower(status) {
	case "draft", "hidden", "scheduled":
		return false
	}
	return true
}

// IsPostVisibleToPublic returns true if none of the post's tags are in the
// effectively-hidden-posts set. Used to filter public post listings.
func IsPostVisibleToPublic(postTags []repository.PostTagInfo, hiddenPostsTagIDs map[int64]bool) bool {
	for _, t := range postTags {
		if hiddenPostsTagIDs[t.ID] {
			return false
		}
	}
	return true
}

// ExpandPostTagsWithAncestors takes a postID→tags map and adds ancestor tags for
// each direct tag, filtering out is_hidden ancestors when publicOnly is true.
// Deduplication is per-post.
func (b *Builder) ExpandPostTagsWithAncestors(
	ctx context.Context,
	postTagsMap map[int64][]repository.PostTagInfo,
	publicOnly bool,
) map[int64][]repository.PostTagInfo {
	g, err := b.tags.GetTagSnapshot(ctx)
	if err != nil {
		return postTagsMap
	}

	result := make(map[int64][]repository.PostTagInfo, len(postTagsMap))
	for postID, tags := range postTagsMap {
		seen := make(map[int64]bool, len(tags)*3)
		expanded := make([]repository.PostTagInfo, 0, len(tags)*2)
		roots := make([]int64, 0, len(tags))

		// Pass 1 — the post's own tags, claimed before any ancestor walk runs.
		// A post tagged with both "botany" and its parent "nature" carries both,
		// and walking up from "botany" first would otherwise reach "nature" and
		// file it as inherited, hiding it from the post's tag strip.
		for _, t := range tags {
			if seen[t.ID] {
				continue
			}
			seen[t.ID] = true
			// A hidden tag contributes nothing — not even its ancestors.
			if publicOnly && g.EffectiveHidden[t.ID] {
				continue
			}
			expanded = append(expanded, t)
			roots = append(roots, t.ID)
		}

		// Pass 2 — ancestors of those tags, BFS in-memory, marked inherited.
		for _, id := range roots {
			queue := []int64{id}
			for len(queue) > 0 {
				cur := queue[0]
				queue = queue[1:]

				for _, pid := range g.Parents[cur] {
					if seen[pid] {
						continue
					}
					seen[pid] = true
					if publicOnly && g.EffectiveHidden[pid] {
						continue
					}
					p := g.ByID[pid]
					expanded = append(expanded, repository.PostTagInfo{
						ID:        p.ID,
						Name:      p.Name,
						Slug:      p.Slug,
						Inherited: true,
					})
					queue = append(queue, pid)
				}
			}
		}
		result[postID] = expanded
	}
	return result
}

// ExtractMediaURL returns a single preview URL for list responses:
// thumbnail path if set, else first markdown image URL, else first video/audio
// src from a <video>/<source> tag in the content, else first bare media path
// found in the content.
func ExtractMediaURL(thumbPath sql.NullString, content string) *string {
	var tp string
	if thumbPath.Valid {
		tp = thumbPath.String
	}
	if u := utils.DeriveMediaURL(tp, content); u != "" {
		return &u
	}
	return nil
}

// atlasThumbURL rewrites a preview media URL to request the ladder rung the
// atlas cloud chips display. Local media paths get `?s=N&v=<generation>`,
// replacing any existing query (e.g. a post whose thumbnail_path still carries
// `?thumb`); external URLs are returned unchanged since the server can't resize
// media it doesn't host.
func atlasThumbURL(u, gen string) string {
	if strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://") {
		return u
	}
	return services.VariantURL(u, services.AtlasVariantSize, gen)
}

// floatPtr turns a nullable coordinate into the optional field a view carries.
func floatPtr(f sql.NullFloat64) *float64 {
	if !f.Valid {
		return nil
	}
	v := f.Float64
	return &v
}
