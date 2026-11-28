package services

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"

	"point-api/internal/models"
	"point-api/internal/plugins"
)

// HealthStatus is the state of one site health item.
type HealthStatus string

const (
	// HealthOK means the item needs no action.
	HealthOK HealthStatus = "ok"
	// HealthInfo means the item is a choice of the admin, not a problem: for
	// example, scheduled backups are off. It shows no dashboard dot.
	HealthInfo HealthStatus = "info"
	// HealthWarn means the item needs action, but visitors see no breakage yet.
	HealthWarn HealthStatus = "warn"
	// HealthFail means the item is broken now, or data is at risk.
	HealthFail HealthStatus = "fail"
)

// The keys of the site health items, in the order the report lists them.
const (
	HealthItemDerivatives  = "derivatives"
	HealthItemOriginals    = "originals"
	HealthItemReferences   = "references"
	HealthItemBackup       = "backup"
	HealthItemRestoreCheck = "restore_check"
	HealthItemStorage      = "storage"
)

// healthMaxIDs is the most IDs one item carries. Count is always the full
// number; the IDs are only the start of the repair list.
const healthMaxIDs = 100

// healthMaxSamples is the most example paths the references item carries.
const healthMaxSamples = 10

// defaultSiteHealthBudget is the time the file checks may use. A check that
// reaches it stops and marks its item partial.
const defaultSiteHealthBudget = 15 * time.Second

// Backup age limits. The daily backup task makes a backup at most one day old
// when it runs; two days give one missed run.
const (
	backupWarnAge = 48 * time.Hour
	backupFailAge = 7 * 24 * time.Hour
	// restoreCheckWarnAge: the daily backup task runs the restore check every
	// 7 days, so 14 days means at least one missed check.
	restoreCheckWarnAge = 14 * 24 * time.Hour
)

// Free storage limits, as a fraction of the disk, and an absolute floor.
const (
	storageFailFraction = 0.05
	storageWarnFraction = 0.10
	storageFailBytes    = 1 << 30
)

// healthRestoreCheckFile is the file in <data>/backups where the restore check
// stores its last result. The NF-13 restore check writes it.
const healthRestoreCheckFile = "restore_check.json"

// HealthItem is one site health check result.
type HealthItem struct {
	Key    string       `json:"key"`
	Status HealthStatus `json:"status"`
	// Count is the number of problems the check found.
	Count int `json:"count"`
	// IDs are the targets of the repair action: media IDs for derivatives and
	// originals, post IDs for references. At most healthMaxIDs.
	IDs []int64 `json:"ids,omitempty"`
	// Samples are example media paths that a reference points to and that
	// have no live media row.
	Samples []string `json:"samples,omitempty"`
	// Detail is a short reason for info, warn and fail.
	Detail string `json:"detail,omitempty"`
	// At is the time of the last backup or the last restore check.
	At *time.Time `json:"at,omitempty"`
	// Partial is true when the check stopped at its time budget.
	Partial    bool  `json:"partial,omitempty"`
	FreeBytes  int64 `json:"free_bytes,omitempty"`
	TotalBytes int64 `json:"total_bytes,omitempty"`
}

func (it *HealthItem) addID(id int64) {
	it.Count++
	if len(it.IDs) < healthMaxIDs {
		it.IDs = append(it.IDs, id)
	}
}

// SiteHealthReport is one run of every site health check.
type SiteHealthReport struct {
	CheckedAt  time.Time `json:"checked_at"`
	DurationMS int64     `json:"duration_ms"`
	// Status is the worst status of the items.
	Status HealthStatus `json:"status"`
	Items  []HealthItem `json:"items"`
}

// SiteHealth runs the site health checks and keeps the last report.
//
// A read gets the cached report, so the dashboard can poll it cheaply. A
// refresh runs the checks again. Concurrent refreshes share one run.
type SiteHealth struct {
	media    *MediaService
	system   *SystemService
	settings *SettingsService
	budget   time.Duration
	now      func() time.Time

	flight singleflight.Group
	mu     sync.RWMutex
	last   *SiteHealthReport
}

// NewSiteHealth returns a SiteHealth with no cached report.
func NewSiteHealth(media *MediaService, system *SystemService, settings *SettingsService) *SiteHealth {
	return &SiteHealth{
		media:    media,
		system:   system,
		settings: settings,
		budget:   defaultSiteHealthBudget,
		now:      time.Now,
	}
}

// Cached returns the last report, and false when no check ran yet.
func (h *SiteHealth) Cached() (SiteHealthReport, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if h.last == nil {
		return SiteHealthReport{}, false
	}
	return *h.last, true
}

// Report returns the cached report. When there is none, it runs the checks.
func (h *SiteHealth) Report(ctx context.Context) (SiteHealthReport, error) {
	if r, ok := h.Cached(); ok {
		return r, nil
	}
	return h.Refresh(ctx)
}

// Refresh runs every check and caches the result. The run does not stop when
// the caller's context is cancelled, because other callers can share it.
func (h *SiteHealth) Refresh(ctx context.Context) (SiteHealthReport, error) {
	v, err, _ := h.flight.Do("run", func() (any, error) {
		r, err := h.run(context.WithoutCancel(ctx))
		if err != nil {
			return nil, err
		}
		h.mu.Lock()
		h.last = &r
		h.mu.Unlock()
		return r, nil
	})
	if err != nil {
		return SiteHealthReport{}, err
	}
	return v.(SiteHealthReport), nil
}

// RunScheduled is the scheduler task: it refreshes the cached report.
func (h *SiteHealth) RunScheduled(ctx context.Context) error {
	_, err := h.Refresh(ctx)
	return err
}

func (h *SiteHealth) run(ctx context.Context) (SiteHealthReport, error) {
	start := h.now()
	// Only the file walk has the time budget: it is the part that grows with
	// the library. The other checks are a few queries.
	scanCtx, cancel := context.WithTimeout(ctx, h.budget)
	derivatives, originals, err := h.checkMediaFiles(scanCtx)
	cancel()
	if err != nil {
		return SiteHealthReport{}, err
	}
	references, err := h.checkReferences(ctx)
	if err != nil {
		return SiteHealthReport{}, err
	}
	items := []HealthItem{
		derivatives,
		originals,
		references,
		h.checkBackup(ctx),
		h.checkRestoreCheck(ctx),
		h.checkStorage(),
	}
	r := SiteHealthReport{
		CheckedAt:  start.UTC(),
		DurationMS: h.now().Sub(start).Milliseconds(),
		Status:     HealthOK,
		Items:      items,
	}
	for _, it := range items {
		r.Status = worseStatus(r.Status, it.Status)
	}
	return r, nil
}

func worseStatus(a, b HealthStatus) HealthStatus {
	rank := map[HealthStatus]int{HealthOK: 0, HealthInfo: 1, HealthWarn: 2, HealthFail: 3}
	if rank[b] > rank[a] {
		return b
	}
	return a
}

// checkMediaFiles walks the live media rows a page at a time. It finds media
// whose original file is gone, and media with a missing derivative:
//   - an image without one of the rungs that upload writes (rungs up to
//     UploadMaxVariantSize and below the longest side; rung 128 when the
//     size is not known);
//   - a video whose stored poster file is gone, or with no poster and no
//     transcode when ffmpeg can make them.
//
// A rebuild purges the variants and warms only the newest uploads, so after a
// rebuild this item counts the rest until a visitor or a repair fills them in.
func (h *SiteHealth) checkMediaFiles(ctx context.Context) (HealthItem, HealthItem, error) {
	der := HealthItem{Key: HealthItemDerivatives, Status: HealthOK}
	orig := HealthItem{Key: HealthItemOriginals, Status: HealthOK}
	m := h.media
	base := m.mediaBase()
	for offset := int64(0); ; offset += mediaScanPage {
		if ctx.Err() != nil {
			der.Partial, orig.Partial = true, true
			break
		}
		rows, err := m.repo.ListMediaFiltered(ctx, "", "", "", mediaScanPage, offset)
		if err != nil {
			if ctx.Err() != nil {
				der.Partial, orig.Partial = true, true
				break
			}
			return der, orig, err
		}
		for _, row := range rows {
			if !fileExists(filepath.Join(base, row.OriginalPath)) {
				orig.addID(row.ID)
				continue
			}
			if m.derivativeMissing(row, base) {
				der.addID(row.ID)
			}
		}
		if len(rows) < mediaScanPage {
			break
		}
	}
	if der.Count > 0 {
		der.Status, der.Detail = HealthWarn, "media with missing derivatives"
	}
	if orig.Count > 0 {
		orig.Status, orig.Detail = HealthFail, "media whose original file is missing"
	}
	if der.Partial && der.Detail == "" {
		der.Detail = "check stopped at its time limit"
	}
	if orig.Partial && orig.Detail == "" {
		orig.Detail = "check stopped at its time limit"
	}
	return der, orig, nil
}

// derivativeMissing reports whether a media item lacks a derived file that
// the server writes for it. The original exists.
func (s *MediaService) derivativeMissing(m models.Medium, base string) bool {
	switch {
	case strings.EqualFold(m.FileType, "image"):
		longest := int64(0)
		if m.Width.Valid && m.Height.Valid {
			longest = max(m.Width.Int64, m.Height.Int64)
		}
		for _, size := range VariantSizes {
			if size > UploadMaxVariantSize {
				break
			}
			if longest > 0 && int64(size) >= longest {
				continue
			}
			if longest <= 0 && size != VariantSizes[0] {
				continue
			}
			if !fileExists(s.variantFullPath(m.OriginalPath, size)) {
				return true
			}
		}
		return false
	case strings.EqualFold(m.FileType, "video"):
		hasPoster := m.ThumbnailPath.Valid && m.ThumbnailPath.String != ""
		if hasPoster && !fileExists(filepath.Join(base, m.ThumbnailPath.String)) {
			return true
		}
		if s.canRunVideoJobs(m) && (!hasPoster || s.TranscodedVideo(m) == "") {
			return true
		}
		return false
	}
	return false
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// mediaRefStart lists the characters that may come before a media path in
// post content: the start, white space, or markup. A path after any other
// character is part of an external URL (https://host/2024/05/post) and is not
// a media reference.
const mediaRefStart = " \t\r\n(\"'=>[,"

// mediaRefCandidates returns the media table paths that one post refers to.
// Each reference has one or two candidates: the match, and the match cut at
// its first space, because mediaPathRe also takes the words after a bare path.
func mediaRefCandidates(content, thumbnailPath string) [][]string {
	var refs [][]string
	add := func(p string) {
		if i := strings.IndexAny(p, "?#"); i >= 0 {
			p = p[:i]
		}
		c := []string{"originals" + p}
		if i := strings.IndexAny(p, " \t"); i >= 0 {
			c = append(c, "originals"+p[:i])
		}
		refs = append(refs, c)
	}
	for _, loc := range mediaPathRe.FindAllStringSubmatchIndex(content, -1) {
		if loc[2] > 0 && !strings.ContainsRune(mediaRefStart, rune(content[loc[2]-1])) {
			continue
		}
		add(content[loc[2]:loc[3]])
	}
	if thumbPathRe.MatchString(thumbnailPath) {
		add(thumbnailPath)
	}
	return refs
}

// thumbPathRe matches a post thumbnail that is a media path, not a poster
// path or an external URL.
var thumbPathRe = regexp.MustCompile(`^/\d{4}/\d{2}/`)

// checkReferences finds published posts that show a media path with no live
// media row: a file that was never uploaded, was renamed outside the app, or
// is in the trash.
func (h *SiteHealth) checkReferences(ctx context.Context) (HealthItem, error) {
	it := HealthItem{Key: HealthItemReferences, Status: HealthOK}
	posts, err := h.media.repo.GetAllPublishedPostContents(ctx)
	if err != nil {
		return it, err
	}
	type postRefs struct {
		id   int64
		refs [][]string
	}
	var all []postRefs
	seen := map[string]struct{}{}
	var lookup []string
	for _, p := range posts {
		refs := mediaRefCandidates(p.Content, p.ThumbnailPath)
		if len(refs) == 0 {
			continue
		}
		all = append(all, postRefs{id: p.ID, refs: refs})
		for _, cands := range refs {
			for _, c := range cands {
				if _, ok := seen[c]; !ok {
					seen[c] = struct{}{}
					lookup = append(lookup, c)
				}
			}
		}
	}
	live := map[string]struct{}{}
	rows, err := h.media.repo.GetMediaByPaths(ctx, lookup)
	if err != nil {
		return it, err
	}
	for _, r := range rows {
		live[r.OriginalPath] = struct{}{}
	}
	sampled := map[string]struct{}{}
	for _, p := range all {
		broken := false
		for _, cands := range p.refs {
			found := false
			for _, c := range cands {
				if _, ok := live[c]; ok {
					found = true
					break
				}
			}
			if found {
				continue
			}
			broken = true
			if _, ok := sampled[cands[0]]; !ok && len(it.Samples) < healthMaxSamples {
				sampled[cands[0]] = struct{}{}
				it.Samples = append(it.Samples, "/"+strings.TrimPrefix(cands[0], "originals/"))
			}
		}
		if broken {
			it.addID(p.id)
		}
	}
	if it.Count > 0 {
		it.Status, it.Detail = HealthFail, "published posts that show missing media"
	}
	return it, nil
}

// checkBackup reports the age of the newest backup archive. A host that
// manages backups is ok: the host's own check reads last_backup.
func (h *SiteHealth) checkBackup(ctx context.Context) HealthItem {
	it := HealthItem{Key: HealthItemBackup, Status: HealthOK}
	last := h.system.LastBackupTime()
	if !last.IsZero() {
		t := last.UTC()
		it.At = &t
	}
	if h.system.BackupManaged() {
		return it
	}
	if !h.backupsScheduled(ctx) {
		it.Status, it.Detail = HealthInfo, "scheduled backups are off"
		return it
	}
	age := h.now().Sub(last)
	switch {
	case last.IsZero():
		it.Status, it.Detail = HealthFail, "no backup exists"
	case age > backupFailAge:
		it.Status, it.Detail = HealthFail, "the last backup is older than 7 days"
	case age > backupWarnAge:
		it.Status, it.Detail = HealthWarn, "the last backup is older than 2 days"
	}
	return it
}

// backupsScheduled reports whether the daily backup task runs: the backups
// plugin is on and the enable_backup setting is true. Managed mode always
// schedules backups.
func (h *SiteHealth) backupsScheduled(ctx context.Context) bool {
	all, _ := h.settings.Snapshot(ctx)
	setting, _ := h.settings.GetSetting(ctx, "enable_backup", "true")
	return plugins.IsEnabled("backups", all) && h.system.BackupEnabled(setting)
}

// healthRestoreCheck is the part of the stored restore check result that the
// health check reads.
type healthRestoreCheck struct {
	Backup    string    `json:"backup"`
	CheckedAt time.Time `json:"checked_at"`
	Passed    bool      `json:"passed"`
	Error     string    `json:"error,omitempty"`
}

// checkRestoreCheck reports the age and result of the last restore check.
// The daily backup task runs the restore check, so when scheduled backups are
// off, a missing or old restore check is info, not a problem. A failed restore
// check stays fail.
func (h *SiteHealth) checkRestoreCheck(ctx context.Context) HealthItem {
	it := HealthItem{Key: HealthItemRestoreCheck, Status: HealthOK}
	scheduled := h.system.BackupManaged() || h.backupsScheduled(ctx)
	data, err := os.ReadFile(filepath.Join(h.system.dataPath, "backups", healthRestoreCheckFile))
	if errors.Is(err, os.ErrNotExist) && !scheduled {
		it.Status, it.Detail = HealthInfo, "scheduled backups are off"
		return it
	}
	if errors.Is(err, os.ErrNotExist) {
		it.Status, it.Detail = HealthWarn, "no restore check has run"
		return it
	}
	var rc healthRestoreCheck
	if err == nil {
		err = json.Unmarshal(data, &rc)
	}
	if err != nil {
		it.Status, it.Detail = HealthWarn, "the restore check result cannot be read"
		return it
	}
	t := rc.CheckedAt.UTC()
	it.At = &t
	switch {
	case !rc.Passed:
		it.Status, it.Count, it.Detail = HealthFail, 1, "the last restore check failed"
		if rc.Error != "" {
			it.Detail += ": " + rc.Error
		}
	case h.now().Sub(rc.CheckedAt) > restoreCheckWarnAge && !scheduled:
		it.Status, it.Detail = HealthInfo, "scheduled backups are off"
	case h.now().Sub(rc.CheckedAt) > restoreCheckWarnAge:
		it.Status, it.Detail = HealthWarn, "the last restore check is older than 14 days"
	}
	return it
}

// checkStorage reports the free space on the disk that holds the data
// directory.
func (h *SiteHealth) checkStorage() HealthItem {
	it := HealthItem{Key: HealthItemStorage, Status: HealthOK}
	d, err := h.system.GetDiskInfo()
	if err != nil || d.Total <= 0 {
		it.Status, it.Detail = HealthWarn, "free storage cannot be read"
		return it
	}
	it.FreeBytes, it.TotalBytes = d.Free, d.Total
	it.Status, it.Detail = storageStatus(d.Free, d.Total)
	return it
}

func storageStatus(free, total int64) (HealthStatus, string) {
	frac := float64(free) / float64(total)
	switch {
	case free < storageFailBytes || frac < storageFailFraction:
		return HealthFail, "free storage is very low"
	case frac < storageWarnFraction:
		return HealthWarn, "free storage is low"
	}
	return HealthOK, ""
}
