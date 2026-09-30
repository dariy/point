package services

import (
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
