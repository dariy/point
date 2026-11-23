//go:build !unit

package services

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"testing"
)

// ageTrash sets deleted_at of a row to the given number of days in the past.
func ageTrash(t *testing.T, db *sql.DB, table string, id int64, days int) {
	t.Helper()
	q := `UPDATE ` + table + ` SET deleted_at = datetime('now', ?) WHERE id = ?`
	if _, err := db.Exec(q, "-"+strconv.Itoa(days)+" days", id); err != nil {
		t.Fatalf("age %s %d: %v", table, id, err)
	}
}

// The purge removes media that has been in the trash for more than 30 days,
// with its files, and keeps newer trash and live media.
func TestTrashPurge_MediaRemovesOnlyExpired(t *testing.T) {
	f := newTrashFixture(t)
	ctx := context.Background()
	db := f.svc.repo.DB()

	recent, err := f.svc.UploadFile(ctx, UploadFileParams{Content: jpegBytes(t, 640, 480), Filename: "recent.jpg", MimeType: "image/jpeg"})
	if err != nil {
		t.Fatal(err)
	}
	live, err := f.svc.UploadFile(ctx, UploadFileParams{Content: jpegBytes(t, 320, 240), Filename: "live.jpg", MimeType: "image/jpeg"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.BulkDeleteMedia(ctx, []int64{f.imageID, recent.ID}); err != nil {
		t.Fatal(err)
	}
	ageTrash(t, db, "media", f.imageID, TrashRetentionDays+1)
	ageTrash(t, db, "media", recent.ID, TrashRetentionDays-1)

	n, err := f.svc.PurgeExpiredTrash(ctx)
	if err != nil {
		t.Fatalf("PurgeExpiredTrash: %v", err)
	}
	if n != 1 {
		t.Errorf("purged %d, want 1", n)
	}
	if f.fileExists(t) {
		t.Error("the purge kept the file of the expired media on disk")
	}
	if _, err := f.svc.repo.GetMediaByPath(ctx, f.path); !errors.Is(err, sql.ErrNoRows) {
		t.Errorf("expired row is still there: err=%v", err)
	}
	if row, err := f.svc.repo.GetMediaByPath(ctx, recent.OriginalPath); err != nil || !row.DeletedAt.Valid {
		t.Errorf("recent trash: err=%v deleted_at=%v, want kept in the trash", err, row.DeletedAt)
	}
	if row, err := f.svc.repo.GetMediaByPath(ctx, live.OriginalPath); err != nil || row.DeletedAt.Valid {
		t.Errorf("live media: err=%v deleted_at=%v, want kept live", err, row.DeletedAt)
	}
}

// The purge removes posts that have been in the trash for more than 30 days
// and keeps newer trash and live posts.
func TestTrashPurge_PostsRemovesOnlyExpired(t *testing.T) {
	f := newTrashFixture(t) // post 1 (live) and user 1
	ctx := context.Background()
	db := f.svc.repo.DB()
	for _, id := range []int64{2, 3} {
		if _, err := db.Exec(`INSERT INTO posts (id, title, slug, content, author_id, status) VALUES (?, 'T', ?, '', 1, 'draft')`, id, "t"+strconv.FormatInt(id, 10)); err != nil {
			t.Fatal(err)
		}
	}
	ageTrash(t, db, "posts", 2, TrashRetentionDays+1)
	ageTrash(t, db, "posts", 3, TrashRetentionDays-1)

	posts := NewPostService(f.svc.repo, nil, nil, nil, "http://localhost")
	n, err := posts.PurgeExpiredTrash(ctx)
	if err != nil {
		t.Fatalf("PurgeExpiredTrash: %v", err)
	}
	if n != 1 {
		t.Errorf("purged %d, want 1", n)
	}
	var ids string
	if err := db.QueryRow(`SELECT group_concat(id, ' ') FROM (SELECT id FROM posts ORDER BY id)`).Scan(&ids); err != nil {
		t.Fatal(err)
	}
	if ids != "1 3" {
		t.Errorf("posts after the purge = %q, want \"1 3\"", ids)
	}
}

// The scheduled task runs both purges and records its outcome in the health
// registry under "trash purge".
func TestTrashPurge_SchedulerRecordsHealth(t *testing.T) {
	f := newTrashFixture(t)
	ctx := context.Background()
	if err := f.svc.DeleteMedia(ctx, f.imageID); err != nil {
		t.Fatal(err)
	}
	ageTrash(t, f.svc.repo.DB(), "media", f.imageID, TrashRetentionDays+1)

	h := NewHealthRegistry()
	posts := NewPostService(f.svc.repo, nil, nil, nil, "http://localhost")
	s := NewSchedulerService(nil, posts, nil, f.svc, nil, nil).WithHealth(h)
	s.RunTaskForTest(ctx, "trash purge", s.purgeTrash)

	snap := h.Snapshot()
	if len(snap) != 1 || snap[0].Name != "trash purge" || !snap[0].Healthy() {
		t.Fatalf("health = %+v, want one healthy \"trash purge\"", snap)
	}
	if f.fileExists(t) {
		t.Error("the scheduled purge kept the expired file")
	}
}
