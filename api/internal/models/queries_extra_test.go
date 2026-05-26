package models

import (
	"context"
	"database/sql"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"
	pointsql "point-api/sql"
)

func setupTestDB(t *testing.T) (*Queries, *sql.DB) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}

	// Use SplitSeq for efficient iteration without allocating a full slice
	for stmt := range strings.SplitSeq(pointsql.SchemaSQL, ";") {
		trimmed := strings.TrimSpace(stmt)
		if trimmed == "" {
			continue
		}
		if _, err := db.Exec(trimmed); err != nil {
			t.Fatalf("failed to execute schema statement: %v\nStatement: %s", err, trimmed)
		}
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

// TestQueryScanBodies exercises list/scan functions with actual data
// to cover the rows.Next() loop bodies that are missed when Limit=0.
func TestQueryScanBodies(t *testing.T) {
	q, db := setupTestDB(t)
	defer func() { _ = db.Close() }()
	ctx := context.Background()

	// Seed user
	u, _ := q.CreateUser(ctx, CreateUserParams{Username: "scan_u", Email: "s@t.com", PasswordHash: "h", DisplayName: "U"})

	// Seed session for GetUserSessions scan body
	_, _ = q.CreateSession(ctx, CreateSessionParams{
		UserID: u.ID, Token: "scan_tok", IpAddress: "1", UserAgent: "a",
		ExpiresAt: time.Now().Add(time.Hour).UTC().Round(0),
	})
	sessions, err := q.GetUserSessions(ctx, u.ID)
	if err != nil {
		t.Fatalf("GetUserSessions failed: %v", err)
	}
	if len(sessions) == 0 {
		t.Error("expected at least 1 session in scan")
	}

	// Seed setting for ListSettings scan body
	_, _ = q.UpdateSetting(ctx, UpdateSettingParams{Key: "scan_k", Value: sql.NullString{String: "v", Valid: true}, ValueType: "s"})
	settings, err := q.ListSettings(ctx)
	if err != nil {
		t.Fatalf("ListSettings failed: %v", err)
	}
	if len(settings) == 0 {
		t.Error("expected at least 1 setting in scan")
	}

	// Seed tags for ListTags and GetTagChildren/GetTagParents scan bodies
	parent, _ := q.CreateTag(ctx, CreateTagParams{Name: "ScanParent", Slug: "scan-parent"})
	child, _ := q.CreateTag(ctx, CreateTagParams{Name: "ScanChild", Slug: "scan-child"})
	_ = q.AddTagRelationship(ctx, AddTagRelationshipParams{ParentID: parent.ID, ChildID: child.ID})

	tags, err := q.ListTags(ctx, true)
	if err != nil {
		t.Fatalf("ListTags failed: %v", err)
	}
	if len(tags) == 0 {
		t.Error("expected at least 1 tag in scan")
	}

	children, err := q.GetTagChildren(ctx, parent.ID)
	if err != nil {
		t.Fatalf("GetTagChildren failed: %v", err)
	}
	if len(children) == 0 {
		t.Error("expected at least 1 child in scan")
	}

	parents, err := q.GetTagParents(ctx, child.ID)
	if err != nil {
		t.Fatalf("GetTagParents failed: %v", err)
	}
	if len(parents) == 0 {
		t.Error("expected at least 1 parent in scan")
	}

	// Seed post for ListPosts and GetTagsForPost scan bodies
	p, _ := q.CreatePost(ctx, CreatePostParams{
		Title: "ScanPost", Slug: "scan-post", AuthorID: u.ID, Status: "published",
	})
	_ = q.AddTagToPost(ctx, AddTagToPostParams{PostID: p.ID, TagID: parent.ID})

	posts, err := q.ListPosts(ctx, ListPostsParams{
		StatusFilter:   false,
		IncludeDrafts:  true,
		IncludeHidden:  false,
		FeaturedFilter: false,
		Limit:          100,
		Offset:         0,
	})
	if err != nil {
		t.Fatalf("ListPosts (scan) failed: %v", err)
	}
	if len(posts) == 0 {
		t.Error("expected at least 1 post in scan")
	}

	tagsForPost, err := q.GetTagsForPost(ctx, p.ID)
	if err != nil {
		t.Fatalf("GetTagsForPost failed: %v", err)
	}
	if len(tagsForPost) == 0 {
		t.Error("expected at least 1 tag for post in scan")
	}

	now := time.Now().UTC().Round(0)
	m, _ := q.CreateMedia(ctx, CreateMediaParams{
		Filename: "scan.jpg", Checksum: "scan_c",
		PostID:     sql.NullInt64{Int64: p.ID, Valid: true},
		UploadedAt: now,
	})
	_ = m

	media, err := q.ListMedia(ctx, ListMediaParams{
		TypeFilter: false,
		FileType:   "",
		Offset:     0,
		Limit:      100,
	})
	if err != nil {
		t.Fatalf("ListMedia (scan) failed: %v", err)
	}
	if len(media) == 0 {
		t.Error("expected at least 1 media in scan")
	}

	mediaByPost, err := q.GetMediaByPostID(ctx, sql.NullInt64{Int64: p.ID, Valid: true})
	if err != nil {
		t.Fatalf("GetMediaByPostID failed: %v", err)
	}
	if len(mediaByPost) == 0 {
		t.Error("expected at least 1 media by post in scan")
	}
}

// TestGetPostsByTagWithData covers the GetPostsByTag scan loop with actual matching rows.
func TestGetPostsByTagWithData(t *testing.T) {
	q, db := setupTestDB(t)
	defer func() { _ = db.Close() }()
	ctx := context.Background()

	u, _ := q.CreateUser(ctx, CreateUserParams{Username: "u2", Email: "u2@t.com", PasswordHash: "h", DisplayName: "U2"})
	tag, _ := q.CreateTag(ctx, CreateTagParams{Name: "Nature", Slug: "nature"})
	post, _ := q.CreatePost(ctx, CreatePostParams{Title: "Post", Slug: "post-tag", AuthorID: u.ID, Status: "published"})
	_, _ = q.PublishPost(ctx, post.ID)
	_ = q.AddTagToPost(ctx, AddTagToPostParams{PostID: post.ID, TagID: tag.ID})
	_ = q.UpdateTagPostCount(ctx, tag.ID)

	posts, err := q.GetPostsByTag(ctx, GetPostsByTagParams{
		TagID:         tag.ID,
		IncludeDrafts: true,
		Limit:         10,
	})
	if err != nil {
		t.Fatalf("GetPostsByTag failed: %v", err)
	}
	if len(posts) == 0 {
		t.Error("expected at least 1 post from GetPostsByTag")
	}

	posts2, err := q.GetPostsByTag(ctx, GetPostsByTagParams{
		TagID:               tag.ID,
		PublishedOnlyFilter: true,
		Limit:               10,
	})
	if err != nil {
		t.Fatalf("GetPostsByTag (published only) failed: %v", err)
	}
	if len(posts2) == 0 {
		t.Error("expected at least 1 published post")
	}
}

// TestScanFunctionErrors covers scan-function error branches by closing the DB.
func TestScanFunctionErrors(t *testing.T) {
	q, db := setupTestDB(t)
	ctx := context.Background()

	u, _ := q.CreateUser(ctx, CreateUserParams{Username: "erru", Email: "e@e.com", PasswordHash: "h", DisplayName: "E"})
	tag, _ := q.CreateTag(ctx, CreateTagParams{Name: "ErrTag", Slug: "errtag"})
	post, _ := q.CreatePost(ctx, CreatePostParams{Title: "ErrPost", Slug: "errpost", AuthorID: u.ID, Status: "published"})
	_ = q.AddTagToPost(ctx, AddTagToPostParams{PostID: post.ID, TagID: tag.ID})
	sess, _ := q.CreateSession(ctx, CreateSessionParams{UserID: u.ID, Token: "t", ExpiresAt: time.Now().Add(time.Hour)})
	_ = sess
	m, _ := q.CreateMedia(ctx, CreateMediaParams{Filename: "f.jpg", Checksum: "c2", UploadedAt: time.Now().UTC().Round(0)})
	_ = m
	_, _ = q.UpdateSetting(ctx, UpdateSettingParams{Key: "k", Value: sql.NullString{String: "v", Valid: true}, ValueType: "string"})

	_ = db.Close()

	if _, err := q.GetMediaByPostID(ctx, sql.NullInt64{Int64: post.ID, Valid: true}); err == nil {
		t.Error("GetMediaByPostID: expected error on closed db")
	}
	if _, err := q.GetTagChildren(ctx, tag.ID); err == nil {
		t.Error("GetTagChildren: expected error on closed db")
	}
	if _, err := q.GetTagParents(ctx, tag.ID); err == nil {
		t.Error("GetTagParents: expected error on closed db")
	}
	if _, err := q.GetTagsForPost(ctx, post.ID); err == nil {
		t.Error("GetTagsForPost: expected error on closed db")
	}
	if _, err := q.GetUserSessions(ctx, u.ID); err == nil {
		t.Error("GetUserSessions: expected error on closed db")
	}
	if _, err := q.ListMedia(ctx, ListMediaParams{}); err == nil {
		t.Error("ListMedia: expected error on closed db")
	}
	if _, err := q.ListPosts(ctx, ListPostsParams{}); err == nil {
		t.Error("ListPosts: expected error on closed db")
	}
	if _, err := q.ListSettings(ctx); err == nil {
		t.Error("ListSettings: expected error on closed db")
	}
	if _, err := q.ListTags(ctx, false); err == nil {
		t.Error("ListTags: expected error on closed db")
	}
	if _, err := q.GetPostsByTag(ctx, GetPostsByTagParams{TagID: tag.ID, IncludeDrafts: true, Limit: 10}); err == nil {
		t.Error("GetPostsByTag: expected error on closed db")
	}
}
