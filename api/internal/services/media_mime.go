package services

import (
	"bytes"
	"errors"
	"strings"
)

// ErrUnsupportedMediaType is returned when an upload's actual content does not
// match any allowlisted image/video/audio format.
var ErrUnsupportedMediaType = errors.New("unsupported media type")

// allowedMediaTypes is the canonical MIME allowlist for uploads. Keys are the
// MIME types DetectMediaType may return; the value is the file-type category
// (image/video/audio) UploadFile uses for processing.
var allowedMediaTypes = map[string]string{
	"image/jpeg":       "image",
	"image/png":        "image",
	"image/gif":        "image",
	"image/webp":       "image",
	"image/avif":       "image",
	"image/bmp":        "image",
	"image/tiff":       "image",
	"image/svg+xml":    "image",
	"image/heic":       "image",
	"image/heif":       "image",
	"video/mp4":        "video",
	"video/quicktime":  "video",
	"video/webm":       "video",
	"video/x-msvideo":  "video",
	"video/x-matroska": "video",
	"video/ogg":        "video",
	"audio/mpeg":       "audio",
	"audio/mp4":        "audio",
	"audio/ogg":        "audio",
	"audio/wav":        "audio",
	"audio/flac":       "audio",
	"audio/aac":        "audio",
}

// MediaTypeCategory returns the file-type category ("image"/"video"/"audio")
// for an allowlisted MIME type, or "" if not allowlisted.
func MediaTypeCategory(mimeType string) string {
	return allowedMediaTypes[normalizeMIME(mimeType)]
}

// normalizeMIME lowercases and strips any parameters (e.g. "; charset=…").
func normalizeMIME(m string) string {
	if i := strings.IndexByte(m, ';'); i >= 0 {
		m = m[:i]
	}
	return strings.ToLower(strings.TrimSpace(m))
}

// DetectMediaType sniffs an upload's magic bytes and returns a canonical,
// allowlisted MIME type — ignoring the client-supplied Content-Type entirely.
// The declared type (from the browser or filename) is used only as a tie-break
// for container formats that share a signature (the ISO base-media family:
// mp4/mov/m4a/heic/avif all begin with "ftyp"). Returns ErrUnsupportedMediaType
// when the content is not a recognized, allowlisted media format — so an HTML
// page or script renamed to .jpg is rejected rather than stored.
func DetectMediaType(content []byte, declared string) (string, error) {
	declared = normalizeMIME(declared)

	if t := sniffMediaType(content, declared); t != "" {
		if _, ok := allowedMediaTypes[t]; ok {
			return t, nil
		}
	}
	return "", ErrUnsupportedMediaType
}

// sniffMediaType returns the MIME type implied by the content's magic bytes, or
// "" if unrecognized. declared disambiguates the ISO base-media container family.
func sniffMediaType(b []byte, declared string) string {
	if len(b) < 12 {
		return ""
	}

	switch {
	case bytes.HasPrefix(b, []byte{0xFF, 0xD8, 0xFF}):
		return "image/jpeg"
	case bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")):
		return "image/png"
	case bytes.HasPrefix(b, []byte("GIF87a")), bytes.HasPrefix(b, []byte("GIF89a")):
		return "image/gif"
	case bytes.HasPrefix(b, []byte("BM")):
		return "image/bmp"
	case bytes.HasPrefix(b, []byte("II*\x00")), bytes.HasPrefix(b, []byte("MM\x00*")):
		return "image/tiff"
	case bytes.HasPrefix(b, []byte("RIFF")) && bytes.Equal(b[8:12], []byte("WEBP")):
		return "image/webp"
	case bytes.HasPrefix(b, []byte("RIFF")) && bytes.Equal(b[8:12], []byte("AVI ")):
		return "video/x-msvideo"
	case bytes.HasPrefix(b, []byte("RIFF")) && bytes.Equal(b[8:12], []byte("WAVE")):
		return "audio/wav"
	case bytes.HasPrefix(b, []byte("OggS")):
		return sniffOgg(b, declared)
	case bytes.HasPrefix(b, []byte("fLaC")):
		return "audio/flac"
	case bytes.HasPrefix(b, []byte("ID3")):
		return "audio/mpeg"
	case b[0] == 0xFF && (b[1]&0xE0) == 0xE0 && (b[1]&0x06) != 0x00:
		// MPEG audio frame sync (MP3 without an ID3 tag). The layer bits
		// (b[1]&0x06) must be non-zero for a valid frame.
		return "audio/mpeg"
	case bytes.HasPrefix(b, []byte{0xFF, 0xF1}), bytes.HasPrefix(b, []byte{0xFF, 0xF9}):
		return "audio/aac" // ADTS
	case bytes.HasPrefix(b, []byte{0x1A, 0x45, 0xDF, 0xA3}):
		return sniffMatroska(b, declared)
	case isSVG(b):
		return "image/svg+xml"
	case bytes.Equal(b[4:8], []byte("ftyp")):
		return sniffISOBMFF(b, declared)
	}
	return ""
}

// sniffISOBMFF resolves the ISO base-media container family from its major
// brand (bytes 8–11), which distinguishes mp4/mov/m4a/heic/avif — all of which
// share the "ftyp" box. Ambiguous audio/video mp4 brands fall back to the
// declared type since the boxes alone can't tell an audio-only .m4a from a .mp4.
func sniffISOBMFF(b []byte, declared string) string {
	brand := strings.TrimSpace(string(b[8:12]))
	switch brand {
	case "avif", "avis":
		return "image/avif"
	case "heic", "heix", "heim", "heis":
		return "image/heic"
	case "hevc", "hevx", "mif1", "msf1":
		return "image/heif"
	case "qt":
		return "video/quicktime"
	case "M4A", "M4B", "F4A":
		return "audio/mp4"
	case "M4V":
		return "video/mp4"
	}
	// mp4/isom/etc.: could be audio-only or video. Trust the declared category
	// when it is an mp4 audio/video type; default to video/mp4.
	switch declared {
	case "audio/mp4", "audio/x-m4a", "audio/m4a":
		return "audio/mp4"
	case "video/quicktime":
		return "video/quicktime"
	}
	return "video/mp4"
}

// sniffOgg distinguishes Ogg audio (Vorbis/Opus/FLAC) from Ogg video (Theora).
// The codec identifier sits in the first page payload after the 28-byte header.
func sniffOgg(b []byte, declared string) string {
	head := b
	if len(head) > 64 {
		head = head[:64]
	}
	switch {
	case bytes.Contains(head, []byte("OpusHead")), bytes.Contains(head, []byte("\x01vorbis")), bytes.Contains(head, []byte("FLAC")):
		return "audio/ogg"
	case bytes.Contains(head, []byte("\x80theora")):
		return "video/ogg"
	}
	if declared == "video/ogg" {
		return "video/ogg"
	}
	return "audio/ogg"
}

// sniffMatroska distinguishes WebM/MKV from Matroska audio. Both share the EBML
// header; the DocType appears shortly after. WebM and generic matroska map to
// video (the app has no audio-only matroska path).
func sniffMatroska(b []byte, declared string) string {
	head := b
	if len(head) > 64 {
		head = head[:64]
	}
	if bytes.Contains(head, []byte("webm")) {
		return "video/webm"
	}
	return "video/x-matroska"
}

// isSVG reports whether the content looks like an SVG document: XML/text whose
// leading non-whitespace begins an XML prolog, comment, doctype, or <svg> tag.
func isSVG(b []byte) bool {
	head := b
	if len(head) > 1024 {
		head = head[:1024]
	}
	head = bytes.TrimPrefix(head, []byte("\xef\xbb\xbf")) // UTF-8 BOM
	trimmed := bytes.TrimLeft(head, " \t\r\n")
	if !bytes.HasPrefix(trimmed, []byte("<")) {
		return false
	}
	lower := bytes.ToLower(head)
	return bytes.Contains(lower, []byte("<svg"))
}
