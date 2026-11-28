package services

import (
	"context"
	"encoding/json"
	"fmt"
	"image"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"point-api/internal/models"
)

// JobKindMediaPhash is the job kind that fills media.phash for old images.
// The migration enqueue_media_phash_backfill queues the first job with the
// same literal kind.
const JobKindMediaPhash = "media.phash"

// phashBatch is the number of images one backfill job hashes. The job store
// runs one job at a time, so a short job lets a video transcode or a
// cross-post run between two batches.
const phashBatch = 50

type phashPayload struct {
	// AfterID is the last media id that an earlier batch read.
	AfterID int64 `json:"after_id"`
}

// storePhash writes the perceptual hash of src to the media row. A failure is
// logged: the media stays usable, and it is not a possible duplicate.
func (s *MediaService) storePhash(ctx context.Context, id int64, src image.Image) {
	if src == nil {
		return
	}
	if err := s.repo.SetMediaPhash(ctx, models.SetMediaPhashParams{Phash: phashValue(src), ID: id}); err != nil {
		slog.Warn("perceptual hash not stored", "media_id", id, "error", err)
	}
}

// phashJob hashes one batch of images with no media.phash, in id order, and
// queues the next batch when this one was full. An image that does not decode
// keeps a NULL hash and the batch continues: the cursor in the payload moves
// past it, so no job reads it again.
func (s *MediaService) phashJob(ctx context.Context, payload json.RawMessage) error {
	var p phashPayload
	if len(payload) > 0 {
		if err := json.Unmarshal(payload, &p); err != nil {
			return fmt.Errorf("phash job payload: %w", err)
		}
	}
	rows, err := s.repo.ListImagesWithoutPhash(ctx, models.ListImagesWithoutPhashParams{AfterID: p.AfterID, Limit: phashBatch})
	if err != nil {
		return err
	}
	base := s.mediaBase()
	for _, r := range rows {
		if err := ctx.Err(); err != nil {
			return err
		}
		p.AfterID = r.ID
		full := filepath.Clean(filepath.Join(base, r.OriginalPath))
		if !strings.HasPrefix(full, base+string(filepath.Separator)) {
			continue
		}
		data, err := os.ReadFile(full)
		if err != nil {
			slog.Warn("phash backfill: original not read", "media_id", r.ID, "error", err)
			continue
		}
		src, err := s.decodeImage(ctx, data)
		if err != nil {
			slog.Warn("phash backfill: image not decoded", "media_id", r.ID, "mime_type", r.MimeType, "error", err)
			continue
		}
		s.storePhash(ctx, r.ID, src)
	}
	if len(rows) == phashBatch && s.jobs != nil {
		if _, err := s.jobs.Enqueue(ctx, JobKindMediaPhash, p); err != nil {
			return fmt.Errorf("phash backfill: next batch not queued: %w", err)
		}
	}
	return nil
}

// DuplicateGroup is a set of live media whose perceptual hashes are near.
type DuplicateGroup struct {
	Media []models.Medium
}

// DuplicatePage is one page of the possible duplicates view.
type DuplicatePage struct {
	Groups []DuplicateGroup
	// Total is the number of media in all groups; GroupCount the number of
	// groups.
	Total      int64
	GroupCount int
	Page       int
	Pages      int
}

// PossibleDuplicates returns one page of the groups of live images whose
// perceptual hashes are within PhashMaxDistance. A page holds whole groups and
// up to perPage media; a group larger than perPage gets a page of its own. The
// group with the newest upload comes first.
//
// A group can also hold exact duplicates (the same checksum), for example
// after "Upload again".
func (s *MediaService) PossibleDuplicates(ctx context.Context, page, perPage int) (DuplicatePage, error) {
	if perPage < 1 {
		perPage = 1
	}
	if page < 1 {
		page = 1
	}
	rows, err := s.repo.ListMediaPhashes(ctx)
	if err != nil {
		return DuplicatePage{}, err
	}
	entries := make([]phashEntry, 0, len(rows))
	for _, r := range rows {
		entries = append(entries, phashEntry{id: r.ID, hash: r.Phash.Int64})
	}
	groups := groupByPhash(entries)

	// Pack whole groups into pages.
	var pages [][][]int64
	count := 0
	var total int64
	for _, g := range groups {
		total += int64(len(g))
		if len(pages) == 0 || count+len(g) > perPage {
			pages = append(pages, nil)
			count = 0
		}
		pages[len(pages)-1] = append(pages[len(pages)-1], g)
		count += len(g)
	}
	out := DuplicatePage{Total: total, GroupCount: len(groups), Page: page, Pages: max(len(pages), 1)}
	if page > len(pages) {
		return out, nil
	}

	var ids []int64
	for _, g := range pages[page-1] {
		ids = append(ids, g...)
	}
	media, err := s.repo.ListLiveMediaByIDs(ctx, ids)
	if err != nil {
		return DuplicatePage{}, err
	}
	byID := make(map[int64]models.Medium, len(media))
	for _, m := range media {
		byID[m.ID] = m
	}
	for _, g := range pages[page-1] {
		var grp DuplicateGroup
		for _, id := range g {
			if m, ok := byID[id]; ok {
				grp.Media = append(grp.Media, m)
			}
		}
		if len(grp.Media) > 1 {
			out.Groups = append(out.Groups, grp)
		}
	}
	return out, nil
}
