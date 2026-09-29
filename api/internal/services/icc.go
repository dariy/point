package services

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"image"
	"io"
	"os"
	"strings"
	"unicode/utf16"

	"github.com/disintegration/imaging"
)

// iccMaxBytes bounds a profile read from an upload. Real display profiles are
// 0.5–60 KB; a larger one is either a device-link table or hostile.
const iccMaxBytes = 4 << 20

// iccChunkMax is the most profile bytes one APP2 segment holds: the 65,535-byte
// segment length, minus its own 2 bytes, the 12-byte "ICC_PROFILE\0" marker and
// the 2 sequence bytes.
const iccChunkMax = 65535 - 2 - 14

var iccMarker = []byte("ICC_PROFILE\x00")

// extractICC returns the ICC profile embedded in a JPEG (APP2 ICC_PROFILE
// segments, joined in sequence order) or a PNG (iCCP chunk). It returns nil
// when the source has no profile, the profile is malformed, or it is sRGB:
// browsers assume sRGB, so a variant needs no profile to render it correctly.
func extractICC(data []byte) []byte {
	var icc []byte
	switch {
	case bytes.HasPrefix(data, []byte{0xFF, 0xD8}):
		icc = jpegICC(data)
	case bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")):
		icc = pngICC(data)
	}
	if len(icc) < 132 || isSRGBProfile(icc) {
		return nil
	}
	return icc
}

// jpegICC walks the marker segments up to the start of scan and joins the
// ICC_PROFILE chunks by their 1-based sequence number.
func jpegICC(data []byte) []byte {
	chunks := map[int][]byte{}
	total := 0
	for i := 2; i+4 <= len(data); {
		if data[i] != 0xFF {
			return nil
		}
		marker := data[i+1]
		if marker == 0xFF { // fill byte
			i++
			continue
		}
		if marker == 0xDA || marker == 0xD9 { // SOS, EOI: no more headers
			break
		}
		if marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7) {
			i += 2
			continue
		}
		n := int(binary.BigEndian.Uint16(data[i+2:]))
		if n < 2 || i+2+n > len(data) {
			return nil
		}
		seg := data[i+4 : i+2+n]
		if marker == 0xE2 && len(seg) > 14 && bytes.HasPrefix(seg, iccMarker) {
			seq, count := int(seg[12]), int(seg[13])
			if seq == 0 || seq > count {
				return nil
			}
			chunks[seq] = seg[14:]
			total = count
		}
		i += 2 + n
	}
	if total == 0 || len(chunks) != total {
		return nil
	}
	var out []byte
	for seq := 1; seq <= total; seq++ {
		c, ok := chunks[seq]
		if !ok {
			return nil
		}
		out = append(out, c...)
	}
	return out
}

// pngICC inflates the iCCP chunk: a Latin-1 name, a NUL, a compression method
// byte (0 = zlib) and the compressed profile.
func pngICC(data []byte) []byte {
	for i := 8; i+12 <= len(data); {
		n := int(binary.BigEndian.Uint32(data[i:]))
		typ := string(data[i+4 : i+8])
		if n < 0 || i+12+n > len(data) {
			return nil
		}
		body := data[i+8 : i+8+n]
		switch typ {
		case "iCCP":
			nul := bytes.IndexByte(body, 0)
			if nul < 0 || nul+2 > len(body) || body[nul+1] != 0 {
				return nil
			}
			zr, err := zlib.NewReader(bytes.NewReader(body[nul+2:]))
			if err != nil {
				return nil
			}
			defer func() { _ = zr.Close() }()
			icc, err := io.ReadAll(io.LimitReader(zr, iccMaxBytes+1))
			if err != nil || len(icc) > iccMaxBytes {
				return nil
			}
			return icc
		case "IDAT", "IEND": // iCCP must come before image data
			return nil
		}
		i += 12 + n
	}
	return nil
}

// isSRGBProfile reports whether a profile's description names sRGB. The
// description is a v2 'desc' (ASCII) or v4 'mluc' (UTF-16BE) tag.
func isSRGBProfile(icc []byte) bool {
	count := int(binary.BigEndian.Uint32(icc[128:]))
	for k := 0; k < count; k++ {
		e := 132 + 12*k
		if e+12 > len(icc) {
			return false
		}
		if string(icc[e:e+4]) != "desc" {
			continue
		}
		off := int(binary.BigEndian.Uint32(icc[e+4:]))
		size := int(binary.BigEndian.Uint32(icc[e+8:]))
		if off < 0 || size < 12 || off+size > len(icc) || off+size < off {
			return false
		}
		return strings.Contains(strings.ToLower(profileText(icc[off:off+size])), "srgb")
	}
	return false
}

// profileText returns the readable text of a 'desc' or 'mluc' tag.
func profileText(tag []byte) string {
	switch string(tag[:4]) {
	case "desc":
		n := int(binary.BigEndian.Uint32(tag[8:]))
		if n < 0 || 12+n > len(tag) {
			n = len(tag) - 12
		}
		return string(bytes.TrimRight(tag[12:12+n], "\x00"))
	case "mluc":
		if len(tag) < 28 {
			return ""
		}
		l := int(binary.BigEndian.Uint32(tag[20:]))
		o := int(binary.BigEndian.Uint32(tag[24:]))
		if l < 0 || o < 0 || o+l > len(tag) || o+l < o {
			return ""
		}
		u := make([]uint16, l/2)
		for j := range u {
			u[j] = binary.BigEndian.Uint16(tag[o+2*j:])
		}
		return string(utf16.Decode(u))
	}
	return ""
}

// iccSegments encodes a profile as APP2 ICC_PROFILE segments.
func iccSegments(icc []byte) []byte {
	count := (len(icc) + iccChunkMax - 1) / iccChunkMax
	if count > 255 {
		return nil
	}
	var out []byte
	for seq := 1; seq <= count; seq++ {
		chunk := icc[(seq-1)*iccChunkMax : min(seq*iccChunkMax, len(icc))]
		n := 2 + len(iccMarker) + 2 + len(chunk)
		out = append(out, 0xFF, 0xE2, byte(n>>8), byte(n))
		out = append(out, iccMarker...)
		out = append(out, byte(seq), byte(count))
		out = append(out, chunk...)
	}
	return out
}

// saveJPEGWithICC writes img as a JPEG. A non-nil icc is embedded as APP2
// segments directly after SOI, so the browser renders the variant in the
// source's colour space rather than as sRGB.
func saveJPEGWithICC(img image.Image, path string, icc []byte, opts ...imaging.EncodeOption) error {
	if len(icc) == 0 {
		return imaging.Save(img, path, opts...)
	}
	var buf bytes.Buffer
	if err := imaging.Encode(&buf, img, imaging.JPEG, opts...); err != nil {
		return err
	}
	enc := buf.Bytes()
	out := make([]byte, 0, len(enc)+len(icc)+64)
	out = append(out, enc[:2]...)
	out = append(out, iccSegments(icc)...)
	out = append(out, enc[2:]...)
	// path is a variantFullPath under the media root, never request input.
	//nolint:gosec // G703: path is composed from the storage root, not from input
	return os.WriteFile(path, out, 0644)
}
