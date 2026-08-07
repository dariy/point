package services

import (
	"strings"
	"time"
)

// DefaultPostTitleFormatKey is the setting holding the pattern used to title a
// post that was saved without one.
const DefaultPostTitleFormatKey = "default_post_title_format"

// DefaultPostTitleFormat is the pattern used when the setting is unset or blank.
const DefaultPostTitleFormat = "YYYY-MM-DD"

// titleDateTokens maps the admin-facing date tokens to Go reference layouts.
// The tokens are the conventional YYYY-MM-DD kind rather than Go's "2006-01-02"
// because the field is edited by blog owners in /light/settings, not by Go
// programmers.
//
// Deliberately no one-letter tokens: they would fire inside ordinary words in
// the literal part of a pattern ("recap" → "rec" + am). The lowercase pairs
// still can ("Session" → "Se" + 05 + "ion"), which is what the [...] escape in
// FormatTitleDate is for.
//
// Order matters: the scanner takes the first token that matches at a position,
// so every token must come before any token that is a prefix of it.
var titleDateTokens = []struct {
	token  string
	layout string
}{
	{"YYYY", "2006"},
	{"YY", "06"},
	{"MMMM", "January"},
	{"MMM", "Jan"},
	{"MM", "01"},
	{"DDDD", "Monday"},
	{"DDD", "Mon"},
	{"DD", "02"},
	{"HH", "15"},
	{"mm", "04"},
	{"ss", "05"},
}

// FormatTitleDate renders t through a token pattern (see titleDateTokens);
// anything that is not a token is copied through literally, and text wrapped in
// square brackets ("[Session] DD.MM") is copied literally even where it looks
// like a token.
//
// Each token is formatted on its own instead of assembling one Go layout
// string, so digits the author typed as literals ("Note 2006", "Day 15") stay
// literal rather than being read back as a year or an hour.
func FormatTitleDate(format string, t time.Time) string {
	var b strings.Builder
	for i := 0; i < len(format); {
		if format[i] == '[' {
			if end := strings.IndexByte(format[i:], ']'); end >= 0 {
				b.WriteString(format[i+1 : i+end])
				i += end + 1
				continue
			}
		}
		matched := false
		for _, tok := range titleDateTokens {
			if strings.HasPrefix(format[i:], tok.token) {
				b.WriteString(t.Format(tok.layout))
				i += len(tok.token)
				matched = true
				break
			}
		}
		if !matched {
			b.WriteByte(format[i])
			i++
		}
	}
	return strings.TrimSpace(b.String())
}
