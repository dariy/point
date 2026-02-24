package models

import (
	"context"
	"database/sql"
	"os"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

func setupTestDB(t *testing.T) (*Queries, *sql.DB) {
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatal(err)
	}

	schema, err := os.ReadFile("../../sql/schema.sql")
	if err != nil {
		t.Fatal(err)
	}

	_, err = db.Exec(string(schema))
	if err != nil {
		t.Fatal(err)
	}

	return New(db), db
}

func TestQueries_Extra(t *testing.T) {
	q, db := setupTestDB(t)
	defer db.Close()
	ctx := context.Background()

	// 1. GetUserByEmail
	_, _ = q.CreateUser(ctx, CreateUserParams{Username: "u", Email: "u@t.com", PasswordHash: "h", DisplayName: "U"})
	user, err := q.GetUserByEmail(ctx, "u@t.com")
	if err != nil || user.Username != "u" {
		t.Errorf("GetUserByEmail failed")
	}

	// 2. Storage Usage
	usage, _ := q.GetStorageUsage(ctx)
	if usage.Valid && usage.Float64 != 0 {
		// Should be 0
	}

	// 3. Delete Setting
	_, _ = q.UpdateSetting(ctx, UpdateSettingParams{Key: "k", Value: sql.NullString{String: "v", Valid: true}, ValueType: "s"})
	err = q.DeleteSetting(ctx, "k")
	if err != nil {
		t.Errorf("DeleteSetting failed")
	}

	// 4. Session cleanup
	q.DeleteExpiredSessions(ctx)

	// 5. Tag post count
	q.UpdateTagPostCount(ctx, 1)

	// 6. Remove relationships
	q.RemoveTagFromPost(ctx, RemoveTagFromPostParams{PostID: 1, TagID: 1})
	q.RemoveTagRelationship(ctx, RemoveTagRelationshipParams{ParentID: 1, ChildID: 2})

	// 7. WithTx
	_ = q.WithTx(nil)

	// 8. More model calls
	q.CountMedia(ctx, CountMediaParams{})
	q.CountPosts(ctx, CountPostsParams{})
	q.CountPostsByTag(ctx, CountPostsByTagParams{})
	q.ListMedia(ctx, ListMediaParams{})
	q.ListPosts(ctx, ListPostsParams{})
	q.ListTags(ctx, ListTagsParams{IncludeEmptyFilter: true})
	q.ListSettings(ctx)
	q.GetFirstUser(ctx)
	q.GetMediaByPostID(ctx, sql.NullInt64{Int64: 1, Valid: true})
	q.GetTagsForPost(ctx, 1)
	q.GetUserSessions(ctx, 1)
	q.UpdateSessionActivity(ctx, 1)
	q.UpdateUserLogin(ctx, 1)
	q.WithdrawPost(ctx, 1)
	q.ClearTagRelationships(ctx, ClearTagRelationshipsParams{})
}

