package utils

import (
	"regexp"
	"strings"

	"github.com/mozillazg/go-unidecode"
)

var (
	regexpNonAlphanumeric = regexp.MustCompile("[^a-z0-9-_]")
	regexpHyphens         = regexp.MustCompile("-+")
	regexpSpaces          = regexp.MustCompile(`\s+`)
)

func Slugify(text string) string {
	if text == "" {
		return ""
	}

	// Transliterate to ASCII
	text = unidecode.Unidecode(text)

	// Convert to lowercase
	text = strings.ToLower(text)

	// Replace spaces with hyphens
	text = regexpSpaces.ReplaceAllString(text, "-")

	// Remove non-alphanumeric characters except hyphens and underscores
	text = regexpNonAlphanumeric.ReplaceAllString(text, "")

	// Remove multiple consecutive hyphens
	text = regexpHyphens.ReplaceAllString(text, "-")

	// Remove leading/trailing hyphens
	text = strings.Trim(text, "-")

	// Truncate to 200 chars (simplified compared to Python version's word-aware cut)
	if len(text) > 200 {
		text = text[:200]
		text = strings.TrimRight(text, "-")
	}

	return text
}
