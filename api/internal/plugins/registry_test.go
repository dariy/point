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

	var immersive *ManifestEntry
	for i := range manifest {
		if manifest[i].ID == "immersive" {
			immersive = &manifest[i]
		}
	}
	if immersive == nil {
		t.Fatalf("enabled plugin 'immersive' missing from manifest")
	}
	if immersive.Entry != "/assets/js/p/immersive-ABC123.js" {
		t.Errorf("immersive Entry = %q", immersive.Entry)
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
	// Every plugin defaults enabled except: the alternative immersive viewer,
	// which ships off so the default public viewer stays Standard; the two
	// non-default tags-viz alternatives (only Atlas is on by default in the
	// exclusive area); and the external-service opt-ins (MCP server, remark42
	// comments) admins must enable deliberately.
	defaultOff := map[string]bool{"immersive-sheet": true, "tags-map": true, "tags-graph": true, "mcp": true, "comments": true}
	for _, d := range Registry {
		if !d.DefaultEnabled && !defaultOff[d.ID] {
			t.Errorf("plugin %q unexpectedly defaults disabled", d.ID)
		}
	}
}

func TestAreaPlugins_AndEnabledInArea(t *testing.T) {
	members := AreaPlugins("immersive")
	if len(members) != 2 {
		t.Fatalf("immersive area should have 2 members, got %d", len(members))
	}
	if AreaPlugins("") != nil {
		t.Errorf("empty area should match nothing")
	}

	// Defaults: only Standard immersive is enabled.
	enabled := EnabledInArea("immersive", map[string]string{})
	if len(enabled) != 1 || enabled[0] != "immersive" {
		t.Errorf("default enabled immersive = %v, want [immersive]", enabled)
	}

	// Both on.
	enabled = EnabledInArea("immersive", map[string]string{EnabledKey("immersive-sheet"): "true"})
	if len(enabled) != 2 {
		t.Errorf("both immersive plugins should be enabled, got %v", enabled)
	}
}

func TestIsLockedOff(t *testing.T) {
	// Single-member core area: the sole plugin is always locked.
	if !IsLockedOff("media-library", map[string]string{}) {
		t.Errorf("media-library should be locked off (sole core plugin)")
	}
	// Non-core plugin is never locked.
	if IsLockedOff("timeline", map[string]string{}) {
		t.Errorf("non-core plugin must never be locked")
	}
	// Immersive (Standard) is the only enabled member by default → locked.
	if !IsLockedOff("immersive", map[string]string{}) {
		t.Errorf("immersive should be locked when it is the only enabled viewer")
	}
	// With Sheet also enabled, neither is locked.
	both := map[string]string{EnabledKey("immersive-sheet"): "true"}
	if IsLockedOff("immersive", both) || IsLockedOff("immersive-sheet", both) {
		t.Errorf("with both viewers enabled, neither should be locked")
	}
	// A disabled plugin is never "locked off".
	if IsLockedOff("immersive-sheet", map[string]string{}) {
		t.Errorf("disabled plugin must not be reported locked")
	}
}

func TestExclusivePeers(t *testing.T) {
	// tags-atlas is in the exclusive "tags-viz" area; its peers are the other two.
	peers := ExclusivePeers("tags-atlas")
	want := map[string]bool{"tags-map": true, "tags-graph": true}
	if len(peers) != len(want) {
		t.Fatalf("tags-atlas peers = %v, want %d members", peers, len(want))
	}
	for _, p := range peers {
		if !want[p] {
			t.Errorf("unexpected peer %q", p)
		}
	}
	// Non-exclusive plugin (core area) has no exclusive peers.
	if got := ExclusivePeers("immersive"); got != nil {
		t.Errorf("core-area plugin should have no exclusive peers, got %v", got)
	}
	// Plain plugin with no area at all.
	if got := ExclusivePeers("timeline"); got != nil {
		t.Errorf("area-less plugin should have no exclusive peers, got %v", got)
	}
	// Unknown id.
	if got := ExclusivePeers("does-not-exist"); got != nil {
		t.Errorf("unknown plugin should have no exclusive peers, got %v", got)
	}
}

func TestDefaultPresets(t *testing.T) {
	presets := DefaultPresets()
	for _, id := range []string{"minimalistic", "standalone", "fully-featured"} {
		if _, ok := presets[id]; !ok {
			t.Errorf("missing default preset %q", id)
		}
	}
	if len(presets["fully-featured"]) != len(Registry) {
		t.Errorf("fully-featured should include every plugin")
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
