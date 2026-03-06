package models

import (
	"context"
	"database/sql"
	"os"
	"testing"

	_ "modernc.org/sqlite"
)

func setupTestDB(t *testing.T) (*Queries, *sql.DB) {
	db, err := sql.Open("sqlite", ":memory:")
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
	defer func() {
		_ = db.Close()
	}()
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
		t.Errorf("expected 0 storage usage for new DB, got %v", usage.Float64)
	}

	// 3. Delete Setting
	_, _ = q.UpdateSetting(ctx, UpdateSettingParams{Key: "k", Value: sql.NullString{String: "v", Valid: true}, ValueType: "s"})
	err = q.DeleteSetting(ctx, "k")
	if err != nil {
		t.Errorf("DeleteSetting failed")
	}

	// 4. Session cleanup
	_ = q.DeleteExpiredSessions(ctx)

	// 5. Tag post count
	_ = q.UpdateTagPostCount(ctx, 1)

	// 6. Remove relationships
	_ = q.RemoveTagFromPost(ctx, RemoveTagFromPostParams{PostID: 1, TagID: 1})
	_ = q.RemoveTagRelationship(ctx, RemoveTagRelationshipParams{ParentID: 1, ChildID: 2})

	// 7. WithTx
	_ = q.WithTx(nil)

	// 8. More model calls
	_, _ = q.CountMedia(ctx, CountMediaParams{})
	_, _ = q.CountPosts(ctx, CountPostsParams{})
	_, _ = q.CountPostsByTag(ctx, CountPostsByTagParams{})
	_, _ = q.ListMedia(ctx, ListMediaParams{})
	_, _ = q.ListPosts(ctx, ListPostsParams{})
	_, _ = q.ListTags(ctx, ListTagsParams{IncludeEmptyFilter: true})
	_, _ = q.ListSettings(ctx)
	_, _ = q.GetFirstUser(ctx)
	_, _ = q.GetMediaByPostID(ctx, sql.NullInt64{Int64: 1, Valid: true})
	_, _ = q.GetTagsForPost(ctx, 1)
	_, _ = q.GetUserSessions(ctx, 1)
	_ = q.UpdateSessionActivity(ctx, 1)
	_ = q.UpdateUserLogin(ctx, 1)
	_, _ = q.WithdrawPost(ctx, 1)
	_ = q.ClearTagRelationships(ctx, ClearTagRelationshipsParams{})
}

