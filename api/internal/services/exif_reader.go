package services

import (
	"fmt"
	"io"
	"log/slog"
	"strings"

	exif "github.com/dsoprea/go-exif/v3"
	exifcommon "github.com/dsoprea/go-exif/v3/common"
)

// EXIF reading. Uses the same dsoprea library the writer does (exif_writer.go)
// — the codebase previously carried a second EXIF dependency (rwcarlsen/goexif)
// used only here, which meant two parsers, two sets of quirks, and two stale
// dependencies to track for one format.

// extractedEXIFTags is the allowlist of tags lifted into a media record's
// metadata, in no particular order. Everything else in the file is ignored:
// the metadata blob is served to clients, so it holds what the UI shows plus
// GPS (which the frontend's own allowlist then withholds from the public).
var extractedEXIFTags = map[string]bool{
	"Make":             true,
	"Model":            true,
	"Software":         true,
	"DateTimeOriginal": true,
	"Orientation":      true,
	"ExposureTime":     true,
	"FNumber":          true,
	"ISOSpeedRatings":  true,
	"FocalLength":      true,
}

// extractEXIF reads the allowlisted EXIF tags from an image.
//
// Values are returned as strings in the shape the frontend expects, notably
// rationals as "1/200" — see formatEXIFValue. GPS is returned as float64
// degrees under GPSLatitude/GPSLongitude, which is also what the geotagging
// path reads.
//
// A file with no EXIF, or unparseable EXIF, yields an empty map rather than an
// error: metadata is a nice-to-have and must never fail an upload.
func (s *MediaService) extractEXIF(r io.Reader) map[string]interface{} {
	metadata := make(map[string]interface{})

	data, err := io.ReadAll(r)
	if err != nil {
		return metadata
	}
	rawExif, err := exif.SearchAndExtractExif(data)
	if err != nil {
		// ErrNoExif is the common case (PNG, stripped JPEG); not worth logging.
		return metadata
	}

	entries, _, err := exif.GetFlatExifData(rawExif, nil)
	if err != nil {
		slog.Debug("exif: could not parse extracted block", "error", err)
		return metadata
	}

	for _, e := range entries {
		if !extractedEXIFTags[e.TagName] {
			continue
		}
		// A tag can appear in more than one IFD; the first occurrence wins,
		// matching the previous library's behaviour.
		if _, seen := metadata[e.TagName]; seen {
			continue
		}
		if v := formatEXIFValue(e.Value); v != "" {
			metadata[e.TagName] = sanitizeEXIFValue(v)
		}
	}

	if lat, lon, ok := extractEXIFGPS(rawExif); ok {
		metadata["GPSLatitude"] = lat
		metadata["GPSLongitude"] = lon
	}

	return metadata
}

// formatEXIFValue renders a decoded EXIF value as the string stored in the
// metadata blob.
//
// Rationals keep their fractional form ("1/200"), because that is what a
// shutter speed means and what the frontend's formatter parses; collapsing them
// to a decimal would make "1/200 s" render as "0.005 s". Multi-value tags take
// their first element — every allowlisted tag is conceptually single-valued,
// and the libraries differ on how they pad.
func formatEXIFValue(v interface{}) string {
	switch t := v.(type) {
	case string:
		return strings.TrimRight(strings.TrimSpace(t), "\x00")
	case []string:
		if len(t) == 0 {
			return ""
		}
		return strings.TrimRight(strings.TrimSpace(t[0]), "\x00")
	case []exifcommon.Rational:
		if len(t) == 0 {
			return ""
		}
		return formatRational(uint64(t[0].Numerator), uint64(t[0].Denominator))
	case []exifcommon.SignedRational:
		if len(t) == 0 {
			return ""
		}
		if t[0].Denominator < 0 {
			return formatRational(uint64(-t[0].Numerator), uint64(-t[0].Denominator))
		}
		return formatRational(uint64(t[0].Numerator), uint64(t[0].Denominator))
	case []uint16:
		if len(t) == 0 {
			return ""
		}
		return fmt.Sprintf("%d", t[0])
	case []uint32:
		if len(t) == 0 {
			return ""
		}
		return fmt.Sprintf("%d", t[0])
	case []int32:
		if len(t) == 0 {
			return ""
		}
		return fmt.Sprintf("%d", t[0])
	case nil:
		return ""
	default:
		return fmt.Sprintf("%v", v)
	}
}

// formatRational renders n/d, reducing to a bare integer when the denominator
// divides evenly — "100" reads better than "100/1" for ISO or focal length,
// and the frontend parses both.
func formatRational(n, d uint64) string {
	if d == 0 {
		return ""
	}
	if n%d == 0 {
		return fmt.Sprintf("%d", n/d)
	}
	return fmt.Sprintf("%d/%d", n, d)
}

// extractEXIFGPS pulls decimal-degree coordinates out of the GPS IFD, honouring
// the N/S and E/W reference tags. Reports ok=false when the image carries no
// usable GPS block, which is the normal case.
func extractEXIFGPS(rawExif []byte) (lat, lon float64, ok bool) {
	mapping, err := exifcommon.NewIfdMappingWithStandard()
	if err != nil {
		return 0, 0, false
	}
	_, index, err := exif.Collect(mapping, exif.NewTagIndex(), rawExif)
	if err != nil {
		return 0, 0, false
	}
	ifd, err := index.RootIfd.ChildWithIfdPath(exifcommon.IfdGpsInfoStandardIfdIdentity)
	if err != nil {
		return 0, 0, false
	}
	gi, err := ifd.GpsInfo()
	if err != nil {
		return 0, 0, false
	}
	return gi.Latitude.Decimal(), gi.Longitude.Decimal(), true
}
