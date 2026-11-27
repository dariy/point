//go:build !unit

package services

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"point-api/internal/plugins"
)

// siteHealthFixture has one problem of each kind: an image without one of its
// rungs, an image without its original, and a published post that shows a
// file with no media row. A good image and a post with false-positive text
// are there too, so a check that reports too much fails.
type siteHealthFixture struct {
	sh        *SiteHealth
	media     *MediaService
	system    *SystemService
	dataDir   string
	goodID    int64
	noRungID  int64
	noOrigID  int64
	brokenID  int64 // post with a missing media path
	healthyID int64 // post with good references only
}

func newSiteHealthFixture(t *testing.T) siteHealthFixture {
	t.Helper()
	media, dir := setupMediaService(t)
	t.Cleanup(func() {
		_ = os.RemoveAll(dir)
		_ = media.repo.Close()
	})
	ctx := context.Background()
	// Each image has its own size: an upload with the same bytes is the same
	// media row.
	upload := func(name string, w int) (int64, string) {
		m, err := media.UploadFile(ctx, UploadFileParams{Content: jpegBytes(t, w, 600), Filename: name, MimeType: "image/jpeg"})
		if err != nil {
			t.Fatalf("UploadFile %s: %v", name, err)
		}
		return m.ID, m.OriginalPath
	}
	goodID, goodPath := upload("good.jpg", 800)
	noRungID, noRungPath := upload("norung.jpg", 810)
	noOrigID, noOrigPath := upload("noorig.jpg", 820)

	if err := os.Remove(media.variantFullPath(noRungPath, 256)); err != nil {
		t.Fatalf("fixture: remove rung: %v", err)
	}
	if err := os.Remove(filepath.Join(dir, "media", noOrigPath)); err != nil {
		t.Fatalf("fixture: remove original: %v", err)
	}

	db := media.repo.DB()
	if _, err := db.Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'u','e','h','D')`); err != nil {
		t.Fatal(err)
	}
	bare := "/" + strings.TrimPrefix(goodPath, "originals/")
	insert := func(id int64, status, content, thumb string) {
		t.Helper()
		if _, err := db.Exec(`INSERT INTO posts (id, title, slug, content, author_id, status, published_at, thumbnail_path) VALUES (?, 'P', ?, ?, 1, ?, datetime('now'), NULLIF(?, ''))`,
			id, "p"+string(rune('a'+id)), content, status, thumb); err != nil {
			t.Fatal(err)
		}
	}
	// Good references: a bare line with words after it, markdown with a
	// query, and an external URL with a date path. None is broken.
	insert(1, "published", "See "+bare+" here\n![x]("+bare+"?s=512)\nhttps://example.com/2023/04/a-post", bare+"?thumb")
	insert(2, "published", "![gone](/2020/01/gone.jpg)\n"+bare, "")
	// A draft is not live: its broken path does not count.
	insert(3, "draft", "![gone](/2020/01/draft-gone.jpg)", "")

	// The backups plugin is off on a fresh install; the backup tests need it on.
	if err := media.settingsService.SetSetting(ctx, plugins.EnabledKey("backups"), "true", "boolean"); err != nil {
		t.Fatal(err)
	}
	system := NewSystemService(media.repo, dir, "")
	sh := NewSiteHealth(media, system, media.settingsService)
	return siteHealthFixture{
		sh: sh, media: media, system: system, dataDir: dir,
		goodID: goodID, noRungID: noRungID, noOrigID: noOrigID,
		brokenID: 2, healthyID: 1,
	}
}

func item(t *testing.T, r SiteHealthReport, key string) HealthItem {
	t.Helper()
	for _, it := range r.Items {
		if it.Key == key {
			return it
		}
	}
	t.Fatalf("report has no item %q", key)
	return HealthItem{}
}

func (f siteHealthFixture) writeBackup(t *testing.T, age time.Duration) {
	t.Helper()
	dir := filepath.Join(f.dataDir, "backups")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "backup_test.tar.gz")
	if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	when := time.Now().Add(-age)
	if err := os.Chtimes(p, when, when); err != nil {
		t.Fatal(err)
	}
}

func (f siteHealthFixture) writeRestoreCheck(t *testing.T, rc healthRestoreCheck) {
	t.Helper()
	dir := filepath.Join(f.dataDir, "backups")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(rc)
	if err := os.WriteFile(filepath.Join(dir, healthRestoreCheckFile), data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestSiteHealth_MediaFiles(t *testing.T) {
	f := newSiteHealthFixture(t)
	r, err := f.sh.Refresh(context.Background())
	if err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	der := item(t, r, HealthItemDerivatives)
	if der.Status != HealthWarn || der.Count != 1 || len(der.IDs) != 1 || der.IDs[0] != f.noRungID {
		t.Errorf("derivatives = %+v, want warn with id %d", der, f.noRungID)
	}
	orig := item(t, r, HealthItemOriginals)
	if orig.Status != HealthFail || orig.Count != 1 || orig.IDs[0] != f.noOrigID {
		t.Errorf("originals = %+v, want fail with id %d", orig, f.noOrigID)
	}
	if der.Partial || orig.Partial {
		t.Error("a small library hit the time budget")
	}
}

func TestSiteHealth_References(t *testing.T) {
	f := newSiteHealthFixture(t)
	r, err := f.sh.Refresh(context.Background())
	if err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	ref := item(t, r, HealthItemReferences)
	if ref.Status != HealthFail || ref.Count != 1 || ref.IDs[0] != f.brokenID {
		t.Fatalf("references = %+v, want fail with post %d", ref, f.brokenID)
	}
	if len(ref.Samples) != 1 || ref.Samples[0] != "/2020/01/gone.jpg" {
		t.Errorf("samples = %v, want [/2020/01/gone.jpg]", ref.Samples)
	}
}

func TestSiteHealth_TrashedMediaIsABrokenReference(t *testing.T) {
	f := newSiteHealthFixture(t)
	ctx := context.Background()
	if err := f.media.DeleteMedia(ctx, f.goodID); err != nil {
		t.Fatalf("DeleteMedia: %v", err)
	}
	r, err := f.sh.Refresh(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if ref := item(t, r, HealthItemReferences); ref.Count != 2 {
		t.Errorf("references count = %d, want 2 (both posts show the trashed image)", ref.Count)
	}
}

func TestSiteHealth_Backup(t *testing.T) {
	f := newSiteHealthFixture(t)
	ctx := context.Background()
	check := func(want HealthStatus) HealthItem {
		t.Helper()
		r, err := f.sh.Refresh(ctx)
		if err != nil {
			t.Fatal(err)
		}
		it := item(t, r, HealthItemBackup)
		if it.Status != want {
			t.Errorf("backup = %+v, want %s", it, want)
		}
		return it
	}
	check(HealthFail) // no backup exists
	f.writeBackup(t, 10*24*time.Hour)
	check(HealthFail)
	f.writeBackup(t, 3*24*time.Hour)
	check(HealthWarn)
	f.writeBackup(t, time.Hour)
	if it := check(HealthOK); it.At == nil {
		t.Error("backup item has no time")
	}
	if err := f.media.settingsService.SetSetting(ctx, "enable_backup", "false", "boolean"); err != nil {
		t.Fatal(err)
	}
	check(HealthWarn)
	f.system.WithManagedBackups(true)
	check(HealthOK)
}

func TestSiteHealth_RestoreCheck(t *testing.T) {
	f := newSiteHealthFixture(t)
	ctx := context.Background()
	check := func(want HealthStatus) HealthItem {
		t.Helper()
		r, err := f.sh.Refresh(ctx)
		if err != nil {
			t.Fatal(err)
		}
		it := item(t, r, HealthItemRestoreCheck)
		if it.Status != want {
			t.Errorf("restore_check = %+v, want %s", it, want)
		}
		return it
	}
	check(HealthWarn) // never ran
	f.writeRestoreCheck(t, healthRestoreCheck{Backup: "b.tar.gz", CheckedAt: time.Now(), Passed: false, Error: "hash mismatch"})
	if it := check(HealthFail); !strings.Contains(it.Detail, "hash mismatch") {
		t.Errorf("detail = %q, want the stored error", it.Detail)
	}
	f.writeRestoreCheck(t, healthRestoreCheck{Backup: "b.tar.gz", CheckedAt: time.Now().Add(-20 * 24 * time.Hour), Passed: true})
	check(HealthWarn)
	f.writeRestoreCheck(t, healthRestoreCheck{Backup: "b.tar.gz", CheckedAt: time.Now(), Passed: true})
	if it := check(HealthOK); it.At == nil {
		t.Error("restore_check item has no time")
	}
}

func TestSiteHealth_Storage(t *testing.T) {
	f := newSiteHealthFixture(t)
	r, err := f.sh.Refresh(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	it := item(t, r, HealthItemStorage)
	if it.TotalBytes <= 0 || it.FreeBytes < 0 {
		t.Errorf("storage = %+v, want the disk size", it)
	}
}

func TestStorageStatus(t *testing.T) {
	const gib = int64(1 << 30)
	cases := []struct {
		free, total int64
		want        HealthStatus
	}{
		{50 * gib, 100 * gib, HealthOK},
		{8 * gib, 100 * gib, HealthWarn},
		{4 * gib, 100 * gib, HealthFail},
		{gib / 2, 4 * gib, HealthFail}, // under the absolute floor
	}
	for _, c := range cases {
		if got, _ := storageStatus(c.free, c.total); got != c.want {
			t.Errorf("storageStatus(%d, %d) = %s, want %s", c.free, c.total, got, c.want)
		}
	}
}

func TestSiteHealth_CachesUntilRefresh(t *testing.T) {
	f := newSiteHealthFixture(t)
	ctx := context.Background()
	if _, ok := f.sh.Cached(); ok {
		t.Fatal("a new SiteHealth has a cached report")
	}
	first, err := f.sh.Report(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if first.Status != HealthFail {
		t.Errorf("overall status = %s, want fail", first.Status)
	}
	f.writeBackup(t, time.Hour)
	again, err := f.sh.Report(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !again.CheckedAt.Equal(first.CheckedAt) || item(t, again, HealthItemBackup).Status != HealthFail {
		t.Error("Report ran the checks again instead of the cached report")
	}
	fresh, err := f.sh.Refresh(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if item(t, fresh, HealthItemBackup).Status != HealthOK {
		t.Error("Refresh did not run the checks again")
	}
	if cached, _ := f.sh.Cached(); !cached.CheckedAt.Equal(fresh.CheckedAt) {
		t.Error("Refresh did not replace the cached report")
	}
}

func TestSiteHealth_TimeBudgetMarksPartial(t *testing.T) {
	f := newSiteHealthFixture(t)
	f.sh.budget = time.Nanosecond
	r, err := f.sh.Refresh(context.Background())
	if err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if !item(t, r, HealthItemDerivatives).Partial || !item(t, r, HealthItemOriginals).Partial {
		t.Error("a scan past its budget is not marked partial")
	}
	// The other checks do not share the budget.
	if ref := item(t, r, HealthItemReferences); ref.Count != 1 {
		t.Errorf("references count = %d, want 1", ref.Count)
	}
}

// TestSiteHealth_RebuildDerivativesRepairs checks the repair of the
// derivatives item: it writes the missing rung of the listed image, and the
// next check is ok. It does not touch the thumbnail generation.
func TestSiteHealth_RebuildDerivativesRepairs(t *testing.T) {
	f := newSiteHealthFixture(t)
	ctx := context.Background()
	gen, _ := f.media.settingsService.GetSetting(ctx, ThumbnailGenerationSetting, "")

	res, err := f.media.RebuildDerivatives(ctx, []int64{f.noRungID, f.noRungID, f.noOrigID, 99999})
	if err != nil {
		t.Fatalf("RebuildDerivatives: %v", err)
	}
	if res.Rebuilt != 1 {
		t.Errorf("rebuilt = %d, want 1", res.Rebuilt)
	}
	if len(res.Failed) != 2 || res.Failed[0] != f.noOrigID || res.Failed[1] != 99999 {
		t.Errorf("failed = %v, want [%d 99999]", res.Failed, f.noOrigID)
	}
	r, err := f.sh.Refresh(ctx)
	if err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if der := item(t, r, HealthItemDerivatives); der.Status != HealthOK || der.Count != 0 {
		t.Errorf("derivatives after repair = %+v, want ok", der)
	}
	if after, _ := f.media.settingsService.GetSetting(ctx, ThumbnailGenerationSetting, ""); after != gen {
		t.Errorf("thumbnail generation moved from %q to %q", gen, after)
	}
}

func TestRebuildDerivatives_Bounds(t *testing.T) {
	media, dir := setupMediaService(t)
	t.Cleanup(func() {
		_ = os.RemoveAll(dir)
		_ = media.repo.Close()
	})
	ctx := context.Background()
	if _, err := media.RebuildDerivatives(ctx, nil); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("no ids: err = %v, want ErrInvalidInput", err)
	}
	if _, err := media.RebuildDerivatives(ctx, make([]int64, MaxDerivativeRebuild+1)); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("too many ids: err = %v, want ErrInvalidInput", err)
	}
}
