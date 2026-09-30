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

// fakeFFmpeg writes stub ffmpeg/ffprobe scripts into a temp dir and points
// FFMPEG_PATH at them, so the probe parsing runs where ffmpeg is absent.
func fakeFFmpeg(t *testing.T, probeJSON string) *FFmpeg {
	t.Helper()
	dir := t.TempDir()
	stub := "#!/bin/sh\ncat <<'JSON'\n" + probeJSON + "\nJSON\n"
	for _, name := range []string{"ffmpeg", "ffprobe"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(stub), 0o700); err != nil { //nolint:gosec // test stub must be executable
			t.Fatal(err)
		}
	}
	t.Setenv("FFMPEG_PATH", filepath.Join(dir, "ffmpeg"))
	f := DetectFFmpeg()
	if !f.Available() {
		t.Fatalf("stub toolchain not detected: %+v", f)
	}
	return f
}

func TestFFmpegProbe_ParsesOutput(t *testing.T) {
	f := fakeFFmpeg(t, `{"streams":[{"codec_type":"audio","codec_name":"aac"},{"codec_type":"video","codec_name":"hevc","width":3840,"height":2160},{"codec_type":"video","codec_name":"mjpeg","width":10,"height":10}],"format":{"duration":"12.5"}}`)
	p, err := f.Probe(context.Background(), "clip.mov")
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	want := VideoProbe{VideoCodec: "hevc", AudioCodec: "aac", Width: 3840, Height: 2160, Duration: 12.5}
	if *p != want {
		t.Errorf("probe = %+v, want %+v", *p, want)
	}
}

func TestFFmpegProbe_NoVideoStream(t *testing.T) {
	f := fakeFFmpeg(t, `{"streams":[{"codec_type":"audio","codec_name":"aac"}],"format":{"duration":"3"}}`)
	if _, err := f.Probe(context.Background(), "a.m4a"); err == nil {
		t.Error("want an error for a file without a video stream")
	}
}

func TestFFmpegProbe_BadOutput(t *testing.T) {
	f := fakeFFmpeg(t, `not json`)
	if _, err := f.Probe(context.Background(), "x.mp4"); err == nil {
		t.Error("want an error for unparsable ffprobe output")
	}
}
