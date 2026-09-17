package services

import (
	"strings"
	"testing"
)

// assertRendered fails once per fragment RenderContent(in) should have produced
// but did not, quoting the whole output so the diff is readable.
func assertRendered(t *testing.T, in, got string, want ...string) {
	t.Helper()
	for _, w := range want {
		if !strings.Contains(got, w) {
			t.Errorf("RenderContent(%q) = %q\n  missing %q", in, got, w)
		}
	}
}

// TestRenderContent_CarouselBlock pins the render contract the Carousel Studio
// feature is built on: a :::{.carousel-block} fence wrapping bare media paths
// must render to a <div class="carousel-block"> containing one <img> per path.
//
// Nothing in the render pipeline is carousel-specific — this exercises
// goldmark-fences + goldmark-attributes (post_render.go), preprocessContent's
// bare-path expansion, and the bluemonday div/class allowlist together. If this
// test breaks, the output contract in docs/features/carousel-studio.md is void.
func TestRenderContent_CarouselBlock(t *testing.T) {
	svc := NewPostService(nil, nil, nil, nil, "")

	const in = ":::{.carousel-block}\n\n/2026/08/a.jpg\n\n/2026/08/b.jpg\n\n:::"
	got, err := svc.RenderContent(in)
	if err != nil {
		t.Fatalf("RenderContent returned error: %v", err)
	}

	assertRendered(t, in, got,
		`<div class="carousel-block">`,
		`<img src="/2026/08/a.jpg"`,
		`<img src="/2026/08/b.jpg"`,
	)

	// The <img> tags must be *inside* the div, not siblings emitted before or
	// after it.
	openIdx := strings.Index(got, `<div class="carousel-block">`)
	closeIdx := strings.LastIndex(got, "</div>")
	if openIdx < 0 || closeIdx < 0 || closeIdx < openIdx {
		t.Fatalf("RenderContent(%q) = %q\n  no well-formed <div>…</div>", in, got)
	}
	inner := got[openIdx:closeIdx]
	if strings.Count(inner, "<img ") != 2 {
		t.Errorf("RenderContent(%q): want 2 <img> inside the div, got %d\n  inner = %q",
			in, strings.Count(inner, "<img "), inner)
	}

	// A keyed fence — :::{.carousel-block #c-7f3a} — is how a post addresses one
	// carousel among several. Nothing downstream may key off the fence being
	// bare: the class still has to land, the id has to survive bluemonday, and
	// the slides still render through the same generic pipeline.
	t.Run("keyed fence", func(t *testing.T) {
		const keyed = ":::{.carousel-block #c-7f3a}\n\n/2026/08/a.jpg\n\n/2026/08/b.jpg\n\n:::"
		got, err := svc.RenderContent(keyed)
		if err != nil {
			t.Fatalf("RenderContent returned error: %v", err)
		}
		assertRendered(t, keyed, got,
			`class="carousel-block"`,
			`id="c-7f3a"`,
			`<img src="/2026/08/a.jpg"`,
			`<img src="/2026/08/b.jpg"`,
		)
		if n := strings.Count(got, "<img "); n != 2 {
			t.Errorf("RenderContent(%q): want 2 <img>, got %d\n  %q", keyed, n, got)
		}
	})
}

// TestRenderContent_CarouselBlock_BlankLineContract records *why* the block
// writer (a later bead) must emit a blank line between paths: html.WithHardWraps()
// is enabled (post_render.go), so consecutive bare paths land in ONE <p> joined
// by <br> instead of a <p> per image. The splitter must match the "blank line
// between paths" form asserted above.
func TestRenderContent_CarouselBlock_BlankLineContract(t *testing.T) {
	svc := NewPostService(nil, nil, nil, nil, "")

	withBlanks := ":::{.carousel-block}\n\n/2026/08/a.jpg\n\n/2026/08/b.jpg\n\n:::"
	got, err := svc.RenderContent(withBlanks)
	if err != nil {
		t.Fatalf("RenderContent returned error: %v", err)
	}
	if n := strings.Count(got, "<p>"); n != 2 {
		t.Errorf("blank-line-separated paths: want 2 <p>, got %d\n  %q", n, got)
	}
	if strings.Contains(got, "<br") {
		t.Errorf("blank-line-separated paths should not be <br>-joined\n  %q", got)
	}

	noBlanks := ":::{.carousel-block}\n/2026/08/a.jpg\n/2026/08/b.jpg\n:::"
	got, err = svc.RenderContent(noBlanks)
	if err != nil {
		t.Fatalf("RenderContent returned error: %v", err)
	}
	if n := strings.Count(got, "<p>"); n != 1 || !strings.Contains(got, "<br") {
		t.Errorf("adjacent paths collapse into one <br>-joined <p> (WithHardWraps); "+
			"got %d <p>, <br> present=%v\n  %q", n, strings.Contains(got, "<br"), got)
	}
}

// TestCarouselFenceFlattensIntoMediaPaths pins the reversal of decision C8.
// A :::{.carousel-block} fence used to be THE Instagram carousel, selected by
// carouselBlockPaths, which dropped the post's loose photos. Several carousels
// per post make "the carousel" undefined, so the fence is now nothing special
// to path extraction: its slides are content paths like any other, in document
// order, deduped once.
func TestCarouselFenceFlattensIntoMediaPaths(t *testing.T) {
	content := "![loose](/2026/06/a.jpg)\n\n" +
		":::{.carousel-block}\n\n/2026/06/s1.jpg\n\n/2026/06/s2.jpg\n\n:::\n\n" +
		"![loose](/2026/06/b.jpg)\n\n" +
		":::{.carousel-block}\n\n/2026/06/s3.jpg\n\n/2026/06/s1.jpg\n\n:::"

	want := []string{
		"originals/2026/06/a.jpg",
		"originals/2026/06/s1.jpg",
		"originals/2026/06/s2.jpg",
		"originals/2026/06/b.jpg",
		"originals/2026/06/s3.jpg",
	}
	got := ExtractMediaPaths(content, "")
	if len(got) != len(want) {
		t.Fatalf("want %v, got %v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("path %d: want %q, got %q", i, want[i], got[i])
		}
	}
}
