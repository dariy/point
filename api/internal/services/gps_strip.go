package services

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"hash/crc32"
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

// xmpGPS matches the GPS properties of an XMP packet in any namespace, both as
// attributes (exif:GPSLatitude="…") and as elements
// (<exif:GPSLatitude>…</exif:GPSLatitude>). Lightroom writes both forms. The
// "gps" prefix of the local name matches without case, so vendor properties
// such as drone-dji:GpsLatitude match too.
var xmpGPS = regexp.MustCompile(`\s+[\w.-]+:(?i:gps)\w*\s*=\s*("[^"]*"|'[^']*')|<[\w.-]+:(?i:gps)\w*\s*/>|(?s)<[\w.-]+:(?i:gps)\w*[^>]*>.*?</[\w.-]+:(?i:gps)\w*>`)

// gpsBlankers maps a MIME type to the function that removes the GPS position
// from bytes of that format in place, without a change of length.
var gpsBlankers = map[string]func([]byte) error{
	"image/jpeg": blankJPEGGPS,
	"image/png":  blankPNGGPS,
	"image/webp": blankWebPGPS,
	"image/tiff": blankTIFFFileGPS,
	"image/heic": blankISOBMFFGPS,
	"image/heif": blankISOBMFFGPS,
	"image/avif": blankISOBMFFGPS,
}

// StripsGPS reports whether NoGPSOriginal cleans originals of the MIME type.
func StripsGPS(mimeType string) bool {
	return gpsBlankers[strings.ToLower(mimeType)] != nil
}

// NoGPSOriginal returns the absolute path of a copy of the media item's
// original without its GPS position, and writes the copy on the first request.
// The original on disk does not change.
//
// JPEG, PNG, WebP, TIFF, HEIC/HEIF and AVIF are stripped. For another format
// it returns "" and a nil error, and the caller serves the original.
func (s *MediaService) NoGPSOriginal(ctx context.Context, media models.Medium) (string, error) {
	blank := gpsBlankers[strings.ToLower(media.MimeType)]
	if blank == nil {
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
		return nil, writeNoGPSCopy(srcFull, dstFull, blank)
	}); err != nil {
		return "", err
	}
	return dstFull, nil
}

// writeNoGPSCopy writes the image at src to dst without the GPS IFD entries and
// without the GPS properties of its XMP packets. blank cleans the bytes.
func writeNoGPSCopy(src, dst string, blank func([]byte) error) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return fmt.Errorf("read original: %w", err)
	}
	if err := blank(data); err != nil {
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

// xmpTag is the IFD0 tag that holds an XMP packet in a TIFF file.
const xmpTag = 700

// tiffTypeSize is the byte size of one value of each TIFF field type.
var tiffTypeSize = map[uint16]int{1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8}

// blankTIFFGPS finds the GPS IFD of a TIFF block, zeroes the values its entries
// point to, and sets its entry count to zero. It also blanks the GPS properties
// of an XMP packet in IFD0. A malformed block is left as it is where it cannot
// be read.
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
		switch bo.Uint16(t[e:]) {
		case gpsIFDTag:
			gps = int(bo.Uint32(t[e+8:]))
		case xmpTag:
			if size := int(bo.Uint32(t[e+4:])); size > 4 {
				if off := int(bo.Uint32(t[e+8:])); off >= 8 && off+size <= len(t) {
					blankXMPGPS(t[off : off+size])
				}
			}
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

// blankTIFFFileGPS removes the GPS position from the bytes of a TIFF file in
// place. The file is one TIFF block, so its offsets start at byte 0.
func blankTIFFFileGPS(data []byte) error {
	if len(data) < 8 || (string(data[:4]) != "II*\x00" && string(data[:4]) != "MM\x00*") {
		return fmt.Errorf("not a tiff")
	}
	blankTIFFGPS(data)
	return nil
}

// blankPNGGPS removes the GPS position from PNG bytes in place. It cleans the
// eXIf chunk and the XMP of uncompressed text chunks, and writes the CRC of
// each changed chunk again. A compressed zTXt or iTXt chunk stays as it is.
func blankPNGGPS(data []byte) error {
	if len(data) < 8 || string(data[:8]) != "\x89PNG\r\n\x1a\n" {
		return fmt.Errorf("not a png")
	}
	for p := 8; p+12 <= len(data); {
		n := int(binary.BigEndian.Uint32(data[p:]))
		end := p + 12 + n
		if n < 0 || end > len(data) {
			break
		}
		typ := string(data[p+4 : p+8])
		body := data[p+8 : p+8+n]
		before := crc32.ChecksumIEEE(data[p+4 : p+8+n])
		switch typ {
		case "eXIf":
			blankTIFFGPS(body)
		case "iTXt", "tEXt":
			blankXMPGPS(body)
		}
		if sum := crc32.ChecksumIEEE(data[p+4 : p+8+n]); sum != before {
			binary.BigEndian.PutUint32(data[p+8+n:], sum)
		}
		if typ == "IEND" {
			break
		}
		p = end
	}
	return nil
}

// blankWebPGPS removes the GPS position from WebP bytes in place. It cleans
// the EXIF and XMP chunks of the RIFF container.
func blankWebPGPS(data []byte) error {
	if len(data) < 12 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
		return fmt.Errorf("not a webp")
	}
	for p := 12; p+8 <= len(data); {
		n := int(binary.LittleEndian.Uint32(data[p+4:]))
		end := p + 8 + n
		if n < 0 || end > len(data) {
			break
		}
		body := data[p+8 : end]
		switch string(data[p : p+4]) {
		case "EXIF":
			blankTIFFGPS(bytes.TrimPrefix(body, exifHeader))
		case "XMP ":
			blankXMPGPS(body)
		}
		p = end + n%2
	}
	return nil
}

// isoBox is one box of an ISO base media file: its type and the byte range of
// its payload.
type isoBox struct {
	typ        string
	start, end int
}

// isoBoxes lists the boxes in data[start:end]. It stops at the first box that
// does not fit.
func isoBoxes(data []byte, start, end int) []isoBox {
	var boxes []isoBox
	for p := start; p+8 <= end; {
		size := int(binary.BigEndian.Uint32(data[p:]))
		hdr := 8
		switch size {
		case 0:
			size = end - p
		case 1:
			if p+16 > end {
				return boxes
			}
			big := binary.BigEndian.Uint64(data[p+8:])
			if big > uint64(end-p) {
				return boxes
			}
			size, hdr = int(big), 16
		}
		if size < hdr || p+size > end {
			return boxes
		}
		boxes = append(boxes, isoBox{string(data[p+4 : p+8]), p + hdr, p + size})
		p += size
	}
	return boxes
}

// beUint reads a big-endian unsigned integer of n bytes (0, 4 or 8) at p.
func beUint(data []byte, p, n int) (uint64, bool) {
	if p < 0 || p+n > len(data) {
		return 0, false
	}
	switch n {
	case 0:
		return 0, true
	case 4:
		return uint64(binary.BigEndian.Uint32(data[p:])), true
	case 8:
		return binary.BigEndian.Uint64(data[p:]), true
	}
	return 0, false
}

// blankISOBMFFGPS removes the GPS position from HEIC, HEIF or AVIF bytes in
// place. It reads the item list of the top-level meta box, then cleans the
// Exif item and each XMP item (a mime item). Only items stored as one extent
// in the file are cleaned.
func blankISOBMFFGPS(data []byte) error {
	top := isoBoxes(data, 0, len(data))
	if len(top) == 0 || top[0].typ != "ftyp" {
		return fmt.Errorf("not an iso media file")
	}
	for _, meta := range top {
		if meta.typ != "meta" || meta.start+4 > meta.end {
			continue
		}
		kinds := map[uint32]string{}
		var iloc isoBox
		for _, b := range isoBoxes(data, meta.start+4, meta.end) {
			switch b.typ {
			case "iinf":
				parseIINF(data, b, kinds)
			case "iloc":
				iloc = b
			}
		}
		for id, r := range parseILOC(data, iloc) {
			item := data[r[0]:r[1]]
			switch kinds[id] {
			case "Exif":
				// The payload starts with the offset of the TIFF header.
				if len(item) >= 4 {
					if off := int(binary.BigEndian.Uint32(item)); off >= 0 && 4+off < len(item) {
						blankTIFFGPS(item[4+off:])
					}
				}
			case "mime":
				blankXMPGPS(item)
			}
		}
	}
	return nil
}

// parseIINF records the item type of each entry of an iinf box in kinds.
func parseIINF(data []byte, b isoBox, kinds map[uint32]string) {
	p := b.start + 4
	if b.start+4 > b.end {
		return
	}
	if data[b.start] == 0 {
		p += 2
	} else {
		p += 4
	}
	for _, e := range isoBoxes(data, p, b.end) {
		if e.typ != "infe" || e.start+4 > e.end {
			continue
		}
		q := e.start + 4
		var id uint32
		switch data[e.start] {
		case 2:
			if q+8 > e.end {
				continue
			}
			id = uint32(binary.BigEndian.Uint16(data[q:]))
			q += 2
		case 3:
			if q+10 > e.end {
				continue
			}
			id = binary.BigEndian.Uint32(data[q:])
			q += 4
		default:
			continue
		}
		kinds[id] = string(data[q+2 : q+6])
	}
}

// parseILOC returns the byte range of each item of an iloc box that is stored
// as one extent at a file offset.
func parseILOC(data []byte, b isoBox) map[uint32][2]int {
	out := map[uint32][2]int{}
	if b.start+8 > b.end {
		return out
	}
	version := data[b.start]
	p := b.start + 4
	offSize, lenSize := int(data[p]>>4), int(data[p]&15)
	baseSize, idxSize := int(data[p+1]>>4), int(data[p+1]&15)
	if version == 0 {
		idxSize = 0
	}
	p += 2
	if p+4 > b.end {
		return out
	}
	var count int
	if version < 2 {
		count = int(binary.BigEndian.Uint16(data[p:]))
		p += 2
	} else {
		count = int(binary.BigEndian.Uint32(data[p:]))
		p += 4
	}
	for i := 0; i < count; i++ {
		var id uint32
		if version < 2 {
			if p+2 > b.end {
				return out
			}
			id = uint32(binary.BigEndian.Uint16(data[p:]))
			p += 2
		} else {
			if p+4 > b.end {
				return out
			}
			id = binary.BigEndian.Uint32(data[p:])
			p += 4
		}
		method := 0
		if version > 0 {
			if p+2 > b.end {
				return out
			}
			method = int(data[p+1] & 15)
			p += 2
		}
		p += 2 // data_reference_index
		base, ok := beUint(data, p, baseSize)
		p += baseSize
		if !ok || p+2 > b.end {
			return out
		}
		extents := int(binary.BigEndian.Uint16(data[p:]))
		p += 2
		var off, length uint64
		for j := 0; j < extents; j++ {
			p += idxSize
			o, ok1 := beUint(data, p, offSize)
			p += offSize
			l, ok2 := beUint(data, p, lenSize)
			p += lenSize
			if !ok1 || !ok2 || p > b.end {
				return out
			}
			off, length = o, l
		}
		start := base + off
		if method != 0 || extents != 1 || length == 0 || start > uint64(len(data)) || length > uint64(len(data))-start {
			continue
		}
		out[id] = [2]int{int(start), int(start + length)}
	}
	return out
}
