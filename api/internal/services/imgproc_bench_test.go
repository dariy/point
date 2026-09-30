package services

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"path/filepath"
	"testing"
)

// benchJPEG is a 24 MP camera-sized JPEG with a gradient, so the encoder and
// the resampler do real work.
func benchJPEG(b *testing.B) []byte {
	b.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 6000, 4000))
	for y := 0; y < 4000; y++ {
		for x := 0; x < 6000; x++ {
			img.SetRGBA(x, y, color.RGBA{uint8(x), uint8(y), uint8(x ^ y), 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
		b.Fatal(err)
	}
	return buf.Bytes()
}

// BenchmarkDecodeAndLadder measures one upload's image work: decode, then
// every rung resized and written as a JPEG.
func BenchmarkDecodeAndLadder(b *testing.B) {
	data := benchJPEG(b)
	dir := b.TempDir()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		src, err := safeImagingDecode(bytes.NewReader(data))
		if err != nil {
			b.Fatal(err)
		}
		for _, img := range fitLadder(src, VariantSizes) {
			if err := saveJPEGWithICC(img, filepath.Join(dir, "v.jpg"), nil, 85); err != nil {
				b.Fatal(err)
			}
		}
	}
}
