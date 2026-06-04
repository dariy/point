package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"point-api/internal/models"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

func TestTagHandler_MinPostsThreshold(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	handler := NewTagHandler(tagSvc, settingsSvc)
	e := echo.New()

	ctx := context.Background()

	// 0. Create user
	user, _ := repo.CreateUser(ctx, models.CreateUserParams{Username: "admin", PasswordHash: "hash", DisplayName: "Admin"})

	// 1. Create two tags
	t1, _ := repo.CreateTag(ctx, models.CreateTagParams{Name: "Tag High", Slug: "tag-high"})
	t2, _ := repo.CreateTag(ctx, models.CreateTagParams{Name: "Tag Low", Slug: "tag-low"})

	// 2. Add posts to make Tag High have 5 posts and Tag Low have 2 posts
	for i := 1; i <= 5; i++ {
		p, _ := repo.CreatePost(ctx, models.CreatePostParams{Title: "P", Slug: "p-h-" + strconv.Itoa(i), Status: "published", AuthorID: user.ID})
		_ = repo.AddTagToPost(ctx, models.AddTagToPostParams{PostID: p.ID, TagID: t1.ID})
	}
	for i := 1; i <= 2; i++ {
		p, _ := repo.CreatePost(ctx, models.CreatePostParams{Title: "P", Slug: "p-l-" + strconv.Itoa(i), Status: "published", AuthorID: user.ID})
		_ = repo.AddTagToPost(ctx, models.AddTagToPostParams{PostID: p.ID, TagID: t2.ID})
	}

	// Recalculate counts to be sure
	_ = repo.UpdateAllTagPostCounts(ctx)

	// 3. Set threshold to 4
	_ = settingsSvc.SetSetting(ctx, "min_tag_posts_to_show", "4", "integer")

	// 4. Test ListTags as Guest (publicOnly)
	req := httptest.NewRequest(http.MethodGet, "/tags", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := handler.ListTags(c); err != nil {
		t.Fatalf("ListTags failed: %v", err)
	}

	var resp struct {
		Tags []map[string]interface{} `json:"tags"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)

	foundLow := false
	for _, tag := range resp.Tags {
		if tag["slug"] == "tag-low" {
			foundLow = true
			break
		}
	}

	if foundLow {
		t.Error("FAIL: 'tag-low' is still visible to guest in ListTags")
	} else {
		t.Log("PASS: 'tag-low' is hidden from guest in ListTags")
	}

	// 5. Test GetTagCloud as Guest
	req = httptest.NewRequest(http.MethodGet, "/tags/cloud", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)

	if err := handler.GetTagCloud(c); err != nil {
		t.Fatalf("GetTagCloud failed: %v", err)
	}

	var cloudResp struct {
		Tags []map[string]interface{} `json:"tags"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &cloudResp)

	foundLowInCloud := false
	for _, tag := range cloudResp.Tags {
		if tag["slug"] == "tag-low" {
			foundLowInCloud = true
			break
		}
	}

	if foundLowInCloud {
		t.Error("FAIL: 'tag-low' is still visible to guest in GetTagCloud")
	} else {
		t.Log("PASS: 'tag-low' is hidden from guest in GetTagCloud")
	}

	// 5b. Test GetPostBySlug as Guest - check if tag-low is in tags list
	// Create a post with both tags
	post, _ := repo.CreatePost(ctx, models.CreatePostParams{Title: "Test Post", Slug: "test-post", Status: "published", AuthorID: user.ID})
	_ = repo.AddTagToPost(ctx, models.AddTagToPostParams{PostID: post.ID, TagID: t1.ID})
	_ = repo.AddTagToPost(ctx, models.AddTagToPostParams{PostID: post.ID, TagID: t2.ID})

	postHandler := NewPostHandler(services.NewPostService(repo), settingsSvc, nil, tagSvc)
	req = httptest.NewRequest(http.MethodGet, "/posts/test-post", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues("test-post")

	if err := postHandler.GetPostBySlug(c); err != nil {
		t.Fatalf("GetPostBySlug failed: %v", err)
	}

	var postResp map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &postResp)
	postTags := postResp["tags"].([]interface{})

	foundLowInPost := false
	for _, it := range postTags {
		tag := it.(map[string]interface{})
		if tag["slug"] == "tag-low" {
			foundLowInPost = true
			break
		}
	}

	if foundLowInPost {
		t.Error("FAIL: 'tag-low' is still visible in post response for guest")
	} else {
		t.Log("PASS: 'tag-low' is hidden from post response for guest")
	}

	// 6. Test ListTags as Admin (user set)
	req = httptest.NewRequest(http.MethodGet, "/tags", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.Set("user", "some-user")

	if err := handler.ListTags(c); err != nil {
		t.Fatalf("ListTags (Admin) failed: %v", err)
	}

	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	foundLowAsAdmin := false
	for _, tag := range resp.Tags {
		if tag["slug"] == "tag-low" {
			foundLowAsAdmin = true
			break
		}
	}

	if !foundLowAsAdmin {
		t.Error("FAIL: 'tag-low' is hidden from admin, but should be visible")
	} else {
		t.Log("PASS: 'tag-low' is visible to admin as expected")
	}

	// 7. Test GetTagByID as Guest
	req = httptest.NewRequest(http.MethodGet, "/tags/"+strconv.FormatInt(t2.ID, 10), nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(strconv.FormatInt(t2.ID, 10))

	if err := handler.GetTagByID(c); err == nil {
		if rec.Code == http.StatusOK {
			t.Error("FAIL: GetTagByID returned 200 for tag below threshold")
		} else if rec.Code != http.StatusNotFound {
			t.Errorf("FAIL: GetTagByID returned status %d, expected 404", rec.Code)
		}
	} else {
		he, ok := err.(*echo.HTTPError)
		if ok && he.Code == http.StatusNotFound {
			t.Log("PASS: GetTagByID returned 404 for tag below threshold")
		} else {
			t.Errorf("FAIL: GetTagByID returned error %v, expected 404", err)
		}
	}

	// 8. Test GetTagBySlug as Guest
	req = httptest.NewRequest(http.MethodGet, "/tags/slug/tag-low", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues("tag-low")

	if err := handler.GetTagBySlug(c); err == nil {
		if rec.Code == http.StatusOK {
			t.Error("FAIL: GetTagBySlug returned 200 for tag below threshold")
		} else if rec.Code != http.StatusNotFound {
			t.Errorf("FAIL: GetTagBySlug returned status %d, expected 404", rec.Code)
		}
	} else {
		he, ok := err.(*echo.HTTPError)
		if ok && he.Code == http.StatusNotFound {
			t.Log("PASS: GetTagBySlug returned 404 for tag below threshold")
		} else {
			t.Errorf("FAIL: GetTagBySlug returned error %v, expected 404", err)
		}
	}
}

func TestPostResponse_ExcludePageTags(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	postSvc := services.NewPostService(repo)
	handler := NewPostHandler(postSvc, settingsSvc, nil, tagSvc)
	e := echo.New()

	ctx := context.Background()

	// 0. Create user
	user, _ := repo.CreateUser(ctx, models.CreateUserParams{Username: "admin", PasswordHash: "hash", DisplayName: "Admin"})

	// 1. Create _page system tag and a child tag
	pageTag, _ := repo.CreateTag(ctx, models.CreateTagParams{Name: "_page", Slug: "_page"})
	childTag, _ := repo.CreateTag(ctx, models.CreateTagParams{Name: "Child Page", Slug: "child-page"})
	_ = repo.AddTagRelationship(ctx, models.AddTagRelationshipParams{ParentID: pageTag.ID, ChildID: childTag.ID})

	// 2. Create a normal tag
	normalTag, _ := repo.CreateTag(ctx, models.CreateTagParams{Name: "Normal", Slug: "normal"})

	// 3. Create a post with both tags
	p, _ := repo.CreatePost(ctx, models.CreatePostParams{Title: "P", Slug: "p", Status: "published", AuthorID: user.ID})
	_ = repo.AddTagToPost(ctx, models.AddTagToPostParams{PostID: p.ID, TagID: childTag.ID})
	_ = repo.AddTagToPost(ctx, models.AddTagToPostParams{PostID: p.ID, TagID: normalTag.ID})
	_ = repo.AddTagToPost(ctx, models.AddTagToPostParams{PostID: p.ID, TagID: pageTag.ID})

	// 4. Fetch posts
	req := httptest.NewRequest(http.MethodGet, "/posts", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := handler.ListPosts(c); err != nil {
		t.Fatalf("ListPosts failed: %v", err)
	}

	var resp struct {
		Posts []map[string]interface{} `json:"posts"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)

	if len(resp.Posts) != 1 {
		t.Fatalf("expected 1 post, got %d", len(resp.Posts))
	}

	tags := resp.Posts[0]["tags"].([]interface{})

	foundNormal := false
	foundChild := false
	foundPage := false
	for _, it := range tags {
		tag := it.(map[string]interface{})
		if tag["slug"] == "normal" {
			foundNormal = true
		}
		if tag["slug"] == "child-page" {
			foundChild = true
		}
		if tag["slug"] == "_page" {
			foundPage = true
		}
	}

	if !foundNormal {
		t.Error("FAIL: 'normal' tag not found in post response")
	}
	if foundChild {
		t.Error("FAIL: 'child-page' (descendant of _page) found in post response")
	} else {
		t.Log("PASS: 'child-page' correctly excluded from post response")
	}
	if foundPage {
		t.Log("NOTE: '_page' tag found in post response (it is NOT an excluded descendant by current logic)")
	} else {
		t.Log("PASS: '_page' correctly excluded from post response")
	}
}
