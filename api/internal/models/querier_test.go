package models

import (
	"context"
	"database/sql"
	"testing"
	"time"
)

// TestQueries_MissingCoverage exercises every query function that had 0% coverage.
func TestQueries_MissingCoverage(t *testing.T) {
	q, db := setupTestDB(t)
	defer func() { _ = db.Close() }()
	ctx := context.Background()

	u, err := q.CreateUser(ctx, CreateUserParams{
		Username:     "owner",
		Email:        "owner@test.com",
		PasswordHash: "hash",
		DisplayName:  "Owner",
	})
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	t.Run("UpsertSecret and GetSecret", func(t *testing.T) {
		err := q.UpsertSecret(ctx, UpsertSecretParams{Key: "my_key", Value: sql.NullString{String: "my_val", Valid: true}})
		if err != nil {
			t.Fatalf("UpsertSecret: %v", err)
		}
		secret, err := q.GetSecret(ctx, "my_key")
		if err != nil {
			t.Fatalf("GetSecret: %v", err)
		}
		if secret.Value.String != "my_val" {
			t.Errorf("expected 'my_val', got %q", secret.Value.String)
		}

		_ = q.UpsertSecret(ctx, UpsertSecretParams{Key: "my_key", Value: sql.NullString{String: "updated", Valid: true}})
		secret2, _ := q.GetSecret(ctx, "my_key")
		if secret2.Value.String != "updated" {
			t.Errorf("expected 'updated', got %q", secret2.Value.String)
		}
	})

	t.Run("AddPostViewCount and BulkPublishScheduledPosts", func(t *testing.T) {
		p, err := q.CreatePost(ctx, CreatePostParams{Title: "Sched", Slug: "sched", AuthorID: u.ID, Status: "draft"})
		if err != nil {
			t.Fatalf("CreatePost: %v", err)
		}

		err = q.AddPostViewCount(ctx, AddPostViewCountParams{ID: p.ID, ViewCount: 5})
		if err != nil {
			t.Fatalf("AddPostViewCount: %v", err)
		}

		past := time.Now().Add(-time.Minute).UTC()
		_, err = q.UpdatePost(ctx, UpdatePostParams{
			ID:          p.ID,
			AuthorID:    u.ID,
			Title:       "Sched",
			Slug:        "sched",
			ScheduledAt: sql.NullTime{Time: past, Valid: true},
		})
		if err != nil {
			t.Fatalf("UpdatePost scheduled: %v", err)
		}

		published, err := q.BulkPublishScheduledPosts(ctx)
		if err != nil {
			t.Fatalf("BulkPublishScheduledPosts: %v", err)
		}
		_ = published
	})

	t.Run("SoftDeletePost, CountTrashedPosts, ListTrashedPosts, RestorePost", func(t *testing.T) {
		p, err := q.CreatePost(ctx, CreatePostParams{Title: "ToTrash", Slug: "to-trash", AuthorID: u.ID, Status: "draft"})
		if err != nil {
			t.Fatalf("CreatePost: %v", err)
		}

		err = q.SoftDeletePost(ctx, SoftDeletePostParams{ID: p.ID, AuthorID: u.ID})
		if err != nil {
			t.Fatalf("SoftDeletePost: %v", err)
		}

		count, err := q.CountTrashedPosts(ctx)
		if err != nil {
			t.Fatalf("CountTrashedPosts: %v", err)
		}
		if count == 0 {
			t.Error("expected at least 1 trashed post")
		}

		trashed, err := q.ListTrashedPosts(ctx, ListTrashedPostsParams{Limit: 10, Offset: 0})
		if err != nil {
			t.Fatalf("ListTrashedPosts: %v", err)
		}
		if len(trashed) == 0 {
			t.Error("expected trashed posts, got none")
		}

		err = q.RestorePost(ctx, RestorePostParams{ID: p.ID, AuthorID: u.ID})
		if err != nil {
			t.Fatalf("RestorePost: %v", err)
		}

		count2, _ := q.CountTrashedPosts(ctx)
		if count2 != 0 {
			t.Errorf("expected 0 trashed posts after restore, got %d", count2)
		}
	})

	t.Run("UpdateMediaMetadata", func(t *testing.T) {
		m, err := q.CreateMedia(ctx, CreateMediaParams{
			Filename:   "test.jpg",
			Checksum:   "abc123",
			UploadedAt: time.Now().UTC(),
		})
		if err != nil {
			t.Fatalf("CreateMedia: %v", err)
		}

		updated, err := q.UpdateMediaMetadata(ctx, UpdateMediaMetadataParams{
			ID:       m.ID,
			Metadata: sql.NullString{String: `{"exif":"data"}`, Valid: true},
		})
		if err != nil {
			t.Fatalf("UpdateMediaMetadata: %v", err)
		}
		if !updated.Metadata.Valid || updated.Metadata.String != `{"exif":"data"}` {
			t.Errorf("expected metadata to be set, got %v", updated.Metadata)
		}
	})

	t.Run("API Keys", func(t *testing.T) {
		k, err := q.CreateAPIKey(ctx, CreateAPIKeyParams{
			UserID:  u.ID,
			Name:    "Test Key",
			KeyHash: "testhash",
			Prefix:  "prefix",
		})
		if err != nil {
			t.Fatalf("CreateAPIKey: %v", err)
		}

		k2, err := q.GetAPIKeyByHash(ctx, "testhash")
		if err != nil {
			t.Fatalf("GetAPIKeyByHash: %v", err)
		}
		if k2.ID != k.ID {
			t.Errorf("expected key ID %d, got %d", k.ID, k2.ID)
		}

		err = q.TouchAPIKeyLastUsed(ctx, k.ID)
		if err != nil {
			t.Fatalf("TouchAPIKeyLastUsed: %v", err)
		}

		keys, err := q.ListAPIKeysByUser(ctx, u.ID)
		if err != nil {
			t.Fatalf("ListAPIKeysByUser: %v", err)
		}
		if len(keys) != 1 {
			t.Errorf("expected 1 key, got %d", len(keys))
		}

		err = q.RevokeAPIKey(ctx, RevokeAPIKeyParams{ID: k.ID, UserID: u.ID})
		if err != nil {
			t.Fatalf("RevokeAPIKey: %v", err)
		}

		err = q.DeleteAPIKey(ctx, DeleteAPIKeyParams{ID: k.ID, UserID: u.ID})
		if err != nil {
			t.Fatalf("DeleteAPIKey: %v", err)
		}
	})

	t.Run("Analytics and Views", func(t *testing.T) {
		p1, err := q.CreatePost(ctx, CreatePostParams{Title: "V1", Slug: "v1", AuthorID: u.ID, Status: "published"})
		if err != nil {
			t.Fatalf("CreatePost: %v", err)
		}
		err = q.AddPostViewCount(ctx, AddPostViewCountParams{ID: p1.ID, ViewCount: 10})
		if err != nil {
			t.Fatalf("AddPostViewCount: %v", err)
		}

		p2, err := q.CreatePost(ctx, CreatePostParams{Title: "V2", Slug: "v2", AuthorID: u.ID, Status: "published"})
		if err != nil {
			t.Fatalf("CreatePost: %v", err)
		}
		err = q.AddPostViewCount(ctx, AddPostViewCountParams{ID: p2.ID, ViewCount: 20})
		if err != nil {
			t.Fatalf("AddPostViewCount: %v", err)
		}

		stats, err := q.GetPostAnalytics(ctx)
		if err != nil {
			t.Fatalf("GetPostAnalytics: %v", err)
		}
		if stats.TotalViews != 30 {
			t.Errorf("expected 30 total views, got %d", stats.TotalViews)
		}

		posts, err := q.ListPostsByViews(ctx, ListPostsByViewsParams{
			StatusFilter:   false,
			IncludeDrafts:  true,
			IncludeHidden:  false,
			FeaturedFilter: false,
			Limit:          10,
			Offset:         0,
		})
		if err != nil {
			t.Fatalf("ListPostsByViews: %v", err)
		}
		if len(posts) < 2 {
			t.Errorf("expected at least 2 posts, got %d", len(posts))
		}
		if posts[0].ID != p2.ID {
			t.Errorf("expected p2 to be first (most views), got %d", posts[0].ID)
		}
	})
}
