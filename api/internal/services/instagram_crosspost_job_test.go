package services

import (
	"context"
	"testing"

	"point-api/internal/models"
)

// A cross-post runs as a durable job: a failure stays queued for a retry, and
// a retry after a stored Instagram media id does not post again.
func TestInstagramCrossPostJob(t *testing.T) {
	ctx := context.Background()
	jobs, now := newTestJobs(t)
	repo := jobs.repo
	// A localhost APP_URL makes CrossPostToInstagram fail before any HTTP call.
	svc := NewPostService(repo, nil, nil, nil, "http://localhost").WithJobs(jobs)

	user, err := repo.CreateUser(ctx, models.CreateUserParams{
		Username: "u", Email: "u@example.com", PasswordHash: "h", DisplayName: "U",
	})
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	post, err := repo.CreatePost(ctx, models.CreatePostParams{
		Title: "P", Slug: "p", Content: "x", Status: "published", AuthorID: user.ID, InstagramShare: true,
	})
	if err != nil {
		t.Fatalf("CreatePost: %v", err)
	}

	svc.crossPostToInstagramAsync(post.ID)
	if ran, err := jobs.RunOnce(ctx); !ran || err != nil {
		t.Fatalf("RunOnce: ran=%v err=%v", ran, err)
	}
	j, _ := repo.GetJob(ctx, 1)
	if j.Kind != JobKindInstagramCrossPost || j.State != JobQueued || j.Attempts != 1 {
		t.Fatalf("after failure: kind=%q state=%q attempts=%d", j.Kind, j.State, j.Attempts)
	}

	// The publish did succeed on Instagram; the retry must skip.
	if err := svc.updateInstagramStatus(ctx, post.ID, "published", "ig-123", ""); err != nil {
		t.Fatalf("updateInstagramStatus: %v", err)
	}
	*now = now.Add(maxJobBackoff)
	if ran, err := jobs.RunOnce(ctx); !ran || err != nil {
		t.Fatalf("RunOnce retry: ran=%v err=%v", ran, err)
	}
	j, _ = repo.GetJob(ctx, 1)
	if j.State != JobDone {
		t.Fatalf("retry state = %q (%s), want done", j.State, j.LastError)
	}
	got, _ := repo.GetPost(ctx, post.ID)
	if got.InstagramMediaID.String != "ig-123" || got.InstagramStatus != "published" {
		t.Fatalf("post changed on retry: %+v", got)
	}
}
