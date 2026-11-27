//go:build !unit

package services

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// trashFixture is a media service with one published post that shows one
// uploaded image, so the image is public before each test trashes it.
type trashFixture struct {
	svc     *MediaService
	tmpDir  string
	imageID int64
	path    string // "originals/YYYY/MM/file"
}

func newTrashFixture(t *testing.T) trashFixture {
	t.Helper()
	svc, tmpDir := setupMediaService(t)
	t.Cleanup(func() {
		_ = os.RemoveAll(tmpDir)
		_ = svc.repo.Close()
	})
	ctx := context.Background()
	m, err := svc.UploadFile(ctx, UploadFileParams{
		Content:  jpegBytes(t, 800, 600),
		Filename: "shown.jpg",
		MimeType: "image/jpeg",
	})
	if err != nil {
		t.Fatalf("UploadFile: %v", err)
	}
	db := svc.repo.DB()
	if _, err := db.Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'u','e','h','D')`); err != nil {
		t.Fatal(err)
	}
	content := "See /" + strings.TrimPrefix(m.OriginalPath, "originals/")
	if _, err := db.Exec(`INSERT INTO posts (id, title, slug, content, author_id, status, published_at) VALUES (1,'P','p',?,1,'published',datetime('now'))`, content); err != nil {
		t.Fatal(err)
	}
	// The post shows the image but does not own it (post_id stays NULL), so
	// the image is also an orphan for CleanupOrphaned.
	if err := svc.UpdateMediaVisibilityForPaths(ctx, []string{m.OriginalPath}); err != nil {
		t.Fatal(err)
	}
	if got, _ := svc.repo.GetMediaByPath(ctx, m.OriginalPath); got.IsPublic == 0 {
		t.Fatal("fixture: image is not public before the trash")
	}
	return trashFixture{svc: svc, tmpDir: tmpDir, imageID: m.ID, path: m.OriginalPath}
}

func (f trashFixture) fileExists(t *testing.T) bool {
	t.Helper()
	_, err := os.Stat(filepath.Join(f.tmpDir, "media", f.path))
	return err == nil
}

// assertTrashed checks every rule a trashed file obeys: the files stay, the row
// is private and marked, and no live listing shows it.
func (f trashFixture) assertTrashed(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	if !f.fileExists(t) {
		t.Error("the trash removed the original from disk")
	}
	row, err := f.svc.repo.GetMediaByPath(ctx, f.path)
	if err != nil {
		t.Fatalf("GetMediaByPath: %v", err)
	}
	if !row.DeletedAt.Valid {
		t.Error("deleted_at is not set")
	}
	if row.IsPublic != 0 {
		t.Error("a trashed file is still public")
	}

	lib, total, err := f.svc.ListMedia(ctx, ListMediaParams{Page: 1, PerPage: 50})
	if err != nil {
		t.Fatal(err)
	}
	if total != 0 || len(lib) != 0 {
		t.Errorf("library shows the trashed file: total=%d len=%d", total, len(lib))
	}
	if folders, _ := f.svc.GetMediaFolders(ctx, ""); len(folders) != 0 {
		t.Errorf("folders list a trashed file: %v", folders)
	}
	if orphans, n, _ := f.svc.ListOrphanedMedia(ctx, 1, 50); n != 0 || len(orphans) != 0 {
		t.Errorf("orphan list shows the trashed file: n=%d", n)
	}
	// The picker and the post editor resolve media by content path.
	if byPath, _ := f.svc.GetMediaByContentPaths(ctx, []string{"/" + strings.TrimPrefix(f.path, "originals/")}); len(byPath) != 0 {
		t.Error("a path lookup resolves the trashed file")
	}
	trash, n, err := f.svc.ListTrashedMedia(ctx, 1, 50)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 || len(trash) != 1 || trash[0].ID != f.imageID {
		t.Errorf("trash list = %d rows (total %d), want the image", len(trash), n)
	}
	// A full recalculation must not make it public again: the post still
	// shows it.
	if _, err := f.svc.RecalculateAllMediaVisibility(ctx); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.UpdateMediaVisibilityForPaths(ctx, []string{f.path}); err != nil {
		t.Fatal(err)
	}
	if row, _ := f.svc.repo.GetMediaByPath(ctx, f.path); row.IsPublic != 0 {
		t.Error("a visibility recalculation made a trashed file public")
	}
}

func TestMediaTrash_DeleteMovesToTrash(t *testing.T) {
	f := newTrashFixture(t)
	if err := f.svc.DeleteMedia(context.Background(), f.imageID); err != nil {
		t.Fatalf("DeleteMedia: %v", err)
	}
	f.assertTrashed(t)
	// A second delete is a no-op, not an error.
	if err := f.svc.DeleteMedia(context.Background(), f.imageID); err != nil {
		t.Errorf("DeleteMedia of a trashed file: %v", err)
	}
}

func TestMediaTrash_BulkDeleteMovesToTrash(t *testing.T) {
	f := newTrashFixture(t)
	n, err := f.svc.BulkDeleteMedia(context.Background(), []int64{f.imageID, 9999})
	if err != nil {
		t.Fatalf("BulkDeleteMedia: %v", err)
	}
	if n != 1 {
		t.Errorf("moved %d, want 1", n)
	}
	f.assertTrashed(t)
	if n, _ := f.svc.BulkDeleteMedia(context.Background(), []int64{f.imageID}); n != 0 {
		t.Errorf("a second bulk delete moved %d, want 0", n)
	}
}

func TestMediaTrash_CleanupOrphanedMovesToTrash(t *testing.T) {
	f := newTrashFixture(t)
	n, _, err := f.svc.CleanupOrphaned(context.Background())
	if err != nil {
		t.Fatalf("CleanupOrphaned: %v", err)
	}
	if n != 1 {
		t.Errorf("moved %d, want 1", n)
	}
	f.assertTrashed(t)
}

func TestMediaTrash_TrashLogsVisibility(t *testing.T) {
	f := newTrashFixture(t)
	ctx := context.Background()
	if err := f.svc.DeleteMedia(ctx, f.imageID); err != nil {
		t.Fatal(err)
	}
	var last int64
	if err := f.svc.repo.DB().QueryRow(
		`SELECT is_public FROM media_visibility_log WHERE media_id = ? ORDER BY id DESC LIMIT 1`, f.imageID).Scan(&last); err != nil {
		t.Fatalf("visibility log: %v", err)
	}
	if last != 0 {
		t.Errorf("last visibility log row is_public = %d, want 0", last)
	}
}

func TestMediaTrash_RestoreRecalculatesVisibility(t *testing.T) {
	f := newTrashFixture(t)
	ctx := context.Background()
	if err := f.svc.DeleteMedia(ctx, f.imageID); err != nil {
		t.Fatal(err)
	}
	n, err := f.svc.RestoreMedia(ctx, []int64{f.imageID})
	if err != nil {
		t.Fatalf("RestoreMedia: %v", err)
	}
	if n != 1 {
		t.Errorf("restored %d, want 1", n)
	}
	row, err := f.svc.repo.GetMediaByPath(ctx, f.path)
	if err != nil {
		t.Fatal(err)
	}
	if row.DeletedAt.Valid {
		t.Error("deleted_at is still set after restore")
	}
	if row.IsPublic == 0 {
		t.Error("restore did not make the file public again; a published post shows it")
	}
	if _, total, _ := f.svc.ListMedia(ctx, ListMediaParams{Page: 1, PerPage: 50}); total != 1 {
		t.Errorf("library total after restore = %d, want 1", total)
	}
	if _, total, _ := f.svc.ListTrashedMedia(ctx, 1, 50); total != 0 {
		t.Errorf("trash total after restore = %d, want 0", total)
	}
	// A restore of a live file does nothing.
	if n, _ := f.svc.RestoreMedia(ctx, []int64{f.imageID}); n != 0 {
		t.Errorf("restore of a live file restored %d", n)
	}
}

func TestMediaTrash_RestoreKeepsUnshownFilePrivate(t *testing.T) {
	f := newTrashFixture(t)
	ctx := context.Background()
	// No post shows the file any more.
	if _, err := f.svc.repo.DB().Exec(`UPDATE posts SET content = '' WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.DeleteMedia(ctx, f.imageID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.RestoreMedia(ctx, []int64{f.imageID}); err != nil {
		t.Fatal(err)
	}
	if row, _ := f.svc.repo.GetMediaByPath(ctx, f.path); row.IsPublic != 0 {
		t.Error("restore made public a file that no published post shows")
	}
}

func TestMediaTrash_PermanentDelete(t *testing.T) {
	f := newTrashFixture(t)
	ctx := context.Background()

	// A live file is refused: it goes to the trash first.
	err := f.svc.PermanentlyDeleteMedia(ctx, f.imageID)
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("PermanentlyDeleteMedia of a live file = %v, want ErrConflict", err)
	}
	if !f.fileExists(t) {
		t.Fatal("a refused permanent delete removed the file")
	}

	if err := f.svc.DeleteMedia(ctx, f.imageID); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.PermanentlyDeleteMedia(ctx, f.imageID); err != nil {
		t.Fatalf("PermanentlyDeleteMedia: %v", err)
	}
	if f.fileExists(t) {
		t.Error("the original is still on disk after Delete now")
	}
	if _, err := f.svc.GetMediaByID(ctx, f.imageID); !errors.Is(err, ErrMediaNotFound) {
		t.Errorf("row after Delete now: %v, want ErrMediaNotFound", err)
	}
	if err := f.svc.PermanentlyDeleteMedia(ctx, f.imageID); !errors.Is(err, ErrMediaNotFound) {
		t.Errorf("second Delete now = %v, want ErrMediaNotFound", err)
	}
}

// The default policy has no user to ask, so a trashed match stays in the
// trash and the upload is a new row: no silent restore.
func TestMediaTrash_DefaultUploadOfTrashedBytesMakesANewRow(t *testing.T) {
	f := newTrashFixture(t)
	ctx := context.Background()
	if err := f.svc.DeleteMedia(ctx, f.imageID); err != nil {
		t.Fatal(err)
	}
	m, err := f.svc.UploadFile(ctx, UploadFileParams{
		Content:  jpegBytes(t, 800, 600),
		Filename: "again.jpg",
		MimeType: "image/jpeg",
	})
	if err != nil {
		t.Fatalf("UploadFile: %v", err)
	}
	if m.ID == f.imageID {
		t.Fatalf("upload returned the trashed row %d, want a new row", m.ID)
	}
	if m.DeletedAt.Valid {
		t.Error("the new row is in the trash")
	}
	if m.OriginalPath == f.path {
		t.Error("the new row shares the original file of the trashed row")
	}
	old, err := f.svc.GetMediaByID(ctx, f.imageID)
	if err != nil {
		t.Fatal(err)
	}
	if !old.DeletedAt.Valid {
		t.Error("a default upload restored the trashed row")
	}

	// A second default upload reuses the new live row.
	again, err := f.svc.UploadFile(ctx, UploadFileParams{
		Content:  jpegBytes(t, 800, 600),
		Filename: "again.jpg",
		MimeType: "image/jpeg",
	})
	if err != nil {
		t.Fatalf("second UploadFile: %v", err)
	}
	if again.ID != m.ID {
		t.Errorf("second upload = row %d, want the live row %d", again.ID, m.ID)
	}
}

// DuplicateAsk reports a trashed match like a live one and changes nothing:
// the client decides between a restore and a second copy.
func TestMediaTrash_AskOnTrashedBytesReportsTheTrashedRow(t *testing.T) {
	f := newTrashFixture(t)
	ctx := context.Background()
	if err := f.svc.DeleteMedia(ctx, f.imageID); err != nil {
		t.Fatal(err)
	}
	_, err := f.svc.UploadFile(ctx, UploadFileParams{
		Content:     jpegBytes(t, 800, 600),
		Filename:    "again.jpg",
		MimeType:    "image/jpeg",
		OnDuplicate: DuplicateAsk,
	})
	var dup *DuplicateMediaError
	if !errors.As(err, &dup) {
		t.Fatalf("UploadFile = %v, want a DuplicateMediaError", err)
	}
	if dup.Existing.ID != f.imageID || !dup.Existing.DeletedAt.Valid {
		t.Errorf("existing = row %d (trashed %v), want the trashed row %d", dup.Existing.ID, dup.Existing.DeletedAt.Valid, f.imageID)
	}
	m, err := f.svc.GetMediaByID(ctx, f.imageID)
	if err != nil {
		t.Fatal(err)
	}
	if !m.DeletedAt.Valid {
		t.Error("an ask restored the trashed row; only Use the existing file may do that")
	}
}
