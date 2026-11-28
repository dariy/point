package models

import (
	"context"
	"testing"
)

// TestPostRevisionQueries examines the post_revisions queries against real
// rows: insert, list, get and prune. The cascade on a post delete needs
// foreign_keys, which this bare database does not turn on; the services
// integration test TestPostRevisions_RemovedWithPost examines it.
func TestPostRevisionQueries(t *testing.T) {
	q, db := setupTestDB(t)
	defer func() { _ = db.Close() }()
	ctx := context.Background()

	u, err := q.CreateUser(ctx, CreateUserParams{Username: "rv", Email: "rv@t.com", PasswordHash: "h", DisplayName: "R"})
	if err != nil {
		t.Fatal(err)
	}
	post, err := q.CreatePost(ctx, CreatePostParams{Title: "P", Slug: "p", AuthorID: u.ID, Status: "draft"})
	if err != nil {
		t.Fatal(err)
	}

	pub, err := q.CreatePostRevision(ctx, CreatePostRevisionParams{PostID: post.ID, Kind: "publish", Title: "T0", Content: "c0", Tags: `["a"]`, Css: "x"})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 4; i++ {
		if _, err := q.CreatePostRevision(ctx, CreatePostRevisionParams{PostID: post.ID, Kind: "manual", Title: "T", Content: "c", Tags: "[]"}); err != nil {
			t.Fatal(err)
		}
	}

	got, err := q.GetPostRevision(ctx, GetPostRevisionParams{ID: pub.ID, PostID: post.ID})
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "T0" || got.Content != "c0" || got.Tags != `["a"]` || got.Css != "x" {
		t.Errorf("GetPostRevision = %+v", got)
	}
	if _, err := q.GetPostRevision(ctx, GetPostRevisionParams{ID: pub.ID, PostID: post.ID + 1}); err == nil {
		t.Error("GetPostRevision with another post id: expected an error")
	}

	// Keep two: the two newest manual revisions and the publish revision stay.
	pruned, err := q.PrunePostRevisions(ctx, PrunePostRevisionsParams{PostID: post.ID, Keep: 2})
	if err != nil {
		t.Fatal(err)
	}
	if pruned != 2 {
		t.Errorf("PrunePostRevisions = %d, want 2", pruned)
	}
	list, err := q.ListPostRevisions(ctx, post.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 3 || list[0].Kind != "manual" || list[2].ID != pub.ID {
		t.Errorf("ListPostRevisions after prune = %+v", list)
	}
}

// TestPostRevisionQueries_ClosedDB examines the error returns of the queries.
func TestPostRevisionQueries_ClosedDB(t *testing.T) {
	q, db := setupTestDB(t)
	_ = db.Close()
	ctx := context.Background()

	if _, err := q.CreatePostRevision(ctx, CreatePostRevisionParams{PostID: 1, Kind: "manual"}); err == nil {
		t.Error("CreatePostRevision: expected error on closed db")
	}
	if _, err := q.ListPostRevisions(ctx, 1); err == nil {
		t.Error("ListPostRevisions: expected error on closed db")
	}
	if _, err := q.GetPostRevision(ctx, GetPostRevisionParams{ID: 1, PostID: 1}); err == nil {
		t.Error("GetPostRevision: expected error on closed db")
	}
	if _, err := q.PrunePostRevisions(ctx, PrunePostRevisionsParams{PostID: 1, Keep: 1}); err == nil {
		t.Error("PrunePostRevisions: expected error on closed db")
	}
}
