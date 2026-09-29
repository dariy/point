package services

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"point-api/internal/models"
)

// StripGPSPublicSetting is the settings key that decides whether the served
// bytes of an original carry its GPS position. An absent row means on.
const StripGPSPublicSetting = "strip_gps_public"

// noGPSDir is the subtree of VariantsRoot that holds the GPS-free copies of
// originals. It sits under the variants root so a thumbnail rebuild purges it
// and a backup leaves it out, like every other derived file.
const noGPSDir = "nogps"

// NoGPSRelPath returns the media-relative path of the GPS-free copy of the
// original at originalPath. The copy keeps the original's filename.
func NoGPSRelPath(originalPath string) string {
	return filepath.Join(VariantsRoot, noGPSDir, strings.TrimPrefix(originalPath, "originals/"))
}

// xmpGPS matches the GPS properties of the EXIF schema in an XMP packet, both
// as attributes (exif:GPSLatitude="…") and as simple elements
// (<exif:GPSLatitude>…</exif:GPSLatitude>). Lightroom writes both forms.
var xmpGPS = regexp.MustCompile(`\s+exif:GPS\w+\s*=\s*("[^"]*"|'[^']*')|<exif:GPS\w+\s*/>|(?s)<exif:GPS\w+[^>]*>.*?</exif:GPS\w+>`)

// NoGPSOriginal returns the absolute path of a copy of the media item's
// original without its GPS position, and writes the copy on the first request.
// The original on disk does not change.
//
// Only JPEG is stripped. For another format it returns "" and a nil error, and
// the caller serves the original.
func (s *MediaService) NoGPSOriginal(ctx context.Context, media models.Medium) (string, error) {
	if !strings.EqualFold(media.MimeType, "image/jpeg") {
		return "", nil
	}
	base := s.mediaBase()
	srcFull := filepath.Clean(filepath.Join(base, media.OriginalPath))
	dstFull := filepath.Clean(filepath.Join(base, NoGPSRelPath(media.OriginalPath)))
	if !strings.HasPrefix(srcFull, base+string(filepath.Separator)) ||
		!strings.HasPrefix(dstFull, base+string(filepath.Separator)) {
		return "", fmt.Errorf("invalid media path")
	}
	// An EXIF edit rewrites the original in place, so a copy older than its
	// source is written again.
	if variantIsFresh(dstFull, srcFull) {
		return dstFull, nil
	}
	if _, err, _ := s.variantFlight.Do("nogps:"+media.OriginalPath, func() (any, error) {
		return nil, writeNoGPSCopy(srcFull, dstFull)
	}); err != nil {
		return "", err
	}
	return dstFull, nil
}

// writeNoGPSCopy writes the JPEG at src to dst without the GPS IFD entries and
// without the GPS properties of its XMP packets.
func writeNoGPSCopy(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return fmt.Errorf("read jpeg: %w", err)
	}
	if err := blankJPEGGPS(data); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return fmt.Errorf("create nogps dir: %w", err)
	}
	tmp := dst + ".tmp"
	//nolint:gosec // G703: NoGPSOriginal checks that dst stays under the media root
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return fmt.Errorf("write temp file: %w", err)
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename: %w", err)
	}
	return nil
}

// blankJPEGGPS removes the GPS position from JPEG bytes in place.
//
// Nothing moves: the GPS IFD is emptied and its values are zeroed, and each
// GPS property of an XMP packet is overwritten with spaces. A rewrite of the
// segment list would change lengths, which breaks the offsets of a
// multi-picture file (the gain map of an Ultra HDR photo) and drops the data
// after EOI. The embedded pictures that follow the primary one are cleaned
// too, because they can carry their own EXIF.
func blankJPEGGPS(data []byte) error {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return fmt.Errorf("not a jpeg")
	}
	for pos := 0; pos >= 0 && pos < len(data); {
		next := blankHeaderGPS(data, pos)
		i := bytes.Index(data[next:], []byte{0xFF, 0xD8, 0xFF})
		if i < 0 {
			break
		}
		pos = next + i
	}
	return nil
}

// blankHeaderGPS walks the marker segments of the JPEG that starts at pos,
// cleans each APP1 segment, and returns the offset where the walk stopped.
func blankHeaderGPS(data []byte, pos int) int {
	p := pos + 2
	for p+4 <= len(data) {
		if data[p] != 0xFF {
			return p
		}
		marker := data[p+1]
		if marker == 0xFF { // fill byte
			p++
			continue
		}
		if marker == 0xD9 || (marker >= 0xD0 && marker <= 0xD7) || marker == 0x01 {
			p += 2
			continue
		}
		n := int(binary.BigEndian.Uint16(data[p+2:]))
		end := p + 2 + n
		if n < 2 || end > len(data) {
			return p
		}
		if marker == 0xE1 {
			seg := data[p+4 : end]
			if bytes.HasPrefix(seg, exifHeader) {
				blankTIFFGPS(seg[len(exifHeader):])
			} else {
				blankXMPGPS(seg)
			}
		}
		if marker == 0xDA { // start of scan: entropy-coded data follows
			return end
		}
		p = end
	}
	return p
}

var exifHeader = []byte("Exif\x00\x00")

// gpsIFDTag is the IFD0 tag whose value is the offset of the GPS IFD.
const gpsIFDTag = 0x8825

// tiffTypeSize is the byte size of one value of each TIFF field type.
var tiffTypeSize = map[uint16]int{1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8}

// blankTIFFGPS finds the GPS IFD of a TIFF block, zeroes the values its entries
// point to, and sets its entry count to zero. A malformed block is left as it
// is where it cannot be read.
func blankTIFFGPS(t []byte) {
	if len(t) < 8 {
		return
	}
	var bo binary.ByteOrder
	switch string(t[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return
	}
	ifd0 := int(bo.Uint32(t[4:]))
	if ifd0 < 8 || ifd0+2 > len(t) {
		return
	}
	count := int(bo.Uint16(t[ifd0:]))
	gps := -1
	for i := 0; i < count; i++ {
		e := ifd0 + 2 + 12*i
		if e+12 > len(t) {
			return
		}
		if bo.Uint16(t[e:]) == gpsIFDTag {
			gps = int(bo.Uint32(t[e+8:]))
		}
	}
	if gps < 8 || gps+2 > len(t) {
		return
	}
	n := int(bo.Uint16(t[gps:]))
	for i := 0; i < n; i++ {
		e := gps + 2 + 12*i
		if e+12 > len(t) {
			break
		}
		size := tiffTypeSize[bo.Uint16(t[e+2:])] * int(bo.Uint32(t[e+4:]))
		if size > 4 {
			if off := int(bo.Uint32(t[e+8:])); off >= 8 && off+size <= len(t) {
				clear(t[off : off+size])
			}
		}
		clear(t[e : e+12])
	}
	bo.PutUint16(t[gps:], 0)
}

// blankXMPGPS overwrites every GPS property of the XMP packets in seg with
// spaces. The packet keeps its length and stays well-formed XML.
func blankXMPGPS(seg []byte) {
	for _, loc := range xmpGPS.FindAllIndex(seg, -1) {
		for i := loc[0]; i < loc[1]; i++ {
			seg[i] = ' '
		}
	}
}
