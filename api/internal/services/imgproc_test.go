package services

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"testing"
)

// TestFitSizeRule pins the truncation rule that articleSrcset (srcset.go) and
// thumbSrcset (mediaUrl.js) copy: the long side is the rung, the short side
// is int(rung * short/long).
func TestFitSizeRule(t *testing.T) {
	cases := []struct{ w, h, box, wantW, wantH int }{
		{4000, 3000, 1024, 1024, 768},
		{3000, 4000, 1024, 768, 1024},
		{4032, 3024, 512, 512, 384},
		{3024, 4032, 256, 192, 256},
		{3000, 4001, 512, 383, 512}, // 383.9: truncated, not rounded
		{1000, 1000, 128, 128, 128},
		{5000, 3, 128, 128, 1},     // never below 1
		{800, 600, 1024, 800, 600}, // no upscale
	}
	for _, c := range cases {
		w, h := fitSize(c.w, c.h, c.box, c.box)
		if w != c.wantW || h != c.wantH {
			t.Errorf("fitSize(%d×%d, %d) = %d×%d, want %d×%d", c.w, c.h, c.box, w, h, c.wantW, c.wantH)
		}
		longest := max(c.w, c.h)
		if c.box < longest {
			// The srcset.go expression for the width descriptor.
			if d := max(int(float64(c.box)*(float64(c.w)/float64(longest))), 1); d != w {
				t.Errorf("%d×%d at %d: srcset descriptor %d, resize width %d", c.w, c.h, c.box, d, w)
			}
		}
	}
}

func TestFitImageKeepsSmallSource(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 100, 50))
	if got := fitImage(src, 128, 128); got != image.Image(src) {
		t.Fatal("fitImage upscaled or copied a source that fits")
	}
	if b := fitImage(src, 64, 64).Bounds(); b.Dx() != 64 || b.Dy() != 32 {
		t.Fatalf("got %v, want 64×32", b)
	}
}

// exifJPEG returns a w×h JPEG with a red top-left pixel block and an APP1
// segment that sets Orientation to o.
func exifJPEG(t *testing.T, w, h, o int, bigEndian bool) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			c := color.RGBA{0, 0, 255, 255}
			if x < w/4 && y < h/4 {
				c = color.RGBA{255, 0, 0, 255}
			}
			img.SetRGBA(x, y, c)
		}
	}
	var enc bytes.Buffer
	if err := jpeg.Encode(&enc, img, &jpeg.Options{Quality: 95}); err != nil {
		t.Fatal(err)
	}
	var tiff []byte
	if bigEndian {
		tiff = []byte{'M', 'M', 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, byte(o), 0, 0, 0, 0, 0, 0}
	} else {
		tiff = []byte{'I', 'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, byte(o), 0, 0, 0, 0, 0, 0, 0}
	}
	seg := append([]byte("Exif\x00\x00"), tiff...)
	n := len(seg) + 2
	out := append([]byte{0xFF, 0xD8, 0xFF, 0xE1, byte(n >> 8), byte(n)}, seg...)
	return append(out, enc.Bytes()[2:]...)
}

func TestDecodeOrientedAppliesEXIF(t *testing.T) {
	// Where the red block of the stored image lands after each orientation,
	// as a corner of the displayed image: 0 top-left, 1 top-right,
	// 2 bottom-left, 3 bottom-right.
	corner := map[int]int{1: 0, 2: 1, 3: 3, 4: 2, 5: 0, 6: 1, 7: 3, 8: 2}
	for o := 1; o <= 8; o++ {
		for _, be := range []bool{false, true} {
			img, err := safeImagingDecode(bytes.NewReader(exifJPEG(t, 80, 40, o, be)))
			if err != nil {
				t.Fatalf("o=%d: %v", o, err)
			}
			b := img.Bounds()
			wantW, wantH := 80, 40
			if o >= 5 {
				wantW, wantH = 40, 80
			}
			if b.Dx() != wantW || b.Dy() != wantH {
				t.Fatalf("o=%d: size %v, want %d×%d", o, b.Size(), wantW, wantH)
			}
			pts := []image.Point{{2, 2}, {wantW - 3, 2}, {2, wantH - 3}, {wantW - 3, wantH - 3}}
			for i, p := range pts {
				r, _, _, _ := img.At(b.Min.X+p.X, b.Min.Y+p.Y).RGBA()
				if red := r > 0x8000; red != (i == corner[o]) {
					t.Errorf("o=%d be=%v: corner %d red=%v", o, be, i, red)
				}
			}
		}
	}
}
