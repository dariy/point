package api

import (
	"database/sql"
	"strings"
	"testing"

	"point-api/internal/models"
	"point-api/internal/services"
)

func img(path string, w, h int64) models.Medium {
	return models.Medium{
		OriginalPath: "originals" + path,
		FileType:     "image",
		Width:        sql.NullInt64{Int64: w, Valid: true},
		Height:       sql.NullInt64{Int64: h, Valid: true},
	}
}

// A landscape source wider than the whole ladder gets every rung plus the
// original, and the descriptors on a landscape source are the rungs.
func TestArticleSrcset_Landscape(t *testing.T) {
	got := articleSrcset("/2026/03/photo.jpg", imageDims{width: 4000, height: 3000}, "abc")
	want := "/2026/03/photo.jpg?s=128&v=abc 128w, " +
		"/2026/03/photo.jpg?s=256&v=abc 256w, " +
		"/2026/03/photo.jpg?s=512&v=abc 512w, " +
		"/2026/03/photo.jpg?s=1024&v=abc 1024w, " +
		"/2026/03/photo.jpg 4000w"
	if got != want {
		t.Errorf("srcset = %q, want %q", got, want)
	}
}

// A portrait's rung caps its HEIGHT, so its width is rung*W/H — a 9:16 phone
// shot at rung 1024 is 576 wide, not 1024. Getting this wrong tells the
// browser every candidate is 1.78x wider than it is.
func TestArticleSrcset_PortraitDescriptorsAreRealWidths(t *testing.T) {
	got := articleSrcset("/2026/03/p.jpg", imageDims{width: 1080, height: 1920}, "abc")
	want := "/2026/03/p.jpg?s=128&v=abc 72w, " +
		"/2026/03/p.jpg?s=256&v=abc 144w, " +
		"/2026/03/p.jpg?s=512&v=abc 288w, " +
		"/2026/03/p.jpg?s=1024&v=abc 576w, " +
		"/2026/03/p.jpg 1080w"
	if got != want {
		t.Errorf("srcset = %q, want %q", got, want)
	}
}

// Rungs at or above the longest side are never written to disk — the route
// serves the original for them — so they must not be offered as candidates.
func TestArticleSrcset_DropsRungsAtOrAboveTheSource(t *testing.T) {
	got := articleSrcset("/2026/03/s.jpg", imageDims{width: 400, height: 300}, "abc")
	want := "/2026/03/s.jpg?s=128&v=abc 128w, " +
		"/2026/03/s.jpg?s=256&v=abc 256w, " +
		"/2026/03/s.jpg 400w"
	if got != want {
		t.Errorf("srcset = %q, want %q", got, want)
	}

	// Exactly on a rung: 512 would upscale nothing but duplicate the original.
	got = articleSrcset("/2026/03/e.jpg", imageDims{width: 512, height: 512}, "abc")
	if strings.Contains(got, "s=512") {
		t.Errorf("rung equal to the longest side was offered: %q", got)
	}
}

// A source smaller than the bottom rung has no variants at all, so a srcset
// would be a single candidate identical to src.
func TestArticleSrcset_TinySourceGetsNothing(t *testing.T) {
	if got := articleSrcset("/2026/03/t.jpg", imageDims{width: 100, height: 80}, "abc"); got != "" {
		t.Errorf("srcset = %q, want empty", got)
	}
}

// Without a generation token the URLs still resolve; they just cannot be
// pinned. VariantURL owns that rule — this only checks it is honoured here.
func TestArticleSrcset_NoGeneration(t *testing.T) {
	got := articleSrcset("/2026/03/p.jpg", imageDims{width: 300, height: 200}, "")
	if strings.Contains(got, "v=") {
		t.Errorf("expected no v= without a token, got %q", got)
	}
	if !strings.Contains(got, "/2026/03/p.jpg?s=128 128w") {
		t.Errorf("expected a bare rung URL, got %q", got)
	}
}

func TestInjectArticleSrcset(t *testing.T) {
	media := []models.Medium{img("/2026/03/photo.jpg", 4000, 3000)}
	in := `<p>Text.</p><img src="/2026/03/photo.jpg" alt="a" loading="lazy" decoding="async">`
	out := injectArticleSrcset(in, media, "gen1")

	if !strings.Contains(out, `src="/2026/03/photo.jpg"`) {
		t.Errorf("src no longer points at the bare original: %q", out)
	}
	if !strings.Contains(out, `sizes="`+articleImageSizes+`"`) {
		t.Errorf("sizes missing: %q", out)
	}
	// & in an attribute value must be escaped, or a browser is entitled to
	// read `&v=` as a character reference.
	if !strings.Contains(out, "&amp;v=gen1") || strings.Contains(out, "&v=gen1") {
		t.Errorf("srcset ampersands not escaped: %q", out)
	}
	if !strings.Contains(out, `alt="a"`) || !strings.Contains(out, `loading="lazy"`) ||
		!strings.Contains(out, `decoding="async"`) {
		t.Errorf("existing attributes lost: %q", out)
	}
	if !strings.Contains(out, "<p>Text.</p>") {
		t.Errorf("surrounding markup lost: %q", out)
	}
	if strings.Contains(out, "<picture") {
		t.Errorf("emitted a <picture>, which postMedia.js cannot parse: %q", out)
	}
}

func TestInjectArticleSrcset_LeavesUnknownImagesAlone(t *testing.T) {
	media := []models.Medium{img("/2026/03/known.jpg", 2000, 1500)}
	cases := map[string]string{
		"unknown path":    `<img src="/2026/03/other.jpg">`,
		"external":        `<img src="https://example.com/x.jpg">`,
		"no src":          `<img alt="broken">`,
		"already has one": `<img src="/2026/03/known.jpg" srcset="/x.jpg 1w">`,
		"legacy ?thumb":   `<img src="/2026/03/other.jpg?thumb">`,
	}
	for name, in := range cases {
		if got := injectArticleSrcset(in, media, "g"); got != in {
			t.Errorf("%s: rewrote %q to %q", name, in, got)
		}
	}
}

// A stored path that still carries the legacy `?thumb` is the same media row;
// the lookup is on the bare path, and src is left exactly as it was.
func TestInjectArticleSrcset_LegacyThumbQuery(t *testing.T) {
	media := []models.Medium{img("/2026/03/photo.jpg", 2000, 1500)}
	out := injectArticleSrcset(`<img src="/2026/03/photo.jpg?thumb">`, media, "g")
	if !strings.Contains(out, `src="/2026/03/photo.jpg?thumb"`) {
		t.Errorf("src was rewritten: %q", out)
	}
	if !strings.Contains(out, `srcset="`) {
		t.Errorf("no srcset for a legacy ?thumb src: %q", out)
	}
	if strings.Contains(out, "thumb?s=") || strings.Contains(out, "?thumb&") {
		t.Errorf("candidate URL kept the legacy query: %q", out)
	}
}

// Rows with no recorded dimensions, and non-images, cannot yield an honest
// descriptor and must be skipped rather than guessed at.
func TestArticleImageDims_SkipsUnusableRows(t *testing.T) {
	dims := articleImageDims([]models.Medium{
		{OriginalPath: "originals/2026/03/novideo.mp4", FileType: "video",
			Width: sql.NullInt64{Int64: 1920, Valid: true}, Height: sql.NullInt64{Int64: 1080, Valid: true}},
		{OriginalPath: "originals/2026/03/nodims.jpg", FileType: "image"},
		{OriginalPath: "originals/2026/03/zero.jpg", FileType: "image",
			Width: sql.NullInt64{Int64: 0, Valid: true}, Height: sql.NullInt64{Int64: 0, Valid: true}},
		img("/2026/03/ok.jpg", 800, 600),
	})
	if len(dims) != 1 {
		t.Fatalf("dims = %v, want only the usable image", dims)
	}
	if d := dims["/2026/03/ok.jpg"]; d.width != 800 || d.height != 600 {
		t.Errorf("dims = %+v", d)
	}
}

// The rendered body is what the immersive viewer parses, so the injection must
// survive a round trip through the real renderer, not just a hand-written tag.
func TestInjectArticleSrcset_OnRenderedContent(t *testing.T) {
	svc := services.NewPostService(nil, nil, nil, nil, "")
	rendered, err := svc.RenderContent("/2026/03/photo.jpg")
	if err != nil {
		t.Fatalf("RenderContent: %v", err)
	}
	out := injectArticleSrcset(rendered, []models.Medium{img("/2026/03/photo.jpg", 4000, 3000)}, "g")
	if !strings.Contains(out, `srcset="`) || !strings.Contains(out, `sizes="`) {
		t.Errorf("no candidates on rendered content: %q", out)
	}
	if !strings.Contains(out, `src="/2026/03/photo.jpg"`) {
		t.Errorf("src changed: %q", out)
	}
	if !strings.Contains(out, `loading="lazy"`) || !strings.Contains(out, `decoding="async"`) {
		t.Errorf("loading hints lost: %q", out)
	}
	// Idempotent: a second pass must not stack a second srcset.
	if again := injectArticleSrcset(out, []models.Medium{img("/2026/03/photo.jpg", 4000, 3000)}, "g"); again != out {
		t.Errorf("second pass changed the output:\n%q\n%q", out, again)
	}
}
