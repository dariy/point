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

func TestPreprocessContent_Media(t *testing.T) {
	cases := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "image extension",
			input:    "/2026/02/photo.jpg",
			expected: "![photo.jpg](/2026/02/photo.jpg)",
		},
		{
			name:     "video extension",
			input:    "/2026/02/vid.mp4",
			expected: "<video src=\"/2026/02/vid.mp4\" controls></video>",
		},
		{
			name:     "audio extension",
			input:    "/2026/02/song.mp3",
			expected: "<audio src=\"/2026/02/song.mp3\" controls></audio>",
		},
		{
			name:     "unknown extension",
			input:    "/2026/02/doc.pdf",
			expected: "/2026/02/doc.pdf",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := preprocessContent(tc.input)
			if got != tc.expected {
				t.Errorf("preprocessContent(%q) = %q; want %q", tc.input, got, tc.expected)
			}
		})
	}
}

func TestNewPostService(t *testing.T) {
	// Calling NewPostService to ensure it initializes correctly
	// and to cover the parser configuration logic.
	svc := NewPostService(nil, nil, nil, "")
	if svc == nil {
		t.Fatal("NewPostService returned nil")
	}
	if svc.md == nil {
		t.Error("NewPostService did not initialize goldmark")
	}
}
