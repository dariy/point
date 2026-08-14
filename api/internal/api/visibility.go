package api

import (
	"strings"

	"point-api/internal/repository"
)

// isPubliclyReadableStatus reports whether a post in this status may be served
// to an anonymous reader who asks for it by slug or id.
//
// The listing queries already filter by status, but a direct fetch bypasses
// them, so this is the gate that decides what a leaked URL is worth. Anything
// that is not live is withheld: a draft, a post withdrawn to hidden, and a
// scheduled post — which is finished writing and merely waiting for its
// publish time, and would otherwise be readable by anyone who guessed the slug
// before it went out.
func isPubliclyReadableStatus(status string) bool {
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
