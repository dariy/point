package models

import (
	"context"
	"database/sql"
	"testing"
	"time"
)

// TestQueryScanBodies exercises list/scan functions with actual data
// to cover the rows.Next() loop bodies that are missed when Limit=0.
func TestQueryScanBodies(t *testing.T) {
	q, db := setupTestDB(t)
	defer db.Close()
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

	// ListPosts with Limit > 0 and IncludeDrafts=true to see scan body
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

	// Seed media for ListMedia and GetMediaByPostID scan bodies
	now := time.Now().UTC().Round(0)
	m, _ := q.CreateMedia(ctx, CreateMediaParams{
		Filename: "scan.jpg", Checksum: "scan_c",
		PostID: sql.NullInt64{Int64: p.ID, Valid: true},
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
	defer db.Close()
	ctx := context.Background()

	// Create user, tag, published post with that tag.
	u, _ := q.CreateUser(ctx, CreateUserParams{Username: "u2", Email: "u2@t.com", PasswordHash: "h", DisplayName: "U2"})
	tag, _ := q.CreateTag(ctx, CreateTagParams{Name: "Nature", Slug: "nature"})
	post, _ := q.CreatePost(ctx, CreatePostParams{Title: "Post", Slug: "post-tag", AuthorID: u.ID, Status: "published"})
	_, _ = q.PublishPost(ctx, post.ID)
	_ = q.AddTagToPost(ctx, AddTagToPostParams{PostID: post.ID, TagID: tag.ID})
	_ = q.UpdateTagPostCount(ctx, tag.ID)

	// IncludeDrafts=true to bypass status filter, get all posts with this tag.
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

	// PublishedOnlyFilter=true, status='published' — should also return the post.
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

	// Insert some data first.
	u, _ := q.CreateUser(ctx, CreateUserParams{Username: "erru", Email: "e@e.com", PasswordHash: "h", DisplayName: "E"})
	tag, _ := q.CreateTag(ctx, CreateTagParams{Name: "ErrTag", Slug: "errtag"})
	post, _ := q.CreatePost(ctx, CreatePostParams{Title: "ErrPost", Slug: "errpost", AuthorID: u.ID, Status: "published"})
	_ = q.AddTagToPost(ctx, AddTagToPostParams{PostID: post.ID, TagID: tag.ID})
	sess, _ := q.CreateSession(ctx, CreateSessionParams{UserID: u.ID, Token: "t", ExpiresAt: time.Now().Add(time.Hour)})
	_ = sess
	m, _ := q.CreateMedia(ctx, CreateMediaParams{Filename: "f.jpg", Checksum: "c2", UploadedAt: time.Now().UTC().Round(0)})
	_ = m
	_, _ = q.UpdateSetting(ctx, UpdateSettingParams{Key: "k", Value: sql.NullString{String: "v", Valid: true}, ValueType: "string"})

	// Now close the DB to force all subsequent queries to fail.
	db.Close()

	// Each of these should return an error (QueryContext fails on closed DB).
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
