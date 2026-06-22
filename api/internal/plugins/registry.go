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
}

// Registry is the static, authoritative catalog of all plugins. Phase 1 ships
// with every plugin DefaultEnabled:true so behavior is identical to today; the
// admin Plugins page (Phase 3) and per-plugin extraction (Phase 4) build on top.
var Registry = []Descriptor{
	// ── Tag visualizations: single-claim on the tags-route slot ──────────────
	{ID: "tags-atlas", Type: TypeRoute, Slot: "tags-route", Routes: []string{"/tags"}, EntryName: "tags-atlas", DefaultEnabled: true},
	{ID: "tags-map", Type: TypeRoute, Slot: "tags-route", Routes: []string{"/tags"}, EntryName: "tags-map", DefaultEnabled: true},
	{ID: "tags-graph", Type: TypeRoute, Slot: "tags-route", Routes: []string{"/tags"}, EntryName: "tags-graph", DefaultEnabled: true},

	// ── Shell slots ──────────────────────────────────────────────────────────
	{ID: "timeline", Type: TypeSlot, Slot: "timeline", EntryName: "timeline", DefaultEnabled: true},
	{ID: "tag-cloud", Type: TypeSlot, Slot: "home-explore", EntryName: "tag-cloud", DefaultEnabled: true},
	{ID: "nav-menu", Type: TypeSlot, Slot: "nav-menu", EntryName: "nav-menu", DefaultEnabled: true},
	{ID: "breadcrumbs", Type: TypeSlot, Slot: "breadcrumbs", EntryName: "breadcrumbs", DefaultEnabled: true},
	{ID: "public-header", Type: TypeSlot, Slot: "header", EntryName: "public-header", DefaultEnabled: true},
	{ID: "public-footer", Type: TypeSlot, Slot: "footer", EntryName: "public-footer", DefaultEnabled: true},

	// ── Content enhancers ────────────────────────────────────────────────────
	{ID: "immersive", Type: TypeEnhancer, Slot: "post-viewer", EntryName: "immersive", DefaultEnabled: true},
	{ID: "custom-css", Type: TypeEnhancer, EntryName: "custom-css", DefaultEnabled: true},

	// ── Admin routes ─────────────────────────────────────────────────────────
	{ID: "media-library", Type: TypeRoute, Routes: []string{"/light/media"}, EntryName: "media-library", DefaultEnabled: true},
	{ID: "admin-posts-list", Type: TypeRoute, Routes: []string{"/light/posts"}, EntryName: "admin-posts-list", DefaultEnabled: true},
	{ID: "admin-home", Type: TypeRoute, Routes: []string{"/light"}, EntryName: "admin-home", DefaultEnabled: true},

	// ── Backend-gated services ───────────────────────────────────────────────
	{ID: "instagram", Type: TypeService, Routes: []string{"/api/instagram"}, DefaultEnabled: true},
	{ID: "ai-analysis", Type: TypeService, DefaultEnabled: true},
	{ID: "passkeys", Type: TypeService, Routes: []string{"/api/auth/webauthn"}, DefaultEnabled: true},
	{ID: "api-keys", Type: TypeService, Routes: []string{"/api/api-keys"}, DefaultEnabled: true},
	{ID: "backups", Type: TypeService, DefaultEnabled: true},
	{ID: "offline-sync", Type: TypeService, DefaultEnabled: true},
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

// ManifestEntry is one enabled plugin as delivered to the client. It carries
// only what the frontend PluginHost needs — never DefaultEnabled or any hint of
// disabled plugins.
type ManifestEntry struct {
	ID     string   `json:"id"`
	Type   Type     `json:"type"`
	Slot   string   `json:"slot,omitempty"`
	Routes []string `json:"routes,omitempty"`
	Entry  string   `json:"entry,omitempty"`
}

// BuildManifest returns the enabled-only manifest. chunks maps a plugin id to
// its hashed chunk filename (from the build's plugin-manifest.json); when a
// plugin has no built chunk yet (Phase 1) its Entry is left empty. Disabled
// plugins are omitted entirely.
func BuildManifest(settings map[string]string, chunks map[string]string) []ManifestEntry {
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

// SeedValue formats a descriptor's default enabled state for SetSetting.
func SeedValue(d Descriptor) string { return strconv.FormatBool(d.DefaultEnabled) }
