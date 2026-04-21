package services

import (
	"bytes"
	"fmt"
	"os"
	"regexp"

	exif "github.com/dsoprea/go-exif/v3"
	jpegstructure "github.com/dsoprea/go-jpeg-image-structure/v2"
)

var nonAlphaNumSpace = regexp.MustCompile(`[^a-zA-Z0-9 ]`)

// sanitizeEXIFValue strips every character that is not alphanumeric or space.
func sanitizeEXIFValue(s string) string {
	return nonAlphaNumSpace.ReplaceAllString(s, "")
}

// ifd0StringTags are EXIF tags in IFD0 whose values are ASCII strings.
var ifd0StringTags = map[string]bool{
	"Make":     true,
	"Model":    true,
	"Software": true,
}

// exifIfdStringTags are EXIF tags in the ExifIFD whose values are ASCII strings.
var exifIfdStringTags = map[string]bool{
	"DateTimeOriginal": true,
}

// writeEXIFToFile writes the string-typed EXIF fields from fields into the JPEG
// at filePath. Non-JPEG mimeTypes are silently ignored (no-op). The file is
// written atomically via a temp file + rename. Only Make, Model, Software
// (IFD0) and DateTimeOriginal (ExifIFD) are written; all other field names
// are skipped. Values must already be sanitized by the caller.
func writeEXIFToFile(filePath, mimeType string, fields map[string]interface{}) error {
	if mimeType != "image/jpeg" {
		return nil
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		return fmt.Errorf("read jpeg: %w", err)
	}

	jmp := jpegstructure.NewJpegMediaParser()
	intfc, err := jmp.ParseBytes(data)
	if err != nil {
		return fmt.Errorf("parse jpeg: %w", err)
	}
	sl := intfc.(*jpegstructure.SegmentList)

	rootIb, err := sl.ConstructExifBuilder()
	if err != nil {
		return fmt.Errorf("construct exif builder: %w", err)
	}

	ifd0Ib, err := exif.GetOrCreateIbFromRootIb(rootIb, "IFD0")
	if err != nil {
		return fmt.Errorf("get IFD0: %w", err)
	}

	exifIb, err := exif.GetOrCreateIbFromRootIb(rootIb, "IFD0/Exif")
	if err != nil {
		return fmt.Errorf("get ExifIFD: %w", err)
	}

	for k, v := range fields {
		s, ok := v.(string)
		if !ok || s == "" {
			continue
		}
		if ifd0StringTags[k] {
			_ = ifd0Ib.SetStandardWithName(k, s)
		} else if exifIfdStringTags[k] {
			_ = exifIb.SetStandardWithName(k, s)
		}
		// Numeric and unknown fields are silently skipped.
	}

	if err := sl.SetExif(rootIb); err != nil {
		return fmt.Errorf("set exif: %w", err)
	}

	var buf bytes.Buffer
	if err := sl.Write(&buf); err != nil {
		return fmt.Errorf("write jpeg segments: %w", err)
	}

	tmp := filePath + ".tmp"
	if err := os.WriteFile(tmp, buf.Bytes(), 0644); err != nil {
		return fmt.Errorf("write temp file: %w", err)
	}
	if err := os.Rename(tmp, filePath); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename: %w", err)
	}
	return nil
}
