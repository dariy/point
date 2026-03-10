package api

import (
	"database/sql"
	"testing"
	"time"

	"point-api/internal/models"
	"point-api/internal/repository"
)

func TestNullFloat64(t *testing.T) {
	// Valid
	f := sql.NullFloat64{Float64: 3.14, Valid: true}
	p := nullFloat64(f)
	if p == nil || *p != 3.14 {
		t.Errorf("expected 3.14, got %v", p)
	}

	// Invalid
	f = sql.NullFloat64{Valid: false}
	if nullFloat64(f) != nil {
		t.Error("expected nil for invalid NullFloat64")
	}
}

func TestPostTagsOrEmpty(t *testing.T) {
	// nil → empty slice
	result := postTagsOrEmpty(nil)
	if result == nil || len(result) != 0 {
		t.Error("expected non-nil empty slice for nil input")
	}

	// non-nil passed through
	tags := []repository.PostTagInfo{{ID: 1, Name: "foo", Slug: "foo"}}
	result = postTagsOrEmpty(tags)
	if len(result) != 1 {
		t.Errorf("expected len 1, got %d", len(result))
	}
}

func TestPostByTagToResponse(t *testing.T) {
	now := time.Now()
	p := models.GetPostsByTagRow{
		ID:                1,
		Title:             "My Post",
		Slug:              "my-post",
		Formatter:         "markdown",
		Status:            "published",
		IsFeatured:        false,
		ViewCount:         5,
		CreatedAt:         now,
		UpdatedAt:         now,
		AuthorID:          1,
		AuthorUsername:    "user",
		AuthorDisplayName: "User",
	}
	tags := []repository.PostTagInfo{{ID: 2, Name: "Tag", Slug: "tag"}}

	resp := postByTagToResponse(p, tags)
	if resp["id"] != int64(1) {
		t.Errorf("expected id=1, got %v", resp["id"])
	}
	if resp["title"] != "My Post" {
		t.Errorf("expected title My Post, got %v", resp["title"])
	}
	tagList := resp["tags"].([]map[string]interface{})
	if len(tagList) != 1 || tagList[0]["name"] != "Tag" {
		t.Errorf("unexpected tags: %v", resp["tags"])
	}
}

func TestTagToListItem(t *testing.T) {
	tag := models.Tag{
		ID:          10,
		Name:        "Places",
		Slug:        "places",
		IsImportant: true,
		PostCount:   5,
	}
	item := tagToListItem(tag)
	if item["id"] != int64(10) {
		t.Errorf("expected id=10, got %v", item["id"])
	}
	if item["post_count"] != int64(5) {
		t.Errorf("expected post_count=5, got %v", item["post_count"])
	}
}

func TestTagLocationsResponse(t *testing.T) {
	// nil → empty slice
	result := tagLocationsResponse(nil)
	if len(result) != 0 {
		t.Errorf("expected empty slice, got %v", result)
	}

	// with location
	loc := &models.TagLocation{ID: 1, Latitude: 48.8, Longitude: 2.3}
	result = tagLocationsResponse(loc)
	if len(result) != 1 {
		t.Errorf("expected 1 location, got %d", len(result))
	}
	if result[0]["latitude"] != float64(48.8) {
		t.Errorf("expected latitude 48.8, got %v", result[0]["latitude"])
	}
}

func TestExtractMediaURL(t *testing.T) {
	// thumbnail takes priority
	thumb := sql.NullString{String: "/thumbs/photo.jpg", Valid: true}
	p := extractMediaURL(thumb, "<video src='/vid.mp4'>")
	if p == nil || *p != "/thumbs/photo.jpg" {
		t.Errorf("expected thumbnail path, got %v", p)
	}

	// video src when no thumbnail
	p = extractMediaURL(sql.NullString{Valid: false}, `<video src="/media/vid.mp4"></video>`)
	if p == nil || *p != "/media/vid.mp4" {
		t.Errorf("expected video src, got %v", p)
	}

	// bare media path
	p = extractMediaURL(sql.NullString{Valid: false}, "/2026/01/audio.mp3")
	if p == nil || *p != "/2026/01/audio.mp3" {
		t.Errorf("expected bare path, got %v", p)
	}

	// no media
	p = extractMediaURL(sql.NullString{Valid: false}, "just text")
	if p != nil {
		t.Errorf("expected nil, got %v", p)
	}
}

func TestInjectPostHiddenFields(t *testing.T) {
	resp := map[string]interface{}{
		"tags": []map[string]interface{}{{"name": "foo"}},
	}
	tags := []models.Tag{{ID: 1, IsHidden: true}}
	hiddenPostsIDs := map[int64]bool{1: true}

	injectPostHiddenFields(resp, "hidden", tags, hiddenPostsIDs)

	if resp["is_hidden"] != true {
		t.Error("expected is_hidden=true for status=hidden")
	}
	if resp["is_hidden_by_tag"] != true {
		t.Error("expected is_hidden_by_tag=true")
	}
}

func TestInjectPostHiddenFieldsFromInfo(t *testing.T) {
	resp := map[string]interface{}{
		"tags": []map[string]interface{}{{"name": "bar"}},
	}
	tags := []repository.PostTagInfo{{ID: 2, IsHidden: true}}
	hiddenPostsIDs := map[int64]bool{2: true}

	injectPostHiddenFieldsFromInfo(resp, "published", tags, hiddenPostsIDs)

	if resp["is_hidden"] != false {
		t.Error("expected is_hidden=false for published status")
	}
	if resp["is_hidden_by_tag"] != true {
		t.Error("expected is_hidden_by_tag=true from tag ID 2")
	}
}

func TestMediaToResponse(t *testing.T) {
	m := models.Medium{
		ID:           1,
		Filename:     "photo.jpg",
		OriginalPath: "originals/2026/03/photo.jpg",
		FileType:     "IMAGE",
		MimeType:     "image/jpeg",
		FileSize:     1024,
		IsPublic:     1,
		ThumbnailPath: sql.NullString{String: "thumbnails/2026/03/photo.jpg", Valid: true},
	}
	resp := mediaToResponse(m)

	if resp["path"] != "/2026/03/photo.jpg" {
		t.Errorf("expected path /2026/03/photo.jpg, got %v", resp["path"])
	}
	if resp["file_type"] != "image" {
		t.Errorf("expected lowercase file_type, got %v", resp["file_type"])
	}
	if resp["thumbnail_path"] == nil {
		t.Error("expected thumbnail_path to be set")
	}
	// thumbnail path should be derived from media path + ?thumb
	if resp["thumbnail_path"] != "/2026/03/photo.jpg?thumb" {
		t.Errorf("expected thumbnail path /2026/03/photo.jpg?thumb, got %v", resp["thumbnail_path"])
	}

	// No thumbnail
	m.ThumbnailPath = sql.NullString{Valid: false}
	resp = mediaToResponse(m)
	if resp["thumbnail_path"] != nil {
		t.Errorf("expected nil thumbnail_path, got %v", resp["thumbnail_path"])
	}
}
