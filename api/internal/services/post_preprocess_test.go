package services

import (
	"strings"
	"testing"
)

func TestPreprocessContent_SetextHeaders(t *testing.T) {
	cases := []struct {
		name        string
		input       string
		wantContain string
		wantAbsent  string
	}{
		{
			name:        "setext h1 converted to ATX",
			input:       "My Heading\n===\nContent",
			wantContain: "# My Heading",
			wantAbsent:  "===",
		},
		{
			name:        "setext h2 left untouched by preprocessor (parser handles it)",
			input:       "My Heading\n---\nContent",
			wantContain: "My Heading\n---",
			wantAbsent:  "",
		},
		{
			name:        "standalone --- unchanged",
			input:       "\n---\nNext card",
			wantContain: "---",
			wantAbsent:  "",
		},
		{
			name:        "multiple equals still triggers setext h1 rule",
			input:       "Section\n========\nBody",
			wantContain: "# Section",
			wantAbsent:  "========",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := preprocessContent(tc.input)
			if !strings.Contains(got, tc.wantContain) {
				t.Errorf("preprocessContent(%q) = %q; want to contain %q", tc.input, got, tc.wantContain)
			}
			if tc.wantAbsent != "" && strings.Contains(got, tc.wantAbsent) {
				t.Errorf("preprocessContent(%q) = %q; should not contain %q", tc.input, got, tc.wantAbsent)
			}
		})
	}
}
