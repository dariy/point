package utils

import (
	"regexp"
	"strings"
)

var (
	// videoTagRe extracts src from <video>/<source> tags.
	// [^>]* (zero-or-more) matches even when src is the first attribute.
	videoTagRe = regexp.MustCompile(`(?i)<(?:video|source)[^>]*\ssrc="([^"]+)"`)

	// markdownImageRe matches standard markdown image syntax ![alt](url).
	markdownImageRe = regexp.MustCompile(`!\[.*\]\(([^)]+)\)`)

	// bareMediaRe matches a line containing only a media file path or URL.
	bareMediaRe = regexp.MustCompile(`(?im)^[ \t]*((?:https?://|/)\S+\.(?:mp4|webm|mov|ogv|m4v|avi|mkv|mp3|m4a|ogg|wav|flac|aac|opus|jpg|jpeg|png|gif|webp|svg))[ \t]*$`)
)

// DeriveMediaURL returns a single normalized preview URL for list responses:
// the thumbnail path if set, else the first markdown image URL, else the first
// <video>/<source> src, else the first bare media path found in the content.
// It returns "" when nothing matches. The result is normalized the same way the
// stored posts.media_url column is, so callers can use either interchangeably.
func DeriveMediaURL(thumbnailPath, content string) string {
	var rawURL string
	switch {
	case thumbnailPath != "":
		rawURL = thumbnailPath
	case mustMatch(markdownImageRe, content) != "":
		rawURL = mustMatch(markdownImageRe, content)
	case mustMatch(videoTagRe, content) != "":
		rawURL = mustMatch(videoTagRe, content)
	case mustMatch(bareMediaRe, content) != "":
		rawURL = mustMatch(bareMediaRe, content)
	default:
		return ""
	}

	// Normalize: strip /media/originals/ or originals/ to return the simplified path.
	normalized := rawURL
	normalized = strings.TrimPrefix(normalized, "/media/originals/")
	normalized = strings.TrimPrefix(normalized, "originals/")
	if !strings.HasPrefix(normalized, "http") && !strings.HasPrefix(normalized, "/") {
		normalized = "/" + normalized
	}
	return normalized
}

func mustMatch(re *regexp.Regexp, s string) string {
	if m := re.FindStringSubmatch(s); m != nil {
		return m[1]
	}
	return ""
}
