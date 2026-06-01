package services

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"path/filepath"
	"strings"
	"testing"

	goexif "github.com/rwcarlsen/goexif/exif"
)

func TestSanitizeEXIFValue(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"Canon", "Canon"},
		{"EOS R5", "EOS R5"},
		{"Adobe Lightroom 5.7", "Adobe Lightroom 57"},
		{"2023:05:15 12:30:00", "20230515 123000"},
		{"Nikon <script>", "Nikon script"},
		{"f/2.8", "f28"},
		{"", ""},
		{"   ", "   "},
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

	f, err := os.Open(jpegPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	x, err := goexif.Decode(f)
	if err != nil {
		t.Fatalf("goexif.Decode after write: %v", err)
	}

	check := func(tag goexif.FieldName, want string) {
		t.Helper()
		val, err := x.Get(tag)
		if err != nil {
			t.Errorf("tag %s not found: %v", tag, err)
			return
		}
		got := strings.Trim(val.String(), "\"")
		if got != want {
			t.Errorf("tag %s = %q; want %q", tag, got, want)
		}
	}
	check(goexif.Make, "TestCamera")
	check(goexif.Model, "Model X")
	check(goexif.Software, "TestSoft 10")
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

	f, _ := os.Open(jpegPath)
	defer func() { _ = f.Close() }()
	x, err := goexif.Decode(f)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	val, _ := x.Get(goexif.Make)
	if got := strings.Trim(val.String(), "\""); got != "OnlyString" {
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
