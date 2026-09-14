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
	"fmt"
	"hash/fnv"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"

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

// loadHTMLShells reads index.html and returns the two shells the SPA routes
// serve: the public one carries the deployment-supplied <head> markup
// (analytics/verification tags), the admin one omits it so the injected
// third-party script never loads in the authenticated /light context — a smaller
// XSS blast radius, and it keeps admin traffic out of analytics.
//
// The build version is substituted here, at serve time, instead of mutating the
// file on disk (the old sed/skip-worktree dance in run.sh + Dockerfile):
// index.html stays on disk pristine with the literal __BUILD_VERSION__
// placeholder and is a normally tracked file. version is cfg.AppVersion except
// under DEV_ASSET_RELOAD (see liveAssets.load). Both shells are "" when the
// frontend isn't built — the SPA routes fall back to a 503.
func loadHTMLShells(cfg config.Config, version string, cssManifest map[string]string) (shell, adminShell string) {
	b, err := os.ReadFile(filepath.Join(cfg.FrontendDir, "index.html"))
	if err != nil {
		return "", ""
	}
	base := strings.ReplaceAll(string(b), "__BUILD_VERSION__", version)
	// Rewrite the CSS bundle links to their content-addressed URLs so an
	// unchanged bundle keeps the same URL across deploys and can be cached
	// forever. Without a manifest the ?v=<build version> links stay, which
	// still busts correctly on deploy — just on every deploy.
	for name, hashed := range cssManifest {
		base = strings.ReplaceAll(base,
			"/assets/css/"+name+"?v="+version,
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

// assetSnapshot is one reading of the built frontend: the CSS bundle manifest,
// the two HTML shells rewritten with it, and the plugin chunk/CSS maps. It is
// never mutated once built, so a request holding one sees a consistent set even
// while a reload swaps in the next.
type assetSnapshot struct {
	// CSSManifest maps "light.css" → "light.81e2e81c.css"; nil without a
	// manifest (see loadCSSManifest).
	CSSManifest map[string]string
	// Shell is the public index.html, version-stamped and with the CSS bundle
	// links rewritten to their content-addressed URLs. Empty when unbuilt, which
	// is what makes the SPA fallback answer 503.
	Shell string
	// AdminShell is the same shell minus the deployment-injected <head> markup.
	AdminShell string
	// ChunkMap maps a plugin id to its hashed chunk filename; CSSMap is the set
	// of plugin ids with a CSS partial on disk.
	ChunkMap map[string]string
	CSSMap   map[string]bool

	// stamp is the size and mtime of each watched file, taken just before the
	// files were read.
	stamp []fileStamp
}

type fileStamp struct{ size, mtime int64 }

// liveAssets hands out the current assetSnapshot.
//
// Without DEV_ASSET_RELOAD the snapshot is read once at startup and never
// replaced — the production path, with no disk access per request. With it,
// every HTML shell serve (forShell) first stats index.html and the two build
// manifests and, when one changed, re-reads the whole snapshot and swaps it in,
// so `run.sh --watch` can rebuild CSS or JS under a running server. Everything
// else — the cache-control Pre filter, the plugin chunk gate — reads the
// current snapshot without statting: a new hash only reaches a browser through
// a shell, and the shell reloads first.
//
// Not covered: the CSP inline-script hashes (csp.go) are still computed from
// index.html once at startup, so editing an inline <script> there needs a
// restart.
type liveAssets struct {
	cfg         config.Config
	manifestDir string // where plugin-manifest.json lives; see newFrontendAssets
	reload      bool
	watched     []string
	cur         atomic.Pointer[assetSnapshot]
	mu          sync.Mutex // one reload at a time
}

func newLiveAssets(cfg config.Config, manifestDir string) *liveAssets {
	a := &liveAssets{
		cfg:         cfg,
		manifestDir: manifestDir,
		reload:      cfg.DevAssetReload,
		watched: []string{
			filepath.Join(cfg.FrontendDir, "index.html"),
			filepath.Join(cfg.FrontendDir, "css", "asset-manifest.json"),
			filepath.Join(manifestDir, "plugin-manifest.json"),
		},
	}
	a.cur.Store(a.load(a.stat()))
	return a
}

// current returns the snapshot in force, without touching the disk.
func (a *liveAssets) current() *assetSnapshot { return a.cur.Load() }

// cssManifest is the Pre filter's getter (see installMiddleware).
func (a *liveAssets) cssManifest() map[string]string { return a.cur.Load().CSSManifest }

// forShell returns the snapshot to render an HTML shell from, reloading it
// first when DEV_ASSET_RELOAD is set and a watched file changed.
func (a *liveAssets) forShell() *assetSnapshot {
	s := a.cur.Load()
	if !a.reload || slices.Equal(a.stat(), s.stamp) {
		return s
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	// Re-stat under the lock: a concurrent serve may already have reloaded,
	// possibly from a newer build than the stat above saw.
	stamp := a.stat()
	if s = a.cur.Load(); slices.Equal(stamp, s.stamp) {
		return s
	}
	s = a.load(stamp)
	a.cur.Store(s)
	slog.Info("frontend build changed on disk; reloaded shells and manifests")
	return s
}

func (a *liveAssets) stat() []fileStamp {
	out := make([]fileStamp, len(a.watched))
	for i, p := range a.watched {
		if fi, err := os.Stat(p); err == nil {
			out[i] = fileStamp{size: fi.Size(), mtime: fi.ModTime().UnixNano()}
		}
	}
	return out
}

// load does every startup read of the built frontend. A manifest caught
// half-written by a build yields the no-manifest fallback, and the build's
// final write changes the stamp, so the next shell serve reloads again.
func (a *liveAssets) load(stamp []fileStamp) *assetSnapshot {
	cssManifest := loadCSSManifest(filepath.Join(a.cfg.FrontendDir, "css"))
	// Under reload the shell's ?v= also names the build it was read from. app.js
	// keeps its URL across rebuilds, and the service worker answers a URL it
	// has cached before revalidating it, so a fixed ?v= would show every JS
	// edit one reload late.
	version := a.cfg.AppVersion
	if a.reload {
		h := fnv.New32a()
		for _, f := range stamp {
			_, _ = fmt.Fprintf(h, "%d:%d;", f.size, f.mtime)
		}
		version += fmt.Sprintf("-%08x", h.Sum32())
	}
	shell, adminShell := loadHTMLShells(a.cfg, version, cssManifest)
	return &assetSnapshot{
		CSSManifest: cssManifest,
		Shell:       shell,
		AdminShell:  adminShell,
		// Static build map (plugin id → hashed chunk filename). Empty when no
		// per-plugin chunks are built, which makes every /assets/js/p/* request
		// 404 and every manifest Entry empty.
		ChunkMap: plugins.LoadChunkMap(filepath.Join(a.manifestDir, "plugin-manifest.json")),
		CSSMap:   plugins.LoadCssMap(filepath.Join(a.cfg.FrontendDir, "css", "p")),
		stamp:    stamp,
	}
}

// newFrontendAssets bundles everything the frontend routes need: the frontend
// directory, the resolved JS bundle directory, and the live shells and plugin
// maps.
//
// The JS bundle directory is resolved once — the release bundle (frontend/js),
// or the debug bundle (frontend/js-debug) when FRONTEND_DEBUG is set and built.
// The chunk map MUST come from the same directory we serve so plugin chunk
// hashes match the bundle the browser loads.
func newFrontendAssets(cfg config.Config) frontendAssets {
	jsDir := resolveJSDir(cfg.FrontendDir, cfg.FrontendDebug)
	manifestDir := jsDir
	if manifestDir == "" {
		manifestDir = filepath.Join(cfg.FrontendDir, "js")
	}
	return frontendAssets{
		Dir:    cfg.FrontendDir,
		JSDir:  jsDir,
		Assets: newLiveAssets(cfg, manifestDir),
	}
}
