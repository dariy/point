//go:build integration

package services

import (
	"context"
	"testing"

	"point-api/internal/models"
)

// TestAuditPublicPostLinks covers the incident where a public index post
// linked to posts hidden by a hides-posts tag: every link 404'd for anonymous
// visitors while looking fine to a logged-in admin.
func TestAuditPublicPostLinks(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	tagService := NewTagService(repo)
	postService := NewPostService(repo, nil, nil, tagService, "http://localhost")
	ctx := context.Background()

	user, err := repo.CreateUser(ctx, models.CreateUserParams{
		Username: "u", Email: "u@example.com", PasswordHash: "h", DisplayName: "U",
	})
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	hidingTag, err := repo.CreateTag(ctx, models.CreateTagParams{
		Name: "Feature", Slug: "feature", HidesPosts: true,
	})
	if err != nil {
		t.Fatalf("CreateTag: %v", err)
	}

	// Hidden-by-tag target.
	hidden, err := repo.CreatePost(ctx, models.CreatePostParams{
		Title: "Hidden Feature", Slug: "hidden-feature", Content: "x",
		Status: "published", AuthorID: user.ID,
	})
	if err != nil {
		t.Fatalf("CreatePost hidden: %v", err)
	}
	_ = repo.AddTagToPost(ctx, models.AddTagToPostParams{PostID: hidden.ID, TagID: hidingTag.ID})

	// Draft target.
	if _, err := repo.CreatePost(ctx, models.CreatePostParams{
		Title: "Draft", Slug: "draft-post", Content: "x",
		Status: "draft", AuthorID: user.ID,
	}); err != nil {
		t.Fatalf("CreatePost draft: %v", err)
	}

	// Reachable target.
	if _, err := repo.CreatePost(ctx, models.CreatePostParams{
		Title: "Fine", Slug: "fine-post", Content: "x",
		Status: "published", AuthorID: user.ID,
	}); err != nil {
		t.Fatalf("CreatePost fine: %v", err)
	}

	// Public index post linking to all three + a nonexistent slug.
	index, err := repo.CreatePost(ctx, models.CreatePostParams{
		Title: "Index", Slug: "index-post",
		Content: "[a](/posts/hidden-feature) [b](/posts/draft-post) " +
			`<a href="/posts/fine-post">c</a> [d](/posts/no-such-post)`,
		Status: "published", AuthorID: user.ID,
	})
	if err != nil {
		t.Fatalf("CreatePost index: %v", err)
	}

	// A hidden post linking to another hidden post must NOT be reported —
	// only links on publicly reachable posts matter.
	hiddenLinker, err := repo.CreatePost(ctx, models.CreatePostParams{
		Title: "Hidden Linker", Slug: "hidden-linker",
		Content: "[x](/posts/hidden-feature)", Status: "published", AuthorID: user.ID,
	})
	if err != nil {
		t.Fatalf("CreatePost hidden linker: %v", err)
	}
	_ = repo.AddTagToPost(ctx, models.AddTagToPostParams{PostID: hiddenLinker.ID, TagID: hidingTag.ID})

	issues, scanned, err := postService.AuditPublicPostLinks(ctx)
	if err != nil {
		t.Fatalf("AuditPublicPostLinks: %v", err)
	}
	if scanned != 2 { // index-post + fine-post
		t.Errorf("expected 2 scanned public posts, got %d", scanned)
	}
	if len(issues) != 3 {
		t.Fatalf("expected 3 issues, got %d: %+v", len(issues), issues)
	}

	byTarget := map[string]PostLinkIssue{}
	for _, i := range issues {
		if i.SourceID != index.ID {
			t.Errorf("unexpected issue source %d (%s)", i.SourceID, i.SourceSlug)
		}
		byTarget[i.TargetSlug] = i
	}
	if i, ok := byTarget["hidden-feature"]; !ok {
		t.Error("expected issue for hidden-feature")
	} else if i.Reason != "target hidden by tag 'Feature'" {
		t.Errorf("unexpected reason: %q", i.Reason)
	}
	if i, ok := byTarget["draft-post"]; !ok {
		t.Error("expected issue for draft-post")
	} else if i.Reason != "target not published (status: draft)" {
		t.Errorf("unexpected reason: %q", i.Reason)
	}
	if i, ok := byTarget["no-such-post"]; !ok {
		t.Error("expected issue for no-such-post")
	} else if i.Reason != "target not found (deleted or slug typo)" {
		t.Errorf("unexpected reason: %q", i.Reason)
	}
}
