package services

import (
	"strings"
	"testing"
)

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

	for _, want := range []string{
		`<div class="carousel-block">`,
		`<img src="/2026/08/a.jpg"`,
		`<img src="/2026/08/b.jpg"`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("RenderContent(%q) = %q\n  missing %q", in, got, want)
		}
	}

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
