//go:build !unit

package services

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"point-api/internal/migrations"
)

// newVideoMediaService returns a media service with the job store and ffmpeg
// attached, over a migrated database.
func newVideoMediaService(t *testing.T, ff *FFmpeg) (*MediaService, *JobService, string) {
	t.Helper()
	svc, tmp := setupMediaService(t)
	t.Cleanup(func() { _ = os.RemoveAll(tmp) })
	if err := migrations.Run(context.Background(), svc.repo); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	jobs := NewJobService(svc.repo)
	svc.WithVideo(jobs, ff)
	return svc, jobs, tmp
}

func TestVideoTranscodeRelPath(t *testing.T) {
	got := VideoTranscodeRelPath("originals/2026/09/1700_clip.MOV")
	if want := filepath.Join("variants", "video", "2026", "09", "1700_clip.mp4"); got != want {
		t.Fatalf("path = %q, want %q", got, want)
	}
}

func TestNeedsReencode(t *testing.T) {
	for _, tc := range []struct {
		v, a string
		want bool
	}{{"h264", "aac", false}, {"h264", "", false}, {"hevc", "aac", true}, {"h264", "pcm_s16le", true}} {
		if got := (&VideoProbe{VideoCodec: tc.v, AudioCodec: tc.a}).NeedsReencode(); got != tc.want {
			t.Errorf("%s/%s: NeedsReencode = %v, want %v", tc.v, tc.a, got, tc.want)
		}
	}
}

func TestTranscodeArgs(t *testing.T) {
	remux := transcodeArgs("in.mov", "out.mp4", false, 2)
	if !slices.Contains(remux, "copy") || slices.Contains(remux, "libx264") {
		t.Errorf("remux args: %v", remux)
	}
	enc := strings.Join(transcodeArgs("in.mov", "out.mp4", true, 2), " ")
	for _, want := range []string{"-threads 2", "libx264", "-profile:v high", "yuv420p", "-crf 23", "-b:a 128k", "+faststart", "min(1920,iw)"} {
		if !strings.Contains(enc, want) {
			t.Errorf("encode args miss %q: %s", want, enc)
		}
	}
}

// encodeFixture writes a 1 s clip with the given video and audio encoders.
func encodeFixture(t *testing.T, f *FFmpeg, name, vcodec, acodec string) []byte {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	cmd := exec.Command(f.FFmpegPath, "-v", "error", //nolint:gosec // test fixture
		"-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=1",
		"-f", "lavfi", "-i", "sine=duration=1",
		"-c:v", vcodec, "-pix_fmt", "yuv420p", "-c:a", acodec, "-shortest", path)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("ffmpeg cannot encode the fixture: %v: %s", err, out)
	}
	data, err := os.ReadFile(path) //nolint:gosec // test temp file
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestVideoTranscodeJob(t *testing.T) {
	t.Setenv("FFMPEG_PATH", "")
	ff := DetectFFmpeg()
	if !ff.Available() {
		t.Skip("ffmpeg/ffprobe not installed")
	}
	for _, tc := range []struct{ name, file, vcodec, acodec string }{
		{"remux", "clip.mp4", "libx264", "aac"},
		{"reencode", "clip.mov", "mpeg4", "pcm_s16le"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, jobs, tmp := newVideoMediaService(t, ff)
			ctx := context.Background()

			content := encodeFixture(t, ff, tc.file, tc.vcodec, tc.acodec)
			media, err := svc.UploadFile(ctx, UploadFileParams{Filename: tc.file, Content: content, MimeType: "video/mp4"})
			if err != nil {
				t.Fatal(err)
			}
			if got := svc.TranscodedVideo(media); got != "" {
				t.Fatalf("transcode served before the job ran: %s", got)
			}
			if ran, err := jobs.RunOnce(ctx); err != nil || !ran {
				t.Fatalf("RunOnce = %v, %v", ran, err)
			}
			out := svc.TranscodedVideo(media)
			if out == "" {
				t.Fatal("no transcode after the job")
			}
			p, err := ff.Probe(ctx, out)
			if err != nil || p.VideoCodec != "h264" || p.AudioCodec != "aac" {
				t.Fatalf("transcode probe = %+v, %v", p, err)
			}
			orig, _ := os.ReadFile(filepath.Join(tmp, "media", media.OriginalPath)) //nolint:gosec // test temp file
			if !bytes.Equal(orig, content) {
				t.Error("the original changed")
			}
		})
	}
}

func TestVideoTranscodeJob_FailureKeepsOriginal(t *testing.T) {
	t.Setenv("FFMPEG_PATH", "")
	ff := DetectFFmpeg()
	if !ff.Available() {
		t.Skip("ffmpeg/ffprobe not installed")
	}
	svc, jobs, tmp := newVideoMediaService(t, ff)
	ctx := context.Background()

	media, err := svc.UploadFile(ctx, UploadFileParams{Filename: "bad.mp4", Content: []byte("not a video"), MimeType: "video/mp4"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if got := svc.TranscodedVideo(media); got != "" {
		t.Fatalf("a failed job left a transcode: %s", got)
	}
	if _, err := os.Stat(filepath.Join(tmp, "media", VideoTranscodeRelPath(media.OriginalPath)+".tmp")); !os.IsNotExist(err) {
		t.Error("the temporary file was left behind")
	}
}

func TestVideoTranscode_NoFFmpegEnqueuesNothing(t *testing.T) {
	svc, jobs, _ := newVideoMediaService(t, &FFmpeg{})
	if _, err := svc.UploadFile(context.Background(), UploadFileParams{Filename: "a.mp4", Content: []byte("x"), MimeType: "video/mp4"}); err != nil {
		t.Fatal(err)
	}
	if ran, _ := jobs.RunOnce(context.Background()); ran {
		t.Error("a job was enqueued without ffmpeg")
	}
}
