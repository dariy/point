package services

import (
	"reflect"
	"testing"
)

func TestMediaPathRe(t *testing.T) {
	content := "![alt](</2026/08/my image.jpg>)\n![alt2](/2026/08/my%20image2.jpg)\n/2026/08/my bare image.jpg"
	matches := mediaPathRe.FindAllStringSubmatch(content, -1)
	var got []string
	for _, m := range matches {
		got = append(got, m[1])
	}
	want := []string{
		"/2026/08/my image.jpg",
		"/2026/08/my%20image2.jpg",
		"/2026/08/my bare image.jpg",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("mediaPathRe.FindAllStringSubmatch() = %q, want %q", got, want)
	}
}

func TestVariantURL(t *testing.T) {
	cases := []struct {
		name string
		path string
		size int
		gen  string
		want string
	}{
		{"bare path", "/2026/03/photo.jpg", 512, "c0ffee01", "/2026/03/photo.jpg?s=512&v=c0ffee01"},
		// Stored paths still carry the legacy `?thumb` — there is no data
		// migration behind them — so the existing query is dropped, never
		// appended to.
		{"legacy thumb query", "/2026/03/photo.jpg?thumb", 256, "c0ffee01", "/2026/03/photo.jpg?s=256&v=c0ffee01"},
		{"legacy sized thumb", "/2026/03/photo.jpg?thumb=128", 128, "c0ffee01", "/2026/03/photo.jpg?s=128&v=c0ffee01"},
		// No token still has to resolve: `v` only decides how long the response
		// may be cached, it never selects a file.
		{"no generation", "/2026/03/photo.jpg", 1024, "", "/2026/03/photo.jpg?s=1024"},
		{"token is escaped", "/2026/03/photo.jpg", 512, "a b&c", "/2026/03/photo.jpg?s=512&v=a+b%26c"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := VariantURL(tc.path, tc.size, tc.gen); got != tc.want {
				t.Errorf("VariantURL(%q, %d, %q) = %q, want %q", tc.path, tc.size, tc.gen, got, tc.want)
			}
		})
	}
}

func TestThumbnailGenerationFrom(t *testing.T) {
	if got := ThumbnailGenerationFrom(map[string]string{ThumbnailGenerationSetting: "c0ffee01"}); got != "c0ffee01" {
		t.Errorf("stored token = %q, want c0ffee01", got)
	}
	// A site that has never run a rebuild has no row; it must still serve a
	// usable token rather than an empty one.
	if got := ThumbnailGenerationFrom(map[string]string{}); got != DefaultThumbnailGeneration {
		t.Errorf("missing token = %q, want %q", got, DefaultThumbnailGeneration)
	}
	if got := ThumbnailGenerationFrom(map[string]string{ThumbnailGenerationSetting: ""}); got != DefaultThumbnailGeneration {
		t.Errorf("empty token = %q, want %q", got, DefaultThumbnailGeneration)
	}
}
