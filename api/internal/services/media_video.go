package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"point-api/internal/models"
)

// JobKindVideoTranscode is the job kind that writes the browser-safe MP4 of an
// uploaded video.
const JobKindVideoTranscode = "video.transcode"

// videoDir is the subtree of VariantsRoot that holds the transcodes. Like every
// derived file, a backup leaves it out.
const videoDir = "video"

const (
	defaultVideoTimeout = 30 * time.Minute
	defaultVideoThreads = 2
)

// VideoTranscodeRelPath returns the media-relative path of the transcode of the
// video at originalPath: media/variants/video/<YYYY>/<MM>/<name>.mp4.
func VideoTranscodeRelPath(originalPath string) string {
	relUnder := strings.TrimPrefix(originalPath, "originals/")
	name := strings.TrimSuffix(filepath.Base(relUnder), filepath.Ext(relUnder)) + ".mp4"
	return filepath.Join(VariantsRoot, videoDir, filepath.Dir(relUnder), name)
}

type videoTranscodePayload struct {
	MediaID int64 `json:"media_id"`
}

// WithVideo attaches the job store and ffmpeg, and registers the transcode
// handler. Without ffmpeg (the slim image) no job is enqueued and the original
// is served.
func (s *MediaService) WithVideo(jobs *JobService, ff *FFmpeg) *MediaService {
	s.jobs, s.ffmpeg = jobs, ff
	s.videoTimeout, s.videoThreads = defaultVideoTimeout, defaultVideoThreads
	if jobs != nil {
		jobs.Register(JobKindVideoTranscode, s.runVideoTranscodeJob)
	}
	return s
}

// enqueueTranscode adds a transcode job for a video. A failure to enqueue is
// logged: the original stays in service.
func (s *MediaService) enqueueTranscode(ctx context.Context, media models.Medium) {
	if s.jobs == nil || !s.ffmpeg.Available() || !strings.EqualFold(media.FileType, "video") {
		return
	}
	if _, err := s.jobs.Enqueue(ctx, JobKindVideoTranscode, videoTranscodePayload{MediaID: media.ID}); err != nil {
		slog.Warn("video transcode: enqueue failed", "media_id", media.ID, "error", err)
	}
}

func (s *MediaService) runVideoTranscodeJob(ctx context.Context, raw json.RawMessage) error {
	var p videoTranscodePayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return fmt.Errorf("decode payload: %w", err)
	}
	media, err := s.getMedia(ctx, p.MediaID)
	if errors.Is(err, ErrMediaNotFound) {
		// The media item was deleted after the upload. Nothing to do.
		return nil
	}
	if err != nil {
		return err
	}
	return s.TranscodeVideo(ctx, media)
}

// TranscodeVideo writes the MP4 of a video item. An H.264/AAC source gets a
// remux; any other source is encoded again. The original does not change. The
// output is written to a temporary file and renamed, so the media route never
// serves a partial file.
func (s *MediaService) TranscodeVideo(ctx context.Context, media models.Medium) error {
	if !s.ffmpeg.Available() {
		return ErrFFmpegMissing
	}
	base := s.mediaBase()
	src := filepath.Clean(filepath.Join(base, media.OriginalPath))
	dst := filepath.Clean(filepath.Join(base, VideoTranscodeRelPath(media.OriginalPath)))
	if !strings.HasPrefix(src, base+string(filepath.Separator)) ||
		!strings.HasPrefix(dst, base+string(filepath.Separator)) {
		return fmt.Errorf("invalid media path")
	}
	if variantIsFresh(dst, src) {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, s.videoTimeout)
	defer cancel()

	probe, err := s.ffmpeg.Probe(ctx, src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	tmp := dst + ".tmp"
	defer func() { _ = os.Remove(tmp) }()
	if err := s.ffmpeg.Transcode(ctx, src, tmp, probe.NeedsReencode(), s.videoThreads); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return fmt.Errorf("video transcode timed out after %s: %w", s.videoTimeout, err)
		}
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		return err
	}
	slog.Info("video transcode: done", "media_id", media.ID, "remux", !probe.NeedsReencode(), "src_codec", probe.VideoCodec)
	return nil
}

// TranscodedVideo returns the absolute path of the transcode of a video item,
// or "" when none is ready. The caller then serves the original.
func (s *MediaService) TranscodedVideo(media models.Medium) string {
	if !strings.EqualFold(media.FileType, "video") {
		return ""
	}
	base := s.mediaBase()
	src := filepath.Clean(filepath.Join(base, media.OriginalPath))
	dst := filepath.Clean(filepath.Join(base, VideoTranscodeRelPath(media.OriginalPath)))
	if !strings.HasPrefix(dst, base+string(filepath.Separator)) || !variantIsFresh(dst, src) {
		return ""
	}
	return dst
}
