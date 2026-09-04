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

// TestCarouselBlockPaths covers the "carousel block wins" selector that
// post_publish.go uses to decide an Instagram carousel: when a post carries a
// :::{.carousel-block} fence, only its slides ship — in fence order, in the DB
// "originals/…" form — and the post's other loose photos are dropped.
func TestCarouselBlockPaths(t *testing.T) {
	t.Run("no fence returns nil", func(t *testing.T) {
		if got := carouselBlockPaths("![a](/2026/06/a.jpg)\n![b](/2026/06/b.jpg)"); got != nil {
			t.Errorf("want nil, got %v", got)
		}
	})

	t.Run("fence slides only, in order", func(t *testing.T) {
		content := "![loose](/2026/06/loose.jpg)\n\n" +
			":::{.carousel-block}\n\n/2026/06/s1.jpg\n\n/2026/06/s2.jpg\n\n/2026/06/s3.jpg\n\n:::"
		got := carouselBlockPaths(content)
		want := []string{
			"originals/2026/06/s1.jpg",
			"originals/2026/06/s2.jpg",
			"originals/2026/06/s3.jpg",
		}
		if len(got) != len(want) {
			t.Fatalf("want %v, got %v", want, got)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Errorf("slide %d: want %q, got %q", i, want[i], got[i])
			}
		}
	})
}
