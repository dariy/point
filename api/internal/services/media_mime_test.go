package services

import (
	"bytes"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"testing"
)

func TestDetectMediaType_RealEncoders(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))

	var jpg bytes.Buffer
	_ = jpeg.Encode(&jpg, img, nil)
	var p bytes.Buffer
	_ = png.Encode(&p, img)
	var g bytes.Buffer
	_ = gif.Encode(&g, img, nil)

	cases := []struct {
		name     string
		content  []byte
		declared string
		want     string
	}{
		{"jpeg", jpg.Bytes(), "image/jpeg", "image/jpeg"},
		{"png", p.Bytes(), "image/png", "image/png"},
		{"gif", g.Bytes(), "image/gif", "image/gif"},
		// Content wins over a lying client header.
		{"jpeg declared as html", jpg.Bytes(), "text/html", "image/jpeg"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := DetectMediaType(tc.content, tc.declared)
			if err != nil {
				t.Fatalf("DetectMediaType: %v", err)
			}
			if got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestDetectMediaType_MagicByteFixtures(t *testing.T) {
	// Minimal magic-byte prefixes padded to satisfy the 12-byte minimum.
	pad := func(b []byte) []byte {
		if len(b) < 16 {
			b = append(b, make([]byte, 16-len(b))...)
		}
		return b
	}
	riff := func(fourcc string) []byte {
		b := append([]byte("RIFF\x00\x00\x00\x00"), []byte(fourcc)...)
		return pad(b)
	}
	ftyp := func(brand string) []byte {
		return pad(append([]byte("\x00\x00\x00\x20ftyp"), []byte(brand)...))
	}

	cases := []struct {
		name     string
		content  []byte
		declared string
		want     string
		wantErr  bool
	}{
		{"webp", riff("WEBP"), "", "image/webp", false},
		{"avi", riff("AVI "), "", "video/x-msvideo", false},
		{"wav", riff("WAVE"), "", "audio/wav", false},
		{"bmp", pad([]byte("BM\x00\x00")), "", "image/bmp", false},
		{"flac", pad([]byte("fLaC\x00\x00")), "", "audio/flac", false},
		{"ogg opus", pad(append([]byte("OggS\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00OpusHead"), 0)), "", "audio/ogg", false},
		{"mp4 isom", ftyp("isom"), "video/mp4", "video/mp4", false},
		{"quicktime", ftyp("qt  "), "", "video/quicktime", false},
		{"m4a", ftyp("M4A "), "audio/mp4", "audio/mp4", false},
		{"heic", ftyp("heic"), "", "image/heic", false},
		{"avif", ftyp("avif"), "", "image/avif", false},
		{"mkv webm", pad(append([]byte("\x1a\x45\xdf\xa3"), []byte("....webm....")...)), "", "video/webm", false},
		{"svg", []byte(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>`), "image/svg+xml", "image/svg+xml", false},
		// Rejections.
		{"html", []byte("<!doctype html><html><body>hi</body></html>"), "image/jpeg", "", true},
		{"plain text", []byte("just some plain text that is long enough"), "text/plain", "", true},
		{"pdf", pad([]byte("%PDF-1.7\x00\x00")), "application/pdf", "", true},
		{"elf binary", pad([]byte("\x7fELF\x02\x01\x01\x00")), "", "", true},
		{"too short", []byte("hi"), "image/jpeg", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := DetectMediaType(tc.content, tc.declared)
			if tc.wantErr {
				if err == nil {
					t.Errorf("expected rejection, got %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("DetectMediaType: %v", err)
			}
			if got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestMediaTypeCategory(t *testing.T) {
	cases := map[string]string{
		"image/jpeg":        "image",
		"image/svg+xml":     "image",
		"video/mp4":         "video",
		"audio/mpeg":        "audio",
		"image/jpeg; q=0.9": "image", // parameters stripped
		"application/pdf":   "",
		"text/html":         "",
	}
	for mime, want := range cases {
		if got := MediaTypeCategory(mime); got != want {
			t.Errorf("MediaTypeCategory(%q) = %q, want %q", mime, got, want)
		}
	}
}
