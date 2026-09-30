package services

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestDetectFFmpeg_OverrideMissing(t *testing.T) {
	t.Setenv("FFMPEG_PATH", filepath.Join(t.TempDir(), "nope"))
	f := DetectFFmpeg()
	if f.Available() {
		t.Fatalf("Available() = true for a missing FFMPEG_PATH: %+v", f)
	}
	if _, err := f.Probe(context.Background(), "x.mp4"); !errors.Is(err, ErrFFmpegMissing) {
		t.Fatalf("Probe err = %v, want ErrFFmpegMissing", err)
	}
}

func TestDetectFFmpeg_NilSafe(t *testing.T) {
	var f *FFmpeg
	if f.Available() {
		t.Fatal("nil FFmpeg reports available")
	}
}

func TestFFmpegProbe(t *testing.T) {
	t.Setenv("FFMPEG_PATH", "")
	f := DetectFFmpeg()
	if !f.Available() {
		t.Skip("ffmpeg/ffprobe not installed")
	}
	path := filepath.Join(t.TempDir(), "clip.mp4")
	cmd := exec.Command(f.FFmpegPath, "-v", "error",
		"-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=1",
		"-f", "lavfi", "-i", "sine=duration=1",
		"-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("ffmpeg cannot encode the fixture: %v: %s", err, out)
	}
	p, err := f.Probe(context.Background(), path)
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if p.VideoCodec != "h264" || p.AudioCodec != "aac" || p.Width != 320 || p.Height != 240 {
		t.Errorf("probe = %+v, want h264/aac 320x240", p)
	}
	if p.Duration < 0.9 || p.Duration > 1.2 {
		t.Errorf("duration = %v, want about 1s", p.Duration)
	}

	notVideo := filepath.Join(t.TempDir(), "x.txt")
	_ = os.WriteFile(notVideo, []byte("hello"), 0o600)
	if _, err := f.Probe(context.Background(), notVideo); err == nil {
		t.Error("Probe of a text file returned no error")
	}
}
