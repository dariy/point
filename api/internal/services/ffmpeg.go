package services

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
)

// ErrFFmpegMissing is returned by FFmpeg methods when no ffmpeg/ffprobe
// binary was found. The slim image ships without ffmpeg; callers must treat
// this as "serve the original", not as a failure.
var ErrFFmpegMissing = errors.New("ffmpeg is not available")

// FFmpeg locates the ffmpeg and ffprobe binaries. ffmpeg runs as a child
// process, so the Go binary stays CGO-free.
//
// The full image installs ffmpeg; the slim image does not. FFMPEG_PATH
// overrides the lookup: it names the ffmpeg binary, and ffprobe is looked
// for next to it.
type FFmpeg struct {
	FFmpegPath  string `json:"ffmpeg_path,omitempty"`
	FFprobePath string `json:"ffprobe_path,omitempty"`
}

// DetectFFmpeg finds ffmpeg and ffprobe. It never fails: a missing binary
// leaves its path empty, and Available reports false.
func DetectFFmpeg() *FFmpeg {
	f := &FFmpeg{}
	if p := os.Getenv("FFMPEG_PATH"); p != "" {
		if st, err := os.Stat(p); err == nil && !st.IsDir() { //nolint:gosec // FFMPEG_PATH is operator config, not user input
			f.FFmpegPath = p
			probe := filepath.Join(filepath.Dir(p), "ffprobe")
			if st, err := os.Stat(probe); err == nil && !st.IsDir() { //nolint:gosec // derived from FFMPEG_PATH
				f.FFprobePath = probe
			}
		}
		return f
	}
	if p, err := exec.LookPath("ffmpeg"); err == nil {
		f.FFmpegPath = p
	}
	if p, err := exec.LookPath("ffprobe"); err == nil {
		f.FFprobePath = p
	}
	return f
}

// Available reports whether both ffmpeg and ffprobe were found. Safe on nil.
func (f *FFmpeg) Available() bool {
	return f != nil && f.FFmpegPath != "" && f.FFprobePath != ""
}

// VideoProbe is what Probe reads from a video file.
type VideoProbe struct {
	VideoCodec string  `json:"video_codec"`
	AudioCodec string  `json:"audio_codec,omitempty"`
	Width      int     `json:"width"`
	Height     int     `json:"height"`
	Duration   float64 `json:"duration"` // seconds
}

// Probe runs ffprobe on path and returns the first video stream's codec and
// size, the first audio stream's codec, and the container duration.
func (f *FFmpeg) Probe(ctx context.Context, path string) (*VideoProbe, error) {
	if !f.Available() {
		return nil, ErrFFmpegMissing
	}
	out, err := exec.CommandContext(ctx, f.FFprobePath, //nolint:gosec // detected binary; path is passed after "--"
		"-v", "error",
		"-print_format", "json",
		"-show_entries", "format=duration:stream=codec_type,codec_name,width,height",
		"--", path,
	).Output()
	if err != nil {
		return nil, fmt.Errorf("ffprobe %s: %w", filepath.Base(path), err)
	}
	var raw struct {
		Streams []struct {
			CodecType string `json:"codec_type"`
			CodecName string `json:"codec_name"`
			Width     int    `json:"width"`
			Height    int    `json:"height"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(out, &raw); err != nil {
		return nil, fmt.Errorf("ffprobe output: %w", err)
	}
	p := &VideoProbe{}
	for _, s := range raw.Streams {
		switch s.CodecType {
		case "video":
			if p.VideoCodec == "" {
				p.VideoCodec, p.Width, p.Height = s.CodecName, s.Width, s.Height
			}
		case "audio":
			if p.AudioCodec == "" {
				p.AudioCodec = s.CodecName
			}
		}
	}
	if p.VideoCodec == "" {
		return nil, fmt.Errorf("ffprobe %s: no video stream", filepath.Base(path))
	}
	p.Duration, _ = strconv.ParseFloat(raw.Format.Duration, 64)
	return p, nil
}

// videoMaxSide is the longest side of a transcode. A smaller source is not
// scaled up.
const videoMaxSide = 1920

// NeedsReencode reports whether a source must be encoded again. A source with
// H.264 video and AAC audio (or no audio) plays in every browser, so a remux
// into MP4 is enough.
func (p *VideoProbe) NeedsReencode() bool {
	return p.VideoCodec != "h264" || (p.AudioCodec != "" && p.AudioCodec != "aac")
}

// transcodeArgs returns the ffmpeg arguments that write src to dst as an MP4
// with H.264 High and AAC. With reencode false, the streams are copied. The
// output has no global metadata, so a location tag in the source is not served.
func transcodeArgs(src, dst string, reencode bool, threads int) []string {
	args := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-y",
		"-threads", strconv.Itoa(threads),
		"-i", src,
		"-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "-1",
	}
	if reencode {
		// Scale the long side down to videoMaxSide; -2 keeps the other side even.
		scale := fmt.Sprintf("scale='if(gte(iw,ih),min(%[1]d,iw),-2)':'if(gte(iw,ih),-2,min(%[1]d,ih))'", videoMaxSide)
		args = append(args,
			"-vf", scale,
			"-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-crf", "23", "-preset", "medium",
			"-c:a", "aac", "-b:a", "128k", "-ac", "2",
		)
	} else {
		args = append(args, "-c", "copy")
	}
	return append(args, "-movflags", "+faststart", "-f", "mp4", dst)
}

// Transcode writes src to dst as an MP4 that plays in every browser. See
// transcodeArgs. ctx bounds the run; threads limits the encoder threads.
func (f *FFmpeg) Transcode(ctx context.Context, src, dst string, reencode bool, threads int) error {
	if !f.Available() {
		return ErrFFmpegMissing
	}
	cmd := exec.CommandContext(ctx, f.FFmpegPath, transcodeArgs(src, dst, reencode, threads)...) //nolint:gosec // detected binary; paths come from media rows
	if out, err := cmd.CombinedOutput(); err != nil {
		msg := string(out)
		if len(msg) > 500 {
			msg = msg[len(msg)-500:]
		}
		return fmt.Errorf("ffmpeg %s: %w: %s", filepath.Base(src), err, msg)
	}
	return nil
}

// posterArgs returns the ffmpeg arguments that write one JPEG frame at the
// offset at (seconds) of src to stdout.
func posterArgs(src string, at float64) []string {
	return []string{"-nostdin", "-hide_banner", "-loglevel", "error",
		"-ss", strconv.FormatFloat(at, 'f', 3, 64),
		"-i", src,
		"-frames:v", "1", "-map_metadata", "-1", "-q:v", "2",
		"-f", "image2pipe", "-c:v", "mjpeg", "pipe:1",
	}
}

// Frame returns one JPEG frame of src at the offset at (seconds).
func (f *FFmpeg) Frame(ctx context.Context, src string, at float64) ([]byte, error) {
	if !f.Available() {
		return nil, ErrFFmpegMissing
	}
	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, f.FFmpegPath, posterArgs(src, at)...) //nolint:gosec // detected binary; paths come from media rows
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		msg := stderr.String()
		if len(msg) > 500 {
			msg = msg[len(msg)-500:]
		}
		return nil, fmt.Errorf("ffmpeg frame %s: %w: %s", filepath.Base(src), err, msg)
	}
	if stdout.Len() == 0 {
		return nil, fmt.Errorf("ffmpeg frame %s: no frame at %.3fs", filepath.Base(src), at)
	}
	return stdout.Bytes(), nil
}
