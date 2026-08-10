package api

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"point-api/internal/services"
)

func TestPickLatestSemverTag(t *testing.T) {
	tags := func(names ...string) []githubTag {
		out := make([]githubTag, 0, len(names))
		for _, n := range names {
			out = append(out, githubTag{Name: n})
		}
		return out
	}

	cases := []struct {
		name string
		in   []githubTag
		want string
	}{
		{"empty", nil, ""},
		{"single", tags("v0.1.42"), "v0.1.42"},
		// GitHub orders tags by commit date, so a tag cut later on an older
		// branch lands at index 0 while not being the latest version.
		{"out of order", tags("v0.1.30", "v0.1.42", "v0.1.41"), "v0.1.42"},
		// Double-digit patches must not be compared as strings.
		{"numeric compare", tags("v0.1.9", "v0.1.10"), "v0.1.10"},
		// The repo carries a legacy two-part "v0.1" tag that must be ignored.
		{"skips unparseable", tags("v0.1", "nightly", "v0.1.2"), "v0.1.2"},
		{"no parseable tags", tags("v0.1", "nightly"), ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := pickLatestSemverTag(tc.in); got != tc.want {
				t.Errorf("pickLatestSemverTag() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestWithSlimSuffix(t *testing.T) {
	cases := []struct{ in, want string }{
		{"v0.1.42", "v0.1.42-slim"},
		{"v0.1.42-slim", "v0.1.42-slim"},
		{"dev", "dev"},
		{"", ""},
	}
	for _, tc := range cases {
		if got := withSlimSuffix(tc.in); got != tc.want {
			t.Errorf("withSlimSuffix(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// The -slim suffix must not make an equal version look like an upgrade, and
// must not mask a real one — the update banner compares the two decorated
// strings, so the suffix has to be transparent to the comparison.
func TestSemverGreaterThan_SlimSuffix(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"v0.1.43-slim", "v0.1.42-slim", true},
		{"v0.1.42-slim", "v0.1.42-slim", false},
		{"v0.1.42-slim", "v0.1.43-slim", false},
		{"v0.1.10-slim", "v0.1.9-slim", true},
		{"v0.2.0", "v0.1.42", true},
	}
	for _, tc := range cases {
		if got := semverGreaterThan(tc.a, tc.b); got != tc.want {
			t.Errorf("semverGreaterThan(%q, %q) = %v, want %v", tc.a, tc.b, got, tc.want)
		}
	}
}

// newVersionTestHandler wires a SystemHandler with just enough for
// versionStatus: a real settings service over an in-memory DB.
func newVersionTestHandler(t *testing.T, appVersion string) *SystemHandler {
	t.Helper()
	repo := setupTestDB(t)
	t.Cleanup(func() { _ = repo.Close() })
	return &SystemHandler{
		settingsService: services.NewSettingsService(repo),
		appVersion:      appVersion,
	}
}

// stubUpstream replaces the GitHub lookup for one test and counts its calls.
func stubUpstream(t *testing.T, tag string, err error) *int {
	t.Helper()
	calls := 0
	prev := fetchLatestTag
	fetchLatestTag = func() (string, error) {
		calls++
		return tag, err
	}
	t.Cleanup(func() { fetchLatestTag = prev })
	return &calls
}

// seedCache writes the stored upstream answer as if a check had run at `when`.
func seedCache(t *testing.T, h *SystemHandler, latest string, when time.Time) {
	t.Helper()
	b, err := json.Marshal(versionCheckCache{Latest: latest, CheckedAt: when})
	if err != nil {
		t.Fatalf("marshal cache: %v", err)
	}
	if err := h.settingsService.SetSetting(context.Background(), "_version_check_cached", string(b), "string"); err != nil {
		t.Fatalf("seed cache: %v", err)
	}
}

// The daily cache is what keeps Point off GitHub's 60/hour anonymous limit: an
// answer younger than 24h must be served as-is, with no call out.
func TestVersionStatus_ServesFreshCache(t *testing.T) {
	h := newVersionTestHandler(t, "v0.1.42")
	seedCache(t, h, "v0.1.43", time.Now().Add(-time.Hour))
	calls := stubUpstream(t, "v9.9.9", nil)

	out := h.versionStatus(context.Background(), false)

	if *calls != 0 {
		t.Errorf("fresh cache must not call upstream, got %d calls", *calls)
	}
	if out["latest"] != "v0.1.43" {
		t.Errorf("latest = %v, want v0.1.43", out["latest"])
	}
	if out["fetched"] != false {
		t.Errorf("fetched = %v, want false", out["fetched"])
	}
	if out["update_available"] != true {
		t.Errorf("update_available = %v, want true", out["update_available"])
	}
}

// The manual check exists to prove the plugin still works, so it must ignore a
// cache the normal endpoint would have been happy with.
func TestVersionStatus_ForceBypassesCache(t *testing.T) {
	h := newVersionTestHandler(t, "v0.1.42")
	seedCache(t, h, "v0.1.42", time.Now().Add(-time.Hour))
	calls := stubUpstream(t, "v0.1.43", nil)

	out := h.versionStatus(context.Background(), true)

	if *calls != 1 {
		t.Errorf("force must call upstream exactly once, got %d", *calls)
	}
	if out["latest"] != "v0.1.43" {
		t.Errorf("latest = %v, want v0.1.43", out["latest"])
	}
	if out["fetched"] != true {
		t.Errorf("fetched = %v, want true", out["fetched"])
	}
	// The refreshed answer must be persisted, or every page load re-checks.
	next := h.versionStatus(context.Background(), false)
	if *calls != 1 {
		t.Errorf("forced check did not persist: upstream called %d times", *calls)
	}
	if next["latest"] != "v0.1.43" {
		t.Errorf("cached latest = %v, want v0.1.43", next["latest"])
	}
}

// A failed check must report the reason (that is the whole point of asking)
// without discarding the last known-good answer — otherwise a flaky network
// would quietly turn "update available" into "you're up to date".
func TestVersionStatus_FetchErrorKeepsLastKnown(t *testing.T) {
	h := newVersionTestHandler(t, "v0.1.42")
	checkedAt := time.Now().Add(-time.Hour).UTC().Truncate(time.Second)
	seedCache(t, h, "v0.1.43", checkedAt)
	stubUpstream(t, "", errors.New("GitHub API returned 403"))

	out := h.versionStatus(context.Background(), true)

	if out["error"] != "GitHub API returned 403" {
		t.Errorf("error = %v, want the upstream failure", out["error"])
	}
	if out["fetched"] != false {
		t.Errorf("fetched = %v, want false", out["fetched"])
	}
	if out["latest"] != "v0.1.43" {
		t.Errorf("latest = %v, want the retained v0.1.43", out["latest"])
	}
	if out["update_available"] != true {
		t.Errorf("update_available = %v, want true", out["update_available"])
	}
	// checked_at still reports the last *successful* check, not this attempt.
	got, ok := out["checked_at"].(time.Time)
	if !ok || !got.Equal(checkedAt) {
		t.Errorf("checked_at = %v, want the previous %v", out["checked_at"], checkedAt)
	}
}

// With no cache and no reachable upstream there is simply no answer: an empty
// `latest` must never be compared into a spurious update banner.
func TestVersionStatus_NoCacheNoNetwork(t *testing.T) {
	h := newVersionTestHandler(t, "v0.1.42")
	stubUpstream(t, "", errors.New("dial tcp: lookup api.github.com: no such host"))

	out := h.versionStatus(context.Background(), false)

	if out["latest"] != "" {
		t.Errorf("latest = %v, want empty", out["latest"])
	}
	if out["update_available"] != false {
		t.Errorf("update_available = %v, want false", out["update_available"])
	}
	if _, ok := out["checked_at"]; ok {
		t.Errorf("checked_at must be absent when no check ever succeeded, got %v", out["checked_at"])
	}
}
