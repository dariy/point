//go:build !unit

package services

import (
	"context"
	"os"
	"testing"

	"point-api/internal/models"
)

// The public page cache is what a guest — and the owner with revelio off — is
// actually served. Nothing used to drop it on a write, so a post switched to
// hidden stayed in the cached feed for the rest of the 15-minute TTL while
// opening it already 404'd: the list and the post disagreeing about whether the
// post exists.
func TestPostWritesInvalidatePublicPageCache(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	cache, dir := setupCacheService(t)
	defer func() { _ = os.RemoveAll(dir) }()

	tagService := NewTagService(repo).WithCache(cache)
	postService := NewPostService(repo, nil, nil, tagService, "http://localhost").WithCache(cache)
	ctx := context.Background()

	user, err := repo.CreateUser(ctx, models.CreateUserParams{
		Username: "u", Email: "u@example.com", PasswordHash: "h", DisplayName: "U",
	})
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	post, _, err := postService.CreatePost(ctx, CreatePostParams{
		Title: "Live", Status: "published", AuthorID: user.ID,
	})
	if err != nil {
		t.Fatalf("CreatePost: %v", err)
	}

	// Stands in for a rendered feed page that lists the post.
	const key = "homepage_p1_pp12.json"
	warm := func() {
		t.Helper()
		if err := cache.Set(ctx, key, []byte(`{"posts":[{"slug":"live"}]}`)); err != nil {
			t.Fatalf("warm cache: %v", err)
		}
	}
	cached := func() bool {
		_, err := cache.Get(ctx, key)
		return err == nil
	}

	// The reported bug: published → hidden.
	warm()
	if _, err := postService.UpdatePostStatus(ctx, post.ID, "hidden"); err != nil {
		t.Fatalf("UpdatePostStatus: %v", err)
	}
	if cached() {
		t.Error("hiding a post left the rendered feed page cached — it would still list a post that now 404s")
	}

	// And every other write that changes what a guest sees.
	for _, tc := range []struct {
		name string
		do   func() error
	}{
		{"publish", func() error { _, err := postService.PublishPost(ctx, post.ID); return err }},
		{"withdraw", func() error { _, err := postService.WithdrawPost(ctx, post.ID); return err }},
		{"edit", func() error {
			_, _, err := postService.UpdatePost(ctx, UpdatePostParams{
				ID: post.ID, Title: "Renamed", Slug: "live", Status: "published",
				Formatter: "markdown", AuthorID: user.ID,
			})
			return err
		}},
		{"trash", func() error { return postService.SoftDeletePost(ctx, post.ID, user.ID) }},
		{"restore", func() error { return postService.RestorePost(ctx, post.ID, user.ID) }},
		{"create", func() error {
			_, _, err := postService.CreatePost(ctx, CreatePostParams{
				Title: "Another", Status: "published", AuthorID: user.ID,
			})
			return err
		}},
		{"tag write", func() error {
			_, err := tagService.CreateTag(ctx, CreateTagParams{Name: "Hidden", Slug: "hidden-tag", HidesPosts: true})
			return err
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			warm()
			if err := tc.do(); err != nil {
				t.Fatalf("%s: %v", tc.name, err)
			}
			if cached() {
				t.Errorf("%s left the public page cache behind", tc.name)
			}
		})
	}
}
