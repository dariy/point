//go:build integration

package services

import (
	"strings"
	"testing"
)

func TestPostService_Sanitization(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()

	tests := []struct {
		name    string
		content string
		want    []string
		notWant []string
	}{
		{
			name:    "Allowed div and class",
			content: `<div class="test">Safe HTML</div>`,
			want:    []string{`<div class="test">Safe HTML</div>`},
		},
		{
			name:    "Blocked script",
			content: `<script>alert('xss')</script>Safe Content`,
			want:    []string{`Safe Content`},
			notWant: []string{`<script>`, `alert`},
		},
		{
			name:    "Blocked onclick",
			content: `<div onclick="alert('xss')">Click Me</div>`,
			want:    []string{`<div>Click Me</div>`},
			notWant: []string{`onclick`},
		},
		{
			name:    "Allowed SVG",
			content: `<svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26"/></svg>`,
			want:    []string{`<svg`, `viewbox="0 0 24 24"`, `<path`, `d="M12 2l3.09 6.26"`},
		},
		{
			name:    "Allowed complex layout",
			content: `<header class="hero"><div class="hero-eyebrow">MIT License</div><h1 class="hero-h1">Title <em>Emphasis</em></h1></header>`,
			want:    []string{`<header class="hero">`, `<div class="hero-eyebrow">`, `<h1 class="hero-h1">`, `<em>Emphasis</em>`},
		},
		{
			name:    "Goldmark Attributes",
			content: "Paragraph\n{.hero-p}",
			want:    []string{`<p class="hero-p">Paragraph</p>`},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := svc.RenderContent(tt.content)
			if err != nil {
				t.Fatalf("RenderContent failed: %v", err)
			}

			for _, w := range tt.want {
				if !strings.Contains(strings.ToLower(got), strings.ToLower(w)) {
					t.Errorf("expected rendered content to contain %q, got %q", w, got)
				}
			}
			for _, nw := range tt.notWant {
				if strings.Contains(strings.ToLower(got), strings.ToLower(nw)) {
					t.Errorf("expected rendered content NOT to contain %q, got %q", nw, got)
				}
			}
		})
	}
}
