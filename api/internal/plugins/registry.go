// Package plugins is the server-side source of truth for Point's plugin system.
//
// A plugin is a vertical slice of functionality (tag visualizations, immersive
// mode, timeline, service integrations, admin pages, …) that can be toggled
// on/off by the admin. The hard constraint of the system is that the client
// receives an ENABLED-ONLY manifest: disabled plugins must never appear in the
// served HTML/JS and their chunks + API routes must 404.
//
// This package is deliberately decoupled — it imports nothing from the rest of
// the codebase. Enabled-state is resolved from a plain settings map (the result
// of SettingsService.GetAllSettings) so callers own the storage/caching policy.
package plugins

import (
	"encoding/json"
	"os"
	"strconv"
)

// Type categorizes how a plugin attaches to the application.
type Type string

const (
	// TypeRoute owns a route (e.g. the /tags provider, admin pages).
	TypeRoute Type = "route"
	// TypeSlot fills a named shell region (breadcrumbs, nav menu, timeline, …).
	TypeSlot Type = "slot"
	// TypeEnhancer augments post content (immersive viewer, custom-CSS injection).
	TypeEnhancer Type = "enhancer"
	// TypeService is a backend-gated capability with little/no public JS.
	TypeService Type = "service"
)

// Descriptor is the static definition of a plugin. The slice in Registry is the
// authoritative catalog; everything else (enabled state, manifest, chunk URLs)
// is derived from it.
type Descriptor struct {
	// ID is the stable plugin identifier, used in the plugin.<id>.enabled
	// setting key and as the lookup key into the build's chunk map.
	ID string
	// Title is the human-facing display name shown on the admin Plugins page.
	// Optional; when empty the frontend humanizes the ID. Set it for ids that
	// don't title-case cleanly (acronyms like "mcp" → "MCP") or need tuning.
	Title string
	// Type categorizes how the plugin attaches (route/slot/enhancer/service).
	Type Type
	// Slot is the named shell region a slot/enhancer plugin fills (optional).
	Slot string
	// Routes lists public/admin route prefixes the plugin owns (optional;
	// informational in Phase 1, consumed by requirePlugin gating in Phase 4).
	Routes []string
	// EntryName is the esbuild entry name (frontend/src/plugins/<id>/index.js)
	// resolved to a hashed chunk path via the build's plugin-manifest.json.
	// Service plugins with no public JS leave this empty.
	EntryName string
	// DefaultEnabled is the enabled state for fresh installs and whenever the
	// plugin.<id>.enabled setting is absent.
	DefaultEnabled bool
	// Area groups plugins that are alternatives for the same responsibility
	// (e.g. the two immersive viewers). Plugins with no shared area leave it "".
	Area string
	// Core marks a plugin whose Area must always have at least one enabled
	// member: the last enabled plugin in a core area cannot be disabled. An area
	// with a single core plugin therefore stays permanently enabled.
	Core bool
	// Exclusive marks an area where AT MOST one member is enabled (radio
	// semantics; "none" allowed). Enabling a member disables its peers. Contrast
	// Core, which requires at least one member. An area is Exclusive when its
	// members declare it — do not combine Exclusive with Core.
	Exclusive bool
}

// Registry is the static, authoritative catalog of all plugins. Phase 1 ships
// with every plugin DefaultEnabled:true so behavior is identical to today; the
// admin Plugins page (Phase 3) and per-plugin extraction (Phase 4) build on top.
var Registry = []Descriptor{
	// ── Tag visualizations: exclusive claim on the tags-route slot ───────────
	// At most one of the three may be enabled (Area "tags-viz", Exclusive) — the
	// enabled one owns /tags; none enabled hides /tags. Atlas is the default; the
	// others ship off. This replaces the old `tags_module` selector setting.
	{ID: "tags-atlas", Type: TypeRoute, Slot: "tags-route", Routes: []string{"/tags"}, EntryName: "tags-atlas", DefaultEnabled: true, Area: "tags-viz", Exclusive: true},
	{ID: "tags-map", Type: TypeRoute, Slot: "tags-route", Routes: []string{"/tags"}, EntryName: "tags-map", DefaultEnabled: false, Area: "tags-viz", Exclusive: true},
	{ID: "tags-graph", Type: TypeRoute, Slot: "tags-route", Routes: []string{"/tags"}, EntryName: "tags-graph", DefaultEnabled: false, Area: "tags-viz", Exclusive: true},

	// ── Shell slots ──────────────────────────────────────────────────────────
	{ID: "timeline", Type: TypeSlot, Slot: "timeline", EntryName: "timeline", DefaultEnabled: true},
	{ID: "tag-cloud", Type: TypeSlot, Slot: "home-explore", EntryName: "tag-cloud", DefaultEnabled: true},
	{ID: "nav-menu", Type: TypeSlot, Slot: "nav-menu", Routes: []string{"/light/menu", "/api/nav-menu", "/api/pages/nav"}, EntryName: "nav-menu", DefaultEnabled: true},
	{ID: "breadcrumbs", Type: TypeSlot, Slot: "breadcrumbs", EntryName: "breadcrumbs", DefaultEnabled: true},
	{ID: "public-header", Type: TypeSlot, Slot: "header", EntryName: "public-header", DefaultEnabled: true},
	{ID: "public-footer", Type: TypeSlot, Slot: "footer", EntryName: "public-footer", DefaultEnabled: true},
	// Guest-facing distraction-free toggle on the post list: a floating button
	// that hides all chrome (header, footer, timeline, tag cloud, pagination),
	// leaving only the post grid. Pure slot plugin — button + a body class.
	{ID: "distraction-free", Type: TypeSlot, Slot: "post-list-tools", EntryName: "distraction-free", DefaultEnabled: true},

	// ── Content enhancers ────────────────────────────────────────────────────
	// The immersive viewers are alternatives for the post-viewer slot (core
	// area "immersive"): Standard is the default; Sheet ships disabled. Enabling
	// Sheet and disabling Standard switches the public viewer; at least one of
	// the pair must stay enabled.
	{ID: "immersive", Title: "Immersive (Standard)", Type: TypeEnhancer, Slot: "post-viewer", EntryName: "immersive", DefaultEnabled: true, Area: "immersive", Core: true},
	{ID: "immersive-sheet", Title: "Immersive (Sheet)", Type: TypeEnhancer, Slot: "post-viewer", EntryName: "immersive-sheet", DefaultEnabled: false, Area: "immersive", Core: true},
	{ID: "custom-css", Type: TypeEnhancer, EntryName: "custom-css", DefaultEnabled: true},

	// Remark42 comments: widget embedded after post content (post-comments
	// slot), served by the remark42 sidecar through the gated /comments reverse
	// proxy, plus the /light/comments moderation page (nav-menu pattern: one
	// plugin = public surface + admin page).
	{ID: "comments", Title: "Comments (Remark42)", Type: TypeEnhancer, Slot: "post-comments", Routes: []string{"/comments", "/light/comments", "/api/admin/comments"}, EntryName: "comments", DefaultEnabled: true},

	// Previous/next post links at the foot of the article (non-immersive view).
	// No JS chunk — the post renderer gates the block on this plugin's enabled
	// state, so toggling it off simply drops the navigation from article pages.
	{ID: "post-navigation", Type: TypeEnhancer, DefaultEnabled: true},

	// Floating share button injected into the MediaViewer (immersive viewer +
	// lightbox) via the `immersive-share` sub-slot. Toggle off to drop the button.
	{ID: "immersive-share", Type: TypeSlot, Slot: "immersive-share", EntryName: "immersive-share", DefaultEnabled: true},

	// Auto-advancing slideshow injected into the MediaViewer via the `slideshow`
	// sub-slot. Top-right toggle + bottom control bar; toggle off to drop it.
	{ID: "slideshow", Type: TypeSlot, Slot: "slideshow", EntryName: "slideshow", DefaultEnabled: true},

	// ── Admin routes ─────────────────────────────────────────────────────────
	// Each admin route is its own single-plugin core area: it cannot be disabled.
	{ID: "media-library", Type: TypeRoute, Routes: []string{"/light/media"}, EntryName: "media-library", DefaultEnabled: true, Area: "media-library", Core: true},
	{ID: "admin-posts-list", Type: TypeRoute, Routes: []string{"/light/posts"}, EntryName: "admin-posts-list", DefaultEnabled: true, Area: "admin-posts-list", Core: true},
	{ID: "admin-home", Type: TypeRoute, Routes: []string{"/light"}, EntryName: "admin-home", DefaultEnabled: true, Area: "admin-home", Core: true},

	// ── Backend-gated services ───────────────────────────────────────────────
	{ID: "instagram", Type: TypeService, Routes: []string{"/api/instagram"}, DefaultEnabled: true},
	{ID: "ai-analysis", Title: "AI Analysis", Type: TypeService, DefaultEnabled: true},
	{ID: "passkeys", Type: TypeService, Routes: []string{"/api/auth/webauthn"}, DefaultEnabled: true},
	{ID: "api-keys", Type: TypeService, Routes: []string{"/api/api-keys"}, DefaultEnabled: true},
	{ID: "backups", Type: TypeService, DefaultEnabled: true},
	{ID: "offline-sync", Type: TypeService, EntryName: "offline-sync", DefaultEnabled: true},
	{ID: "rss", Title: "RSS", Type: TypeService, Routes: []string{"/feed.xml", "/feed"}, DefaultEnabled: true},
	// In-process MCP (Model Context Protocol) server: exposes the blog to AI
	// clients at /mcp. Off by default — it is a powerful remote-control surface
	// that admins opt into from the Plugins page.
	{ID: "mcp", Title: "MCP", Type: TypeService, Routes: []string{"/mcp"}, DefaultEnabled: false},
}

// byID indexes Registry for O(1) lookups.
var byID = func() map[string]Descriptor {
	m := make(map[string]Descriptor, len(Registry))
	for _, d := range Registry {
		m[d.ID] = d
	}
	return m
}()

// EnabledKey returns the blog_settings key holding a plugin's enabled state.
func EnabledKey(id string) string { return "plugin." + id + ".enabled" }

// Get returns the descriptor for id and whether it exists in the registry.
func Get(id string) (Descriptor, bool) {
	d, ok := byID[id]
	return d, ok
}

// IsEnabled reports whether plugin id is enabled given a settings map. An absent
// plugin.<id>.enabled key falls back to the descriptor's DefaultEnabled; an
// unknown id is never enabled.
func IsEnabled(id string, settings map[string]string) bool {
	d, ok := byID[id]
	if !ok {
		return false
	}
	if v, ok := settings[EnabledKey(id)]; ok {
		return v == "true"
	}
	return d.DefaultEnabled
}

// AreaPlugins returns the descriptors that share an area, in registry order. An
// empty area string matches nothing (plugins without an area are not grouped).
func AreaPlugins(area string) []Descriptor {
	if area == "" {
		return nil
	}
	var out []Descriptor
	for _, d := range Registry {
		if d.Area == area {
			out = append(out, d)
		}
	}
	return out
}

// EnabledInArea returns the enabled plugin ids in an area, in registry order.
func EnabledInArea(area string, settings map[string]string) []string {
	var out []string
	for _, d := range AreaPlugins(area) {
		if IsEnabled(d.ID, settings) {
			out = append(out, d.ID)
		}
	}
	return out
}

// IsLockedOff reports whether plugin id may NOT be disabled: it is the sole
// enabled member of a core area, so disabling it would leave that area empty.
// A non-core plugin, or one with an enabled sibling, is never locked off.
func IsLockedOff(id string, settings map[string]string) bool {
	d, ok := byID[id]
	if !ok || !d.Core || !IsEnabled(id, settings) {
		return false
	}
	enabled := EnabledInArea(d.Area, settings)
	return len(enabled) == 1 && enabled[0] == id
}

// ExclusivePeers returns the other members of id's exclusive area, in registry
// order (nil if id is not in an exclusive area). Enabling id must disable these
// so at most one member of the area stays on.
func ExclusivePeers(id string) []string {
	d, ok := byID[id]
	if !ok || !d.Exclusive || d.Area == "" {
		return nil
	}
	var out []string
	for _, m := range AreaPlugins(d.Area) {
		if m.ID != id {
			out = append(out, m.ID)
		}
	}
	return out
}

// DefaultPresets returns the seed preset definitions: a preset id mapped to the
// plugin ids it enables. Core-area plugins are kept enabled by the apply logic
// regardless of membership, so presets only need to enumerate the rest.
func DefaultPresets() map[string][]string {
	all := make([]string, 0, len(Registry))
	for _, d := range Registry {
		all = append(all, d.ID)
	}
	return map[string][]string{
		// Bare guest experience: only the sheet viewer (core admin areas stay on).
		"minimalistic": {"immersive-sheet"},
		// Self-hosted blog without the advanced/integration services.
		"standalone": filterOut(all, "ai-analysis", "instagram", "immersive-sheet"),
		// Everything available.
		"fully-featured": all,
	}
}

// filterOut returns ids with the given values removed.
func filterOut(ids []string, drop ...string) []string {
	skip := make(map[string]bool, len(drop))
	for _, d := range drop {
		skip[d] = true
	}
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if !skip[id] {
			out = append(out, id)
		}
	}
	return out
}

// ManifestEntry is one enabled plugin as delivered to the client. It carries
// only what the frontend PluginHost needs — never DefaultEnabled or any hint of
// disabled plugins.
type ManifestEntry struct {
	ID     string   `json:"id"`
	Type   Type     `json:"type"`
	Slot   string   `json:"slot,omitempty"`
	Routes []string `json:"routes,omitempty"`
	Entry  string   `json:"entry,omitempty"`
	Css    string   `json:"css,omitempty"`
}

// BuildManifest returns the enabled-only manifest. chunks maps a plugin id to
// its hashed chunk filename (from the build's plugin-manifest.json); when a
// plugin has no built chunk yet (Phase 1) its Entry is left empty. Disabled
// plugins are omitted entirely.
func BuildManifest(settings map[string]string, chunks map[string]string, cssMap map[string]bool) []ManifestEntry {
	out := make([]ManifestEntry, 0, len(Registry))
	for _, d := range Registry {
		if !IsEnabled(d.ID, settings) {
			continue
		}
		e := ManifestEntry{ID: d.ID, Type: d.Type, Slot: d.Slot, Routes: d.Routes}
		if d.EntryName != "" {
			if chunk, ok := chunks[d.ID]; ok && chunk != "" {
				e.Entry = "/assets/js/p/" + chunk
			}
		}
		if cssMap != nil && cssMap[d.ID] {
			e.Css = "/assets/css/p/" + d.ID + ".css"
		}
		out = append(out, e)
	}
	return out
}

// PluginForChunk reverse-maps a chunk filename to its owning plugin id using the
// build's chunk map. Used by the gated chunk handler to authorize requests.
func PluginForChunk(chunks map[string]string, chunk string) (string, bool) {
	for id, name := range chunks {
		if name == chunk {
			return id, true
		}
	}
	return "", false
}

// LoadChunkMap reads the build's plugin-manifest.json (plugin id → hashed chunk
// filename). A missing or unreadable file yields an empty map, which is the
// correct Phase 1 state: no per-plugin chunks exist yet, so every chunk request
// 404s and every manifest Entry is empty.
func LoadChunkMap(path string) map[string]string {
	b, err := os.ReadFile(path)
	if err != nil {
		return map[string]string{}
	}
	var m map[string]string
	if err := json.Unmarshal(b, &m); err != nil {
		return map[string]string{}
	}
	return m
}

// LoadCssMap reads the plugin CSS output directory to map plugin ids that have CSS.
func LoadCssMap(dir string) map[string]bool {
	m := make(map[string]bool)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return m
	}
	for _, e := range entries {
		if !e.IsDir() && len(e.Name()) > 4 && e.Name()[len(e.Name())-4:] == ".css" {
			id := e.Name()[:len(e.Name())-4]
			m[id] = true
		}
	}
	return m
}

// SeedValue formats a descriptor's default enabled state for SetSetting.
func SeedValue(d Descriptor) string { return strconv.FormatBool(d.DefaultEnabled) }
