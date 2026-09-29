package services

import (
	"bytes"
	"compress/zlib"
	"context"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/jpeg"
	"image/png"
	"os"
	"testing"
)

// testICC builds a minimal ICC profile whose v2 'desc' tag reads name, padded
// to size bytes so a test can force a multi-segment profile.
func testICC(name string, size int) []byte {
	desc := make([]byte, 12+len(name)+1)
	copy(desc, "desc")
	binary.BigEndian.PutUint32(desc[8:], uint32(len(name)+1))
	copy(desc[12:], name)
	off := 128 + 4 + 12
	icc := make([]byte, max(size, off+len(desc)))
	binary.BigEndian.PutUint32(icc[0:], uint32(len(icc)))
	copy(icc[36:], "acsp")
	binary.BigEndian.PutUint32(icc[128:], 1)
	copy(icc[132:], "desc")
	binary.BigEndian.PutUint32(icc[136:], uint32(off))
	binary.BigEndian.PutUint32(icc[140:], uint32(len(desc)))
	copy(icc[off:], desc)
	for i := off + len(desc); i < len(icc); i++ {
		icc[i] = byte(i * 7)
	}
	return icc
}

// jpegWithICC encodes a w×h JPEG and embeds icc (if any) after SOI.
func jpegWithICC(t *testing.T, w, h int, icc []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, image.NewRGBA(image.Rect(0, 0, w, h)), nil); err != nil {
		t.Fatal(err)
	}
	enc := buf.Bytes()
	if icc == nil {
		return enc
	}
	return append(append(append([]byte{}, enc[:2]...), iccSegments(icc)...), enc[2:]...)
}

// countAPP2 counts ICC_PROFILE segments in a JPEG.
func countAPP2(data []byte) int {
	n := 0
	for i := 2; i+4 <= len(data) && data[i] == 0xFF && data[i+1] != 0xDA; {
		l := int(binary.BigEndian.Uint16(data[i+2:]))
		if data[i+1] == 0xE2 && bytes.HasPrefix(data[i+4:], iccMarker) {
			n++
		}
		i += 2 + l
	}
	return n
}

func TestExtractICC_JPEG(t *testing.T) {
	p3 := testICC("Display P3", 3000)
	if got := extractICC(jpegWithICC(t, 8, 8, p3)); !bytes.Equal(got, p3) {
		t.Errorf("single-segment profile: got %d bytes, want %d", len(got), len(p3))
	}

	big := testICC("Adobe RGB (1998)", 150_000)
	data := jpegWithICC(t, 8, 8, big)
	if n := countAPP2(data); n != 3 {
		t.Errorf("150 KB profile in %d segments, want 3", n)
	}
	if got := extractICC(data); !bytes.Equal(got, big) {
		t.Errorf("multi-segment profile did not round-trip")
	}

	if got := extractICC(jpegWithICC(t, 8, 8, nil)); got != nil {
		t.Errorf("untagged JPEG: got %d bytes, want nil", len(got))
	}
	if got := extractICC(jpegWithICC(t, 8, 8, testICC("sRGB IEC61966-2.1", 3000))); got != nil {
		t.Errorf("sRGB profile: got %d bytes, want nil", len(got))
	}
}

func TestExtractICC_PNG(t *testing.T) {
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 4, 4))); err != nil {
		t.Fatal(err)
	}
	p3 := testICC("Display P3", 3000)
	var z bytes.Buffer
	zw := zlib.NewWriter(&z)
	_, _ = zw.Write(p3)
	_ = zw.Close()
	body := append([]byte("ICC\x00\x00"), z.Bytes()...)
	chunk := make([]byte, 8, 12+len(body))
	binary.BigEndian.PutUint32(chunk, uint32(len(body)))
	copy(chunk[4:], "iCCP")
	chunk = append(chunk, body...)
	chunk = binary.BigEndian.AppendUint32(chunk, crc32.ChecksumIEEE(chunk[4:]))

	src := buf.Bytes()
	ihdrEnd := 8 + 12 + 13 // signature + IHDR
	data := append(append(append([]byte{}, src[:ihdrEnd]...), chunk...), src[ihdrEnd:]...)
	if got := extractICC(data); !bytes.Equal(got, p3) {
		t.Errorf("PNG iCCP: got %d bytes, want %d", len(got), len(p3))
	}
	if got := extractICC(src); got != nil {
		t.Errorf("untagged PNG: got %d bytes, want nil", len(got))
	}
}

// TestVariant_ICCProfile checks that every rung, eager or lazy, carries the
// source profile, and that an untagged source yields rungs without APP2.
func TestVariant_ICCProfile(t *testing.T) {
	svc, _ := setupMediaService(t)
	ctx := context.Background()
	p3 := testICC("Display P3", 3000)

	tagged, err := svc.UploadFile(ctx, UploadFileParams{
		Content: jpegWithICC(t, 600, 400, p3), Filename: "p3.jpg", MimeType: "image/jpeg",
	})
	if err != nil {
		t.Fatalf("UploadFile: %v", err)
	}
	plain, err := svc.UploadFile(ctx, UploadFileParams{
		Content: jpegWithICC(t, 600, 400, nil), Filename: "plain.jpg", MimeType: "image/jpeg",
	})
	if err != nil {
		t.Fatalf("UploadFile: %v", err)
	}

	check := func(label string) {
		for _, size := range []int{128, 256, 512} {
			path, err := svc.Variant(ctx, tagged, size)
			if err != nil {
				t.Fatalf("%s Variant(%d): %v", label, size, err)
			}
			data, _ := os.ReadFile(path)
			if got := jpegICC(data); !bytes.Equal(got, p3) {
				t.Errorf("%s rung %d: profile %d bytes, want %d", label, size, len(got), len(p3))
			}
			if _, err := jpeg.Decode(bytes.NewReader(data)); err != nil {
				t.Errorf("%s rung %d does not decode: %v", label, size, err)
			}

			path, err = svc.Variant(ctx, plain, size)
			if err != nil {
				t.Fatalf("%s Variant(%d): %v", label, size, err)
			}
			data, _ = os.ReadFile(path)
			if n := countAPP2(data); n != 0 {
				t.Errorf("%s untagged rung %d has %d APP2 segments, want 0", label, size, n)
			}
		}
	}
	check("eager")

	svc.removeAllVariants(tagged.OriginalPath)
	svc.removeAllVariants(plain.OriginalPath)
	check("lazy")
}
