//go:build !unit

package services

import (
	"context"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// The fixtures are 600x400 gradients from cwebp: one lossy (VP8), one
// lossless (VP8L). Both need the golang.org/x/image/webp registration.
func TestUpload_WebPStoresSizeAndLadder(t *testing.T) {
	for _, name := range []string{"lossy.webp", "lossless.webp"} {
		t.Run(name, func(t *testing.T) {
			svc, tmpDir := setupMediaService(t)
			defer func() { _ = os.RemoveAll(tmpDir) }()
			ctx := context.Background()

			data, err := os.ReadFile(filepath.Join("testdata", name))
			if err != nil {
				t.Fatal(err)
			}
			m, err := svc.UploadFile(ctx, UploadFileParams{Content: data, Filename: name, MimeType: "image/webp"})
			if err != nil {
				t.Fatalf("UploadFile: %v", err)
			}
			if m.Width.Int64 != 600 || m.Height.Int64 != 400 {
				t.Errorf("stored size = %dx%d, want 600x400", m.Width.Int64, m.Height.Int64)
			}
			path, err := svc.Variant(ctx, m, 128)
			if err != nil {
				t.Fatalf("Variant: %v", err)
			}
			if w, h := variantDims(t, path); w != 128 || h != 85 {
				t.Errorf("rung 128 = %dx%d, want 128x85", w, h)
			}
		})
	}
}

// A WebP row stored before the decoder existed has no size. The first lazy
// variant decode fills it in.
func TestVariant_BackfillsWebPDimensions(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir) }()
	ctx := context.Background()

	data, err := os.ReadFile(filepath.Join("testdata", "lossy.webp"))
	if err != nil {
		t.Fatal(err)
	}
	m, err := svc.UploadFile(ctx, UploadFileParams{Content: data, Filename: "old.webp", MimeType: "image/webp"})
	if err != nil {
		t.Fatalf("UploadFile: %v", err)
	}
	// Simulate the old row: no size, no ladder.
	if err := svc.repo.SetMediaDimensions(ctx, m.ID, 0, 0); err != nil {
		t.Fatal(err)
	}
	svc.purgeVariants()
	m, err = svc.repo.GetMedia(ctx, m.ID)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := svc.Variant(ctx, m, 128); err != nil {
		t.Fatalf("Variant: %v", err)
	}
	got, err := svc.repo.GetMedia(ctx, m.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Width.Int64 != 600 || got.Height.Int64 != 400 {
		t.Errorf("backfilled size = %dx%d, want 600x400", got.Width.Int64, got.Height.Int64)
	}
}

// hugeHeaderWebP is a VP8X header that claims a w x h canvas and carries no
// image data.
func hugeHeaderWebP(w, h int) []byte {
	vp8x := make([]byte, 10)
	put24 := func(b []byte, v int) { b[0], b[1], b[2] = byte(v), byte(v>>8), byte(v>>16) }
	put24(vp8x[4:], w-1)
	put24(vp8x[7:], h-1)

	out := []byte("RIFF\x00\x00\x00\x00WEBPVP8X")
	out = binary.LittleEndian.AppendUint32(out, uint32(len(vp8x)))
	out = append(out, vp8x...)
	binary.LittleEndian.PutUint32(out[4:], uint32(len(out)-8))
	return out
}

func TestDecodeImage_WebPPixelGuard(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir) }()

	_, err := svc.decodeImage(context.Background(), hugeHeaderWebP(16000, 16000))
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
}
