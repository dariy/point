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

	png := models.Medium{OriginalPath: "originals/2026/09/x.png", MimeType: "image/png"}
	if p, err := svc.NoGPSOriginal(context.Background(), png); p != "" || err != nil {
		t.Errorf("PNG: got %q, %v; want \"\", nil", p, err)
	}
}
