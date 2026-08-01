package api

import "testing"

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
