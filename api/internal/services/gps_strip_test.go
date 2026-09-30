package services

import (
	"bytes"
	"context"
	"encoding/binary"
	"image"
	"image/jpeg"
	"os"
	"path/filepath"
	"testing"

	exif "github.com/dsoprea/go-exif/v3"
	exifcommon "github.com/dsoprea/go-exif/v3/common"
	jpegstructure "github.com/dsoprea/go-jpeg-image-structure/v2"

	"point-api/internal/config"
	"point-api/internal/models"
)

// testXMP carries GPS in both forms Lightroom writes, next to a creator that
// must survive.
const testXMP = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
	`<rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"` +
	` exif:GPSLatitude="47,1.5N" exif:GPSLongitude='28,50.2E'>` +
	`<exif:GPSAltitude>120/1</exif:GPSAltitude><dc:creator>Jane</dc:creator>` +
	`</rdf:Description></rdf:RDF></x:xmpmeta>`

// geotaggedJPEG returns a JPEG with a GPS IFD, a Make tag and an XMP packet
// with GPS.
func geotaggedJPEG(t *testing.T) []byte {
	t.Helper()
	var plain bytes.Buffer
	if err := jpeg.Encode(&plain, image.NewRGBA(image.Rect(0, 0, 8, 8)), nil); err != nil {
		t.Fatal(err)
	}
	intfc, err := jpegstructure.NewJpegMediaParser().ParseBytes(plain.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	sl := intfc.(*jpegstructure.SegmentList)
	im, err := exifcommon.NewIfdMappingWithStandard()
	if err != nil {
		t.Fatal(err)
	}
	rootIb := exif.NewIfdBuilder(im, exif.NewTagIndex(), exifcommon.IfdStandardIfdIdentity, exifcommon.EncodeDefaultByteOrder)
	if err := rootIb.SetStandardWithName("Make", "TestCam"); err != nil {
		t.Fatal(err)
	}
	gpsIb, err := exif.GetOrCreateIbFromRootIb(rootIb, "IFD/GPSInfo")
	if err != nil {
		t.Fatal(err)
	}
	if err := gpsIb.SetStandardWithName("GPSLatitudeRef", "N"); err != nil {
		t.Fatal(err)
	}
	if err := sl.SetExif(rootIb); err != nil {
		t.Fatal(err)
	}
	var withExif bytes.Buffer
	if err := sl.Write(&withExif); err != nil {
		t.Fatal(err)
	}
	// Insert the XMP APP1 segment right after SOI.
	payload := append([]byte("http://ns.adobe.com/xap/1.0/\x00"), testXMP...)
	seg := []byte{0xFF, 0xE1, 0, 0}
	binary.BigEndian.PutUint16(seg[2:], uint16(len(payload)+2))
	b := withExif.Bytes()
	out := append([]byte{}, b[:2]...)
	out = append(out, seg...)
	out = append(out, payload...)
	return append(out, b[2:]...)
}

// jpegHasGPS reports whether the JPEG carries a GPS IFD or GPS in XMP.
func jpegHasGPS(t *testing.T, data []byte) (ifd, xmp bool) {
	t.Helper()
	intfc, err := jpegstructure.NewJpegMediaParser().ParseBytes(data)
	if err != nil {
		t.Fatal(err)
	}
	sl := intfc.(*jpegstructure.SegmentList)
	if rootIfd, _, err := sl.Exif(); err == nil {
		gps, err := rootIfd.ChildWithIfdPath(exifcommon.IfdGpsInfoStandardIfdIdentity)
		ifd = err == nil && len(gps.Entries()) > 0
	}
	return ifd, bytes.Contains(data, []byte("exif:GPS"))
}

// A trailing embedded picture (an Ultra HDR gain map) keeps its bytes and
// offset, and loses its own GPS.
func TestBlankJPEGGPS_KeepsTrailer(t *testing.T) {
	primary := geotaggedJPEG(t)
	second := geotaggedJPEG(t)
	in := append(append([]byte{}, primary...), second...)
	out := append([]byte{}, in...)
	if err := blankJPEGGPS(out); err != nil {
		t.Fatal(err)
	}
	if len(out) != len(in) {
		t.Fatalf("length changed: %d -> %d", len(in), len(out))
	}
	tail := out[len(primary):]
	if ifd, xmp := jpegHasGPS(t, tail); ifd || xmp {
		t.Errorf("trailing picture keeps GPS: ifd=%v xmp=%v", ifd, xmp)
	}
	if _, err := jpeg.Decode(bytes.NewReader(tail)); err != nil {
		t.Errorf("trailing picture does not decode: %v", err)
	}
}

func TestBlankJPEGGPS(t *testing.T) {
	in := geotaggedJPEG(t)
	if ifd, xmp := jpegHasGPS(t, in); !ifd || !xmp {
		t.Fatalf("fixture has no GPS: ifd=%v xmp=%v", ifd, xmp)
	}
	out := append([]byte{}, in...)
	if err := blankJPEGGPS(out); err != nil {
		t.Fatal(err)
	}
	if len(out) != len(in) {
		t.Errorf("length changed: %d -> %d", len(in), len(out))
	}
	if ifd, xmp := jpegHasGPS(t, out); ifd || xmp {
		t.Errorf("GPS left: ifd=%v xmp=%v", ifd, xmp)
	}
	if !bytes.Contains(out, []byte("TestCam")) || !bytes.Contains(out, []byte("<dc:creator>Jane</dc:creator>")) {
		t.Error("stripping removed metadata other than GPS")
	}
	if _, err := jpeg.Decode(bytes.NewReader(out)); err != nil {
		t.Errorf("stripped copy does not decode: %v", err)
	}
}

func TestBlankJPEGGPS_NoMetadata(t *testing.T) {
	var plain bytes.Buffer
	if err := jpeg.Encode(&plain, image.NewRGBA(image.Rect(0, 0, 4, 4)), nil); err != nil {
		t.Fatal(err)
	}
	if err := blankJPEGGPS(plain.Bytes()); err != nil {
		t.Fatalf("plain JPEG: %v", err)
	}
}

func TestNoGPSOriginal(t *testing.T) {
	storage := t.TempDir()
	svc := &MediaService{cfg: &config.Config{StoragePath: storage}}
	rel := "originals/2026/09/geo_abcdef12.jpg"
	src := filepath.Join(storage, "media", rel)
	if err := os.MkdirAll(filepath.Dir(src), 0755); err != nil {
		t.Fatal(err)
	}
	orig := geotaggedJPEG(t)
	if err := os.WriteFile(src, orig, 0644); err != nil {
		t.Fatal(err)
	}
	m := models.Medium{OriginalPath: rel, MimeType: "image/jpeg"}

	got, err := svc.NoGPSOriginal(context.Background(), m)
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(storage, "media", NoGPSRelPath(rel)); got != want {
		t.Errorf("path = %s, want %s", got, want)
	}
	served, _ := os.ReadFile(got)
	if ifd, xmp := jpegHasGPS(t, served); ifd || xmp {
		t.Errorf("served copy has GPS: ifd=%v xmp=%v", ifd, xmp)
	}
	after, _ := os.ReadFile(src)
	if !bytes.Equal(after, orig) {
		t.Error("the original on disk changed")
	}

	gif := models.Medium{OriginalPath: "originals/2026/09/x.gif", MimeType: "image/gif"}
	if p, err := svc.NoGPSOriginal(context.Background(), gif); p != "" || err != nil {
		t.Errorf("GIF: got %q, %v; want \"\", nil", p, err)
	}
}

// Malformed input never panics and never grows or shrinks the bytes.
func TestBlankJPEGGPS_Malformed(t *testing.T) {
	if err := blankJPEGGPS([]byte("GIF89a")); err == nil {
		t.Error("non-JPEG: want an error")
	}
	cases := map[string][]byte{
		"truncated segment": {0xFF, 0xD8, 0xFF, 0xE1, 0x40, 0x00, 'E'},
		"zero length":       {0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x00, 0, 0},
		"not a marker":      {0xFF, 0xD8, 0x12, 0x34, 0, 0},
		"fill and RST":      {0xFF, 0xD8, 0xFF, 0xFF, 0xD0, 0xFF, 0xD9, 0, 0},
		"bad byte order":    app1(append([]byte("Exif\x00\x00XX"), make([]byte, 16)...)),
		"short tiff":        app1([]byte("Exif\x00\x00II")),
		"ifd0 out of range": app1(append([]byte("Exif\x00\x00II*\x00\xFF\x00\x00\x00"), make([]byte, 8)...)),
	}
	for name, in := range cases {
		out := append([]byte{}, in...)
		if err := blankJPEGGPS(out); err != nil {
			t.Errorf("%s: %v", name, err)
		}
		if len(out) != len(in) {
			t.Errorf("%s: length changed", name)
		}
	}
}

// app1 wraps payload in an APP1 segment after SOI.
func app1(payload []byte) []byte {
	n := len(payload) + 2
	out := []byte{0xFF, 0xD8, 0xFF, 0xE1, byte(n >> 8), byte(n)}
	return append(out, payload...)
}

// A big-endian TIFF block with a GPS IFD whose entry points outside the block:
// the entry is cleared, and nothing out of range is touched.
func TestBlankTIFFGPS_BigEndian(t *testing.T) {
	tiff := make([]byte, 64)
	copy(tiff, "MM\x00\x2A")
	be := binary.BigEndian
	be.PutUint32(tiff[4:], 8)
	be.PutUint16(tiff[8:], 1) // IFD0: one entry, the GPS pointer
	be.PutUint16(tiff[10:], gpsIFDTag)
	be.PutUint16(tiff[12:], 4)
	be.PutUint32(tiff[14:], 1)
	be.PutUint32(tiff[18:], 26)
	be.PutUint16(tiff[26:], 2) // GPS IFD: two entries
	be.PutUint16(tiff[28:], 2) // GPSLatitudeRef, inline
	be.PutUint16(tiff[30:], 5)
	be.PutUint32(tiff[32:], 3) // 3 rationals at a bad offset
	be.PutUint32(tiff[36:], 1000)
	be.PutUint16(tiff[40:], 3) // second entry runs past the block
	blankTIFFGPS(tiff[:48])
	if be.Uint16(tiff[26:]) != 0 {
		t.Error("GPS IFD entry count not zeroed")
	}
	for _, b := range tiff[28:40] {
		if b != 0 {
			t.Fatal("GPS entry not cleared")
		}
	}
}

func TestNoGPSOriginal_Errors(t *testing.T) {
	storage := t.TempDir()
	svc := &MediaService{cfg: &config.Config{StoragePath: storage}}
	ctx := context.Background()
	if _, err := svc.NoGPSOriginal(ctx, models.Medium{OriginalPath: "../../etc/x.jpg", MimeType: "image/jpeg"}); err == nil {
		t.Error("path outside the media root: want an error")
	}
	if _, err := svc.NoGPSOriginal(ctx, models.Medium{OriginalPath: "originals/2026/09/missing.jpg", MimeType: "image/jpeg"}); err == nil {
		t.Error("missing original: want an error")
	}
	// The copy directory cannot be created: a file sits where it must go.
	rel := "originals/2026/09/a.jpg"
	src := filepath.Join(storage, "media", rel)
	if err := os.MkdirAll(filepath.Dir(src), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(src, geotaggedJPEG(t), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(storage, "media", VariantsRoot), nil, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.NoGPSOriginal(ctx, models.Medium{OriginalPath: rel, MimeType: "image/jpeg"}); err == nil {
		t.Error("unwritable copy: want an error")
	}
}

// A fresh copy is served again without a rewrite.
func TestNoGPSOriginal_ReusesFreshCopy(t *testing.T) {
	storage := t.TempDir()
	svc := &MediaService{cfg: &config.Config{StoragePath: storage}}
	rel := "originals/2026/09/b.jpg"
	src := filepath.Join(storage, "media", rel)
	if err := os.MkdirAll(filepath.Dir(src), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(src, geotaggedJPEG(t), 0644); err != nil {
		t.Fatal(err)
	}
	m := models.Medium{OriginalPath: rel, MimeType: "image/jpeg"}
	first, err := svc.NoGPSOriginal(context.Background(), m)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(first, []byte("marker"), 0644); err != nil {
		t.Fatal(err)
	}
	second, err := svc.NoGPSOriginal(context.Background(), m)
	if err != nil || second != first {
		t.Fatalf("second call: %q, %v", second, err)
	}
	if b, _ := os.ReadFile(second); string(b) != "marker" {
		t.Error("a fresh copy was rewritten")
	}
}
