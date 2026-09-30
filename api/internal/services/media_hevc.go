package services

import (
	"encoding/binary"
	"encoding/json"
	"strings"

	"point-api/internal/models"
)

// VideoCodecMetaKey is the media.metadata key that records a video codec the
// upload scan found. The only value it takes today is "hevc".
const VideoCodecMetaKey = "VideoCodec"

// maxHEVCScanDepth bounds the box nesting the scan walks, so a crafted file
// cannot recurse without end.
const maxHEVCScanDepth = 8

// hevcContainers are the boxes on the path moov/trak/mdia/minf/stbl/stsd.
var hevcContainers = map[string]bool{
	"moov": true, "trak": true, "mdia": true, "minf": true, "stbl": true,
}

// IsHEVCVideo reports whether an MP4/MOV file has an HEVC video track: a
// sample entry of type hvc1 or hev1 in an stsd box. It is pure Go and needs no
// ffmpeg, so a slim install can flag video that a browser may not play.
func IsHEVCVideo(b []byte) bool {
	return scanHEVCBoxes(b, 0)
}

func scanHEVCBoxes(b []byte, depth int) bool {
	if depth > maxHEVCScanDepth {
		return false
	}
	for len(b) >= 8 {
		size := uint64(binary.BigEndian.Uint32(b[0:4]))
		typ := string(b[4:8])
		hdr := uint64(8)
		switch size {
		case 0:
			size = uint64(len(b))
		case 1:
			if len(b) < 16 {
				return false
			}
			size = binary.BigEndian.Uint64(b[8:16])
			hdr = 16
		}
		if size < hdr || size > uint64(len(b)) {
			return false
		}
		body := b[hdr:size]
		switch {
		case typ == "stsd":
			if stsdHasHEVC(body) {
				return true
			}
		case hevcContainers[typ]:
			if scanHEVCBoxes(body, depth+1) {
				return true
			}
		}
		b = b[size:]
	}
	return false
}

// stsdHasHEVC reads the sample entries of an stsd body: 4 bytes of version and
// flags, a 4-byte entry count, then one box per entry.
func stsdHasHEVC(body []byte) bool {
	if len(body) < 8 {
		return false
	}
	n := binary.BigEndian.Uint32(body[4:8])
	e := body[8:]
	for i := uint32(0); i < n && len(e) >= 8; i++ {
		size := binary.BigEndian.Uint32(e[0:4])
		switch string(e[4:8]) {
		case "hvc1", "hev1":
			return true
		}
		if size < 8 || uint64(size) > uint64(len(e)) {
			return false
		}
		e = e[size:]
	}
	return false
}

// HEVCNeedsNote reports whether the admin UI must warn that a video may not
// play: the upload scan found HEVC and no H.264 transcode exists.
func (s *MediaService) HEVCNeedsNote(m models.Medium) bool {
	if !strings.EqualFold(m.FileType, "video") || !m.Metadata.Valid {
		return false
	}
	var meta map[string]interface{}
	if json.Unmarshal([]byte(m.Metadata.String), &meta) != nil || meta[VideoCodecMetaKey] != "hevc" {
		return false
	}
	return s.TranscodedVideo(m) == ""
}
