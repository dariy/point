//go:build !unit

package api

import (
	"os"
	"strings"
	"testing"
)

// TestFetchLatestGitHubTag_Live is the canary for the upstream contract: it
// proves the tags endpoint still answers and still yields a usable version.
//
// It is opt-in via POINT_NETWORK_TESTS=1 rather than part of the normal run —
// unauthenticated GitHub API calls are rate-limited to 60/hour per IP, which
// shared CI runners exhaust, and a red build from someone else's quota is worse
// than no signal. pickLatestSemverTag and the rest of the parsing are covered
// hermetically in system_version_test.go.
func TestFetchLatestGitHubTag_Live(t *testing.T) {
	if os.Getenv("POINT_NETWORK_TESTS") != "1" {
		t.Skip("set POINT_NETWORK_TESTS=1 to run tests that call the live GitHub API")
	}

	tag, err := fetchLatestGitHubTag()
	if err != nil {
		t.Fatalf("fetchLatestGitHubTag failed: %v", err)
	}
	if !strings.HasPrefix(tag, "v") {
		t.Errorf("expected tag to start with 'v', got %q", tag)
	}
	if _, _, _, ok := parseSemver(tag); !ok {
		t.Errorf("expected a parseable semver tag, got %q", tag)
	}
}
