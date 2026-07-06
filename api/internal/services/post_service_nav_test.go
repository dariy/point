package services

import (
	"context"
	"strings"
	"testing"

	"point-api/internal/models"
)

// TestPostService_GetPostNavigation exercises the service wrapper end-to-end
// against a real repository: prev/next resolve by published_at, and the tag
// argument is threaded through.
func TestPostService_GetPostNavigation(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	svc := NewPostService(repo, nil, nil, nil, "")
	ctx := context.Background()

	u, err := repo.CreateUser(ctx, models.CreateUserParams{
		Username: "nav", Email: "nav@test.com", PasswordHash: "h", DisplayName: "Nav",
	})
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	older, _, _ := svc.CreatePost(ctx, CreatePostParams{Title: "Older", Slug: "older", Status: "published", AuthorID: u.ID})
	newer, _, _ := svc.CreatePost(ctx, CreatePostParams{Title: "Newer", Slug: "newer", Status: "published", AuthorID: u.ID})
	_, _ = repo.DB().Exec(`UPDATE posts SET published_at='2024-01-01' WHERE id=?`, older.ID)
	_, _ = repo.DB().Exec(`UPDATE posts SET published_at='2024-06-01' WHERE id=?`, newer.ID)

	prev, next, err := svc.GetPostNavigation(ctx, newer.ID, true, "")
	if err != nil {
		t.Fatalf("GetPostNavigation: %v", err)
	}
	if prev == nil || prev.ID != older.ID {
		t.Errorf("prev = %v, want older (%d)", prev, older.ID)
	}
	if next != nil {
		t.Errorf("next = %v, want nil", next)
	}
}

// TestSanitizePostCSS_OutOfRangeEscape covers the defensive branch in escape
// decoding: a hex escape beyond the Unicode range decodes to nothing rather
// than a bogus rune, and the surrounding CSS is unaffected.
func TestSanitizePostCSS_OutOfRangeEscape(t *testing.T) {
	// \110000 is 0x110000, one past the max code point → dropped.
	out, _ := SanitizePostCSS(`.x { color: \110000 red; }`)
	if strings.Contains(out, "110000") {
		t.Errorf("out-of-range escape should be dropped, got %q", out)
	}
	if !strings.Contains(out, "color:") {
		t.Errorf("surrounding CSS should survive, got %q", out)
	}
}
