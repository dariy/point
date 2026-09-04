package plugins

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestIsEnabled_DefaultsAndOverrides(t *testing.T) {
	// Absent key falls back to the descriptor's DefaultEnabled (true in Phase 1).
	if !IsEnabled("timeline", map[string]string{}) {
		t.Errorf("timeline should default to enabled when key absent")
	}
	// Explicit "false" disables.
	if IsEnabled("timeline", map[string]string{EnabledKey("timeline"): "false"}) {
		t.Errorf("timeline should be disabled when plugin.timeline.enabled=false")
	}
	// Explicit "true" enables.
	if !IsEnabled("timeline", map[string]string{EnabledKey("timeline"): "true"}) {
		t.Errorf("timeline should be enabled when plugin.timeline.enabled=true")
	}
	// Unknown plugin is never enabled.
	if IsEnabled("does-not-exist", map[string]string{EnabledKey("does-not-exist"): "true"}) {
		t.Errorf("unknown plugin must never be enabled")
	}
}

func TestEnabledKey(t *testing.T) {
	if got := EnabledKey("immersive"); got != "plugin.immersive.enabled" {
		t.Errorf("EnabledKey = %q", got)
	}
}

func TestBuildManifest_OmitsDisabledAndResolvesChunks(t *testing.T) {
	settings := map[string]string{
		EnabledKey("timeline"):  "false",
		EnabledKey("immersive"): "true",
	}
	chunks := map[string]string{
		"immersive": "immersive-ABC123.js",
		"timeline":  "timeline-XYZ789.js",
	}
	manifest := BuildManifest(settings, chunks, nil)

	for _, e := range manifest {
		if e.ID == "timeline" {
			t.Fatalf("disabled plugin 'timeline' must be absent from manifest")
		}
	}

	var immersive ManifestEntry
	found := false
	for _, e := range manifest {
		if e.ID == "immersive" {
			immersive = e
			found = true
		}
	}
	if !found {
		t.Fatalf("enabled plugin 'immersive' missing from manifest")
	}
	if immersive.Entry != "/assets/js/p/immersive-ABC123.js" {
		t.Errorf("immersive Entry = %q", immersive.Entry)
	}
}

// NormalizeSlots is the one place a whole desired configuration is bent to fit
// the slot rules, so both corrections it can make are exercised per rule kind.
func TestNormalizeSlots(t *testing.T) {
	for slot, rule := range SlotCardinality {
		members := SlotPlugins(slot)
		if len(members) == 0 {
			t.Fatalf("slot %q has a cardinality rule but no candidates", slot)
		}

		// Everything on: a single-claim slot keeps its first candidate only.
		want := map[string]bool{}
		for _, m := range members {
			want[m.ID] = true
		}
		NormalizeSlots(want)
		var on []string
		for _, m := range members {
			if want[m.ID] {
				on = append(on, m.ID)
			}
		}
		if rule.SingleClaim() && (len(on) != 1 || on[0] != members[0].ID) {
			t.Errorf("slot %q (%s) with everything on = %v, want [%s]", slot, rule, on, members[0].ID)
		}

		// Nothing on: a slot that requires a claimant gets its default back, and
		// one that does not stays empty.
		want = map[string]bool{}
		NormalizeSlots(want)
		on = nil
		for _, m := range members {
			if want[m.ID] {
				on = append(on, m.ID)
			}
		}
		switch {
		case rule.RequiresOne() && (len(on) != 1 || on[0] != DefaultClaimant(slot)):
			t.Errorf("slot %q (%s) with nothing on = %v, want [%s]", slot, rule, on, DefaultClaimant(slot))
		case !rule.RequiresOne() && len(on) != 0:
			t.Errorf("slot %q (%s) with nothing on = %v, want none", slot, rule, on)
		}
	}
}

func TestBuildManifest_EmptyChunkMapLeavesEntryEmpty(t *testing.T) {
	// Phase 1 state: no chunks built, every Entry empty, but all enabled plugins
	// still present in the manifest.
	manifest := BuildManifest(map[string]string{}, map[string]string{}, nil)
	wantEnabled := 0
	for _, d := range Registry {
		if d.DefaultEnabled {
			wantEnabled++
		}
	}
	if len(manifest) != wantEnabled {
		t.Fatalf("expected %d entries (default-enabled), got %d", wantEnabled, len(manifest))
	}
	for _, e := range manifest {
		if e.Entry != "" {
			t.Errorf("plugin %s Entry should be empty with no chunk map, got %q", e.ID, e.Entry)
		}
	}
}

func TestBuildManifest_NeverLeaksDisabledOrDefaults(t *testing.T) {
	// Disable everything; the marshaled manifest must not name any plugin id and
	// must never carry the DefaultEnabled field.
	settings := map[string]string{}
	for _, d := range Registry {
		settings[EnabledKey(d.ID)] = "false"
	}
	manifest := BuildManifest(settings, map[string]string{}, nil)
	if len(manifest) != 0 {
		t.Fatalf("expected empty manifest, got %d entries", len(manifest))
	}
	b, _ := json.Marshal(manifest)
	if s := string(b); s != "[]" {
		t.Errorf("expected [] manifest JSON, got %s", s)
	}
	for _, d := range Registry {
		b, _ := json.Marshal(BuildManifest(settings, map[string]string{}, nil))
		if strings.Contains(string(b), d.ID) {
			t.Errorf("disabled plugin %q leaked into manifest JSON", d.ID)
		}
	}
}

func TestBuildManifest_JSONHasNoDefaultEnabledField(t *testing.T) {
	b, _ := json.Marshal(BuildManifest(map[string]string{}, map[string]string{}, nil))
	if strings.Contains(strings.ToLower(string(b)), "default") {
		t.Errorf("manifest JSON must not expose DefaultEnabled: %s", b)
	}
}

func TestPluginForChunk(t *testing.T) {
	chunks := map[string]string{"timeline": "timeline-XYZ789.js"}
	if id, ok := PluginForChunk(chunks, "timeline-XYZ789.js"); !ok || id != "timeline" {
		t.Errorf("PluginForChunk = (%q, %v)", id, ok)
	}
	if _, ok := PluginForChunk(chunks, "unknown.js"); ok {
		t.Errorf("unknown chunk should not resolve")
	}
}

func TestLoadChunkMap(t *testing.T) {
	// Missing file → empty map (the Phase 1 default).
	if m := LoadChunkMap(filepath.Join(t.TempDir(), "missing.json")); len(m) != 0 {
		t.Errorf("missing file should yield empty map, got %v", m)
	}

	dir := t.TempDir()
	path := filepath.Join(dir, "plugin-manifest.json")
	if err := os.WriteFile(path, []byte(`{"timeline":"timeline-XYZ789.js"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	m := LoadChunkMap(path)
	if m["timeline"] != "timeline-XYZ789.js" {
		t.Errorf("LoadChunkMap = %v", m)
	}

	// Malformed JSON → empty map (degrade gracefully).
	bad := filepath.Join(dir, "bad.json")
	_ = os.WriteFile(bad, []byte("{not json"), 0o644)
	if m := LoadChunkMap(bad); len(m) != 0 {
		t.Errorf("malformed file should yield empty map, got %v", m)
	}
}

func TestRegistry_UniqueIDs(t *testing.T) {
	seen := map[string]bool{}
	for _, d := range Registry {
		if seen[d.ID] {
			t.Errorf("duplicate plugin id %q", d.ID)
		}
		seen[d.ID] = true
	}
}

// Which plugins ship on is a product decision that gets retuned per release and
// per deployment, so no test pins the individual flags — an enumerated list of
// them only ever produces a red suite after a deliberate change. What must hold
// for ANY tuning is that the shipped defaults already satisfy the slot rules the
// toggle endpoint and IsLockedOff enforce afterwards: a single-claim slot starts
// with at most one claimant, a required slot with at least one — otherwise a
// fresh install boots with two viewers fighting over a post, or with none.
func TestRegistry_SlotDefaultsSatisfyTheirRules(t *testing.T) {
	fresh := map[string]string{} // no overrides → every plugin at DefaultEnabled

	for slot, rule := range SlotCardinality {
		if len(SlotPlugins(slot)) == 0 {
			t.Errorf("slot %q has rule %s but no plugin claims it", slot, rule)
			continue
		}
		enabled := EnabledInSlot(slot, fresh)
		if rule.SingleClaim() && len(enabled) > 1 {
			t.Errorf("slot %q (%s) ships %d claimants enabled (%v), want at most 1", slot, rule, len(enabled), enabled)
		}
		if rule.RequiresOne() && len(enabled) == 0 {
			t.Errorf("slot %q (%s) ships with no claimant — the slot is empty on a fresh install", slot, rule)
		}
	}
}

// defaultSplit returns the default-enabled candidate of a two-candidate slot and
// its default-disabled sibling. Tests use it instead of naming the two viewers
// directly, so retuning which one ships on doesn't turn them red.
func defaultSplit(t *testing.T, slot string) (on, off string) {
	t.Helper()
	for _, d := range SlotPlugins(slot) {
		if d.DefaultEnabled {
			on = d.ID
		} else {
			off = d.ID
		}
	}
	if on == "" || off == "" {
		t.Fatalf("slot %q needs exactly one default-on and one default-off candidate; got on=%q off=%q", slot, on, off)
	}
	return on, off
}

func TestSlotPlugins_AndEnabledInSlot(t *testing.T) {
	members := SlotPlugins("post-viewer")
	if len(members) != 2 {
		t.Fatalf("post-viewer should have 2 candidates, got %d", len(members))
	}
	if SlotPlugins("") != nil {
		t.Errorf("empty slot should match nothing")
	}
	on, off := defaultSplit(t, "post-viewer")

	// Defaults: exactly the default-on viewer is enabled.
	enabled := EnabledInSlot("post-viewer", map[string]string{})
	if len(enabled) != 1 || enabled[0] != on {
		t.Errorf("default enabled post-viewer = %v, want [%s]", enabled, on)
	}

	// EnabledInSlot reports the raw settings, rule or not: the slot is kept to
	// one claimant by the toggle endpoint, not by this accessor.
	enabled = EnabledInSlot("post-viewer", map[string]string{EnabledKey(off): "true"})
	if len(enabled) != 2 {
		t.Errorf("both immersive plugins should be enabled, got %v", enabled)
	}
}

func TestIsLockedOff(t *testing.T) {
	// A plugin whose slot tolerates none is never locked, however alone it is.
	if IsLockedOff("timeline", map[string]string{}) {
		t.Errorf("plugin in a slot with no minimum must never be locked")
	}
	// Both viz slots tolerate none, so their sole claimant is never locked:
	// /tags and /map may each be turned off entirely.
	for _, slot := range []string{"tags-route", "map-route"} {
		if got := EnabledInSlot(slot, map[string]string{}); len(got) == 1 && IsLockedOff(got[0], map[string]string{}) {
			t.Errorf("sole %s claimant %q must not be locked — the route may be turned off entirely", slot, got[0])
		}
	}
	// Whichever viewer ships on is the required slot's only claimant → locked.
	on, off := defaultSplit(t, "post-viewer")
	if !IsLockedOff(on, map[string]string{}) {
		t.Errorf("%s should be locked when it is the only enabled viewer", on)
	}
	// With the sibling also enabled, neither is locked.
	both := map[string]string{EnabledKey(off): "true"}
	if IsLockedOff(on, both) || IsLockedOff(off, both) {
		t.Errorf("with both viewers enabled, neither should be locked")
	}
	// A disabled plugin is never "locked off".
	if IsLockedOff(off, map[string]string{}) {
		t.Errorf("disabled plugin must not be reported locked")
	}
}

func TestSlotPeers(t *testing.T) {
	// map-route takes one claimant, and the two maps are its only candidates,
	// so the atlas's sole peer is the plain map. The graph is not a peer of
	// either: it lives in tags-route, and enabling it leaves /map alone.
	if got := SlotPeers("tags-atlas"); len(got) != 1 || got[0] != "tags-map" {
		t.Errorf("tags-atlas peers = %v, want [tags-map]", got)
	}
	if got := SlotPeers("tags-map"); len(got) != 1 || got[0] != "tags-atlas" {
		t.Errorf("tags-map peers = %v, want [tags-atlas]", got)
	}
	if got := SlotPeers("tags-graph"); len(got) != 0 {
		t.Errorf("tags-graph peers = %v, want none — the graph owns /tags alone", got)
	}
	// post-viewer takes one too, so each viewer's peer is the other: enabling
	// one is what switches the public viewer over.
	if got := SlotPeers("immersive"); len(got) != 1 || got[0] != "immersive-sheet" {
		t.Errorf("immersive peers = %v, want [immersive-sheet]", got)
	}
	if got := SlotPeers("immersive-sheet"); len(got) != 1 || got[0] != "immersive" {
		t.Errorf("immersive-sheet peers = %v, want [immersive]", got)
	}
	// A slot that takes any number has no peers to switch off.
	if got := SlotPeers("timeline"); got != nil {
		t.Errorf("plugin in a many-slot should have no peers, got %v", got)
	}
	// Unknown id.
	if got := SlotPeers("does-not-exist"); got != nil {
		t.Errorf("unknown plugin should have no peers, got %v", got)
	}
}

func TestDefaultPresets(t *testing.T) {
	presets := DefaultPresets()
	for _, id := range []string{"minimalistic", "standalone", "fully-featured"} {
		if _, ok := presets[id]; !ok {
			t.Errorf("missing default preset %q", id)
		}
	}
	// fully-featured is "everything available": every plugin in the registry
	// except tag-cloud, which no preset offers (it is filtered out of both
	// fully-featured and standalone — see DefaultPresets).
	inFull := map[string]bool{}
	for _, id := range presets["fully-featured"] {
		inFull[id] = true
	}
	if inFull["tag-cloud"] {
		t.Errorf("fully-featured must not include tag-cloud")
	}
	for _, d := range Registry {
		if d.ID != "tag-cloud" && !inFull[d.ID] {
			t.Errorf("fully-featured is missing %q", d.ID)
		}
	}
	if want := len(Registry) - 1; len(presets["fully-featured"]) != want {
		t.Errorf("fully-featured has %d plugins, want %d (every plugin but tag-cloud)",
			len(presets["fully-featured"]), want)
	}
	// Minimalistic enables only the sheet viewer among non-core public plugins.
	if got := presets["minimalistic"]; len(got) != 1 || got[0] != "immersive-sheet" {
		t.Errorf("minimalistic = %v, want [immersive-sheet]", got)
	}
	// Standalone excludes the advanced services and the sheet viewer.
	for _, excluded := range []string{"ai-analysis", "instagram", "immersive-sheet"} {
		for _, id := range presets["standalone"] {
			if id == excluded {
				t.Errorf("standalone must exclude %q", excluded)
			}
		}
	}
}

// The carousel plugin ships as a disabled route plugin: its admin studio at
// /light/carousel and the /api/carousel prefix it will own are both declared on
// one descriptor, and nothing about it is on by default.
func TestRegistry_CarouselDescriptor(t *testing.T) {
	d, ok := Get("carousel")
	if !ok {
		t.Fatal("carousel plugin missing from the registry")
	}
	if d.Type != TypeRoute {
		t.Errorf("carousel Type = %q, want %q", d.Type, TypeRoute)
	}
	if d.DefaultEnabled {
		t.Error("carousel must ship disabled — visitors get the block styling, admins opt into the builder")
	}
	if d.EntryName != "carousel" {
		t.Errorf("carousel EntryName = %q, want \"carousel\"", d.EntryName)
	}
	want := map[string]bool{"/light/carousel": true, "/api/carousel": true}
	got := map[string]bool{}
	for _, r := range d.Routes {
		got[r] = true
	}
	for r := range want {
		if !got[r] {
			t.Errorf("carousel Routes missing %q (have %v)", r, d.Routes)
		}
	}
	// The route is param-less on purpose: plugin admin routes are merged verbatim
	// and the page title is taken from the last path segment.
	for _, r := range d.Routes {
		if strings.Contains(r, ":") {
			t.Errorf("carousel route %q has a path param — the post id belongs in the query string", r)
		}
	}
}
