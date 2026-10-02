//go:build !unit

package services

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"point-api/internal/models"
)

// The fixtures are small gradients with a non-sRGB test ICC profile.
// small.avif is 300x200 from avifenc. small.heic is from pillow-heif: EXIF
// Make "TestCam" and Orientation 6, stored so that it shows as 200x300.

func TestUpload_AVIFStoresSizeAndLadder(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir) }()
	ctx := context.Background()

	data, err := os.ReadFile(filepath.Join("testdata", "small.avif"))
	if err != nil {
		t.Fatal(err)
	}
	m, err := svc.UploadFile(ctx, UploadFileParams{Content: data, Filename: "a.avif", MimeType: "image/avif"})
	if err != nil {
		t.Fatalf("UploadFile: %v", err)
	}
	// The size comes from the header, before the deferred decode.
	if m.Width.Int64 != 300 || m.Height.Int64 != 200 {
		t.Errorf("stored size = %dx%d, want 300x200", m.Width.Int64, m.Height.Int64)
	}
	svc.WaitDeferred()

	full := svc.variantFullPath(m.OriginalPath, 128)
	if w, h := variantDims(t, full); w != 128 || h != 85 {
		t.Errorf("rung 128 = %dx%d, want 128x85", w, h)
	}
	rung, err := os.ReadFile(full)
	if err != nil {
		t.Fatal(err)
	}
	if extractICC(rung) == nil {
		t.Error("rung 128 has no ICC profile")
	}
}

func TestUpload_HEICBecomesJPEG(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir) }()
	ctx := context.Background()

	data, err := os.ReadFile(filepath.Join("testdata", "small.heic"))
	if err != nil {
		t.Fatal(err)
	}
	m, err := svc.UploadFile(ctx, UploadFileParams{Content: data, Filename: "IMG_1.HEIC", MimeType: "image/heic"})
	if err != nil {
		t.Fatalf("UploadFile: %v", err)
	}
	heicRel := m.OriginalPath
	svc.WaitDeferred()

	got, err := svc.repo.GetMedia(ctx, m.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.MimeType != "image/jpeg" || got.Filename != "IMG_1.jpg" || !strings.HasSuffix(got.OriginalPath, "_IMG_1.jpg") {
		t.Fatalf("row = %s %s %s, want the JPEG", got.MimeType, got.Filename, got.OriginalPath)
	}
	if got.Width.Int64 != 200 || got.Height.Int64 != 300 {
		t.Errorf("stored size = %dx%d, want 200x300", got.Width.Int64, got.Height.Int64)
	}
	if got.Checksum != m.Checksum {
		t.Error("checksum changed; a second upload of the HEIC would not deduplicate")
	}

	jpg, err := os.ReadFile(filepath.Join(svc.mediaBase(), got.OriginalPath))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(jpg, []byte{0xFF, 0xD8}) {
		t.Fatal("original is not a JPEG")
	}
	if int64(len(jpg)) != got.FileSize {
		t.Errorf("file_size = %d, want %d", got.FileSize, len(jpg))
	}
	if w, h := variantDims(t, filepath.Join(svc.mediaBase(), got.OriginalPath)); w != 200 || h != 300 {
		t.Errorf("jpeg = %dx%d, want 200x300", w, h)
	}
	if extractICC(jpg) == nil {
		t.Error("jpeg has no ICC profile")
	}
	md := svc.extractEXIF(bytes.NewReader(jpg))
	if md["Make"] != "TestCam" {
		t.Errorf("jpeg EXIF Make = %v, want TestCam", md["Make"])
	}
	if md["Orientation"] != "1" {
		t.Errorf("jpeg EXIF Orientation = %v, want 1: the pixels are already upright", md["Orientation"])
	}

	// The HEIC stays beside the JPEG as the archival original.
	if _, err := os.Stat(filepath.Join(svc.mediaBase(), heicRel)); err != nil {
		t.Errorf("archival HEIC: %v", err)
	}
	if a := svc.heifArchive(got); a != heicRel {
		t.Errorf("heifArchive = %q, want %q", a, heicRel)
	}
	if _, err := os.Stat(svc.variantFullPath(got.OriginalPath, 128)); err != nil {
		t.Errorf("rung 128 of the JPEG: %v", err)
	}

	// A second upload of the same HEIC finds the converted row.
	again, err := svc.UploadFile(ctx, UploadFileParams{Content: data, Filename: "IMG_1.HEIC", MimeType: "image/heic"})
	if err != nil || again.ID != m.ID {
		t.Errorf("re-upload = %d, %v; want row %d", again.ID, err, m.ID)
	}

	// Delete removes the archival HEIC too.
	if err := svc.DeleteMedia(ctx, m.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(svc.mediaBase(), heicRel)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("archival HEIC after delete: %v", err)
	}
}

// The pixel guard reads the size of both formats from the header, so an
// oversized upload is refused before the slow decode starts. The fixture's
// ispe box is patched to claim 10000x10000.
func TestUpload_AVIFHEICPixelGuard(t *testing.T) {
	for _, tc := range []struct{ name, mime string }{{"small.avif", "image/avif"}, {"small.heic", "image/heic"}} {
		t.Run(tc.name, func(t *testing.T) {
			svc, tmpDir := setupMediaService(t)
			defer func() { _ = os.RemoveAll(tmpDir) }()
			data, err := os.ReadFile(filepath.Join("testdata", tc.name))
			if err != nil {
				t.Fatal(err)
			}
			i := bytes.Index(data, []byte("ispe"))
			if i < 0 {
				t.Fatal("fixture has no ispe box")
			}
			binary.BigEndian.PutUint32(data[i+8:], 10000)
			binary.BigEndian.PutUint32(data[i+12:], 10000)

			_, err = svc.UploadFile(context.Background(), UploadFileParams{Content: data, Filename: "big", MimeType: tc.mime})
			if !errors.Is(err, ErrTooLarge) {
				t.Errorf("UploadFile = %v, want ErrTooLarge", err)
			}
		})
	}
}

func TestExtractICC_ISOBMFF(t *testing.T) {
	for _, name := range []string{"small.avif", "small.heic"} {
		data, err := os.ReadFile(filepath.Join("testdata", name))
		if err != nil {
			t.Fatal(err)
		}
		icc := extractICC(data)
		if icc == nil || profileText(icc[144:]) != "Test Wide RGB" {
			t.Errorf("%s: ICC = %d bytes", name, len(icc))
		}
	}
	// A colr box with a size past the end of the data is ignored.
	bad := append([]byte("\x00\x00\x00\x18ftypheic\x00\x00\x00\x00"), []byte("\x00\x00\xff\xffcolrprof")...)
	if extractICC(bad) != nil {
		t.Error("truncated colr box gave a profile")
	}
}

// The error paths of the deferred decode leave the row as it was.
func TestDeferred_ErrorPaths(t *testing.T) {
	svc, tmpDir := setupMediaService(t)
	defer func() { _ = os.RemoveAll(tmpDir) }()
	ctx := context.Background()

	data, err := os.ReadFile(filepath.Join("testdata", "small.heic"))
	if err != nil {
		t.Fatal(err)
	}
	src, err := safeHEIFDecode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	heic := models.Medium{ID: 1, Filename: "x.heic", OriginalPath: "originals/x.heic", MimeType: "image/heic"}

	if err := svc.finishDeferred(ctx, heic, []byte("not an image")); err == nil {
		t.Error("finishDeferred on garbage: want an error")
	}

	escape := heic
	escape.OriginalPath = "../../x.heic"
	if err := svc.convertHEIF(ctx, escape, data, src, nil); err == nil || !strings.Contains(err.Error(), "invalid media path") {
		t.Errorf("convertHEIF outside the media root = %v, want invalid media path", err)
	}

	jpg := filepath.Join(svc.mediaBase(), "originals", "x.jpg")
	if err := os.MkdirAll(filepath.Dir(jpg), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(jpg, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := svc.convertHEIF(ctx, heic, data, src, nil); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Errorf("convertHEIF over an existing JPEG = %v, want already exists", err)
	}
}

func TestSafeHEIFDecode_Truncated(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "small.heic"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := safeHEIFDecode(bytes.NewReader(data[:len(data)/2])); err == nil {
		t.Error("truncated HEIC: want an error")
	}
}

func TestWithHEIFExif_Errors(t *testing.T) {
	if _, err := withHEIFExif([]byte{0xFF, 0xD8}, []byte("no exif here")); err == nil {
		t.Error("HEIC without EXIF: want an error")
	}
	data, err := os.ReadFile(filepath.Join("testdata", "small.heic"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := withHEIFExif([]byte("not a jpeg"), data); err == nil {
		t.Error("output that is not a JPEG: want an error")
	}
}
