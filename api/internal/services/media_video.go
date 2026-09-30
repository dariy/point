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

// JobKindVideoPoster is the job kind that writes a server poster for a video
// that has none.
const JobKindVideoPoster = "video.poster"

// posterOffset is the point of the video, as a fraction of its duration, that
// the server poster shows. The first frame is often black.
const posterOffset = 0.10

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
		jobs.Register(JobKindVideoTranscode, s.videoJob(s.TranscodeVideo))
		jobs.Register(JobKindVideoPoster, s.videoJob(s.WriteServerPoster))
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
	if _, err := s.jobs.Enqueue(ctx, JobKindVideoPoster, videoTranscodePayload{MediaID: media.ID}); err != nil {
		slog.Warn("video poster: enqueue failed", "media_id", media.ID, "error", err)
	}
}

// WriteServerPoster stores a frame at 10 % of the duration as the poster of a
// video item. It does nothing when the item already has a poster: a poster
// from the browser always wins, and it replaces a server poster later.
func (s *MediaService) WriteServerPoster(ctx context.Context, media models.Medium) error {
	if !s.ffmpeg.Available() {
		return ErrFFmpegMissing
	}
	if media.ThumbnailPath.Valid && media.ThumbnailPath.String != "" {
		return nil
	}
	base := s.mediaBase()
	src := filepath.Clean(filepath.Join(base, media.OriginalPath))
	if !strings.HasPrefix(src, base+string(filepath.Separator)) {
		return fmt.Errorf("invalid media path")
	}
	ctx, cancel := context.WithTimeout(ctx, s.videoTimeout)
	defer cancel()
	probe, err := s.ffmpeg.Probe(ctx, src)
	if err != nil {
		return err
	}
	frame, err := s.ffmpeg.Frame(ctx, src, probe.Duration*posterOffset)
	if err != nil {
		return err
	}
	// A browser poster can arrive while ffmpeg runs. Read the row again so it
	// is not overwritten.
	current, err := s.getMedia(ctx, media.ID)
	if err != nil {
		return err
	}
	if current.ThumbnailPath.Valid && current.ThumbnailPath.String != "" {
		return nil
	}
	if _, err := s.storePoster(ctx, current, frame); err != nil {
		return err
	}
	slog.Info("video poster: done", "media_id", media.ID)
	return nil
}

// videoJob returns a job handler that loads the media item of the payload and
// runs fn on it. A media item deleted after the upload leaves nothing to do.
func (s *MediaService) videoJob(fn func(context.Context, models.Medium) error) JobHandler {
	return func(ctx context.Context, raw json.RawMessage) error {
		var p videoTranscodePayload
		if err := json.Unmarshal(raw, &p); err != nil {
			return fmt.Errorf("decode payload: %w", err)
		}
		media, err := s.getMedia(ctx, p.MediaID)
		if errors.Is(err, ErrMediaNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		return fn(ctx, media)
	}
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
