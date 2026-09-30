//go:build !unit

package services

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
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

// stubVideoFFmpeg writes an ffprobe stub that reports probeJSON and an ffmpeg
// stub that writes "mp4" to its last argument, or fails when fail is set. The
// job path then runs where ffmpeg is absent.
func stubVideoFFmpeg(t *testing.T, probeJSON string, fail bool) *FFmpeg {
	t.Helper()
	dir := t.TempDir()
	ffmpeg := "#!/bin/sh\nfor a; do last=$a; done\nprintf mp4 > \"$last\"\n"
	if fail {
		ffmpeg = "#!/bin/sh\necho broken >&2\nexit 1\n"
	}
	probe := "#!/bin/sh\ncat <<'JSON'\n" + probeJSON + "\nJSON\n"
	for name, body := range map[string]string{"ffmpeg": ffmpeg, "ffprobe": probe} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o700); err != nil { //nolint:gosec // test stub must be executable
			t.Fatal(err)
		}
	}
	t.Setenv("FFMPEG_PATH", filepath.Join(dir, "ffmpeg"))
	return DetectFFmpeg()
}

const hevcProbe = `{"streams":[{"codec_type":"video","codec_name":"hevc","width":3840,"height":2160},{"codec_type":"audio","codec_name":"aac"}],"format":{"duration":"2.0"}}`

func TestVideoTranscodeJob_Stub(t *testing.T) {
	ff := stubVideoFFmpeg(t, hevcProbe, false)
	svc, jobs, _ := newVideoMediaService(t, ff)
	ctx := context.Background()
	media, err := svc.UploadFile(ctx, UploadFileParams{Filename: "a.mov", Content: []byte("mov"), MimeType: "video/quicktime"})
	if err != nil {
		t.Fatal(err)
	}
	if ran, err := jobs.RunOnce(ctx); err != nil || !ran {
		t.Fatalf("RunOnce = %v, %v", ran, err)
	}
	out := svc.TranscodedVideo(media)
	if out == "" {
		t.Fatal("no transcode after the job")
	}
	// A fresh transcode is not written again.
	if err := svc.TranscodeVideo(ctx, media); err != nil {
		t.Fatal(err)
	}
	// Rename moves the transcode; delete removes it.
	renamed, err := svc.RenameMedia(ctx, media.ID, "b.mov")
	if err != nil {
		t.Fatal(err)
	}
	if svc.TranscodedVideo(renamed) == "" {
		t.Error("the transcode did not follow the rename")
	}
	if err := svc.DeleteMedia(ctx, media.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(svc.mediaBase(), VideoTranscodeRelPath(renamed.OriginalPath))); !os.IsNotExist(err) {
		t.Error("delete left the transcode")
	}
}

func TestVideoTranscodeJob_StubFailureAndGone(t *testing.T) {
	ff := stubVideoFFmpeg(t, hevcProbe, true)
	svc, _, _ := newVideoMediaService(t, ff)
	ctx := context.Background()
	media, err := svc.UploadFile(ctx, UploadFileParams{Filename: "a.mov", Content: []byte("mov"), MimeType: "video/quicktime"})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.TranscodeVideo(ctx, media); err == nil || !strings.Contains(err.Error(), "broken") {
		t.Fatalf("err = %v, want the ffmpeg output", err)
	}
	if svc.TranscodedVideo(media) != "" {
		t.Error("a failed transcode is served")
	}
	// A job for a deleted item finishes without work.
	if err := svc.runVideoTranscodeJob(ctx, []byte(`{"media_id":9999}`)); err != nil {
		t.Errorf("job for a deleted item: %v", err)
	}
	if err := svc.runVideoTranscodeJob(ctx, []byte(`{`)); err == nil {
		t.Error("a bad payload returned no error")
	}
}

func TestPosterArgs(t *testing.T) {
	got := strings.Join(posterArgs("in.mov", 1.5), " ")
	for _, want := range []string{"-ss 1.500", "-i in.mov", "-frames:v 1", "pipe:1"} {
		if !strings.Contains(got, want) {
			t.Errorf("poster args miss %q: %s", want, got)
		}
	}
}

func TestVideoPosterJob(t *testing.T) {
	t.Setenv("FFMPEG_PATH", "")
	ff := DetectFFmpeg()
	if !ff.Available() {
		t.Skip("ffmpeg/ffprobe not installed")
	}
	svc, _, tmp := newVideoMediaService(t, ff)
	ctx := context.Background()
	content := encodeFixture(t, ff, "clip.mp4", "libx264", "aac")
	media, err := svc.UploadFile(ctx, UploadFileParams{Filename: "clip.mp4", Content: content, MimeType: "video/mp4"})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.runVideoPosterJob(ctx, []byte(`{"media_id":`+strconv.FormatInt(media.ID, 10)+`}`)); err != nil {
		t.Fatal(err)
	}
	got, err := svc.getMedia(ctx, media.ID)
	if err != nil || !got.ThumbnailPath.Valid {
		t.Fatalf("no server poster: %+v, %v", got.ThumbnailPath, err)
	}
	full := filepath.Join(tmp, "media", got.ThumbnailPath.String)
	server, err := os.ReadFile(full) //nolint:gosec // test temp file
	if err != nil {
		t.Fatal(err)
	}

	// With a poster in place, the job does nothing.
	if err := svc.WriteServerPoster(ctx, got); err != nil {
		t.Fatal(err)
	}

	// A browser poster later replaces the server poster.
	browser, err := svc.SaveVideoPoster(ctx, media.ID, server[:0:0])
	if err == nil {
		t.Fatal("empty poster accepted")
	}
	frame, err := ff.Frame(ctx, filepath.Join(tmp, "media", media.OriginalPath), 0)
	if err != nil {
		t.Fatal(err)
	}
	if browser, err = svc.SaveVideoPoster(ctx, media.ID, frame); err != nil || !browser.ThumbnailPath.Valid {
		t.Fatalf("browser poster: %+v, %v", browser.ThumbnailPath, err)
	}
	if err := svc.WriteServerPoster(ctx, browser); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(full) //nolint:gosec // test temp file
	if bytes.Equal(after, server) {
		t.Error("the browser poster did not replace the server poster")
	}

	// A job for a deleted item finishes without work.
	if err := svc.runVideoPosterJob(ctx, []byte(`{"media_id":9999}`)); err != nil {
		t.Errorf("job for a deleted item: %v", err)
	}
}
