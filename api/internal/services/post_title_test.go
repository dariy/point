package services

import (
	"testing"
	"time"
)

func TestFormatTitleDate(t *testing.T) {
	// Sunday, 8 March 2026, 09:07:05 — a single-digit month/day/hour, so
	// zero-padding is exercised, and a PM/AM boundary is one step away.
	ref := time.Date(2026, 3, 8, 9, 7, 5, 0, time.UTC)

	tests := []struct {
		name   string
		format string
		want   string
	}{
		{"default", DefaultPostTitleFormat, "2026-03-08"},
		{"short year", "YY/MM/DD", "26/03/08"},
		{"month names", "DD MMMM YYYY", "08 March 2026"},
		{"abbreviated", "DDD, MMM DD", "Sun, Mar 08"},
		{"time", "YYYY-MM-DD HH:mm:ss", "2026-03-08 09:07:05"},
		{"literals kept", "Notes from DD.MM.YYYY", "Notes from 08.03.2026"},
		{"digits are not tokens", "2006 recap: YYYY", "2006 recap: 2026"},
		{"no tokens", "Journal", "Journal"},
		{"bracket escape", "[Session] DD.MM", "Session 08.03"},
		{"unclosed bracket is literal", "[Journal", "[Journal"},
		{"surrounding space trimmed", "  YYYY  ", "2026"},
		{"empty", "", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := FormatTitleDate(tt.format, ref); got != tt.want {
				t.Errorf("FormatTitleDate(%q) = %q, want %q", tt.format, got, tt.want)
			}
		})
	}
}
