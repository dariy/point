package repository

import (
	"context"
	"testing"
)

// TestRepository_TrashAndRestoreMedia examines the move of media into the
// trash and out of it, and the effect of the trash on the live media queries.
func TestRepository_TrashAndRestoreMedia(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	if _, err := repo.DB().Exec(`INSERT INTO media (id, filename, original_path, file_type, mime_type, file_size, checksum, is_public) VALUES
		(1, 'a.jpg', 'originals/2026/01/a.jpg', 'image', 'image/jpeg', 10, 'c1', 1),
		(2, 'b.jpg', 'originals/2026/01/b.jpg', 'image', 'image/jpeg', 10, 'c2', 1),
		(3, 'c.jpg', 'originals/2026/02/c.jpg', 'image', 'image/jpeg', 10, 'c3', 1)`); err != nil {
		t.Fatal(err)
	}

	// An empty list changes nothing.
	if n, err := repo.TrashMediaByIDs(ctx, nil); err != nil || n != 0 {
		t.Fatalf("TrashMediaByIDs(nil) = %d, %v", n, err)
	}
	if n, err := repo.RestoreMediaByIDs(ctx, nil); err != nil || n != 0 {
		t.Fatalf("RestoreMediaByIDs(nil) = %d, %v", n, err)
	}

	n, err := repo.TrashMediaByIDs(ctx, []int64{1, 3})
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Errorf("TrashMediaByIDs moved %d rows, want 2", n)
	}
	// A second trash of the same rows changes nothing.
	if n, err := repo.TrashMediaByIDs(ctx, []int64{1, 3}); err != nil || n != 0 {
		t.Errorf("second TrashMediaByIDs = %d, %v; want 0, nil", n, err)
	}

	// The trash makes the rows private and sets DeletedAt.
	got, err := repo.GetMediaByIDs(ctx, []int64{1})
	if err != nil || len(got) != 1 {
		t.Fatalf("GetMediaByIDs = %v, %v", got, err)
	}
	if !got[0].DeletedAt.Valid || got[0].IsPublic != 0 {
		t.Errorf("trashed media: DeletedAt.Valid=%v IsPublic=%d; want true, 0", got[0].DeletedAt.Valid, got[0].IsPublic)
	}
	byPath, err := repo.GetMediaByPath(ctx, "originals/2026/01/a.jpg")
	if err != nil || !byPath.DeletedAt.Valid {
		t.Errorf("GetMediaByPath on trashed media: DeletedAt.Valid=%v, err=%v", byPath.DeletedAt.Valid, err)
	}

	// The live queries skip trashed rows.
	all, err := repo.GetAllMediaPaths(ctx)
	if err != nil || len(all) != 1 || all[0].ID != 2 {
		t.Errorf("GetAllMediaPaths = %v, %v; want only media 2", all, err)
	}
	byPaths, err := repo.GetMediaByPaths(ctx, []string{"originals/2026/01/a.jpg", "originals/2026/01/b.jpg"})
	if err != nil || len(byPaths) != 1 || byPaths[0].ID != 2 {
		t.Errorf("GetMediaByPaths = %v, %v; want only media 2", byPaths, err)
	}
	if c, err := repo.CountMediaFiltered(ctx, "", "", ""); err != nil || c != 1 {
		t.Errorf("CountMediaFiltered = %d, %v; want 1", c, err)
	}
	folders, err := repo.ListMediaFolders(ctx, "")
	if err != nil || len(folders) != 1 {
		t.Errorf("ListMediaFolders = %v, %v; want one folder (2026/01)", folders, err)
	}
	if c, err := repo.CountOrphanedMedia(ctx); err != nil || c != 1 {
		t.Errorf("CountOrphanedMedia = %d, %v; want 1", c, err)
	}

	// Restore takes trashed rows out, and leaves live rows alone.
	n, err = repo.RestoreMediaByIDs(ctx, []int64{1, 2})
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("RestoreMediaByIDs restored %d rows, want 1", n)
	}
	got, err = repo.GetMediaByIDs(ctx, []int64{1})
	if err != nil || len(got) != 1 || got[0].DeletedAt.Valid {
		t.Errorf("restored media: %v, %v; want DeletedAt unset", got, err)
	}
}

// TestRepository_TrashMediaByIDs_ClosedDB examines the error returns.
func TestRepository_TrashMediaByIDs_ClosedDB(t *testing.T) {
	repo := setupTestDB(t)
	_ = repo.Close()
	ctx := context.Background()

	if _, err := repo.TrashMediaByIDs(ctx, []int64{1}); err == nil {
		t.Error("TrashMediaByIDs: expected error on closed db")
	}
	if _, err := repo.RestoreMediaByIDs(ctx, []int64{1}); err == nil {
		t.Error("RestoreMediaByIDs: expected error on closed db")
	}
}
