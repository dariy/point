package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"point-api/internal/api"
	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// The tools are thin, but what they are thin over matters: each one has to hand
// the right method, path, params and body to a real handler, and hand the
// handler's answer back as MCP content. These tests drive the registered tools
// through an in-memory client session against real services on a real (in-
// memory) database, so a tool that dispatches to the wrong place fails here
// rather than in a client.

const testBaseURL = "https://blog.test"

// A theme's name is the theme-title it declares, not its filename.
const testThemeCSS = `/* theme-title: "Daylight" */
/* description: "A test theme" */
/* preview-color: "#336699" */
:root { --color-primary: #336699; }`

const testDarkThemeCSS = `/* theme-title: "Midnight" */
/* description: "A test theme with a dark block" */
/* preview-color: "#336699" */
:root { --color-primary: #336699; }
[data-theme="dark"] { --color-primary: #99ccff; }`

// toolEnv is a live MCP session wired to the same handlers the HTTP server
// mounts, plus handles on the stores behind them so a test can assert on state
// rather than only on the tool's own answer.
type toolEnv struct {
	t          *testing.T
	cs         *sdk.ClientSession
	repo       repository.Repository
	settings   *services.SettingsService
	uploadRoot string
	themesDir  string
}

func newToolEnv(t *testing.T) *toolEnv {
	t.Helper()

	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatalf("NewRepository: %v", err)
	}
	t.Cleanup(func() { _ = repo.Close() })

	storage, themesDir, frontend := t.TempDir(), t.TempDir(), t.TempDir()
	uploadRoot := t.TempDir()
	writeFile(t, filepath.Join(themesDir, "default.css"), testThemeCSS)

	cfg := &config.Config{StoragePath: storage, ThemesPath: themesDir, FrontendDir: frontend}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo, settingsSvc, nil, tagSvc, "")
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	themeSvc := services.NewThemeService(cfg, settingsSvc)
	systemSvc := services.NewSystemService(repo, storage, "")
	cacheSvc := services.NewCacheService(storage)
	authSvc := services.NewAuthService(repo)

	// Posts are attributed to the calling principal, so the user it names has
	// to exist before any write.
	if _, err := repo.CreateUser(context.Background(), models.CreateUserParams{
		Username: "owner", Email: "owner@test.local", PasswordHash: "x", DisplayName: "Owner",
	}); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	inv := &invoker{
		ctx:        context.Background(),
		principal:  models.GetAPIKeyByHashRow{ID: 1, UserID: 1},
		e:          echo.New(),
		uploadRoot: uploadRoot,
		baseURL:    testBaseURL,
		h: handlers{
			post:     api.NewPostHandler(postSvc, settingsSvc, mediaSvc, tagSvc),
			tag:      api.NewTagHandler(tagSvc, settingsSvc),
			media:    api.NewMediaHandler(mediaSvc, settingsSvc),
			theme:    api.NewThemeHandler(themeSvc),
			settings: api.NewSettingsHandler(settingsSvc, nil),
			system: api.NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc,
				systemSvc, cacheSvc, authSvc, storage, "test"),
		},
	}

	srv := sdk.NewServer(&sdk.Implementation{Name: "point-mcp", Version: "test"}, nil)
	registerTools(srv, inv)
	registerResources(srv, inv)

	clientT, serverT := sdk.NewInMemoryTransports()
	ctx := context.Background()
	if _, err := srv.Connect(ctx, serverT, nil); err != nil {
		t.Fatalf("server connect: %v", err)
	}
	cs, err := sdk.NewClient(&sdk.Implementation{Name: "test", Version: "1"}, nil).Connect(ctx, clientT, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	t.Cleanup(func() { _ = cs.Close() })

	return &toolEnv{t: t, cs: cs, repo: repo, settings: settingsSvc, uploadRoot: uploadRoot, themesDir: themesDir}
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// result returns the tool's single text content, and whether the call came back
// flagged as an error.
func (env *toolEnv) result(name string, args map[string]any) (string, bool) {
	env.t.Helper()
	res, err := env.cs.CallTool(context.Background(), &sdk.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		env.t.Fatalf("call %s: %v", name, err)
	}
	if len(res.Content) != 1 {
		env.t.Fatalf("call %s: expected 1 content block, got %d", name, len(res.Content))
	}
	text, ok := res.Content[0].(*sdk.TextContent)
	if !ok {
		env.t.Fatalf("call %s: content is %T, want TextContent", name, res.Content[0])
	}
	return text.Text, res.IsError
}

// call runs a tool that is expected to succeed and decodes its JSON answer.
func (env *toolEnv) call(name string, args map[string]any) map[string]any {
	env.t.Helper()
	text, isErr := env.result(name, args)
	if isErr {
		env.t.Fatalf("call %s: unexpected tool error: %s", name, text)
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(text), &out); err != nil {
		env.t.Fatalf("call %s: result is not a JSON object (%v): %s", name, err, text)
	}
	return out
}

// callErr runs a tool that is expected to fail and returns the error text the
// client sees.
func (env *toolEnv) callErr(name string, args map[string]any) string {
	env.t.Helper()
	text, isErr := env.result(name, args)
	if !isErr {
		env.t.Fatalf("call %s: expected a tool error, got: %s", name, text)
	}
	return text
}

// createPost creates a post through the tool and returns its ID.
func (env *toolEnv) createPost(args map[string]any) int64 {
	env.t.Helper()
	out := env.call("point_create_post", args)
	id, ok := out["id"].(float64)
	if !ok {
		env.t.Fatalf("create post: no id in response: %v", out)
	}
	return int64(id)
}

func str(t *testing.T, m map[string]any, key string) string {
	t.Helper()
	v, ok := m[key].(string)
	if !ok {
		t.Fatalf("field %q is %T (%v), want string", key, m[key], m[key])
	}
	return v
}

// ── posts ────────────────────────────────────────────────────────────────────

func TestCreatePost_StoresFieldsAndDefaultsToDraft(t *testing.T) {
	env := newToolEnv(t)

	id := env.createPost(map[string]any{
		"title":            "Hello",
		"content":          "Body text",
		"excerpt":          "A summary",
		"meta_description": "Meta",
		"tags":             []string{"travel"},
	})

	got := env.call("point_get_post", map[string]any{"id": id})
	if s := str(t, got, "title"); s != "Hello" {
		t.Errorf("title = %q, want %q", s, "Hello")
	}
	if s := str(t, got, "content"); s != "Body text" {
		t.Errorf("content = %q, want %q", s, "Body text")
	}
	if s := str(t, got, "excerpt"); s != "A summary" {
		t.Errorf("excerpt = %q, want %q", s, "A summary")
	}
	// The tool, not the caller, supplies the draft default.
	if s := str(t, got, "status"); s != "draft" {
		t.Errorf("status = %q, want draft", s)
	}
	tags, _ := got["tags"].([]any)
	if len(tags) != 1 {
		t.Fatalf("tags = %v, want one tag", got["tags"])
	}
}

// The MCP client writes fenced divs the way the docs show them ("::: {.x}"),
// which the markdown renderer does not accept; the tool normalizes them.
func TestCreatePost_NormalizesFenceSyntax(t *testing.T) {
	env := newToolEnv(t)

	id := env.createPost(map[string]any{
		"title":   "Fences",
		"content": "::: {.gallery}\nphoto\n:::",
	})

	content := str(t, env.call("point_get_post", map[string]any{"id": id}), "content")
	if strings.Contains(content, "::: {") {
		t.Errorf("fence was not normalized: %q", content)
	}
	if !strings.Contains(content, ":::{.gallery}") {
		t.Errorf("content = %q, want a :::{.gallery} fence", content)
	}
}

func TestGetPost_BySlugAndWithoutSelector(t *testing.T) {
	env := newToolEnv(t)
	env.createPost(map[string]any{"title": "Slugged", "content": "x", "slug": "slugged"})

	got := env.call("point_get_post", map[string]any{"slug": "slugged"})
	if s := str(t, got, "title"); s != "Slugged" {
		t.Errorf("title = %q, want Slugged", s)
	}

	if msg := env.callErr("point_get_post", map[string]any{}); !strings.Contains(msg, "provide id or slug") {
		t.Errorf("error = %q, want it to ask for id or slug", msg)
	}
}

// A missing post has to surface as a tool error carrying the API's status, not
// as an empty success.
func TestGetPost_UnknownIDIsAToolError(t *testing.T) {
	env := newToolEnv(t)

	msg := env.callErr("point_get_post", map[string]any{"id": 4242})
	if !strings.Contains(msg, "point API error 404") {
		t.Errorf("error = %q, want a 404 from the API", msg)
	}
}

// The backend PUT replaces the whole post, so the tool seeds the body from the
// current post. Anything the caller omits has to survive that round trip.
func TestUpdatePost_LeavesOmittedFieldsAlone(t *testing.T) {
	env := newToolEnv(t)
	id := env.createPost(map[string]any{
		"title": "Original", "content": "Original body", "excerpt": "Original excerpt",
		"css": "p { color: red; }", "slug": "original", "tags": []string{"keepme"},
	})

	env.call("point_update_post", map[string]any{"id": id, "title": "Renamed"})

	got := env.call("point_get_post", map[string]any{"id": id})
	if s := str(t, got, "title"); s != "Renamed" {
		t.Errorf("title = %q, want Renamed", s)
	}
	for field, want := range map[string]string{
		"content": "Original body",
		"excerpt": "Original excerpt",
		"slug":    "original",
		"css":     "p { color: red; }",
	} {
		if s := str(t, got, field); s != want {
			t.Errorf("%s = %q, want %q — an omitted field was overwritten", field, s, want)
		}
	}
	tags, _ := got["tags"].([]any)
	if len(tags) != 1 {
		t.Errorf("tags = %v, want the original tag to survive", got["tags"])
	}
}

func TestUpdatePost_UnknownIDReportsTheFetchStep(t *testing.T) {
	env := newToolEnv(t)

	msg := env.callErr("point_update_post", map[string]any{"id": 999, "title": "x"})
	if !strings.Contains(msg, "fetching post for update") {
		t.Errorf("error = %q, want it to name the failing step", msg)
	}
}

func TestPublishAndWithdrawPost(t *testing.T) {
	env := newToolEnv(t)
	id := env.createPost(map[string]any{"title": "Draft", "content": "x"})

	if s := str(t, env.call("point_publish_post", map[string]any{"id": id}), "status"); s != "published" {
		t.Errorf("status after publish = %q, want published", s)
	}
	if s := str(t, env.call("point_withdraw_post", map[string]any{"id": id}), "status"); s != "draft" {
		t.Errorf("status after withdraw = %q, want draft", s)
	}
}

// DELETE answers 204 with no body; the tool has to turn that into a result the
// client can read rather than empty content.
func TestDeletePost_EmptyBodyBecomesSuccess(t *testing.T) {
	env := newToolEnv(t)
	id := env.createPost(map[string]any{"title": "Doomed", "content": "x"})

	out := env.call("point_delete_post", map[string]any{"id": id})
	if out["success"] != true {
		t.Errorf("delete result = %v, want {\"success\":true}", out)
	}
	if msg := env.callErr("point_get_post", map[string]any{"id": id}); !strings.Contains(msg, "404") {
		t.Errorf("post still readable after delete: %s", msg)
	}
}

func TestListPosts_AppliesFilters(t *testing.T) {
	env := newToolEnv(t)
	published := env.createPost(map[string]any{"title": "Published one", "content": "x"})
	env.call("point_publish_post", map[string]any{"id": published})
	env.createPost(map[string]any{"title": "Still a draft", "content": "y"})

	all := env.call("point_list_posts", map[string]any{"status": "all"})
	if n, _ := all["total"].(float64); n != 2 {
		t.Errorf("total with status=all = %v, want 2", all["total"])
	}

	onlyPublished := env.call("point_list_posts", map[string]any{"status": "published"})
	posts, _ := onlyPublished["posts"].([]any)
	if len(posts) != 1 {
		t.Fatalf("published listing returned %d posts, want 1", len(posts))
	}
	first, _ := posts[0].(map[string]any)
	if s := str(t, first, "title"); s != "Published one" {
		t.Errorf("published listing returned %q", s)
	}

	found := env.call("point_list_posts", map[string]any{"search": "still"})
	if n, _ := found["total"].(float64); n != 1 {
		t.Errorf("search total = %v, want 1", found["total"])
	}

	paged := env.call("point_list_posts", map[string]any{"page": 1, "per_page": 1, "status": "all"})
	if n, _ := paged["per_page"].(float64); n != 1 {
		t.Errorf("per_page = %v, want the requested 1", paged["per_page"])
	}
}

func TestSetPostTags_ReplacesTheWholeSet(t *testing.T) {
	env := newToolEnv(t)
	id := env.createPost(map[string]any{"title": "Tagged", "content": "x", "tags": []string{"one", "two"}})

	out := env.call("point_set_post_tags", map[string]any{"id": id, "tags": []string{"three"}})
	tags, _ := out["tags"].([]any)
	if len(tags) != 1 {
		t.Fatalf("tags after replace = %v, want exactly one", out["tags"])
	}
	tag, _ := tags[0].(map[string]any)
	if s := str(t, tag, "slug"); s != "three" {
		t.Errorf("remaining tag = %q, want three", s)
	}
}

func TestGeneratePreviewLink(t *testing.T) {
	env := newToolEnv(t)
	id := env.createPost(map[string]any{"title": "Secret", "content": "x"})

	out := env.call("point_generate_preview_link", map[string]any{"id": id})
	token := str(t, out, "token")
	if token == "" {
		t.Fatal("preview link has no token")
	}
	if url := str(t, out, "preview_url"); !strings.HasSuffix(url, "/preview/"+token) {
		t.Errorf("preview_url = %q, want it to end in /preview/%s", url, token)
	}
}

// ── replace_in_post ──────────────────────────────────────────────────────────

func TestReplaceInPost_Content(t *testing.T) {
	env := newToolEnv(t)
	id := env.createPost(map[string]any{"title": "Doc", "content": "alpha beta"})

	env.call("point_replace_in_post", map[string]any{
		"id": id, "field": "content", "old_string": "beta", "new_string": "gamma",
	})

	got := env.call("point_get_post", map[string]any{"id": id})
	if s := str(t, got, "content"); s != "alpha gamma" {
		t.Errorf("content = %q, want %q", s, "alpha gamma")
	}
}

func TestReplaceInPost_CSSAndExcerpt(t *testing.T) {
	env := newToolEnv(t)
	id := env.createPost(map[string]any{
		"title": "Styled", "content": "x", "css": "p { color: red; }", "excerpt": "old summary",
	})

	env.call("point_replace_in_post", map[string]any{
		"id": id, "field": "css", "old_string": "red", "new_string": "blue",
	})
	env.call("point_replace_in_post", map[string]any{
		"id": id, "field": "excerpt", "old_string": "old", "new_string": "new",
	})

	got := env.call("point_get_post", map[string]any{"id": id})
	if s := str(t, got, "css"); !strings.Contains(s, "blue") {
		t.Errorf("css = %q, want it to contain blue", s)
	}
	if s := str(t, got, "excerpt"); s != "new summary" {
		t.Errorf("excerpt = %q, want %q", s, "new summary")
	}
}

// A replacement that would hit several places is refused unless the caller said
// so — the guard that keeps a targeted edit from quietly rewriting a whole post.
func TestReplaceInPost_MultipleMatchesNeedOptIn(t *testing.T) {
	env := newToolEnv(t)
	id := env.createPost(map[string]any{"title": "Repeats", "content": "one one one"})

	msg := env.callErr("point_replace_in_post", map[string]any{
		"id": id, "field": "content", "old_string": "one", "new_string": "two",
	})
	if !strings.Contains(msg, "3 occurrences") {
		t.Errorf("error = %q, want it to report the match count", msg)
	}
	if s := str(t, env.call("point_get_post", map[string]any{"id": id}), "content"); s != "one one one" {
		t.Errorf("content changed despite the refusal: %q", s)
	}

	env.call("point_replace_in_post", map[string]any{
		"id": id, "field": "content", "old_string": "one", "new_string": "two", "allow_multiple": true,
	})
	if s := str(t, env.call("point_get_post", map[string]any{"id": id}), "content"); s != "two two two" {
		t.Errorf("content = %q, want every occurrence replaced", s)
	}
}

func TestReplaceInPost_RejectsMissingTextAndUnknownField(t *testing.T) {
	env := newToolEnv(t)
	id := env.createPost(map[string]any{"title": "Doc", "content": "alpha"})

	if msg := env.callErr("point_replace_in_post", map[string]any{
		"id": id, "field": "content", "old_string": "nowhere", "new_string": "x",
	}); !strings.Contains(msg, "not found") {
		t.Errorf("error = %q, want a not-found message", msg)
	}

	if msg := env.callErr("point_replace_in_post", map[string]any{
		"id": id, "field": "title", "old_string": "Doc", "new_string": "x",
	}); !strings.Contains(msg, "invalid field") {
		t.Errorf("error = %q, want an invalid-field message", msg)
	}
}

func TestReplaceInPost_UnknownIDReportsTheFetchStep(t *testing.T) {
	env := newToolEnv(t)

	msg := env.callErr("point_replace_in_post", map[string]any{
		"id": 999, "field": "content", "old_string": "a", "new_string": "b",
	})
	if !strings.Contains(msg, "fetching post for replacement") {
		t.Errorf("error = %q, want it to name the failing step", msg)
	}
}

// ── tags ─────────────────────────────────────────────────────────────────────

func TestTagTools_CreateGetListDelete(t *testing.T) {
	env := newToolEnv(t)

	created := env.call("point_create_tag", map[string]any{
		"name": "Iceland", "slug": "iceland", "description": "North",
		"locations": []map[string]any{{"latitude": 64.1, "longitude": -21.9}},
	})
	id := int64(created["id"].(float64))

	byID := env.call("point_get_tag", map[string]any{"id": id})
	if s := str(t, byID, "name"); s != "Iceland" {
		t.Errorf("name = %q, want Iceland", s)
	}
	bySlug := env.call("point_get_tag", map[string]any{"slug": "iceland"})
	if n, _ := bySlug["id"].(float64); int64(n) != id {
		t.Errorf("slug lookup returned id %v, want %d", bySlug["id"], id)
	}
	if msg := env.callErr("point_get_tag", map[string]any{}); !strings.Contains(msg, "provide id or slug") {
		t.Errorf("error = %q, want it to ask for id or slug", msg)
	}

	listed := env.call("point_list_tags", map[string]any{})
	if n, _ := listed["total"].(float64); n != 1 {
		t.Errorf("tag total = %v, want 1", listed["total"])
	}

	if out := env.call("point_delete_tag", map[string]any{"id": id}); out["success"] != true {
		t.Errorf("delete result = %v, want {\"success\":true}", out)
	}
	if msg := env.callErr("point_get_tag", map[string]any{"id": id}); !strings.Contains(msg, "404") {
		t.Errorf("tag still readable after delete: %s", msg)
	}
}

// update_tag sends only the fields the caller named, so the handler keeps the
// rest — the tool's pointer fields are what make that true.
func TestUpdateTag_KeepsUnnamedFields(t *testing.T) {
	env := newToolEnv(t)
	created := env.call("point_create_tag", map[string]any{
		"name": "Iceland", "slug": "iceland", "description": "North", "kind": "place",
	})
	id := int64(created["id"].(float64))

	env.call("point_update_tag", map[string]any{"id": id, "name": "Ísland"})

	got := env.call("point_get_tag", map[string]any{"id": id})
	if s := str(t, got, "name"); s != "Ísland" {
		t.Errorf("name = %q, want Ísland", s)
	}
	if s := str(t, got, "description"); s != "North" {
		t.Errorf("description = %q — an unnamed field was cleared", s)
	}
	if s := str(t, got, "kind"); s != "place" {
		t.Errorf("kind = %q — an unnamed field was cleared", s)
	}
}

// ── media ────────────────────────────────────────────────────────────────────

func tinyPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

func TestUploadMedia_FromTheSandbox(t *testing.T) {
	env := newToolEnv(t)
	path := filepath.Join(env.uploadRoot, "photo.png")
	if err := os.WriteFile(path, tinyPNG(t), 0o600); err != nil {
		t.Fatal(err)
	}

	out := env.call("point_upload_media", map[string]any{"file_path": path})
	if s := str(t, out, "path"); s == "" {
		t.Errorf("upload response has no path: %v", out)
	}

	listed := env.call("point_list_media", map[string]any{"page": 1, "per_page": 10})
	items, _ := listed["media"].([]any)
	if len(items) != 1 {
		t.Fatalf("media listing has %d items, want 1", len(items))
	}
}

func TestUploadMedia_RejectsPathsOutsideTheSandbox(t *testing.T) {
	env := newToolEnv(t)
	outside := filepath.Join(t.TempDir(), "secret.png")
	if err := os.WriteFile(outside, tinyPNG(t), 0o600); err != nil {
		t.Fatal(err)
	}

	if msg := env.callErr("point_upload_media", map[string]any{"file_path": outside}); !strings.Contains(msg, "outside") {
		t.Errorf("error = %q, want it to refuse a path outside the upload directory", msg)
	}
	if msg := env.callErr("point_upload_media", map[string]any{
		"file_path": filepath.Join(env.uploadRoot, "missing.png"),
	}); !strings.Contains(msg, "file not found") {
		t.Errorf("error = %q, want a not-found message", msg)
	}
}

func TestAnalyzeMedia_UnknownIDIsAToolError(t *testing.T) {
	env := newToolEnv(t)

	if msg := env.callErr("point_analyze_media", map[string]any{"id": 999}); !strings.Contains(msg, "point API error") {
		t.Errorf("error = %q, want the API's error", msg)
	}
}

// ── themes & settings ────────────────────────────────────────────────────────

func TestThemeTools_ListAndActivate(t *testing.T) {
	env := newToolEnv(t)
	writeFile(t, filepath.Join(env.themesDir, "midnight.css"), testDarkThemeCSS)

	// ListThemes answers a bare array, which the shared decoder cannot take.
	text, isErr := env.result("point_list_themes", map[string]any{})
	if isErr {
		t.Fatalf("list themes: %s", text)
	}
	var themes []map[string]any
	if err := json.Unmarshal([]byte(text), &themes); err != nil {
		t.Fatalf("themes are not a JSON array: %s", text)
	}
	if len(themes) != 2 {
		t.Errorf("listed %d themes, want 2", len(themes))
	}

	if s := str(t, env.call("point_set_active_theme", map[string]any{"name": "midnight"}), "name"); s != "Midnight" {
		t.Errorf("activated theme = %q, want Midnight", s)
	}
	if msg := env.callErr("point_set_active_theme", map[string]any{"name": "nosuchtheme"}); !strings.Contains(msg, "point API error") {
		t.Errorf("error = %q, want the API's rejection", msg)
	}
}

// point_get_theme_css turns the active theme's metadata into a :root block the
// model can copy into post CSS.
func TestGetThemeCSS_TracksTheActiveTheme(t *testing.T) {
	env := newToolEnv(t)

	out := env.call("point_get_theme_css", map[string]any{})
	if css := str(t, out, "css"); !strings.Contains(css, "--color-accent: #336699") {
		t.Errorf("css = %q, want the theme's accent", css)
	}
	vars, _ := out["variables"].(map[string]any)
	if vars["color-scheme"] != "light" {
		t.Errorf("color-scheme = %v, want light for a theme without a dark block", vars["color-scheme"])
	}

	writeFile(t, filepath.Join(env.themesDir, "midnight.css"), testDarkThemeCSS)
	env.call("point_set_active_theme", map[string]any{"name": "midnight"})

	vars, _ = env.call("point_get_theme_css", map[string]any{})["variables"].(map[string]any)
	if vars["color-scheme"] != "dark" {
		t.Errorf("color-scheme = %v, want dark once a dark-capable theme is active", vars["color-scheme"])
	}
}

func TestSettingsTools_ReadAndUpdate(t *testing.T) {
	env := newToolEnv(t)

	updated := env.call("point_update_settings", map[string]any{
		"updates": map[string]string{"blog_title": "My Blog", "posts_per_page": "7"},
	})
	if s := str(t, updated, "blog_title"); s != "My Blog" {
		t.Errorf("update response blog_title = %q", s)
	}

	got := env.call("point_get_settings", map[string]any{})
	if s := str(t, got, "posts_per_page"); s != "7" {
		t.Errorf("posts_per_page = %q, want 7", s)
	}
}

// ── context & analytics ──────────────────────────────────────────────────────

func TestGetContext_ReportsBlogIdentityAndCounts(t *testing.T) {
	env := newToolEnv(t)
	env.call("point_update_settings", map[string]any{
		"updates": map[string]string{
			"blog_title": "My Blog", "blog_subtitle": "Notes", "author_name": "Ada", "posts_per_page": "7",
		},
	})
	id := env.createPost(map[string]any{"title": "One", "content": "x"})
	env.call("point_publish_post", map[string]any{"id": id})

	out := env.call("point_get_context", map[string]any{})
	// base_url is not a setting — it is the configured public URL, which the
	// site itself gets from the request origin and MCP cannot.
	if s := str(t, out, "base_url"); s != testBaseURL {
		t.Errorf("base_url = %q, want %q", s, testBaseURL)
	}
	if s := str(t, out, "blog_title"); s != "My Blog" {
		t.Errorf("blog_title = %q, want My Blog", s)
	}
	if s := str(t, out, "subtitle"); s != "Notes" {
		t.Errorf("subtitle = %q, want Notes", s)
	}
	if s := str(t, out, "author_name"); s != "Ada" {
		t.Errorf("author_name = %q, want Ada", s)
	}
	if n, _ := out["posts_per_page"].(float64); n != 7 {
		t.Errorf("posts_per_page = %v, want 7", out["posts_per_page"])
	}
	theme, _ := out["active_theme"].(map[string]any)
	if theme["name"] != "Daylight" {
		t.Errorf("active_theme = %v, want the default theme", out["active_theme"])
	}
	stats, _ := out["stats"].(map[string]any)
	if n, _ := stats["published_posts"].(float64); n != 1 {
		t.Errorf("published_posts = %v, want 1", stats["published_posts"])
	}
}

func TestAnalyticsTools(t *testing.T) {
	env := newToolEnv(t)
	id := env.createPost(map[string]any{"title": "Popular", "content": "x"})
	env.call("point_publish_post", map[string]any{"id": id})
	env.createPost(map[string]any{"title": "Unpublished", "content": "y"})

	// top_posts asks for published posts sorted by views, whatever the caller
	// passed for limit.
	top := env.call("point_analytics_top_posts", map[string]any{"limit": 5})
	posts, _ := top["posts"].([]any)
	if len(posts) != 1 {
		t.Fatalf("top posts returned %d, want only the published one", len(posts))
	}
	if n, _ := top["per_page"].(float64); n != 5 {
		t.Errorf("per_page = %v, want the requested limit", top["per_page"])
	}
	// An absent limit falls back to 10 rather than to the handler's own default.
	if n, _ := env.call("point_analytics_top_posts", map[string]any{})["per_page"].(float64); n != 10 {
		t.Errorf("default per_page = %v, want 10", n)
	}

	summary := env.call("point_analytics_summary", map[string]any{})
	if _, ok := summary["total_views"]; !ok {
		t.Errorf("summary has no total_views: %v", summary)
	}
}

func TestGetSyntaxGuidelines(t *testing.T) {
	env := newToolEnv(t)

	out := env.call("point_get_syntax_guidelines", map[string]any{})
	for _, key := range []string{"markdown", "html", "css"} {
		if _, ok := out[key]; !ok {
			t.Errorf("guidelines have no %q section: %v", key, out)
		}
	}
}

// Every optional field the update tool knows about has to reach the write body;
// a field missing from that mapping would silently keep its old value.
func TestUpdatePost_AppliesEveryField(t *testing.T) {
	env := newToolEnv(t)
	id := env.createPost(map[string]any{"title": "Before", "content": "before"})

	env.call("point_update_post", map[string]any{
		"id": id, "title": "After", "content": "after", "css": "p { color: blue; }",
		"immersive_mode": "immersive", "formatter": "html", "excerpt": "new excerpt",
		"slug": "after", "is_featured": true, "thumbnail_path": "/media/pic.jpg",
		"meta_description": "new meta", "tags": []string{"fresh"}, "status": "published",
	})

	got := env.call("point_get_post", map[string]any{"id": id})
	for field, want := range map[string]string{
		"title":            "After",
		"content":          "after",
		"css":              "p { color: blue; }",
		"immersive_mode":   "immersive",
		"formatter":        "html",
		"excerpt":          "new excerpt",
		"slug":             "after",
		"thumbnail_path":   "/media/pic.jpg",
		"meta_description": "new meta",
		"status":           "published",
	} {
		if s := str(t, got, field); s != want {
			t.Errorf("%s = %q, want %q", field, s, want)
		}
	}
	if got["is_featured"] != true {
		t.Errorf("is_featured = %v, want true", got["is_featured"])
	}
	tags, _ := got["tags"].([]any)
	if len(tags) != 1 {
		t.Errorf("tags = %v, want the replacement tag", got["tags"])
	}
}

// The fields the write body has to reconstruct from nullable columns are the
// easiest ones to drop on a partial update.
func TestUpdatePost_PreservesNullableFieldsAndSchedule(t *testing.T) {
	env := newToolEnv(t)
	when := time.Now().Add(48 * time.Hour).UTC().Format(time.RFC3339)
	id := env.createPost(map[string]any{
		"title": "Scheduled", "content": "x", "excerpt": "keep me",
		"thumbnail_path": "/media/pic.jpg", "meta_description": "keep this too",
		"scheduled_at": when,
	})
	if s := str(t, env.call("point_get_post", map[string]any{"id": id}), "status"); s != "scheduled" {
		t.Fatalf("status = %q, want scheduled — the fixture needs a future schedule", s)
	}

	env.call("point_update_post", map[string]any{"id": id, "title": "Renamed"})

	got := env.call("point_get_post", map[string]any{"id": id})
	for field, want := range map[string]string{
		"excerpt":          "keep me",
		"thumbnail_path":   "/media/pic.jpg",
		"meta_description": "keep this too",
		"status":           "scheduled",
	} {
		if s := str(t, got, field); s != want {
			t.Errorf("%s = %q, want %q — a nullable field was dropped", field, s, want)
		}
	}
	if got["scheduled_at"] == nil {
		t.Error("scheduled_at was dropped by an unrelated update")
	}
}

// A tool whose first dispatch fails reports that rather than answering with a
// half-built context object.
func TestGetContext_SurfacesHandlerFailures(t *testing.T) {
	env := newToolEnv(t)
	_ = env.repo.Close()

	if msg := env.callErr("point_get_context", map[string]any{}); msg == "" {
		t.Error("expected an error message when the database is gone")
	}
}

// Geocoding a real tag would call out to Nominatim, so the wiring is pinned on
// an unknown tag instead: the lookup fails in the database, before any request
// leaves the process.
func TestGeocodeTag_UnknownIDIsAToolError(t *testing.T) {
	env := newToolEnv(t)

	if msg := env.callErr("point_geocode_tag", map[string]any{"id": 999}); !strings.Contains(msg, "point API error") {
		t.Errorf("error = %q, want the API's error", msg)
	}
}
