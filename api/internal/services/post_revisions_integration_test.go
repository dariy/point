//go:build !unit

package services

import (
	"context"
	"errors"
	"slices"
	"testing"

	"point-api/internal/models"
)

// revisionKinds returns the kinds of a post's revisions, newest first.
func revisionKinds(t *testing.T, svc *PostService, postID int64) []string {
	t.Helper()
	revs, err := svc.ListPostRevisions(context.Background(), postID)
	if err != nil {
		t.Fatalf("ListPostRevisions: %v", err)
	}
	kinds := make([]string, 0, len(revs))
	for _, r := range revs {
		kinds = append(kinds, r.Kind)
	}
	return kinds
}

func countRevisionRows(t *testing.T, svc *PostService, postID int64) int {
	t.Helper()
	var n int
	if err := svc.repo.DB().QueryRow(`SELECT COUNT(*) FROM post_revisions WHERE post_id = ?`, postID).Scan(&n); err != nil {
		t.Fatalf("count revisions: %v", err)
	}
	return n
}

func TestPostRevisions_EachSaveKind(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()
	insertTestUser(t, svc)

	// An autosave that creates the post makes no revision.
	auto, _, err := svc.CreatePost(ctx, CreatePostParams{Title: "Auto", Slug: "auto", AuthorID: 1, Status: "draft", SaveKind: SaveKindAutosave})
	if err != nil {
		t.Fatalf("CreatePost: %v", err)
	}
	if got := revisionKinds(t, svc, auto.ID); len(got) != 0 {
		t.Errorf("autosave create: revisions = %v, want none", got)
	}

	// A create with no save kind is a manual save.
	post, _, err := svc.CreatePost(ctx, CreatePostParams{
		Title: "One", Slug: "one", Content: "a.jpg\n\nfirst", CSS: "color: red;",
		AuthorID: 1, Status: "draft", Tags: []string{"alpha", "beta"},
	})
	if err != nil {
		t.Fatalf("CreatePost: %v", err)
	}

	update := func(kind, status, content string) {
		t.Helper()
		if _, _, err := svc.UpdatePost(ctx, UpdatePostParams{
			ID: post.ID, AuthorID: 1, Title: "One", Slug: "one", Content: content,
			Status: status, Tags: []string{"alpha"}, SaveKind: kind,
		}); err != nil {
			t.Fatalf("UpdatePost(%s): %v", kind, err)
		}
	}
	update(SaveKindAutosave, "draft", "second")     // no revision
	update(SaveKindAutosave, "draft", "third")      // no revision
	update(SaveKindAutosaveLast, "draft", "fourth") // autosave
	update(SaveKindManual, "draft", "fifth")        // manual
	update(SaveKindAutosave, "published", "sixth")  // publish: the status changes
	update(SaveKindManual, "published", "seventh")  // manual: already published

	want := []string{RevisionManual, RevisionPublish, RevisionManual, RevisionAutosave, RevisionManual}
	if got := revisionKinds(t, svc, post.ID); !slices.Equal(got, want) {
		t.Fatalf("revision kinds = %v, want %v", got, want)
	}

	// The first revision holds the title, body, tags and CSS of that save.
	revs, _ := svc.ListPostRevisions(ctx, post.ID)
	first, err := svc.GetPostRevision(ctx, post.ID, revs[len(revs)-1].ID)
	if err != nil {
		t.Fatalf("GetPostRevision: %v", err)
	}
	if first.Title != "One" || first.Content != "a.jpg\n\nfirst" || !slices.Equal(first.Tags, []string{"alpha", "beta"}) {
		t.Errorf("first revision = %+v", first)
	}
	if first.CSS == "" {
		t.Error("first revision lost the CSS")
	}

	// A revision of another post is not found through this post.
	if _, err := svc.GetPostRevision(ctx, auto.ID, first.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetPostRevision of another post: err = %v, want ErrNotFound", err)
	}
	if _, err := svc.ListPostRevisions(ctx, 99999); !errors.Is(err, ErrNotFound) {
		t.Errorf("ListPostRevisions of a missing post: err = %v, want ErrNotFound", err)
	}
}

func TestPostRevisions_PublishPaths(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()
	insertTestUser(t, svc)

	t.Run("CreatePublished", func(t *testing.T) {
		post, _, err := svc.CreatePost(ctx, CreatePostParams{Title: "Live", Slug: "live", AuthorID: 1, Status: "published"})
		if err != nil {
			t.Fatal(err)
		}
		if got := revisionKinds(t, svc, post.ID); !slices.Equal(got, []string{RevisionPublish}) {
			t.Errorf("kinds = %v, want [publish]", got)
		}
	})

	t.Run("PublishPost", func(t *testing.T) {
		post, _, _ := svc.CreatePost(ctx, CreatePostParams{Title: "P", Slug: "p", AuthorID: 1, Status: "draft", SaveKind: SaveKindAutosave})
		if _, err := svc.PublishPost(ctx, post.ID); err != nil {
			t.Fatal(err)
		}
		// A second publish of a published post makes no revision.
		if _, err := svc.PublishPost(ctx, post.ID); err != nil {
			t.Fatal(err)
		}
		if got := revisionKinds(t, svc, post.ID); !slices.Equal(got, []string{RevisionPublish}) {
			t.Errorf("kinds = %v, want [publish]", got)
		}
	})

	t.Run("UpdatePostStatus", func(t *testing.T) {
		post, _, _ := svc.CreatePost(ctx, CreatePostParams{Title: "S", Slug: "s", AuthorID: 1, Status: "draft", SaveKind: SaveKindAutosave, Tags: []string{"gamma"}})
		if _, err := svc.UpdatePostStatus(ctx, post.ID, "hidden"); err != nil {
			t.Fatal(err)
		}
		if _, err := svc.UpdatePostStatus(ctx, post.ID, "published"); err != nil {
			t.Fatal(err)
		}
		revs, _ := svc.ListPostRevisions(ctx, post.ID)
		if len(revs) != 1 || revs[0].Kind != RevisionPublish {
			t.Fatalf("revisions = %+v, want one publish", revs)
		}
		rev, _ := svc.GetPostRevision(ctx, post.ID, revs[0].ID)
		if !slices.Equal(rev.Tags, []string{"gamma"}) {
			t.Errorf("publish revision tags = %v, want [gamma]", rev.Tags)
		}
	})

	t.Run("Scheduled", func(t *testing.T) {
		post, _, _ := svc.CreatePost(ctx, CreatePostParams{Title: "Due", Slug: "due", AuthorID: 1, Status: "scheduled", SaveKind: SaveKindAutosave})
		if _, err := svc.repo.DB().Exec(`UPDATE posts SET scheduled_at = datetime('now', '-1 hour') WHERE id = ?`, post.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := svc.PublishDueScheduledPosts(ctx); err != nil {
			t.Fatal(err)
		}
		if got := revisionKinds(t, svc, post.ID); !slices.Equal(got, []string{RevisionPublish}) {
			t.Errorf("kinds = %v, want [publish]", got)
		}
	})
}

func TestPostRevisions_PruneKeepsLimitAndPublishes(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()
	insertTestUser(t, svc)

	post, _, err := svc.CreatePost(ctx, CreatePostParams{Title: "Many", Slug: "many", AuthorID: 1, Status: "draft", SaveKind: SaveKindAutosave})
	if err != nil {
		t.Fatal(err)
	}
	// Two old publish revisions, then more manual revisions than the limit.
	for _, kind := range []string{RevisionPublish, RevisionPublish} {
		if _, err := repo.CreatePostRevision(ctx, models.CreatePostRevisionParams{PostID: post.ID, Kind: kind, Title: "old", Content: "old", Tags: "[]"}); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < PostRevisionLimit+5; i++ {
		if _, err := repo.CreatePostRevision(ctx, models.CreatePostRevisionParams{PostID: post.ID, Kind: RevisionManual, Title: "m", Content: "m", Tags: "[]"}); err != nil {
			t.Fatal(err)
		}
	}

	// The next save prunes.
	if _, _, err := svc.UpdatePost(ctx, UpdatePostParams{ID: post.ID, AuthorID: 1, Title: "Many", Slug: "many", Content: "new", Status: "draft"}); err != nil {
		t.Fatal(err)
	}

	kinds := revisionKinds(t, svc, post.ID)
	if len(kinds) != PostRevisionLimit+2 {
		t.Fatalf("revisions = %d, want %d (the limit plus two publish revisions)", len(kinds), PostRevisionLimit+2)
	}
	if kinds[0] != RevisionManual {
		t.Errorf("newest kind = %q, want manual", kinds[0])
	}
	publishes := 0
	for _, k := range kinds {
		if k == RevisionPublish {
			publishes++
		}
	}
	if publishes != 2 {
		t.Errorf("publish revisions = %d, want 2", publishes)
	}
}

func TestPostRevisions_Restore(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()
	insertTestUser(t, svc)

	post, _, err := svc.CreatePost(ctx, CreatePostParams{
		Title: "Before", Slug: "keep-slug", Content: "old body", CSS: "color: red;",
		AuthorID: 1, Status: "draft", Tags: []string{"old"}, Excerpt: "keep me",
	})
	if err != nil {
		t.Fatal(err)
	}
	revs, _ := svc.ListPostRevisions(ctx, post.ID)
	oldRev := revs[0].ID

	if _, _, err := svc.UpdatePost(ctx, UpdatePostParams{
		ID: post.ID, AuthorID: 1, Title: "After", Slug: "keep-slug", Content: "new body",
		Status: "draft", Tags: []string{"new"}, Excerpt: "keep me",
	}); err != nil {
		t.Fatal(err)
	}

	restored, _, err := svc.RestorePostRevision(ctx, post.ID, oldRev, 1)
	if err != nil {
		t.Fatalf("RestorePostRevision: %v", err)
	}
	if restored.Title != "Before" || restored.Content != "old body" || restored.Css == "" {
		t.Errorf("restored post = title %q content %q css %q", restored.Title, restored.Content, restored.Css)
	}
	if restored.Slug != "keep-slug" || restored.Excerpt.String != "keep me" || restored.Status != "draft" {
		t.Errorf("restore changed other fields: slug %q excerpt %q status %q", restored.Slug, restored.Excerpt.String, restored.Status)
	}
	tags, _ := svc.GetTagsForPost(ctx, post.ID)
	if len(tags) != 1 || tags[0].Name != "old" {
		t.Errorf("restored tags = %+v, want [old]", tags)
	}

	// The restore is a new revision; the newer revision stays.
	want := []string{RevisionRestore, RevisionManual, RevisionManual}
	if got := revisionKinds(t, svc, post.ID); !slices.Equal(got, want) {
		t.Errorf("kinds = %v, want %v", got, want)
	}

	if _, _, err := svc.RestorePostRevision(ctx, post.ID, 99999, 1); !errors.Is(err, ErrNotFound) {
		t.Errorf("restore of a missing revision: err = %v, want ErrNotFound", err)
	}
}

func TestPostRevisions_RemovedWithPost(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()
	insertTestUser(t, svc)

	post, _, err := svc.CreatePost(ctx, CreatePostParams{Title: "Gone", Slug: "gone", AuthorID: 1, Status: "draft"})
	if err != nil {
		t.Fatal(err)
	}
	if n := countRevisionRows(t, svc, post.ID); n != 1 {
		t.Fatalf("revisions before delete = %d, want 1", n)
	}
	if err := svc.SoftDeletePost(ctx, post.ID, 1); err != nil {
		t.Fatal(err)
	}
	// The trash keeps the history, so a restore from the trash keeps it too.
	if n := countRevisionRows(t, svc, post.ID); n != 1 {
		t.Errorf("revisions in the trash = %d, want 1", n)
	}
	if err := svc.PermanentlyDeletePost(ctx, post.ID, 1); err != nil {
		t.Fatal(err)
	}
	if n := countRevisionRows(t, svc, post.ID); n != 0 {
		t.Errorf("revisions after permanent delete = %d, want 0", n)
	}
}

func TestRevisionKindForSave(t *testing.T) {
	cases := []struct {
		save      string
		publishes bool
		want      string
	}{
		{"", false, RevisionManual},
		{SaveKindManual, false, RevisionManual},
		{SaveKindAutosave, false, ""},
		{SaveKindAutosaveLast, false, RevisionAutosave},
		{SaveKindAutosave, true, RevisionPublish},
		{SaveKindManual, true, RevisionPublish},
		{SaveKindRestore, true, RevisionRestore},
	}
	for _, c := range cases {
		if got := revisionKindForSave(c.save, c.publishes); got != c.want {
			t.Errorf("revisionKindForSave(%q, %v) = %q, want %q", c.save, c.publishes, got, c.want)
		}
	}
}
