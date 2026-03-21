package models

import (
	"context"
	"database/sql"
	"os"
	"testing"
	"time"

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

	// 1. Users
	u, _ := q.CreateUser(ctx, CreateUserParams{Username: "u", Email: "u@t.com", PasswordHash: "h", DisplayName: "U"})
	_, _ = q.GetUser(ctx, u.ID)
	_, _ = q.GetUserByEmail(ctx, "u@t.com")
	_, _ = q.GetUserByUsername(ctx, "u")
	_, _ = q.GetFirstUser(ctx)
	_ = q.UpdateUserLogin(ctx, u.ID)
	_ = q.UpdateUserPassword(ctx, UpdateUserPasswordParams{ID: u.ID, PasswordHash: "h2"})

	// 2. Sessions
	s, _ := q.CreateSession(ctx, CreateSessionParams{UserID: u.ID, Token: "t", IpAddress: "1", UserAgent: "a", ExpiresAt: time.Now().Add(time.Hour).UTC().Round(0)})
	_, _ = q.GetSessionByToken(ctx, "t")
	_, _ = q.GetUserSessions(ctx, u.ID)
	_ = q.UpdateSessionActivity(ctx, s.ID)
	_ = q.DeleteSession(ctx, DeleteSessionParams{ID: s.ID, UserID: u.ID})
	_ = q.DeleteUserSessions(ctx, DeleteUserSessionsParams{UserID: u.ID, ID: 999})
	_ = q.DeleteExpiredSessions(ctx)

	// 3. Settings
	_, _ = q.UpdateSetting(ctx, UpdateSettingParams{Key: "k", Value: sql.NullString{String: "v", Valid: true}, ValueType: "s"})
	_, _ = q.GetSetting(ctx, "k")
	_, _ = q.ListSettings(ctx)
	_ = q.DeleteSetting(ctx, "k")

	// 4. Tags
	tag, _ := q.CreateTag(ctx, CreateTagParams{Name: "T", Slug: "t"})
	_, _ = q.GetTag(ctx, tag.ID)
	_, _ = q.GetTagBySlug(ctx, "t")
	_, _ = q.ListTags(ctx, true)
	_, _ = q.UpdateTag(ctx, UpdateTagParams{ID: tag.ID, Name: "T2", Slug: "t2"})
	_ = q.UpdateTagPostCount(ctx, tag.ID)
	_ = q.UpdateAllTagPostCounts(ctx)

	// 5. Hierarchy
	child, _ := q.CreateTag(ctx, CreateTagParams{Name: "C", Slug: "c"})
	_ = q.AddTagRelationship(ctx, AddTagRelationshipParams{ParentID: tag.ID, ChildID: child.ID})
	_, _ = q.GetTagParents(ctx, child.ID)
	_, _ = q.GetTagChildren(ctx, tag.ID)
	_ = q.RemoveTagRelationship(ctx, RemoveTagRelationshipParams{ParentID: tag.ID, ChildID: child.ID})
	_ = q.ClearTagRelationships(ctx, ClearTagRelationshipsParams{ParentID: tag.ID})

	// 6. Posts
	p, _ := q.CreatePost(ctx, CreatePostParams{Title: "P", Slug: "p", AuthorID: u.ID, Status: "draft"})
	_, _ = q.GetPost(ctx, p.ID)
	_, _ = q.GetPostBySlug(ctx, "p")
	_, _ = q.ListPosts(ctx, ListPostsParams{})
	_, _ = q.CountPosts(ctx, CountPostsParams{})
	_ = q.AddTagToPost(ctx, AddTagToPostParams{PostID: p.ID, TagID: tag.ID})
	_, _ = q.GetTagsForPost(ctx, p.ID)
	_, _ = q.GetPostsByTag(ctx, GetPostsByTagParams{TagID: tag.ID})
	_, _ = q.CountPostsByTag(ctx, CountPostsByTagParams{TagID: tag.ID})
	_ = q.IncrementPostViewCount(ctx, p.ID)
	_, _ = q.PublishPost(ctx, p.ID)
	_, _ = q.WithdrawPost(ctx, p.ID)
	_ = q.SetPostPreviewToken(ctx, SetPostPreviewTokenParams{ID: p.ID, PreviewToken: sql.NullString{String: "tok", Valid: true}})
	_, _ = q.UpdatePost(ctx, UpdatePostParams{ID: p.ID, AuthorID: u.ID, Title: "P2", Slug: "p2"})
	_ = q.RemoveTagFromPost(ctx, RemoveTagFromPostParams{PostID: p.ID, TagID: tag.ID})
	_ = q.ClearPostTags(ctx, p.ID)
	_ = q.DeletePost(ctx, DeletePostParams{ID: p.ID, AuthorID: u.ID})

	// 7. Media
	m, _ := q.CreateMedia(ctx, CreateMediaParams{Filename: "f", Checksum: "c", UploadedAt: time.Now().UTC().Round(0)})
	_, _ = q.GetMedia(ctx, m.ID)
	_, _ = q.GetMediaByChecksum(ctx, "c")
	_, _ = q.GetMediaByPostID(ctx, sql.NullInt64{Int64: 1, Valid: true})
	_, _ = q.ListMedia(ctx, ListMediaParams{})
	_, _ = q.CountMedia(ctx, CountMediaParams{})
	_, _ = q.GetStorageUsage(ctx)
	_, _ = q.UpdateMedia(ctx, UpdateMediaParams{ID: m.ID})
	_, _ = q.UpdateMediaFilename(ctx, UpdateMediaFilenameParams{ID: m.ID, Filename: "f2"})
	_ = q.DeleteMedia(ctx, m.ID)

	// 8. Other
	_ = q.WithTx(nil)
	_ = q.DeleteTag(ctx, tag.ID)
}
