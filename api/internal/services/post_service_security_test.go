package services

import (
	"strings"
	"testing"
)

// containsStr reports whether slice contains s exactly. Defined here (untagged)
// so both the default and `integration` builds see a single definition.
func containsStr(slice []string, s string) bool {
	for _, v := range slice {
		if v == s {
			return true
		}
	}
	return false
}

// TestRenderContent_URLSchemes verifies the sanitizer strips dangerous URL
// schemes on anchors while preserving legitimate http(s), mailto, and relative
// (bare media) links.
func TestRenderContent_URLSchemes(t *testing.T) {
	svc := NewPostService(nil, nil, nil, nil, "")

	stripped := []struct {
		name    string
		content string
		scheme  string
	}{
		{"javascript", `<a href="javascript:alert(1)">x</a>`, "javascript:"},
		{"data:text/html", `<a href="data:text/html,<script>alert(1)</script>">x</a>`, "data:text/html"},
		{"vbscript", `<a href="vbscript:msgbox(1)">x</a>`, "vbscript:"},
	}
	for _, tc := range stripped {
		t.Run("strips_"+tc.name, func(t *testing.T) {
			out, err := svc.RenderContent(tc.content)
			if err != nil {
				t.Fatalf("RenderContent: %v", err)
			}
			if strings.Contains(strings.ToLower(out), tc.scheme) {
				t.Errorf("expected %q scheme stripped, got: %s", tc.scheme, out)
			}
		})
	}

	survives := []struct {
		name    string
		content string
		want    string
	}{
		{"https", `<a href="https://example.com/page">x</a>`, "https://example.com/page"},
		{"http", `<a href="http://example.com">x</a>`, "http://example.com"},
		{"mailto", `<a href="mailto:me@example.com">x</a>`, "mailto:me@example.com"},
		{"relative_link", `<a href="/about">x</a>`, `href="/about"`},
	}
	for _, tc := range survives {
		t.Run("keeps_"+tc.name, func(t *testing.T) {
			out, err := svc.RenderContent(tc.content)
			if err != nil {
				t.Fatalf("RenderContent: %v", err)
			}
			if !strings.Contains(out, tc.want) {
				t.Errorf("expected %q preserved, got: %s", tc.want, out)
			}
		})
	}
}

// TestRenderContent_RelativeMedia proves bare/relative media paths from the
// markdown preprocessor still render as <img>/<video> with their src intact.
func TestRenderContent_RelativeMedia(t *testing.T) {
	svc := NewPostService(nil, nil, nil, nil, "")

	cases := []struct {
		name    string
		content string
		want    string
	}{
		{"bare_image_path", "/2026/02/photo.jpg", `src="/2026/02/photo.jpg"`},
		{"relative_originals_img", `<img src="originals/2026/02/photo.jpg" alt="x">`, `src="originals/2026/02/photo.jpg"`},
		{"bare_video_path", "/2026/02/clip.mp4", `src="/2026/02/clip.mp4"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out, err := svc.RenderContent(tc.content)
			if err != nil {
				t.Fatalf("RenderContent: %v", err)
			}
			if !strings.Contains(out, tc.want) {
				t.Errorf("expected %q preserved, got: %s", tc.want, out)
			}
		})
	}
}

// TestSanitizePostCSS_BypassNormalization verifies comment-splitting and CSS
// escape sequences can no longer evade the denylist.
func TestSanitizePostCSS_BypassNormalization(t *testing.T) {
	cases := []struct {
		name       string
		css        string
		wantAbsent string
	}{
		{"hex_escaped_import", `\40 import url('evil.css');`, "import"},
		{"escaped_import_char", `\@import url('evil.css');`, "import"},
		{"comment_split_external_url", `.bg { background: url(/**/https://evil.com/x.png); }`, "evil.com"},
		{"comment_split_import", `@im/**/port url('evil.css');`, "port url"},
		{"hex_escaped_url", `.bg { background: \75 rl(https://evil.com/x.png); }`, "evil.com"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out, _ := SanitizePostCSS(tc.css)
			if strings.Contains(strings.ToLower(out), tc.wantAbsent) {
				t.Errorf("bypass not caught: %q still present in %q", tc.wantAbsent, out)
			}
		})
	}

	// Legit CSS survives normalization intact.
	out, stripped := SanitizePostCSS(".post { color: red; margin: 10px; }")
	if !strings.Contains(out, "color: red") || !strings.Contains(out, "margin: 10px") {
		t.Errorf("legit CSS altered: %q", out)
	}
	if len(stripped) != 0 {
		t.Errorf("legit CSS reported strips: %v", stripped)
	}
}

// TestSanitizePostCSS_ParserAccuracy verifies the tokenizer-based sanitizer
// keeps properties that merely contain a dangerous substring (the regex
// denylist mangled these — see point-9wxc) while still dropping the real ones.
func TestSanitizePostCSS_ParserAccuracy(t *testing.T) {
	t.Run("justify/align/place-content survive", func(t *testing.T) {
		css := `.row { display: flex; justify-content: center; align-content: start; place-content: end; }`
		out, stripped := SanitizePostCSS(css)
		if len(stripped) != 0 {
			t.Errorf("expected nothing stripped, got %v", stripped)
		}
		for _, want := range []string{"justify-content: center", "align-content: start", "place-content: end"} {
			if !strings.Contains(out, want) {
				t.Errorf("expected %q preserved, got %q", want, out)
			}
		}
	})

	t.Run("standalone content dropped, siblings kept", func(t *testing.T) {
		out, stripped := SanitizePostCSS(`.x::before { content: "hi"; color: red; }`)
		if !containsStr(stripped, "content") {
			t.Errorf("expected content stripped, got %v", stripped)
		}
		if strings.Contains(out, `"hi"`) {
			t.Errorf("expected content value gone, got %q", out)
		}
		if !strings.Contains(out, "color: red") {
			t.Errorf("expected sibling declaration kept, got %q", out)
		}
	})

	t.Run("position absolute/relative kept", func(t *testing.T) {
		out, stripped := SanitizePostCSS(`.a { position: absolute; } .b { position: relative; }`)
		if len(stripped) != 0 {
			t.Errorf("expected nothing stripped, got %v", stripped)
		}
		if !strings.Contains(out, "position: absolute") || !strings.Contains(out, "position: relative") {
			t.Errorf("expected non-fixed positions kept, got %q", out)
		}
	})

	t.Run("internal url and data uri kept", func(t *testing.T) {
		css := `.a { background: url(/2026/02/p.jpg); } .b { background: url('data:image/png;base64,AAAA'); }`
		out, stripped := SanitizePostCSS(css)
		if len(stripped) != 0 {
			t.Errorf("expected nothing stripped for internal/data urls, got %v", stripped)
		}
		if !strings.Contains(out, "/2026/02/p.jpg") || !strings.Contains(out, "data:image/png") {
			t.Errorf("expected internal/data urls kept, got %q", out)
		}
	})

	t.Run("style breakout via < dropped", func(t *testing.T) {
		out, stripped := SanitizePostCSS(`.a { color: red; } </style><script>alert(1)</script>`)
		if !containsStr(stripped, "<script>") {
			t.Errorf("expected <script> recorded, got %v", stripped)
		}
		if strings.Contains(out, "<") {
			t.Errorf("expected all '<' removed, got %q", out)
		}
	})
}
