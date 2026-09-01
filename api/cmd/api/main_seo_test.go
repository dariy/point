package main

// The server-rendered <head>: what a crawler, an unfurler or a shared link sees
// before any JS runs. The rules being pinned here are the ones a later refactor
// can quietly break — what is described, what is deliberately NOT described,
// and which URL each page claims as its own.

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/services"
)

// seoFixture builds a router over an in-memory blog with an owner, a title and
// a subtitle — the settings the homepage and every tag page describe themselves
// with.
func seoFixture(t *testing.T) (*seoEnv, func(path string) *httptest.ResponseRecorder) {
	t.Helper()
	root, _ := writePluginFrontend(t, "immersive")
	cfg := config.Config{AppVersion: "1.0.0", FrontendDir: root}
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = repo.Close() })
	seedOwner(t, repo)

	ctx := context.Background()
	svcs := initServices(&cfg, repo)
	for _, kv := range [][2]string{
		{"blog_title", "Field Notes"},
		{"blog_subtitle", "Photographs from the edge of the map"},
		{"logo_url", "/2024/01/logo.png"},
	} {
		if err := svcs.Settings.SetSetting(ctx, kv[0], kv[1], "string"); err != nil {
			t.Fatal(err)
		}
	}

	env := &seoEnv{cfg: cfg, repo: repo, svcs: svcs, e: setupEcho(cfg, repo, svcs)}
	return env, env.get
}

type seoEnv struct {
	cfg  config.Config
	repo repository.Repository
	svcs *AppServices
	e    interface {
		ServeHTTP(http.ResponseWriter, *http.Request)
	}
}

func (env *seoEnv) get(path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	rec := httptest.NewRecorder()
	env.e.ServeHTTP(rec, req)
	return rec
}

func mustContain(t *testing.T, body string, wants ...string) {
	t.Helper()
	for _, w := range wants {
		if !strings.Contains(body, w) {
			t.Errorf("served document is missing %s:\n%s", w, body)
		}
	}
}

func mustNotContain(t *testing.T, body string, unwanted ...string) {
	t.Helper()
	for _, w := range unwanted {
		if strings.Contains(body, w) {
			t.Errorf("served document must not contain %s:\n%s", w, body)
		}
	}
}

// The homepage is the URL most often shared, and it used to unfurl as the
// shell's placeholder title with nothing behind it.
func TestPrerenderHomepage(t *testing.T) {
	_, get := seoFixture(t)

	body := get("/").Body.String()
	mustContain(t, body,
		"<title>Field Notes</title>",
		`<link rel="canonical" href="http://example.com/">`,
		`og:url" content="http://example.com/"`,
		`name="description" content="Photographs from the edge of the map"`,
		`og:description" content="Photographs from the edge of the map"`,
		`og:type" content="website"`,
		`og:title" content="Field Notes"`,
		`og:site_name" content="Field Notes"`,
		// The site logo, used as configured: it may be an SVG or an off-site
		// URL, neither of which the variant ladder can resize.
		`og:image" content="http://example.com/2024/01/logo.png"`,
		`twitter:card" content="summary"`,
	)
	mustNotContain(t, body, "Loading…")
}

// A tag archive describes itself from the tag, not from the site — and claims
// the plain /tags/<slug> URL however the reader arrived at it.
func TestPrerenderTagPage(t *testing.T) {
	env, get := seoFixture(t)
	if _, err := env.svcs.Tag.CreateTag(context.Background(), services.CreateTagParams{
		Name:        "Iceland",
		Slug:        "iceland",
		Description: "Two weeks around the ring road.",
	}); err != nil {
		t.Fatal(err)
	}

	body := get("/tags/iceland?path=europe/nordics&per_page=99").Body.String()
	mustContain(t, body,
		// Composed the way TagPage.js composes it, so hydration is not a
		// visible title change.
		"<title>Iceland — Posts — Field Notes</title>",
		`og:title" content="Iceland — Posts"`,
		`name="description" content="Two weeks around the ring road."`,
		`og:type" content="website"`,
		`og:site_name" content="Field Notes"`,
		`og:image" content="http://example.com/2024/01/logo.png"`,
	)
	// The breadcrumb chain and the page size are navigation, not identity: one
	// archive reached three ways is still one URL to index.
	mustContain(t, body, `<link rel="canonical" href="http://example.com/tags/iceland">`)
	mustNotContain(t, body, "path=europe", "per_page=99")
}

// A tag with no description of its own still gets one, rather than shipping a
// card with a title and a blank body.
func TestPrerenderTagPageComposesMissingDescription(t *testing.T) {
	env, get := seoFixture(t)
	if _, err := env.svcs.Tag.CreateTag(context.Background(), services.CreateTagParams{
		Name: "Lichen",
		Slug: "lichen",
	}); err != nil {
		t.Fatal(err)
	}

	mustContain(t, get("/tags/lichen").Body.String(),
		`name="description" content="Posts tagged “Lichen” on Field Notes"`)
}

// Pagination canonicalises to itself. Pointing page 2 at page 1 asks a crawler
// to collapse the archive into its first screen and stop following it.
func TestPrerenderCanonicalKeepsPageNumber(t *testing.T) {
	_, get := seoFixture(t)

	mustContain(t, get("/?page=3").Body.String(),
		`<link rel="canonical" href="http://example.com/?page=3">`)
	// Page 1 is the bare URL, not "?page=1" — the two would otherwise be two
	// URLs for the same screen.
	mustContain(t, get("/?page=1").Body.String(),
		`<link rel="canonical" href="http://example.com/">`)
}

// A post page carries a canonical too, and it is the clean post URL: the same
// post is routinely linked with tracking parameters attached.
func TestPrerenderPostCanonical(t *testing.T) {
	env, get := seoFixture(t)
	if _, err := env.repo.CreatePost(context.Background(), models.CreatePostParams{
		Title:    "The Ring Road",
		Slug:     "the-ring-road",
		AuthorID: 1,
		Status:   "published",
		Content:  "hello",
	}); err != nil {
		t.Fatal(err)
	}

	body := get("/posts/the-ring-road?utm_source=chat").Body.String()
	mustContain(t, body,
		`<link rel="canonical" href="http://example.com/posts/the-ring-road">`,
		`og:url" content="http://example.com/posts/the-ring-road"`,
		// The tab title carries the site name, as setPageTitle() gives it after
		// hydration; the card title does not, because og:site_name carries it.
		"<title>The Ring Road — Field Notes</title>",
		`og:title" content="The Ring Road"`,
		`og:type" content="article"`,
	)
	mustNotContain(t, body, "utm_source")

	// A post is one document however the reader arrived at it: the ?page= they
	// came through belongs to the feed behind it, not to this URL.
	mustContain(t, get("/posts/the-ring-road?page=2").Body.String(),
		`<link rel="canonical" href="http://example.com/posts/the-ring-road">`)
}

// A tag the public is not shown must not describe itself to a crawler — and a
// slug that resolves to nothing must not echo itself back into the head either.
func TestPrerenderWithholdsHiddenTags(t *testing.T) {
	env, get := seoFixture(t)
	ctx := context.Background()

	if _, err := env.svcs.Tag.CreateTag(ctx, services.CreateTagParams{
		Name: "Private", Slug: "private", Hidden: true,
	}); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct{ name, path, secret string }{
		{"hidden outright", "/tags/private", "Private"},
		{"tag that does not exist", "/tags/nope", "nope"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := get(tc.path)
			if rec.Code != http.StatusOK {
				t.Fatalf("GET %s = %d, want 200 (the SPA still renders)", tc.path, rec.Code)
			}
			body := rec.Body.String()
			mustNotContain(t, body, "og:title", "<link rel=\"canonical\"")
			if strings.Contains(body, ">"+tc.secret+" — Posts<") {
				t.Errorf("withheld tag named in the head:\n%s", body)
			}
			// The shell is served untouched, placeholder title and all.
			mustContain(t, body, "<title>Loading…</title>")
		})
	}
}

// min_tag_posts_to_show is a visibility rule, not a display filter: a tag under
// the floor is not a page the public is shown, so it is not described either.
func TestPrerenderWithholdsTagUnderPostFloor(t *testing.T) {
	env, get := seoFixture(t)
	ctx := context.Background()
	tag, err := env.svcs.Tag.CreateTag(ctx, services.CreateTagParams{Name: "Sparse", Slug: "sparse"})
	if err != nil {
		t.Fatal(err)
	}
	post, err := env.repo.CreatePost(ctx, models.CreatePostParams{
		Title: "Only One", Slug: "only-one", AuthorID: 1, Status: "published", Content: "x",
	})
	if err != nil {
		t.Fatal(err)
	}
	// The floor counts posts, so the tag needs one to be under it rather than
	// merely absent from the count map.
	if _, err := env.repo.DB().ExecContext(ctx,
		`INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)`, post.ID, tag.ID); err != nil {
		t.Fatal(err)
	}

	// With no floor the tag describes itself.
	mustContain(t, get("/tags/sparse").Body.String(), `og:title" content="Sparse — Posts"`)

	if err := env.svcs.Settings.SetSetting(ctx, "min_tag_posts_to_show", "3", "string"); err != nil {
		t.Fatal(err)
	}
	body := get("/tags/sparse").Body.String()
	mustNotContain(t, body, "og:title", "Sparse")
	mustContain(t, body, "<title>Loading…</title>")
}

// A post that is not live must unfurl as nothing, whichever way it is not live.
// The scheduled case is the sharp one: the post is finished, its title and its
// card image are final, and only its publish time is holding it back — exactly
// the state a status refactor is most likely to let through.
func TestPrerenderWithholdsUnpublishedPosts(t *testing.T) {
	env, get := seoFixture(t)
	ctx := context.Background()

	future := time.Now().Add(48 * time.Hour)
	for _, p := range []models.CreatePostParams{
		{Title: "Draft Secret", Slug: "draft-secret", AuthorID: 1, Status: "draft", Content: "x"},
		{Title: "Hidden Secret", Slug: "hidden-secret", AuthorID: 1, Status: "hidden", Content: "x"},
		{
			Title: "Scheduled Secret", Slug: "scheduled-secret", AuthorID: 1, Status: "scheduled",
			Content: "x", ScheduledAt: sql.NullTime{Time: future, Valid: true},
		},
	} {
		if _, err := env.repo.CreatePost(ctx, p); err != nil {
			t.Fatal(err)
		}
	}

	for _, slug := range []string{"draft-secret", "hidden-secret", "scheduled-secret"} {
		t.Run(slug, func(t *testing.T) {
			body := get("/posts/" + slug).Body.String()
			mustNotContain(t, body, "Secret", "og:title", "og:type")
			mustContain(t, body, "<title>Loading…</title>")
		})
	}
}

// Every described document still boots the SPA, and its CSP still names the one
// inline script it carries — the splice order (metadata, then the bootstrap
// script, then </head>) is what keeps that a single hash.
func TestPrerenderKeepsBootstrapAndCSP(t *testing.T) {
	env, _ := seoFixture(t)
	ctx := context.Background()
	if _, err := env.svcs.Tag.CreateTag(ctx, services.CreateTagParams{Name: "Moss", Slug: "moss"}); err != nil {
		t.Fatal(err)
	}
	if _, err := env.repo.CreatePost(ctx, models.CreatePostParams{
		Title: "Moss Post", Slug: "moss-post", AuthorID: 1, Status: "published", Content: "x",
	}); err != nil {
		t.Fatal(err)
	}

	for _, path := range []string{"/", "/tags/moss", "/posts/moss-post"} {
		t.Run(path, func(t *testing.T) {
			rec := env.get(path)
			assertBootstrap(t, rec, services.DefaultThumbnailGeneration)
			if n := strings.Count(rec.Body.String(), "<title>"); n != 1 {
				t.Errorf("expected exactly one <title>, got %d:\n%s", n, rec.Body.String())
			}
		})
	}
}

// The described shell varies per URL, so what a shared cache may store is now a
// correctness question and not just a performance one. A guest read is the same
// for everyone and may be shared; anything carrying a session is not, and must
// never be stored at an edge — a logged-in admin's shell is a different
// document from the one the public gets.
func TestShellCacheabilityFollowsTheViewer(t *testing.T) {
	env, get := seoFixture(t)

	for _, path := range []string{"/", "/tags/anything", "/posts/anything"} {
		if got := get(path).Header().Get("Cache-Control"); got != "public, max-age=60" {
			t.Errorf("guest GET %s: Cache-Control = %q, want the shared 60s TTL", path, got)
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.AddCookie(&http.Cookie{Name: "session", Value: "whatever"})
	rec := httptest.NewRecorder()
	env.e.ServeHTTP(rec, req)
	if got := rec.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Errorf("authenticated GET /: Cache-Control = %q, want private, no-store", got)
	}
	rec = httptest.NewRecorder()
	env.e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/light/media", nil))
	if got := rec.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Errorf("admin GET /light/media: Cache-Control = %q, want private, no-store", got)
	}
}

// The shell ships a blank <meta name="description"> for the SPA to fill in after
// it boots. A crawler reads the first description element it finds, so an
// injected one queued up behind the blank is the same as no description at all.
func TestPrerenderReplacesTheBlankDescription(t *testing.T) {
	env, get := seoFixture(t)
	if _, err := env.repo.CreatePost(context.Background(), models.CreatePostParams{
		Title: "Described", Slug: "described", AuthorID: 1, Status: "published",
		Content: "x", MetaDescription: sql.NullString{String: "A real description.", Valid: true},
	}); err != nil {
		t.Fatal(err)
	}

	for _, path := range []string{"/", "/posts/described"} {
		t.Run(path, func(t *testing.T) {
			body := get(path).Body.String()
			if n := strings.Count(body, `name="description"`); n != 1 {
				t.Errorf("expected exactly one description meta, got %d:\n%s", n, body)
			}
			mustNotContain(t, body, `name="description" content=""`)
		})
	}

	// An undescribed route keeps the shell as the SPA expects to find it: the
	// blank meta is what its own code fills in.
	mustContain(t, get("/search").Body.String(), `name="description" content=""`, "<title>Loading…</title>")
}

// An excerpt is prose with the post's own line breaks in it, and it can run for
// paragraphs. A description meta is neither: it is one line, and nothing that
// reads it shows more than about 200 characters.
func TestPrerenderNormalisesTheDescription(t *testing.T) {
	env, get := seoFixture(t)
	long := "First line about the walk.\n\nThen a second paragraph that goes on, " +
		strings.Repeat("and on, ", 40) + "and finally stops."
	if _, err := env.repo.CreatePost(context.Background(), models.CreatePostParams{
		Title: "Long One", Slug: "long-one", AuthorID: 1, Status: "published", Content: "x",
		MetaDescription: sql.NullString{String: long, Valid: true},
	}); err != nil {
		t.Fatal(err)
	}

	body := get("/posts/long-one").Body.String()
	desc := regexp.MustCompile(`<meta name="description" content="([^"]*)">`).FindStringSubmatch(body)
	if desc == nil {
		t.Fatalf("no description meta:\n%s", body)
	}
	got := desc[1]
	if strings.ContainsAny(got, "\n\r") {
		t.Errorf("description carries the post's line breaks: %q", got)
	}
	if n := len([]rune(got)); n > metaDescriptionMax+1 { // +1 for the ellipsis
		t.Errorf("description is %d runes, want at most %d: %q", n, metaDescriptionMax, got)
	}
	if !strings.HasSuffix(got, "…") {
		t.Errorf("a cut description should say so: %q", got)
	}
	// Cut between words, not through one.
	if strings.HasSuffix(strings.TrimSuffix(got, "…"), "an") {
		t.Errorf("description cut mid-word: %q", got)
	}
}

// The admin section is not part of the public site and describes nothing.
func TestPrerenderSkipsAdminSection(t *testing.T) {
	_, get := seoFixture(t)
	body := get("/light/posts").Body.String()
	mustNotContain(t, body, "og:title", "canonical", "Field Notes")
}

// getWith is env.get for the cases where the request's headers are the subject:
// a proxied request, a spoofed one.
func (env *seoEnv) getWith(path string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	env.e.ServeHTTP(rec, req)
	return rec
}

// A published post can still be one the public may not read: a tag carrying
// hides_posts withholds every post filed under it, and the post API 404s an
// anonymous reader who asks for it by slug. The head must agree with that —
// otherwise the crawler gets the title, the excerpt and a link to a photograph
// it cannot fetch, for a post whose own page renders "Not found".
func TestPrerenderWithholdsPostsHiddenByTag(t *testing.T) {
	env, get := seoFixture(t)
	ctx := context.Background()

	if _, err := env.repo.CreatePost(ctx, models.CreatePostParams{
		Title: "Buried Lede", Slug: "buried-lede", AuthorID: 1, Status: "published", Content: "x",
	}); err != nil {
		t.Fatal(err)
	}
	post, err := env.svcs.Post.GetPostBySlug(ctx, "buried-lede")
	if err != nil {
		t.Fatal(err)
	}

	// Untagged, it describes itself — so what follows is the tag doing the work.
	mustContain(t, get("/posts/buried-lede").Body.String(), `og:title" content="Buried Lede"`)

	if _, err := env.svcs.Tag.CreateTag(ctx, services.CreateTagParams{
		Name: "Private Set", Slug: "private-set", HidesPosts: true,
	}); err != nil {
		t.Fatal(err)
	}
	if err := env.svcs.Post.UpdatePostTags(ctx, post.ID, []string{"Private Set"}); err != nil {
		t.Fatal(err)
	}

	body := get("/posts/buried-lede").Body.String()
	mustNotContain(t, body, "Buried Lede", "og:title", "og:type")
	mustContain(t, body, "<title>Loading…</title>")
}

// Reading a post from inside a tag archive keeps the archive's URL and carries
// the post in ?slug= (frontend/src/utils/viewContext.js) — so that URL, the one
// a reader copies while reading, is about the post and not about the archive.
func TestPrerenderPostOpenedInsideATagArchive(t *testing.T) {
	env, get := seoFixture(t)
	ctx := context.Background()

	if _, err := env.svcs.Tag.CreateTag(ctx, services.CreateTagParams{
		Name: "Iceland", Slug: "iceland", Description: "Two weeks around the ring road.",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := env.repo.CreatePost(ctx, models.CreatePostParams{
		Title: "The Ring Road", Slug: "the-ring-road", AuthorID: 1, Status: "published", Content: "x",
		MetaDescription: sql.NullString{String: "Nine days, one road.", Valid: true},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := env.repo.CreatePost(ctx, models.CreatePostParams{
		Title: "Unfinished Secret", Slug: "unfinished", AuthorID: 1, Status: "draft", Content: "x",
	}); err != nil {
		t.Fatal(err)
	}

	body := get("/tags/iceland?path=europe&slug=the-ring-road").Body.String()
	mustContain(t, body,
		// TagPage.js titles this view "<post> — <tag>", so the tab does not
		// rename itself on hydration.
		"<title>The Ring Road — Iceland</title>",
		`og:title" content="The Ring Road"`,
		`og:type" content="article"`,
		`name="description" content="Nine days, one road."`,
		// The post's own URL is where this view canonicalises, which is also
		// where TagPage.js points the canonical once it hydrates.
		`<link rel="canonical" href="http://example.com/posts/the-ring-road">`,
	)
	mustNotContain(t, body, "Two weeks around the ring road.", "— Posts")

	// The archive's page number came through the URL with it, and is not part
	// of the post's identity either.
	mustContain(t, get("/tags/iceland?page=2&slug=the-ring-road").Body.String(),
		`<link rel="canonical" href="http://example.com/posts/the-ring-road">`)

	// A ?slug= that is not a post the public may read falls back to describing
	// the archive, and names nothing of the post.
	fallback := get("/tags/iceland?slug=unfinished").Body.String()
	mustContain(t, fallback,
		`og:title" content="Iceland — Posts"`,
		`<link rel="canonical" href="http://example.com/tags/iceland">`,
	)
	mustNotContain(t, fallback, "Unfinished Secret")
}

// Absolute URLs are built from X-Forwarded-Proto because a TLS-terminating
// proxy is the normal deployment — but the header is a client-supplied string
// that lands in an href, and a chain of proxies appends to it rather than
// replacing it.
func TestPrerenderForwardedProtoIsReadAsAnEnum(t *testing.T) {
	env, _ := seoFixture(t)

	for _, tc := range []struct{ name, header, want string }{
		{"terminating proxy", "https", "https://example.com/"},
		// Two proxies deep: the first entry is the scheme the client used.
		{"proxy chain", "https, http", "https://example.com/"},
		{"junk falls back to the connection", `" onload="alert(1)`, "http://example.com/"},
		{"unknown scheme falls back", "javascript", "http://example.com/"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := env.getWith("/", map[string]string{"X-Forwarded-Proto": tc.header}).Body.String()
			mustContain(t, body, `<link rel="canonical" href="`+tc.want+`">`)
			mustNotContain(t, body, "onload", "javascript:", "https, http")
		})
	}
}
