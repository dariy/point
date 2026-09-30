package services

import (
	"bytes"
	"context"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	exif "github.com/dsoprea/go-exif/v3"
	exifcommon "github.com/dsoprea/go-exif/v3/common"

	"point-api/internal/config"
	"point-api/internal/models"
)

// droneXMP carries DJI vendor GPS next to a property that must survive.
const droneXMP = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
	`<rdf:Description xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/"` +
	` drone-dji:GpsLatitude="+47.0123" drone-dji:GpsLongtitude="+28.8456" drone-dji:FlightYawDegree="+12.3">` +
	`<drone-dji:GpsLongitude>+28.8456</drone-dji:GpsLongitude>` +
	`</rdf:Description></rdf:RDF></x:xmpmeta>`

// geoTIFF returns a TIFF block (no Exif prefix) with a Make tag and a GPS IFD.
func geoTIFF(t *testing.T) []byte {
	t.Helper()
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
	b, err := exif.NewIfdByteEncoder().EncodeToExif(rootIb)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// tiffHasGPS reports whether the TIFF block at the start of b has a GPS IFD
// with entries.
func tiffHasGPS(t *testing.T, b []byte) bool {
	t.Helper()
	im, _ := exifcommon.NewIfdMappingWithStandard()
	_, index, err := exif.Collect(im, exif.NewTagIndex(), b)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	gps, err := index.RootIfd.ChildWithIfdPath(exifcommon.IfdGpsInfoStandardIfdIdentity)
	return err == nil && len(gps.Entries()) > 0
}

func hasXMPGPS(b []byte) bool {
	return bytes.Contains(b, []byte("exif:GPS")) || bytes.Contains(b, []byte("drone-dji:Gps"))
}

// checkBlanked runs blank on a copy of in, and checks the length, the GPS and
// the metadata that must survive.
func checkBlanked(t *testing.T, blank func([]byte) error, in []byte, exifAt func([]byte) []byte) []byte {
	t.Helper()
	if !hasXMPGPS(in) || (exifAt != nil && !tiffHasGPS(t, exifAt(in))) {
		t.Fatal("fixture has no GPS")
	}
	out := append([]byte{}, in...)
	if err := blank(out); err != nil {
		t.Fatal(err)
	}
	if len(out) != len(in) {
		t.Errorf("length changed: %d -> %d", len(in), len(out))
	}
	if hasXMPGPS(out) {
		t.Error("XMP GPS left")
	}
	if exifAt != nil && tiffHasGPS(t, exifAt(out)) {
		t.Error("GPS IFD left")
	}
	if !bytes.Contains(out, []byte(`<dc:creator>Jane</dc:creator>`)) && !bytes.Contains(out, []byte(`FlightYawDegree="+12.3"`)) {
		t.Error("stripping removed XMP other than GPS")
	}
	return out
}

func TestXMPGPS_Vendor(t *testing.T) {
	seg := []byte(droneXMP)
	blankXMPGPS(seg)
	if hasXMPGPS(seg) || !bytes.Contains(seg, []byte(`drone-dji:FlightYawDegree="+12.3"`)) {
		t.Errorf("got %s", seg)
	}
}

func pngChunk(typ string, body []byte) []byte {
	out := binary.BigEndian.AppendUint32(nil, uint32(len(body)))
	out = append(out, typ...)
	out = append(out, body...)
	return binary.BigEndian.AppendUint32(out, crc32.ChecksumIEEE(out[4:]))
}

func geoPNG(t *testing.T) []byte {
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 4, 4))); err != nil {
		t.Fatal(err)
	}
	b := buf.Bytes()
	ihdrEnd := 8 + 12 + 13
	out := append([]byte{}, b[:ihdrEnd]...)
	out = append(out, pngChunk("eXIf", geoTIFF(t))...)
	out = append(out, pngChunk("iTXt", append([]byte("XML:com.adobe.xmp\x00\x00\x00\x00\x00"), testXMP+droneXMP...))...)
	return append(out, b[ihdrEnd:]...)
}

func TestBlankPNGGPS(t *testing.T) {
	exifAt := func(b []byte) []byte { return b[8+12+13+8:] }
	out := checkBlanked(t, blankPNGGPS, geoPNG(t), exifAt)
	if _, err := png.Decode(bytes.NewReader(out)); err != nil {
		t.Errorf("stripped PNG does not decode (bad CRC?): %v", err)
	}
	if err := blankPNGGPS([]byte("GIF89a")); err == nil {
		t.Error("non-PNG: want an error")
	}
}

func webpChunk(fourcc string, body []byte) []byte {
	out := append([]byte(fourcc), binary.LittleEndian.AppendUint32(nil, uint32(len(body)))...)
	out = append(out, body...)
	if len(body)%2 == 1 {
		out = append(out, 0)
	}
	return out
}

func TestBlankWebPGPS(t *testing.T) {
	body := webpChunk("VP8X", make([]byte, 10))
	body = append(body, webpChunk("EXIF", append(append([]byte{}, exifHeader...), geoTIFF(t)...))...)
	body = append(body, webpChunk("XMP ", []byte(droneXMP+"x"))...)
	in := append([]byte("RIFF"), binary.LittleEndian.AppendUint32(nil, uint32(len(body)+4))...)
	in = append(in, "WEBP"...)
	in = append(in, body...)
	exifAt := func(b []byte) []byte { return b[12+18+8+len(exifHeader):] }
	checkBlanked(t, blankWebPGPS, in, exifAt)
	if err := blankWebPGPS([]byte("RIFF")); err == nil {
		t.Error("non-WebP: want an error")
	}
}

func TestBlankTIFFFileGPS(t *testing.T) {
	tiff := geoTIFF(t)
	// TestBlankTIFFGPS_XMPTag covers the XMP packet of a TIFF file.
	out := append([]byte{}, tiff...)
	if err := blankTIFFFileGPS(out); err != nil {
		t.Fatal(err)
	}
	if tiffHasGPS(t, out) || !bytes.Contains(out, []byte("TestCam")) {
		t.Error("GPS left, or Make lost")
	}
	if err := blankTIFFFileGPS([]byte("GIF89a..")); err == nil {
		t.Error("non-TIFF: want an error")
	}
}

// An XMP packet in tag 700 of IFD0 loses its GPS properties.
func TestBlankTIFFGPS_XMPTag(t *testing.T) {
	x := []byte(droneXMP)
	tiff := make([]byte, 26, 26+len(x))
	copy(tiff, "II*\x00")
	le := binary.LittleEndian
	le.PutUint32(tiff[4:], 8)
	le.PutUint16(tiff[8:], 1)
	le.PutUint16(tiff[10:], xmpTag)
	le.PutUint16(tiff[12:], 1)
	le.PutUint32(tiff[14:], uint32(len(x)))
	le.PutUint32(tiff[18:], 26)
	tiff = append(tiff, x...)
	blankTIFFGPS(tiff)
	if hasXMPGPS(tiff) {
		t.Error("XMP GPS left in tag 700")
	}
}

func isoTestBox(typ string, body []byte) []byte {
	out := binary.BigEndian.AppendUint32(nil, uint32(8+len(body)))
	return append(append(out, typ...), body...)
}

// geoHEIC returns a minimal HEIF container: ftyp, a meta box with an Exif item
// and an XMP mime item (iloc version 1), and an mdat with both payloads.
func geoHEIC(t *testing.T) (file []byte, exifStart int) {
	exifItem := append([]byte{0, 0, 0, 6}, exifHeader...)
	exifItem = append(exifItem, geoTIFF(t)...)
	xmpItem := []byte(droneXMP)

	infe := func(id uint16, typ string) []byte {
		b := []byte{2, 0, 0, 0}
		b = binary.BigEndian.AppendUint16(b, id)
		b = append(b, 0, 0)
		b = append(b, typ...)
		return isoTestBox("infe", append(b, 0))
	}
	iinf := isoTestBox("iinf", append(append([]byte{0, 0, 0, 0, 0, 2}, infe(1, "Exif")...), infe(2, "mime")...))

	ftyp := isoTestBox("ftyp", []byte("heic\x00\x00\x00\x00mif1heic"))
	ilocLen := 8 + 4 + 2 + 2 + 2*(2+2+2+2+4+4)
	metaLen := 8 + 4 + len(iinf) + ilocLen
	mdatData := len(ftyp) + metaLen + 8
	iloc := []byte{1, 0, 0, 0, 0x44, 0x00, 0, 2}
	for i, it := range [][]byte{exifItem, xmpItem} {
		off := mdatData
		if i == 1 {
			off += len(exifItem)
		}
		iloc = binary.BigEndian.AppendUint16(iloc, uint16(i+1))
		iloc = append(iloc, 0, 0, 0, 0, 0, 1)
		iloc = binary.BigEndian.AppendUint32(iloc, uint32(off))
		iloc = binary.BigEndian.AppendUint32(iloc, uint32(len(it)))
	}
	meta := isoTestBox("meta", append(append([]byte{0, 0, 0, 0}, iinf...), isoTestBox("iloc", iloc)...))
	out := append(ftyp, meta...)
	out = append(out, isoTestBox("mdat", append(append([]byte{}, exifItem...), xmpItem...))...)
	return out, mdatData + 10
}

func TestBlankISOBMFFGPS(t *testing.T) {
	in, at := geoHEIC(t)
	checkBlanked(t, blankISOBMFFGPS, in, func(b []byte) []byte { return b[at:] })
	if err := blankISOBMFFGPS([]byte("not a heic file")); err == nil {
		t.Error("non-HEIF: want an error")
	}
}

// Malformed containers never panic and never change length.
func TestBlankGPS_MalformedContainers(t *testing.T) {
	heic, _ := geoHEIC(t)
	for name, blank := range map[string]func([]byte) error{
		"png": blankPNGGPS, "webp": blankWebPGPS, "heic": blankISOBMFFGPS, "tiff": blankTIFFFileGPS,
	} {
		var src []byte
		switch name {
		case "png":
			src = geoPNG(t)
		case "heic":
			src = heic
		default:
			src = geoTIFF(t)
		}
		for cut := 0; cut < len(src); cut += 7 {
			in := append([]byte{}, src[:cut]...)
			_ = blank(in)
			if len(in) != cut {
				t.Fatalf("%s: length changed", name)
			}
		}
	}
}

func TestNoGPSOriginal_PNG(t *testing.T) {
	storage := t.TempDir()
	svc := &MediaService{cfg: &config.Config{StoragePath: storage}}
	rel := "originals/2026/09/geo.png"
	src := filepath.Join(storage, "media", rel)
	if err := os.MkdirAll(filepath.Dir(src), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(src, geoPNG(t), 0644); err != nil {
		t.Fatal(err)
	}
	got, err := svc.NoGPSOriginal(context.Background(), models.Medium{OriginalPath: rel, MimeType: "image/png"})
	if err != nil || got == "" {
		t.Fatalf("got %q, %v", got, err)
	}
	served, _ := os.ReadFile(got)
	if hasXMPGPS(served) {
		t.Error("served PNG has GPS")
	}
}
