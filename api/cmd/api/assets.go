package main

// The built frontend as the server sees it: where the JS bundle lives, how a
// CSS bundle's content-addressed URL maps back to a file on disk, and the two
// pieces of markup the HTML shell is stamped with at serve time (the plugin
// manifest, the PWA site name).

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"point-api/internal/plugins"
	"point-api/internal/services"
)

// immutableCacheControl is the header for content-addressed URLs: the name
// embeds a hash of the bytes, so the bytes at that URL can never change and a
// revalidation round-trip is pure waste. A year is the practical maximum
// browsers honour.
const immutableCacheControl = "public, max-age=31536000, immutable"

// pluginManifestScript renders the enabled-only plugin manifest as an inline
// <script> assigning window.__PLUGINS__. The manifest is computed per request
// because enabled-state can change at runtime; chunks is the static build map.
// json.Marshal HTML-escapes <, > and & by default, so the payload is safe to
// embed inline. Disabled plugins are absent from the result entirely.
func pluginManifestScript(ctx context.Context, settings *services.SettingsService, chunks map[string]string, cssMap map[string]bool) (string, string) {
	// Snapshot, not GetAllSettings: this runs on every HTML serve and
	// BuildManifest only reads the map.
	all, err := settings.Snapshot(ctx)
	if err != nil {
		all = map[string]string{}
	}
	b, err := json.Marshal(plugins.BuildManifest(all, chunks, cssMap))
	if err != nil {
		b = []byte("[]")
	}
	scriptContent := "window.__PLUGINS__=" + string(b) + ";"
	hash := sha256.Sum256([]byte(scriptContent))
	hashBase64 := base64.StdEncoding.EncodeToString(hash[:])
	return "\n  <script>" + scriptContent + "</script>", hashBase64
}

// inlineScriptRe matches attribute-less inline <script> blocks in index.html.
// Scripts with attributes (src=, type=module) load external files and are
// covered by CSP 'self'.
var inlineScriptRe = regexp.MustCompile(`(?s)<script>(.*?)</script>`)

// inlineScriptHashes returns CSP 'sha256-…' source tokens for every inline
// <script> in the file, so the script-src policy always matches the shell that
// is actually served — no hardcoded hash to keep in sync with index.html by
// hand. Computed once at startup: index.html only changes at build/deploy time
// (the __BUILD_VERSION__ stamp rewrites URLs, not inline script bodies).
func inlineScriptHashes(path string) []string {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var out []string
	for _, m := range inlineScriptRe.FindAllSubmatch(b, -1) {
		h := sha256.Sum256(m[1])
		out = append(out, "'sha256-"+base64.StdEncoding.EncodeToString(h[:])+"'")
	}
	return out
}

// resolveJSDir returns the directory to serve under /assets/js.
// It prefers the pre-built bundle directory (frontend/js/) over the raw
// source directory (frontend/src/), enabling zero-config dev/prod switching.
func resolveJSDir(frontendDir string, debug bool) string {
	// When FRONTEND_DEBUG is on, prefer the debug bundle (frontend/js-debug) if
	// it was built — it carries plugin/console debug logging. Falls through to
	// the normal resolution otherwise, so a missing debug bundle is harmless.
	if debug {
		debugDir := filepath.Join(frontendDir, "js-debug")
		if fi, err := os.Stat(debugDir); err == nil && fi.IsDir() {
			return debugDir
		}
	}
	jsDir := filepath.Join(frontendDir, "js")
	if _, err := os.Stat(jsDir); err == nil {
		return jsDir
	}
	srcDir := filepath.Join(frontendDir, "src")
	if fi, err := os.Stat(srcDir); err == nil && fi.IsDir() {
		return srcDir
	}
	return ""
}

// siteNameFromHost turns a request Host into the name an installed PWA shows
// under its icon: "www.Example.Com:8001" → "example.com". Returns "" when the
// host is unusable, in which case the manifest's own name is kept.
func siteNameFromHost(host string) string {
	h := strings.ToLower(strings.TrimSpace(host))
	if hostOnly, _, err := net.SplitHostPort(h); err == nil {
		h = hostOnly
	}
	h = strings.Trim(h, ".")
	h = strings.TrimPrefix(h, "www.")
	if h == "" || strings.ContainsAny(h, "/ ") {
		return ""
	}
	return h
}

// cssBundleRe matches a content-addressed CSS bundle URL — "light.81e2e81c.css"
// → base "light.css", hash "81e2e81c". The hash exists only in the URL; one
// bundle is written to disk under its plain name, and the server maps back.
var cssBundleRe = regexp.MustCompile(`^([a-zA-Z0-9_-]+)\.([0-9a-f]{8})\.css$`)

// stripCSSBundleHash turns a hashed bundle filename back into the on-disk name,
// reporting whether the name was hashed at all.
func stripCSSBundleHash(name string) (string, bool) {
	m := cssBundleRe.FindStringSubmatch(name)
	if m == nil {
		return name, false
	}
	return m[1] + ".css", true
}

// loadCSSManifest reads the content hashes scripts/build-css.sh records for the
// CSS bundles, mapping "light.css" → "light.81e2e81c.css". An absent or
// unreadable manifest yields nil, and the shell falls back to the plain
// ?v=<build version> URLs — a missing manifest must never mean no stylesheet.
func loadCSSManifest(cssDir string) map[string]string {
	b, err := os.ReadFile(filepath.Join(cssDir, "asset-manifest.json"))
	if err != nil {
		return nil
	}
	var hashes map[string]string
	if err := json.Unmarshal(b, &hashes); err != nil {
		slog.Warn("css asset manifest is unreadable; falling back to versioned URLs", "error", err)
		return nil
	}
	out := make(map[string]string, len(hashes))
	for name, hash := range hashes {
		base, ok := strings.CutSuffix(name, ".css")
		if !ok || !regexp.MustCompile(`^[0-9a-f]{8}$`).MatchString(hash) {
			continue
		}
		out[name] = base + "." + hash + ".css"
	}
	return out
}
