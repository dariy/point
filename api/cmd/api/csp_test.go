package main

import (
	"crypto/sha256"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// hashToken returns the CSP 'sha256-…' token for a script body, the way the
// browser and buildContentSecurityPolicy both compute it.
func hashToken(body string) string {
	sum := sha256.Sum256([]byte(body))
	return "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
}

// writeShell drops an index.html with the given <head> contents into a temp dir
// and returns its path.
func writeShell(t *testing.T, head string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "index.html")
	if err := os.WriteFile(p, []byte("<html><head>"+head+"</head><body></body></html>"), 0o644); err != nil {
		t.Fatalf("write shell: %v", err)
	}
	return p
}

func TestBuildContentSecurityPolicy_Skeleton(t *testing.T) {
	inline := "window.__BOOT__=1;"
	path := writeShell(t, "<script>"+inline+"</script>")

	got := buildContentSecurityPolicy(path, "", "")
	want := "default-src 'self'; script-src 'self' " + hashToken(inline) +
		"; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://server.arcgisonline.com https://github.com https://*.githubusercontent.com; media-src 'self' blob:; connect-src 'self' https://server.arcgisonline.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; " + trustedTypesCSP
	if got != want {
		t.Errorf("CSP mismatch:\n got: %s\nwant: %s", got, want)
	}
	// The trusted-types tail must be last: the per-request script-src splices
	// string-replace "script-src" and rely on nothing after it moving.
	if !strings.HasSuffix(got, "; "+trustedTypesCSP) {
		t.Errorf("trusted-types tail not last: %s", got)
	}
}

func TestBuildContentSecurityPolicy_MissingShell(t *testing.T) {
	// No readable index.html → no inline hashes, script-src is bare 'self'.
	got := buildContentSecurityPolicy(filepath.Join(t.TempDir(), "absent.html"), "", "")
	if !strings.Contains(got, "script-src 'self'; style-src") {
		t.Errorf("expected bare script-src 'self'; got: %s", got)
	}
}

func TestBuildContentSecurityPolicy_OperatorExtras(t *testing.T) {
	path := writeShell(t, "<script>1;</script>")

	got := buildContentSecurityPolicy(path,
		"https://analytics.example https://cdn.example",
		"https://api.example")

	if !strings.Contains(got, "https://analytics.example https://cdn.example; style-src") {
		t.Errorf("script-src missing operator origins: %s", got)
	}
	if !strings.Contains(got, "connect-src 'self' https://server.arcgisonline.com https://api.example;") {
		t.Errorf("connect-src missing operator origin: %s", got)
	}
}

func TestBuildContentSecurityPolicy_RejectsBreakoutInExtras(t *testing.T) {
	path := writeShell(t, "<script>1;</script>")

	// A token carrying a directive/policy/header-split character is dropped
	// whole before it can be appended.
	got := buildContentSecurityPolicy(path,
		"https://ok.example evil;object-src",
		"bad,default-src")

	if strings.ContainsAny(strings.TrimPrefix(got, "default-src 'self'; "), "\r\n") {
		t.Errorf("CSP carries a raw CR/LF: %q", got)
	}
	if strings.Contains(got, "evil;object-src") || strings.Contains(got, "bad,default-src") {
		t.Errorf("breakout token survived into CSP: %s", got)
	}
	if !strings.Contains(got, "https://ok.example; style-src") {
		t.Errorf("clean token in the same list was lost: %s", got)
	}
}

func TestInlineScriptHashes(t *testing.T) {
	a, b := "one();", "two();"
	path := writeShell(t,
		"<script>"+a+"</script>"+
			`<script src="/app.js"></script>`+
			`<script type="module">ignored();</script>`+
			"<script>"+b+"</script>")

	got := inlineScriptHashes(path)
	want := []string{hashToken(a), hashToken(b)}
	if len(got) != len(want) {
		t.Fatalf("got %d hashes %v, want %d %v", len(got), got, len(want), want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("hash %d: got %s, want %s", i, got[i], want[i])
		}
	}

	if inlineScriptHashes(filepath.Join(t.TempDir(), "nope.html")) != nil {
		t.Error("missing file should yield nil")
	}
}

func TestSanitizeCSPSources(t *testing.T) {
	// Normal inputs pass through, whitespace-normalized.
	exact := []struct{ in, want string }{
		{"", ""},
		{"   ", ""},
		{"https://a.example", "https://a.example"},
		{"https://a.example https://b.example", "https://a.example https://b.example"},
		{"  https://a.example   https://b.example  ", "https://a.example https://b.example"},
		{"https://*.cdn.example", "https://*.cdn.example"},
		{"https://a.example;object-src", ""},   // ';'-fused token dropped whole
		{"https://a.example,https://evil", ""}, // ','-fused token dropped whole
	}
	for _, c := range exact {
		if got := sanitizeCSPSources(c.in); got != c.want {
			t.Errorf("sanitizeCSPSources(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	// A breakout character (new directive ';', new policy ',', header split
	// CR/LF) must never survive into the output, whatever the arrangement.
	for _, in := range []string{
		"https://a; object-src *",
		"https://a, default-src *",
		"https://a.example\r\nX-Injected: 1",
		"a;b,c\r\nd",
	} {
		if got := sanitizeCSPSources(in); strings.ContainsAny(got, ";,\r\n") {
			t.Errorf("sanitizeCSPSources(%q) = %q still contains a breakout char", in, got)
		}
	}
}
