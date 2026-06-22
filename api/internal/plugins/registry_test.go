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
	manifest := BuildManifest(settings, chunks)

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
	manifest := BuildManifest(map[string]string{}, map[string]string{})
	if len(manifest) != len(Registry) {
		t.Fatalf("expected %d entries (all enabled), got %d", len(Registry), len(manifest))
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
	manifest := BuildManifest(settings, map[string]string{})
	if len(manifest) != 0 {
		t.Fatalf("expected empty manifest, got %d entries", len(manifest))
	}
	b, _ := json.Marshal(manifest)
	if s := string(b); s != "[]" {
		t.Errorf("expected [] manifest JSON, got %s", s)
	}
	for _, d := range Registry {
		b, _ := json.Marshal(BuildManifest(settings, map[string]string{}))
		if strings.Contains(string(b), d.ID) {
			t.Errorf("disabled plugin %q leaked into manifest JSON", d.ID)
		}
	}
}

func TestBuildManifest_JSONHasNoDefaultEnabledField(t *testing.T) {
	b, _ := json.Marshal(BuildManifest(map[string]string{}, map[string]string{}))
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

func TestRegistry_UniqueIDsAndAllDefaultEnabled(t *testing.T) {
	seen := map[string]bool{}
	for _, d := range Registry {
		if seen[d.ID] {
			t.Errorf("duplicate plugin id %q", d.ID)
		}
		seen[d.ID] = true
		if !d.DefaultEnabled {
			t.Errorf("Phase 1 ships all plugins enabled; %q is not DefaultEnabled", d.ID)
		}
	}
}
