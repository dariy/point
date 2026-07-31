package services

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"path/filepath"
	"testing"

	exif "github.com/dsoprea/go-exif/v3"
)

func TestSanitizeEXIFValue(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"Canon", "Canon"},
		{"EOS R5", "EOS R5"},
		// Punctuation EXIF values genuinely carry is preserved. These used to
		// be mangled — "1/200" became "1200", so the site rendered a 1/200s
		// exposure as "1200 s". See point-quickstart-ci-exif-dedup.
		{"Adobe Lightroom 5.7", "Adobe Lightroom 5.7"},
		{"2023:05:15 12:30:00", "2023:05:15 12:30:00"},
		{"1/200", "1/200"},
		{"f/2.8", "f/2.8"},
		{"EF24-70mm f/2.8L II USM", "EF24-70mm f/2.8L II USM"},
		{"+1.5", "+1.5"},
		{"Nikon D850 (v1.2)", "Nikon D850 (v1.2)"},
		// Anything that could escape a JPEG header or a JSON/HTML context
		// still goes.
		{"Nikon <script>", "Nikon script"},
		{`bad"quote`, "badquote"},
		{`back\slash`, "backslash"},
		{"", ""},
		{"   ", ""},
		{"αβγ", ""},
		{"Hello\nWorld", "HelloWorld"},
	}
	for _, tc := range cases {
		got := sanitizeEXIFValue(tc.input)
		if got != tc.want {
			t.Errorf("sanitizeEXIFValue(%q) = %q; want %q", tc.input, got, tc.want)
		}
	}
}

func TestWriteEXIFToFile_NonJPEG(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "test.png")
	if err := os.WriteFile(path, []byte("fake png data"), 0644); err != nil {
		t.Fatal(err)
	}
	err := writeEXIFToFile(path, "image/png", map[string]interface{}{"Make": "Canon"})
	if err != nil {
		t.Fatalf("expected nil for non-JPEG, got %v", err)
	}
}

func TestWriteEXIFToFile_JPEG_WritesAndReads(t *testing.T) {
	tmp := t.TempDir()
	jpegPath := filepath.Join(tmp, "photo.jpg")

	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	img.SetRGBA(0, 0, color.RGBA{R: 255, A: 255})
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatalf("jpeg.Encode: %v", err)
	}
	if err := os.WriteFile(jpegPath, buf.Bytes(), 0644); err != nil {
		t.Fatal(err)
	}

	fields := map[string]interface{}{
		"Make":     "TestCamera",
		"Model":    "Model X",
		"Software": "TestSoft 10",
	}
	if err := writeEXIFToFile(jpegPath, "image/jpeg", fields); err != nil {
		t.Fatalf("writeEXIFToFile: %v", err)
	}

	tags := readEXIFTags(t, jpegPath)

	check := func(tag, want string) {
		t.Helper()
		if got := tags[tag]; got != want {
			t.Errorf("tag %s = %q; want %q", tag, got, want)
		}
	}
	check("Make", "TestCamera")
	check("Model", "Model X")
	check("Software", "TestSoft 10")
}

func TestWriteEXIFToFile_JPEG_EmptyFields(t *testing.T) {
	tmp := t.TempDir()
	jpegPath := filepath.Join(tmp, "photo.jpg")

	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, nil)
	_ = os.WriteFile(jpegPath, buf.Bytes(), 0644)

	err := writeEXIFToFile(jpegPath, "image/jpeg", map[string]interface{}{})
	if err != nil {
		t.Fatalf("empty fields: %v", err)
	}
}

func TestWriteEXIFToFile_JPEG_SkipsNumericFields(t *testing.T) {
	tmp := t.TempDir()
	jpegPath := filepath.Join(tmp, "photo.jpg")

	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, nil)
	_ = os.WriteFile(jpegPath, buf.Bytes(), 0644)

	fields := map[string]interface{}{
		"GPSLatitude":  37.7749,
		"GPSLongitude": -122.4194,
		"Make":         "OnlyString",
	}
	if err := writeEXIFToFile(jpegPath, "image/jpeg", fields); err != nil {
		t.Fatalf("numeric fields: %v", err)
	}

	if got := readEXIFTags(t, jpegPath)["Make"]; got != "OnlyString" {
		t.Errorf("Make = %q; want OnlyString", got)
	}
}

func TestWriteEXIFToFile_MissingFile(t *testing.T) {
	err := writeEXIFToFile("/nonexistent/path.jpg", "image/jpeg", map[string]interface{}{"Make": "X"})
	if err == nil {
		t.Fatal("expected error for missing file")
	}
}

func TestWriteEXIFToFile_InvalidJPEGContent(t *testing.T) {
	tmp := t.TempDir()
	p := filepath.Join(tmp, "invalid.jpg")
	_ = os.WriteFile(p, []byte("this is not a valid jpeg file"), 0644)
	err := writeEXIFToFile(p, "image/jpeg", map[string]interface{}{"Make": "X"})
	if err == nil {
		t.Error("expected error for invalid JPEG content")
	}
}

func TestWriteEXIFToFile_DateTimeOriginal(t *testing.T) {
	tmp := t.TempDir()
	jpegPath := filepath.Join(tmp, "photo.jpg")

	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, nil)
	_ = os.WriteFile(jpegPath, buf.Bytes(), 0644)

	// DateTimeOriginal goes to ExifIFD; non-string field is skipped.
	fields := map[string]interface{}{
		"DateTimeOriginal": "2024:01:15 10:30:00",
		"UnknownField":     "should be skipped",
		"NonString":        42, // not a string → skipped
	}
	if err := writeEXIFToFile(jpegPath, "image/jpeg", fields); err != nil {
		t.Fatalf("writeEXIFToFile with DateTimeOriginal: %v", err)
	}
}

// readEXIFTags reads the given EXIF string tags out of a JPEG on disk, using
// the same library the writer uses (the second EXIF dependency this codebase
// used to carry was dropped — see point-quickstart-ci-exif-dedup).
func readEXIFTags(t *testing.T, path string) map[string]string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	rawExif, err := exif.SearchAndExtractExif(data)
	if err != nil {
		t.Fatalf("no EXIF in %s: %v", path, err)
	}
	entries, _, err := exif.GetFlatExifData(rawExif, nil)
	if err != nil {
		t.Fatalf("parse EXIF in %s: %v", path, err)
	}
	out := map[string]string{}
	for _, e := range entries {
		if _, seen := out[e.TagName]; seen {
			continue
		}
		if v := formatEXIFValue(e.Value); v != "" {
			out[e.TagName] = v
		}
	}
	return out
}
