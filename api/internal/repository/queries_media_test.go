package repository

import (
	"context"
	"testing"
)

func TestRepository_OrphanedMedia(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	ctx := context.Background()

	// Insert some media
	_, _ = repo.DB().Exec(`INSERT INTO media (filename, original_path, file_type, mime_type, file_size, checksum) VALUES ('f1', 'p1', 'file', 'text/plain', 10, 'c1')`)

	orphans, err := repo.ListOrphanedMedia(ctx, 10, 0)
	if err != nil {
		t.Fatalf("ListOrphanedMedia failed: %v", err)
	}
	if len(orphans) != 1 {
		t.Errorf("expected 1 orphan, got %d", len(orphans))
	}

	count, _ := repo.CountOrphanedMedia(ctx)
	if count != 1 {
		t.Errorf("expected count 1, got %d", count)
	}
}

func TestRepository_MediaIDs(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO media (id, filename, original_path, file_type, mime_type, file_size, checksum) VALUES (1, 'f1', 'p1', 'file', 'text/plain', 10, 'c1'), (2, 'f2', 'p2', 'file', 'text/plain', 10, 'c2')`)

	m, _ := repo.GetMediaByIDs(ctx, []int64{1, 2})
	if len(m) != 2 {
		t.Errorf("GetMediaByIDs failed")
	}

	err := repo.DeleteMediaByIDs(ctx, []int64{1})
	if err != nil {
		t.Errorf("DeleteMediaByIDs failed")
	}
}

func TestRepository_ListOrphanedMediaByPage(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO media (filename, original_path, file_type, mime_type, file_size, checksum) VALUES ('f1','p1','file','text/plain',10,'c1')`)

	media, count, err := repo.ListOrphanedMediaByPage(ctx, 10, 0)
	if err != nil {
		t.Fatalf("ListOrphanedMediaByPage failed: %v", err)
	}
	if len(media) != 1 || count != 1 {
		t.Errorf("expected 1 orphan, got len=%d count=%d", len(media), count)
	}
}

func TestRepository_MediaFolders(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO media (filename, original_path, file_type, mime_type, file_size, checksum) VALUES ('f1','originals/2024/06/img.jpg','image','image/jpeg',100,'c1')`)

	folders, err := repo.ListMediaFolders(ctx, "")
	if err != nil {
		t.Fatalf("ListMediaFolders failed: %v", err)
	}
	if len(folders) != 1 || folders[0].Year != "2024" {
		t.Errorf("ListMediaFolders: unexpected %v", folders)
	}

	// ListMediaFiltered no filter
	items, err := repo.ListMediaFiltered(ctx, "", "", 10, 0)
	if err != nil {
		t.Fatalf("ListMediaFiltered failed: %v", err)
	}
	if len(items) != 1 {
		t.Errorf("expected 1 item, got %d", len(items))
	}

	// ListMediaFiltered with folder
	items2, _ := repo.ListMediaFiltered(ctx, "", "2024/06", 10, 0)
	if len(items2) != 1 {
		t.Errorf("expected 1 item with folder filter, got %d", len(items2))
	}

	// CountMediaFiltered
	count, err := repo.CountMediaFiltered(ctx, "", "")
	if err != nil || count != 1 {
		t.Errorf("CountMediaFiltered: err=%v count=%d", err, count)
	}

	// file type filter
	folders2, _ := repo.ListMediaFolders(ctx, "image")
	if len(folders2) != 1 {
		t.Errorf("ListMediaFolders with type: got %d", len(folders2))
	}
}

func TestRepository_MediaByPath(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO media (id, filename, original_path, file_type, mime_type, file_size, checksum) VALUES (1,'f1','originals/2024/01/img.jpg','image','image/jpeg',100,'c1')`)

	m, err := repo.GetMediaByPath(ctx, "originals/2024/01/img.jpg")
	if err != nil {
		t.Fatalf("GetMediaByPath failed: %v", err)
	}
	if m.ID != 1 {
		t.Errorf("expected id 1, got %d", m.ID)
	}

	// SetMediaPublic true
	if err := repo.SetMediaPublic(ctx, 1, true, nil); err != nil {
		t.Fatalf("SetMediaPublic failed: %v", err)
	}

	// SetMediaPublic false with nil postID
	if err := repo.SetMediaPublic(ctx, 1, false, nil); err != nil {
		t.Fatalf("SetMediaPublic(false) failed: %v", err)
	}
}

func TestRepository_GetAllMediaPaths(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO media (filename, original_path, file_type, mime_type, file_size, checksum) VALUES ('f1','p1','file','text/plain',10,'c1')`)

	items, err := repo.GetAllMediaPaths(ctx)
	if err != nil {
		t.Fatalf("GetAllMediaPaths failed: %v", err)
	}
	if len(items) != 1 {
		t.Errorf("expected 1 media path, got %d", len(items))
	}
}

func TestRepository_GetMediaByPaths(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO media (filename, original_path, file_type, mime_type, file_size, checksum) VALUES ('f1','p1','file','text/plain',10,'c1'), ('f2','p2','file','text/plain',20,'c2')`)

	items, err := repo.GetMediaByPaths(ctx, []string{"p1", "p2"})
	if err != nil {
		t.Fatalf("GetMediaByPaths failed: %v", err)
	}
	if len(items) != 2 {
		t.Errorf("expected 2 items, got %d", len(items))
	}

	// empty input
	items2, err := repo.GetMediaByPaths(ctx, nil)
	if err != nil || len(items2) != 0 {
		t.Errorf("expected empty for nil input")
	}
}

func TestRepository_GetStorageStats(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO media (filename, original_path, file_type, mime_type, file_size, checksum) VALUES ('f1','p1','image','image/jpeg',100,'c1'), ('f2','p2','video','video/mp4',500,'c2')`)

	stats, err := repo.GetStorageStats(ctx)
	if err != nil {
		t.Fatalf("GetStorageStats failed: %v", err)
	}
	if stats.TotalBytes != 600 {
		t.Errorf("expected 600 bytes, got %d", stats.TotalBytes)
	}
	if stats.ImageCount != 1 || stats.VideoCount != 1 {
		t.Errorf("wrong counts: %+v", stats)
	}
}
