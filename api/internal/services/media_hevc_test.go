package services

import (
	"context"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func box(typ string, body ...[]byte) []byte {
	n := 8
	for _, p := range body {
		n += len(p)
	}
	out := make([]byte, 8, n)
	binary.BigEndian.PutUint32(out, uint32(n))
	copy(out[4:], typ)
	for _, p := range body {
		out = append(out, p...)
	}
	return out
}

func stsd(entries ...string) []byte {
	head := make([]byte, 8)
	binary.BigEndian.PutUint32(head[4:], uint32(len(entries)))
	parts := [][]byte{head}
	for _, e := range entries {
		parts = append(parts, box(e, make([]byte, 16)))
	}
	return box("stsd", parts...)
}

func movie(entries ...string) []byte {
	stbl := box("stbl", stsd(entries...))
	moov := box("moov", box("trak", box("mdia", box("minf", stbl))))
	return append(box("ftyp", []byte("isom\x00\x00\x02\x00")), moov...)
}

func TestIsHEVCVideo(t *testing.T) {
	cases := []struct {
		name string
		in   []byte
		want bool
	}{
		{"hvc1", movie("hvc1"), true},
		{"hev1", movie("hev1"), true},
		{"hevc second entry", movie("avc1", "hvc1"), true},
		{"h264", movie("avc1"), false},
		{"audio only", movie("mp4a"), false},
		{"empty", nil, false},
		{"truncated", movie("hvc1")[:30], false},
		{"stsd outside moov", append(box("ftyp", []byte("isom")), stsd("hvc1")...), true},
		{"hvc1 in mdat", box("mdat", []byte("....hvc1....")), false},
	}
	for _, c := range cases {
		if got := IsHEVCVideo(c.in); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestIsHEVCVideoBadSize(t *testing.T) {
	b := movie("hvc1")
	binary.BigEndian.PutUint32(b[len(box("ftyp", []byte("isom\x00\x00\x02\x00"))):], 0xFFFFFFF0)
	if IsHEVCVideo(b) {
		t.Error("oversized box must stop the scan")
	}
}

func TestHEVCNeedsNote(t *testing.T) {
	svc, tmp := setupMediaService(t)
	t.Cleanup(func() { _ = os.RemoveAll(tmp) })
	ctx := context.Background()

	h264, err := svc.UploadFile(ctx, UploadFileParams{Filename: "a.mp4", Content: movie("avc1"), MimeType: "video/mp4"})
	if err != nil {
		t.Fatal(err)
	}
	if svc.HEVCNeedsNote(h264) {
		t.Error("H.264 video must not get the note")
	}

	hevc, err := svc.UploadFile(ctx, UploadFileParams{Filename: "b.mov", Content: movie("hvc1"), MimeType: "video/quicktime"})
	if err != nil {
		t.Fatal(err)
	}
	if !svc.HEVCNeedsNote(hevc) {
		t.Fatalf("HEVC video without a transcode must get the note; metadata=%v", hevc.Metadata)
	}

	dst := filepath.Join(svc.mediaBase(), VideoTranscodeRelPath(hevc.OriginalPath))
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, []byte("mp4"), 0o644); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(time.Hour)
	_ = os.Chtimes(dst, future, future)
	if svc.HEVCNeedsNote(hevc) {
		t.Error("HEVC video with a transcode must not get the note")
	}
}
