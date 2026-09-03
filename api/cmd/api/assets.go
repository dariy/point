package main

// The built frontend as the server sees it: where the JS bundle lives, how a
// CSS bundle's content-addressed URL maps back to a file on disk, and the two
// pieces of markup the HTML shell is stamped with at serve time (the bootstrap
// script, the PWA site name).

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

	"point-api/internal/config"
	"point-api/internal/plugins"
	"point-api/internal/services"
)

// immutableCacheControl is the header for content-addressed URLs: the name
// embeds a hash of the bytes, so the bytes at that URL can never change and a
// revalidation round-trip is pure waste. A year is the practical maximum
// browsers honour.
const immutableCacheControl = "public, max-age=31536000, immutable"

// mediaBootstrap is the window.__MEDIA__ payload: everything a client needs to
// build a variant URL for itself. Gen is the cache-busting token a rebuild
// rolls; Sizes is the ladder, so the frontend picks rungs from the server's
// list rather than from a copy that can drift out of sync with it.
type mediaBootstrap struct {
	Gen   string `json:"gen"`
	Sizes []int  `json:"sizes"`
}

// bootstrapScript renders the inline <script> every HTML document carries,
// along with the base64 sha256 of its body for the CSP script-src splice.
//
// It assigns window.__PLUGINS__ (the enabled-only plugin manifest, computed per
// request because enabled-state changes at runtime; chunks is the static build
// map) and window.__MEDIA__ in ONE body. One body means one hash, which is what
// lets all three injection sites and both CSP splices stay as they are.
//
// json.Marshal HTML-escapes <, > and & by default, so both payloads are safe to
// embed inline. Disabled plugins are absent from the result entirely.
func bootstrapScript(ctx context.Context, settings *services.SettingsService, chunks map[string]string, cssMap map[string]bool) (string, string) {
	// Snapshot, not GetAllSettings: this runs on every HTML serve, and both
	// BuildManifest and the generation token only read the map.
	all, err := settings.Snapshot(ctx)
	if err != nil {
		all = map[string]string{}
	}
	b, err := json.Marshal(plugins.BuildManifest(all, chunks, cssMap))
	if err != nil {
		b = []byte("[]")
	}
	m, err := json.Marshal(mediaBootstrap{
		Gen:   services.ThumbnailGenerationFrom(all),
		Sizes: services.VariantSizes,
	})
	if err != nil {
		m = []byte("{}")
	}
	scriptContent := "window.__PLUGINS__=" + string(b) + ";window.__MEDIA__=" + string(m) + ";"
	hash := sha256.Sum256([]byte(scriptContent))
	hashBase64 := base64.StdEncoding.EncodeToString(hash[:])
	return "\n  <script>" + scriptContent + "</script>", hashBase64
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

// loadHTMLShells reads index.html once at startup and returns the two shells the
// SPA routes serve: the public one carries the deployment-supplied <head> markup
// (analytics/verification tags), the admin one omits it so the injected
// third-party script never loads in the authenticated /light context — a smaller
// XSS blast radius, and it keeps admin traffic out of analytics.
//
// The build version is substituted here, at serve time, instead of mutating the
// file on disk (the old sed/skip-worktree dance in run.sh + Dockerfile):
// index.html stays on disk pristine with the literal __BUILD_VERSION__
// placeholder and is a normally tracked file. Both shells are "" when the
// frontend isn't built — the SPA routes fall back to a 503.
func loadHTMLShells(cfg config.Config, cssManifest map[string]string) (shell, adminShell string) {
	b, err := os.ReadFile(filepath.Join(cfg.FrontendDir, "index.html"))
	if err != nil {
		return "", ""
	}
	base := strings.ReplaceAll(string(b), "__BUILD_VERSION__", cfg.AppVersion)
	// Rewrite the CSS bundle links to their content-addressed URLs so an
	// unchanged bundle keeps the same URL across deploys and can be cached
	// forever. Without a manifest the ?v=<build version> links stay, which
	// still busts correctly on deploy — just on every deploy.
	for name, hashed := range cssManifest {
		base = strings.ReplaceAll(base,
			"/assets/css/"+name+"?v="+cfg.AppVersion,
			"/assets/css/"+hashed)
	}
	// Public shell. Note: an inline <script> injected via HEAD_HTML is NOT
	// covered by the CSP script-src hashes (those are computed from the on-disk
	// shell), so deployments should inject external scripts and allow-list their
	// origin via CSP_SCRIPT_SRC.
	shell = strings.Replace(base, "<!-- __HEAD_HTML__ -->", cfg.HeadHTML, 1)
	// Admin shell — placeholder dropped, no third-party markup.
	adminShell = strings.Replace(base, "<!-- __HEAD_HTML__ -->", "", 1)
	return shell, adminShell
}

// newFrontendAssets bundles everything the frontend routes need: the frontend
// directory, the resolved JS bundle directory, the two HTML shells, and the
// static plugin chunk/CSS maps.
//
// The JS bundle directory is resolved once — the release bundle (frontend/js),
// or the debug bundle (frontend/js-debug) when FRONTEND_DEBUG is set and built.
// The chunk map MUST come from the same directory we serve so plugin chunk
// hashes match the bundle the browser loads.
func newFrontendAssets(cfg config.Config, shell, adminShell string) frontendAssets {
	jsDir := resolveJSDir(cfg.FrontendDir, cfg.FrontendDebug)
	manifestDir := jsDir
	if manifestDir == "" {
		manifestDir = filepath.Join(cfg.FrontendDir, "js")
	}
	return frontendAssets{
		Dir:        cfg.FrontendDir,
		JSDir:      jsDir,
		Shell:      shell,
		AdminShell: adminShell,
		// Static build map (plugin id → hashed chunk filename). Empty in Phase 1
		// (no per-plugin chunks built yet), which makes every /assets/js/p/*
		// request 404 and every manifest Entry empty — the intended foundation
		// state.
		ChunkMap: plugins.LoadChunkMap(filepath.Join(manifestDir, "plugin-manifest.json")),
		CSSMap:   plugins.LoadCssMap(filepath.Join(cfg.FrontendDir, "css", "p")),
	}
}
