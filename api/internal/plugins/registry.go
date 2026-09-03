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
}

// Cardinality is how many enabled plugins a slot accepts. It belongs to the
// SLOT, not to the plugins claiming it: whether alternatives exclude each other,
// and whether the shell survives with none, is a property of the region being
// filled. Plugins are then just candidates for it.
type Cardinality string

const (
	// CardAny — any number of claimants; they compose instead of competing.
	// This is the rule for every slot left out of SlotCardinality.
	CardAny Cardinality = "0+"
	// CardAtMostOne — one claimant or none; enabling one switches the others
	// off, and with none enabled the slot's feature simply disappears.
	CardAtMostOne Cardinality = "0-1"
	// CardExactlyOne — always precisely one claimant: alternatives switch each
	// other off, and the last one standing cannot be disabled.
	CardExactlyOne Cardinality = "1"
	// CardAtLeastOne — one or more; the last claimant cannot be disabled.
	CardAtLeastOne Cardinality = "1+"
)

// SingleClaim reports whether the slot admits at most one enabled plugin, so
// enabling a claimant must switch its peers off (radio semantics).
func (c Cardinality) SingleClaim() bool { return c == CardAtMostOne || c == CardExactlyOne }

// RequiresOne reports whether the slot must always keep a claimant, so its sole
// enabled plugin may not be disabled (see IsLockedOff).
func (c Cardinality) RequiresOne() bool { return c == CardExactlyOne || c == CardAtLeastOne }

// SlotCardinality holds the slots whose rule is not CardAny. List a slot here
// when its claimants are alternatives rather than additions, or when the page
// renders nothing useful without one.
var SlotCardinality = map[string]Cardinality{
	// The enabled graph owns /tags; with none enabled the route is hidden,
	// which is a supported (and preset-used) configuration. The graph is the
	// slot's only candidate today, so the rule is declared rather than needed:
	// it keeps a future second graph viz from silently double-claiming /tags.
	"tags-route": CardAtMostOne,
	// The enabled map owns /map — the atlas and the plain map are alternatives,
	// never both. With none enabled the route is hidden, same as /tags.
	"map-route": CardAtMostOne,
	// An immersive post renders the viewer and nothing else, so it needs one —
	// the Standard and Sheet viewers are the two candidates for it.
	"post-viewer": CardExactlyOne,
	// The post list is the core view of the home, search, and tag pages.
	"post-list": CardExactlyOne,
}

// SlotRule returns the cardinality of a slot; unlisted slots accept any number.
func SlotRule(slot string) Cardinality {
	if c, ok := SlotCardinality[slot]; ok {
		return c
	}
	return CardAny
}

// Registry is the static, authoritative catalog of all plugins. Phase 1 ships
// with every plugin DefaultEnabled:true so behavior is identical to today; the
// admin Plugins page (Phase 3) and per-plugin extraction (Phase 4) build on top.
var Registry = []Descriptor{
	// ── Tag visualizations: two slots, one route each ────────────────────────
	// The force graph owns /tags; the two maps are alternatives for /map, where
	// registry order makes the atlas the one that wins when both are asked for.
	// Each slot takes at most one (SlotCardinality), so none enabled hides that
	// route, and the graph and the maps no longer compete with each other.
	// This replaces the old `tags_module` selector setting.
	{ID: "tags-graph", Type: TypeRoute, Slot: "tags-route", Routes: []string{"/tags"}, EntryName: "tags-graph", DefaultEnabled: false},
	{ID: "tags-atlas", Type: TypeRoute, Slot: "map-route", Routes: []string{"/map"}, EntryName: "tags-atlas", DefaultEnabled: true},
	{ID: "tags-map", Type: TypeRoute, Slot: "map-route", Routes: []string{"/map"}, EntryName: "tags-map", DefaultEnabled: false},

	// ── Post Lists: candidates for the post-list slot ────────────────────────
	{ID: "simple-post-list", Title: "Simple Post List", Type: TypeSlot, Slot: "post-list", EntryName: "simple-post-list", DefaultEnabled: false},
	{ID: "dynamic-post-list", Title: "Dynamic Post List", Type: TypeSlot, Slot: "post-list", EntryName: "dynamic-post-list", DefaultEnabled: true},

	// ── Shell slots ──────────────────────────────────────────────────────────
	{ID: "timeline", Type: TypeSlot, Slot: "timeline", EntryName: "timeline", DefaultEnabled: true},
	{ID: "tag-cloud", Type: TypeSlot, Slot: "home-explore", EntryName: "tag-cloud", DefaultEnabled: false},
	{ID: "nav-menu", Type: TypeSlot, Slot: "nav-menu", Routes: []string{"/light/menu", "/api/nav-menu", "/api/pages/nav"}, EntryName: "nav-menu", DefaultEnabled: true},
	{ID: "breadcrumbs", Type: TypeSlot, Slot: "breadcrumbs", EntryName: "breadcrumbs", DefaultEnabled: true},
	{ID: "public-header", Type: TypeSlot, Slot: "header", EntryName: "public-header", DefaultEnabled: true},
	{ID: "public-footer", Type: TypeSlot, Slot: "footer", EntryName: "public-footer", DefaultEnabled: true},
	// Guest-facing distraction-free toggle on the post list: a floating button
	// that hides all chrome (header, footer, timeline, tag cloud, pagination),
	// leaving only the post grid. Pure slot plugin — button + a body class.
	{ID: "distraction-free", Type: TypeSlot, Slot: "post-list-tools", EntryName: "distraction-free", DefaultEnabled: true},

	// ── Content enhancers ────────────────────────────────────────────────────
	// The two immersive viewers are the candidates for the post-viewer slot,
	// which takes exactly one (SlotCardinality): enabling one switches the
	// public viewer by turning the other off, and the survivor cannot be
	// disabled — same radio behavior as the tag visualizations, minus the
	// "none" option, because an immersive post has nothing else to render.
	{ID: "immersive", Title: "Immersive (Standard)", Type: TypeEnhancer, Slot: "post-viewer", EntryName: "immersive", DefaultEnabled: false},
	{ID: "immersive-sheet", Title: "Immersive (Sheet)", Type: TypeEnhancer, Slot: "post-viewer", EntryName: "immersive-sheet", DefaultEnabled: true},

	// custom-css has no frontend chunk: the CSS injection lives in core and the
	// plugin only gates the /api/themes/custom-css endpoints via RequirePlugin.
	{ID: "custom-css", Type: TypeEnhancer, DefaultEnabled: false},

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

	// /light, /light/posts and /light/media used to be registered here as
	// single-plugin core areas that could never be disabled. They are ordinary
	// lazy routes in frontend/src/app.js now: the plugin indirection bought
	// only code-splitting, which esbuild --splitting provides directly.

	// ── Admin studios ───────────────────────────────────────────────────────
	// Carousel Studio: turns a post's media into an Instagram-ready slide deck,
	// written back into the post as a :::{.carousel-block} fenced div. Admin UI
	// at /light/carousel?post=<id> — the path carries no :id because plugin
	// admin routes are merged verbatim and filtered on the /light prefix
	// (app.js), and the page title is taken from the last path segment. Off by
	// default; the builder lands incrementally (docs/features/carousel-studio.md).
	// The /api/carousel prefix is declared here and adopts RequirePlugin when
	// its CRUD lands in a later bead; until then it simply 404s.
	{ID: "carousel", Title: "Carousel Studio", Type: TypeRoute, Routes: []string{"/light/carousel", "/api/carousel"}, EntryName: "carousel", DefaultEnabled: false},

	// ── Backend-gated services ───────────────────────────────────────────────
	{ID: "instagram", Type: TypeService, Routes: []string{"/api/instagram"}, DefaultEnabled: false},
	{ID: "ai-analysis", Title: "AI Analysis", Type: TypeService, DefaultEnabled: false},
	{ID: "passkeys", Type: TypeService, Routes: []string{"/api/auth/webauthn"}, DefaultEnabled: true},
	{ID: "api-keys", Type: TypeService, Routes: []string{"/api/api-keys"}, DefaultEnabled: false},
	{ID: "backups", Type: TypeService, DefaultEnabled: false},
	{ID: "offline-sync", Type: TypeService, EntryName: "offline-sync", DefaultEnabled: false},
	{ID: "rss", Title: "RSS", Type: TypeService, Routes: []string{"/feed.xml", "/feed"}, DefaultEnabled: true},
	// In-process MCP (Model Context Protocol) server: exposes the blog to AI
	// clients at /mcp. Off by default — it is a powerful remote-control surface
	// that admins opt into from the Plugins page.
	{ID: "mcp", Title: "MCP", Type: TypeService, Routes: []string{"/mcp"}, DefaultEnabled: false},
	// Compares the running build against the upstream git tags and surfaces an
	// update banner on the dashboard. Toggle it off to stop the (daily, cached)
	// call out to the GitHub API entirely — the version endpoint then 404s.
	{ID: "version-check", Title: "Version Check", Type: TypeService, Routes: []string{"/api/system/version"}, DefaultEnabled: true},
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

// SlotPlugins returns the descriptors claiming a slot, in registry order. An
// empty slot string matches nothing (plugins without a slot claim no region).
func SlotPlugins(slot string) []Descriptor {
	if slot == "" {
		return nil
	}
	var out []Descriptor
	for _, d := range Registry {
		if d.Slot == slot {
			out = append(out, d)
		}
	}
	return out
}

// EnabledInSlot returns the enabled plugin ids claiming a slot, registry order.
func EnabledInSlot(slot string, settings map[string]string) []string {
	var out []string
	for _, d := range SlotPlugins(slot) {
		if IsEnabled(d.ID, settings) {
			out = append(out, d.ID)
		}
	}
	return out
}

// IsLockedOff reports whether plugin id may NOT be disabled: its slot requires a
// claimant and id is the only enabled one, so disabling it would leave the slot
// empty. A plugin in a slot that tolerates none, or one with an enabled sibling,
// is never locked off.
func IsLockedOff(id string, settings map[string]string) bool {
	d, ok := byID[id]
	if !ok || !SlotRule(d.Slot).RequiresOne() || !IsEnabled(id, settings) {
		return false
	}
	enabled := EnabledInSlot(d.Slot, settings)
	return len(enabled) == 1 && enabled[0] == id
}

// SlotPeers returns the other candidates for id's slot, in registry order, when
// that slot takes a single claimant (nil otherwise). Enabling id must disable
// these so the slot keeps at most one.
func SlotPeers(id string) []string {
	d, ok := byID[id]
	if !ok || !SlotRule(d.Slot).SingleClaim() {
		return nil
	}
	var out []string
	for _, m := range SlotPlugins(d.Slot) {
		if m.ID != id {
			out = append(out, m.ID)
		}
	}
	return out
}

// NormalizeSlots corrects a desired enabled-set in place so it satisfies every
// slot rule: single-claim slots keep their first requested candidate (registry
// order) and lose the rest; slots that require a claimant fall back to their
// default candidate when the set leaves them empty. Callers that write a whole
// configuration at once (preset application) use it instead of reimplementing
// the rules; individual toggles go through SlotPeers/IsLockedOff.
func NormalizeSlots(want map[string]bool) {
	done := map[string]bool{}
	for _, d := range Registry {
		if d.Slot == "" || done[d.Slot] {
			continue
		}
		done[d.Slot] = true
		rule := SlotRule(d.Slot)
		if rule == CardAny {
			continue
		}

		members := SlotPlugins(d.Slot)
		var enabled []Descriptor
		for _, m := range members {
			if want[m.ID] {
				enabled = append(enabled, m)
			}
		}
		if rule.SingleClaim() && len(enabled) > 1 {
			for _, m := range enabled[1:] {
				want[m.ID] = false
			}
			enabled = enabled[:1]
		}
		if rule.RequiresOne() && len(enabled) == 0 {
			want[DefaultClaimant(d.Slot)] = true
		}
	}
}

// DefaultClaimant is the plugin that fills a slot when nothing else does: the
// candidate marked DefaultEnabled, else the first in registry order. Empty for
// a slot with no candidates at all.
func DefaultClaimant(slot string) string {
	members := SlotPlugins(slot)
	for _, m := range members {
		if m.DefaultEnabled {
			return m.ID
		}
	}
	if len(members) > 0 {
		return members[0].ID
	}
	return ""
}

// DefaultPresets returns the seed preset definitions: a preset id mapped to the
// plugin ids it enables. Slots that require a claimant get one from the apply
// logic regardless of membership (see NormalizeSlots), so presets only need to
// enumerate what they actually want.
func DefaultPresets() map[string][]string {
	all := make([]string, 0, len(Registry))
	for _, d := range Registry {
		all = append(all, d.ID)
	}
	return map[string][]string{
		// Bare guest experience: the sheet viewer and nothing else — no tag
		// visualization, so both /tags and /map are hidden.
		"minimalistic": {"immersive-sheet"},
		// Self-hosted blog without the advanced/integration services.
		"standalone": filterOut(all, "tag-cloud", "ai-analysis", "instagram", "immersive-sheet"),
		// Everything available. Candidates for a single-claim slot (tags-route,
		// map-route, post-viewer) are all listed; NormalizeSlots trims each slot
		// to its first candidate on apply, so this stays a plain "everything"
		// list — it yields the graph on /tags and the atlas on /map.
		"fully-featured": filterOut(all, "tag-cloud"),
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
