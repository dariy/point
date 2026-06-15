//go:build integration

package services

import (
	"context"
	"testing"

	"point-api/internal/models"
)

func TestPostVisibility_HidesPosts(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	postService := NewPostService(repo, nil, nil, nil, "http://localhost")
	ctx := context.Background()

	// 1. Setup
	// Create a user for posts
	user, err := repo.CreateUser(ctx, models.CreateUserParams{
		Username:     "testuser",
		Email:        "test@example.com",
		PasswordHash: "hash",
		DisplayName:  "Test User",
	})
	if err != nil {
		t.Fatalf("failed to create user: %v", err)
	}

	// Create tag 'family' with hides_posts=1
	familyTag, err := repo.CreateTag(ctx, models.CreateTagParams{
		Name:       "Family",
		Slug:       "family",
		HidesPosts: true,
	})
	if err != nil {
		t.Fatalf("failed to create family tag: %v", err)
	}

	// Create child tag 'kids'
	kidsTag, err := repo.CreateTag(ctx, models.CreateTagParams{
		Name: "Kids",
		Slug: "kids",
	})
	if err != nil {
		t.Fatalf("failed to create kids tag: %v", err)
	}

	// Create relationship family -> kids
	err = repo.AddTagRelationship(ctx, models.AddTagRelationshipParams{
		ParentID: familyTag.ID,
		ChildID:  kidsTag.ID,
	})
	if err != nil {
		t.Fatalf("failed to create tag relationship: %v", err)
	}

	// Create a public tag
	publicTag, err := repo.CreateTag(ctx, models.CreateTagParams{
		Name: "Public",
		Slug: "public",
	})
	if err != nil {
		t.Fatalf("failed to create public tag: %v", err)
	}

	// Create three published posts
	// P1 tagged 'family'
	p1, err := repo.CreatePost(ctx, models.CreatePostParams{
		Title:    "P1 Family",
		Slug:     "p1-family",
		Content:  "Content P1",
		Status:   "published",
		AuthorID: user.ID,
	})
	if err != nil {
		t.Fatalf("failed to create post P1: %v", err)
	}
	_ = repo.AddTagToPost(ctx, models.AddTagToPostParams{PostID: p1.ID, TagID: familyTag.ID})

	// P2 tagged 'kids' (inherited hiding)
	p2, err := repo.CreatePost(ctx, models.CreatePostParams{
		Title:    "P2 Kids",
		Slug:     "p2-kids",
		Content:  "Content P2",
		Status:   "published",
		AuthorID: user.ID,
	})
	if err != nil {
		t.Fatalf("failed to create post P2: %v", err)
	}
	_ = repo.AddTagToPost(ctx, models.AddTagToPostParams{PostID: p2.ID, TagID: kidsTag.ID})

	// P3 tagged with an unrelated visible tag
	p3, err := repo.CreatePost(ctx, models.CreatePostParams{
		Title:    "P3 Public",
		Slug:     "p3-public",
		Content:  "Content P3",
		Status:   "published",
		AuthorID: user.ID,
	})
	if err != nil {
		t.Fatalf("failed to create post P3: %v", err)
	}
	_ = repo.AddTagToPost(ctx, models.AddTagToPostParams{PostID: p3.ID, TagID: publicTag.ID})

	// 2. Guest path (IncludeDrafts=false, IncludeHidden=false)
	t.Run("GuestAccess", func(t *testing.T) {
		params := ListPostsParams{
			Page:          1,
			PerPage:       10,
			IncludeDrafts: false,
			IncludeHidden: false,
		}
		posts, total, err := postService.ListPosts(ctx, params)
		if err != nil {
			t.Fatalf("ListPosts failed: %v", err)
		}

		if total != 1 {
			t.Errorf("expected total 1, got %d", total)
		}
		if len(posts) != 1 {
			t.Errorf("expected 1 post, got %d", len(posts))
		} else if posts[0].ID != p3.ID {
			t.Errorf("expected post P3, got %s", posts[0].Title)
		}

		count, err := repo.CountPosts(ctx, models.CountPostsParams{
			IncludeDrafts: false,
			IncludeHidden: false,
		})
		if err != nil {
			t.Fatalf("CountPosts failed: %v", err)
		}
		if count != 1 {
			t.Errorf("repo.CountPosts: expected 1, got %d", count)
		}

		// Feed query
		feedPosts, err := repo.GetPublishedPostsForFeed(ctx, 10)
		if err != nil {
			t.Fatalf("GetPublishedPostsForFeed failed: %v", err)
		}
		if len(feedPosts) != 1 {
			t.Errorf("GetPublishedPostsForFeed: expected 1 post, got %d", len(feedPosts))
		} else if feedPosts[0].ID != p3.ID {
			t.Errorf("GetPublishedPostsForFeed: expected post P3, got %s", feedPosts[0].Title)
		}

		// SortBy views (sqlc ListPostsByViews path)
		params.SortBy = "views"
		postsViews, _, err := postService.ListPosts(ctx, params)
		if err != nil {
			t.Fatalf("ListPostsByViews guest failed: %v", err)
		}
		if len(postsViews) != 1 {
			t.Errorf("ListPostsByViews guest: expected 1 post, got %d", len(postsViews))
		} else if postsViews[0].ID != p3.ID {
			t.Errorf("ListPostsByViews guest: expected post P3, got %s", postsViews[0].Title)
		}
	})

	// 3. Admin path (IncludeDrafts=true or IncludeHidden=true)
	t.Run("AdminAccess", func(t *testing.T) {
		params := ListPostsParams{
			Page:          1,
			PerPage:       10,
			IncludeHidden: true,
		}
		posts, _, err := postService.ListPosts(ctx, params)
		if err != nil {
			t.Fatalf("ListPosts admin failed: %v", err)
		}

		// Should return P1, P2, P3
		if len(posts) != 3 {
			t.Errorf("expected 3 posts for admin, got %d", len(posts))
		}

		// SortBy views (sqlc ListPostsByViews path)
		params.SortBy = "views"
		postsViews, _, err := postService.ListPosts(ctx, params)
		if err != nil {
			t.Fatalf("ListPostsByViews admin failed: %v", err)
		}
		if len(postsViews) != 3 {
			t.Errorf("ListPostsByViews: expected 3 posts for admin, got %d", len(postsViews))
		}
	})
}
