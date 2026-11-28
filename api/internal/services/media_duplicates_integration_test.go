//go:build !unit

package services

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"point-api/internal/migrations"
)

// uploadPhashFixture uploads a file from testdata/phash and returns its id.
func uploadPhashFixture(t *testing.T, svc *MediaService, name string) int64 {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "phash", name))
	if err != nil {
		t.Fatal(err)
	}
	mime := "image/jpeg"
	if filepath.Ext(name) == ".webp" {
		mime = "image/webp"
	}
	m, err := svc.UploadFile(context.Background(), UploadFileParams{Content: data, Filename: name, MimeType: mime})
	if err != nil {
		t.Fatalf("upload %s: %v", name, err)
	}
	if !m.Phash.Valid {
		t.Fatalf("upload %s stored no perceptual hash", name)
	}
	return m.ID
}

func duplicateIDs(t *testing.T, svc *MediaService, page, perPage int) (DuplicatePage, [][]int64) {
	t.Helper()
	res, err := svc.PossibleDuplicates(context.Background(), page, perPage)
	if err != nil {
		t.Fatalf("PossibleDuplicates: %v", err)
	}
	var groups [][]int64
	for _, g := range res.Groups {
		var ids []int64
		for _, m := range g.Media {
			ids = append(ids, m.ID)
		}
		groups = append(groups, ids)
	}
	return res, groups
}

func TestPossibleDuplicates_SamePictureOtherSizeAndFormat(t *testing.T) {
	svc, tmp := setupMediaService(t)
	t.Cleanup(func() { _ = os.RemoveAll(tmp) })
	ctx := context.Background()

	aJPEG := uploadPhashFixture(t, svc, "a.jpg")
	c := uploadPhashFixture(t, svc, "c.jpg")
	aWebP := uploadPhashFixture(t, svc, "a.webp")
	d := uploadPhashFixture(t, svc, "d.jpg")
	bJPEG := uploadPhashFixture(t, svc, "b.jpg")
	bSmall := uploadPhashFixture(t, svc, "b-small.jpg")

	res, groups := duplicateIDs(t, svc, 1, 20)
	// The group with the newest upload comes first.
	want := [][]int64{{bJPEG, bSmall}, {aJPEG, aWebP}}
	if !slices.EqualFunc(groups, want, slices.Equal) {
		t.Fatalf("groups = %v, want %v (c=%d, d=%d are other pictures)", groups, want, c, d)
	}
	if res.Total != 4 || res.GroupCount != 2 || res.Pages != 1 {
		t.Fatalf("total=%d groups=%d pages=%d, want 4, 2, 1", res.Total, res.GroupCount, res.Pages)
	}

	// A page holds whole groups: with room for 3 media, each group gets a page.
	res, groups = duplicateIDs(t, svc, 2, 3)
	if res.Pages != 2 || !slices.EqualFunc(groups, want[1:], slices.Equal) {
		t.Fatalf("page 2 of 2: pages=%d groups=%v, want %v", res.Pages, groups, want[1:])
	}

	// Trash one copy: a group of one is not a group.
	if err := svc.DeleteMedia(ctx, aWebP); err != nil {
		t.Fatal(err)
	}
	_, groups = duplicateIDs(t, svc, 1, 20)
	if !slices.EqualFunc(groups, want[:1], slices.Equal) {
		t.Fatalf("after the trash: groups = %v, want %v", groups, want[:1])
	}
}

func TestPossibleDuplicates_UploadIsNeverBlocked(t *testing.T) {
	svc, tmp := setupMediaService(t)
	t.Cleanup(func() { _ = os.RemoveAll(tmp) })
	data, err := os.ReadFile(filepath.Join("testdata", "phash", "a-small.jpg"))
	if err != nil {
		t.Fatal(err)
	}
	uploadPhashFixture(t, svc, "a.jpg")
	// DuplicateAsk stops only on an exact match. A possible duplicate has
	// other bytes, so the upload makes a new row.
	m, err := svc.UploadFile(context.Background(), UploadFileParams{Content: data, Filename: "a-small.jpg", MimeType: "image/jpeg", OnDuplicate: DuplicateAsk})
	if err != nil {
		t.Fatalf("upload of a possible duplicate: %v", err)
	}
	if m.ID == 0 {
		t.Fatal("no new row")
	}
}

func TestPhashBackfillJob_HashesOldImages(t *testing.T) {
	svc, tmp := setupMediaService(t)
	t.Cleanup(func() { _ = os.RemoveAll(tmp) })
	ctx := context.Background()
	if err := migrations.Run(ctx, svc.repo); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	jobs := NewJobService(svc.repo)
	svc.WithVideo(jobs, nil)

	a := uploadPhashFixture(t, svc, "a.jpg")
	aSmall := uploadPhashFixture(t, svc, "a-small.jpg")
	e := uploadPhashFixture(t, svc, "e.jpg")
	// An image whose original is not on disk any more: the job goes past it.
	broken := uploadPhashFixture(t, svc, "f.jpg")
	brokenRow, _ := svc.repo.GetMedia(ctx, broken)
	if err := os.Remove(filepath.Join(tmp, "media", brokenRow.OriginalPath)); err != nil {
		t.Fatal(err)
	}
	// Make them old media: no hash.
	if _, err := svc.repo.DB().Exec(`UPDATE media SET phash = NULL`); err != nil {
		t.Fatal(err)
	}
	if _, groups := duplicateIDs(t, svc, 1, 20); len(groups) != 0 {
		t.Fatalf("groups before the backfill = %v, want none", groups)
	}

	if _, err := jobs.Enqueue(ctx, JobKindMediaPhash, phashPayload{}); err != nil {
		t.Fatal(err)
	}
	for {
		ran, err := jobs.RunOnce(ctx)
		if err != nil {
			t.Fatalf("RunOnce: %v", err)
		}
		if !ran {
			break
		}
	}

	for _, id := range []int64{a, aSmall, e} {
		if m, _ := svc.repo.GetMedia(ctx, id); !m.Phash.Valid {
			t.Errorf("media %d has no hash after the backfill", id)
		}
	}
	if m, _ := svc.repo.GetMedia(ctx, broken); m.Phash.Valid {
		t.Errorf("media %d with no original has a hash", broken)
	}
	_, groups := duplicateIDs(t, svc, 1, 20)
	if want := [][]int64{{a, aSmall}}; !slices.EqualFunc(groups, want, slices.Equal) {
		t.Fatalf("groups after the backfill = %v, want %v", groups, want)
	}
}

func TestPhashBackfillJob_QueuesTheNextBatch(t *testing.T) {
	svc, tmp := setupMediaService(t)
	t.Cleanup(func() { _ = os.RemoveAll(tmp) })
	ctx := context.Background()
	if err := migrations.Run(ctx, svc.repo); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	jobs := NewJobService(svc.repo)
	svc.WithVideo(jobs, nil)
	// phashBatch image rows with no file: one full batch, then one more.
	for i := 0; i <= phashBatch; i++ {
		if _, err := svc.repo.DB().Exec(`INSERT INTO media (filename, original_path, file_type, mime_type, file_size, checksum)
			VALUES ('x.jpg', 'originals/none.jpg', 'image', 'image/jpeg', 1, ?)`, i); err != nil {
			t.Fatal(err)
		}
	}
	if err := svc.phashJob(ctx, []byte(`{}`)); err != nil {
		t.Fatal(err)
	}
	views, err := jobs.List(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	var next []int64
	for _, v := range views {
		if v.Kind == JobKindMediaPhash {
			next = append(next, v.Refs["after_id"])
		}
	}
	if len(next) != 1 || next[0] != phashBatch {
		t.Fatalf("queued phash jobs = %v, want one with after_id 50", next)
	}
}

func TestMigration_EnqueuesThePhashBackfillOnlyWithImages(t *testing.T) {
	for _, withImage := range []bool{false, true} {
		repo := setupTestDB(t)
		ctx := context.Background()
		if withImage {
			if _, err := repo.DB().Exec(`INSERT INTO media (filename, original_path, file_type, mime_type, file_size, checksum)
				VALUES ('x.jpg', 'originals/x.jpg', 'image', 'image/jpeg', 1, 'c')`); err != nil {
				t.Fatal(err)
			}
		}
		if err := migrations.Run(ctx, repo); err != nil {
			t.Fatalf("migrate: %v", err)
		}
		var n int
		if err := repo.DB().QueryRow(`SELECT COUNT(*) FROM jobs WHERE kind = ? AND state = 'queued'`, JobKindMediaPhash).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if want := map[bool]int{false: 0, true: 1}[withImage]; n != want {
			t.Errorf("with image %v: %d queued phash jobs, want %d", withImage, n, want)
		}
		_ = repo.Close()
	}
}
