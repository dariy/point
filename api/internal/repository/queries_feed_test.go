package repository

import (
	"context"
	"testing"
)

func TestRepository_Sitemap(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	if _, err := repo.DB().Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1, 'u', 'e', 'h', 'd')`); err != nil {
		t.Fatalf("insert user failed: %v", err)
	}
	if _, err := repo.DB().Exec(`INSERT INTO posts (title, slug, content, author_id, status) VALUES ('P1', 'p1', 'C1', 1, 'published')`); err != nil {
		t.Fatalf("insert post failed: %v", err)
	}
	if _, err := repo.DB().Exec(`INSERT INTO tags (name, slug, post_count) VALUES ('T1', 't1', 1)`); err != nil {
		t.Fatalf("insert tag failed: %v", err)
	}

	p, err := repo.GetPublishedPostsForSitemap(ctx)
	if err != nil {
		t.Fatalf("GetPublishedPostsForSitemap failed: %v", err)
	}
	if len(p) != 1 {
		t.Errorf("GetPublishedPostsForSitemap expected 1, got %d", len(p))
	}

	tags, err := repo.GetPublicTagsForSitemap(ctx)
	if err != nil {
		t.Fatalf("GetPublicTagsForSitemap failed: %v", err)
	}
	if len(tags) != 1 {
		t.Errorf("GetPublicTagsForSitemap expected 1, got %d", len(tags))
	}
}

func TestRepository_GetPublishedPostsForFeed(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	insertUserAndPost(t, repo, "feed-post", "published")

	items, err := repo.GetPublishedPostsForFeed(ctx, 10)
	if err != nil {
		t.Fatalf("GetPublishedPostsForFeed failed: %v", err)
	}
	if len(items) != 1 {
		t.Errorf("expected 1 post, got %d", len(items))
	}
}

func TestRepository_GetPublishedPostsForSitemap_RFC3339(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO users (id,username,email,password_hash,display_name) VALUES (1,'u','u@t.com','h','U')`)
	_, _ = repo.DB().Exec(`INSERT INTO posts (id,title,slug,content,author_id,status,published_at) VALUES (1,'P','p','b',1,'published','2024-01-01T12:00:00Z')`)

	items, err := repo.GetPublishedPostsForSitemap(ctx)
	if err != nil {
		t.Fatalf("GetPublishedPostsForSitemap RFC3339: %v", err)
	}
	_ = items
}
