package api

import "point-api/internal/repository"

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
