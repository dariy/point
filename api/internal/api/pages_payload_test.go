package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"testing"
	"time"

	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

// TestPagesPayloads pins the wire format of every BFF page endpoint against a
// fixed fixture site, public and owner side by side.
//
// It exists because these payloads are a contract with a frontend that lives in
// the same repository but is not type-checked against them: nothing else fails
// when a key quietly changes name, stops being emitted, or starts being emitted
// to guests. The fixture deliberately carries the awkward cases — a hidden tag,
// a hides_posts subtree, a scheduled post, a pinned home page, a DAG with two
// routes to the same tag — because those are the rules worth freezing.
//
// Regenerate with `UPDATE_PAGES_GOLDEN=1 go test ./internal/api -run TestPagesPayloads`
// and read the diff: every line of it is a change your users will see.
func TestPagesPayloads(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()

	fx := seedPayloadFixture(t, h)
	e := echo.New()

	cases := []struct {
		name string
		call func(echo.Context) error
		// target is the request URL; params are the route params the endpoint
		// reads (the router is not involved in a handler unit test).
		target string
		params map[string]string
		owner  bool
		// settings are applied before the call. The tags-route slot takes a
		// single claimant, so the graph and the map cannot both be live at
		// once and the cases that need each say so.
		settings map[string]string
		// sortKeys names the top-level arrays whose order comes from iterating
		// the tag snapshot's map and is therefore not stable between runs. They
		// are sorted before comparison; every other array is compared in the
		// order the handler emitted it.
		sortKeys []string
	}{
		{name: "home/public", call: ph.GetHomePage, target: "/"},
		{name: "home/owner", call: ph.GetHomePage, target: "/", owner: true},
		{name: "home/page-2", call: ph.GetHomePage, target: "/?page=2"},
		{name: "home/year-scope", call: ph.GetHomePage, target: "/?year_from=2024&year_to=2024"},
		{name: "home/scheduled-queue", call: ph.GetHomePage, target: "/?page=0", owner: true},

		{name: "tag/public", call: ph.GetTagPage, target: "/tags/paris", params: map[string]string{"slug": "paris"}},
		{name: "tag/owner", call: ph.GetTagPage, target: "/tags/paris", params: map[string]string{"slug": "paris"}, owner: true},
		{name: "tag/breadcrumb-path", call: ph.GetTagPage, target: "/tags/paris?path=country/france", params: map[string]string{"slug": "paris"}},
		{name: "tag/hides-posts-subtree", call: ph.GetTagPage, target: "/tags/vault", params: map[string]string{"slug": "vault"}, owner: true},
		{name: "tag/scheduled-queue", call: ph.GetTagPage, target: "/tags/france?page=0", params: map[string]string{"slug": "france"}, owner: true},

		{name: "directory/public", call: ph.GetTagsPage, target: "/tags"},
		{name: "directory/owner", call: ph.GetTagsPage, target: "/tags", owner: true},

		{name: "graph/public", call: ph.GetTagsGraph, target: "/graph", sortKeys: []string{"tags"}},
		{name: "graph/owner", call: ph.GetTagsGraph, target: "/graph", owner: true, sortKeys: []string{"tags"}},
		{name: "graph/no-posts", call: ph.GetTagsGraph, target: "/graph?posts=0", sortKeys: []string{"tags"}},
		{name: "graph/year-scope", call: ph.GetTagsGraph, target: "/graph?year_from=2024&year_to=2024", sortKeys: []string{"tags"}},

		{name: "cloud/public", call: ph.GetTagCloud, target: "/cloud", params: map[string]string{"id": strconv.FormatInt(fx.franceID, 10)}},
		{name: "cloud/owner", call: ph.GetTagCloud, target: "/cloud", params: map[string]string{"id": strconv.FormatInt(fx.franceID, 10)}, owner: true},

		{name: "map/public", call: ph.GetMapPage, target: "/map", sortKeys: []string{"tags"}, settings: mapPluginOn},
		{name: "map/owner", call: ph.GetMapPage, target: "/map", owner: true, sortKeys: []string{"tags"}},
		{name: "map/year-scope", call: ph.GetMapPage, target: "/map?year_from=2024&year_to=2024", sortKeys: []string{"tags"}},

		{name: "nav/public", call: ph.GetNavMenu, target: "/nav"},
	}

	got := map[string]interface{}{}
	for _, tc := range cases {
		for k, v := range tc.settings {
			if err := h.settingsSvc.SetSetting(context.Background(), k, v, "string"); err != nil {
				t.Fatalf("%s: SetSetting(%s): %v", tc.name, k, err)
			}
		}
		req := httptest.NewRequest(http.MethodGet, tc.target, nil)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		for k, v := range tc.params {
			c.SetParamNames(k)
			c.SetParamValues(v)
		}
		if tc.owner {
			c.Set("user", "owner")
		}
		if err := tc.call(c); err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d", tc.name, rec.Code)
		}
		var body interface{}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("%s: decode: %v", tc.name, err)
		}
		got[tc.name] = canonicalPayload(body, tc.sortKeys)
	}

	// The pinned home page replaces the feed, so it needs the setting flipped
	// after the ordinary home cases have been captured.
	if err := h.settingsSvc.SetSetting(context.Background(), "home_page_post_id", "welcome", "string"); err != nil {
		t.Fatalf("SetSetting(home_page_post_id): %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	if err := ph.GetHomePage(e.NewContext(req, rec)); err != nil {
		t.Fatalf("home/pinned-page: %v", err)
	}
	var pinned interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &pinned); err != nil {
		t.Fatalf("home/pinned-page: decode: %v", err)
	}
	got["home/pinned-page"] = canonicalPayload(pinned, nil)

	golden := filepath.Join("testdata", "pages_payloads.json")
	encoded, err := json.MarshalIndent(got, "", "  ")
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	encoded = append(encoded, '\n')

	if os.Getenv("UPDATE_PAGES_GOLDEN") != "" {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatalf("mkdir testdata: %v", err)
		}
		if err := os.WriteFile(golden, encoded, 0o644); err != nil {
			t.Fatalf("write golden: %v", err)
		}
		t.Logf("wrote %s", golden)
		return
	}

	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatalf("read golden (regenerate with UPDATE_PAGES_GOLDEN=1): %v", err)
	}
	if string(want) != string(encoded) {
		t.Errorf("page payloads changed.\n--- want\n%s\n--- got\n%s", want, encoded)
	}
}

// mapPluginOn hands the single-claim tags-route slot to the map plugin, which
// is what the /map endpoint needs to be reachable at all.
var mapPluginOn = map[string]string{
	"plugin.tags-graph.enabled": "false",
	"plugin.tags-map.enabled":   "true",
}

type payloadFixture struct {
	franceID int64
}

// seedPayloadFixture builds the site the payload golden is taken against: a
// two-branch tag DAG with coordinates, a year tag, a hidden tag, a hides_posts
// tag, published and draft posts, a scheduled one, and a page to pin.
func seedPayloadFixture(t *testing.T, h *testHandlers) payloadFixture {
	t.Helper()
	ctx := context.Background()
	userID := insertUser(h.repo)

	set := func(k, v string) {
		t.Helper()
		if err := h.settingsSvc.SetSetting(ctx, k, v, "string"); err != nil {
			t.Fatalf("SetSetting(%s): %v", k, err)
		}
	}
	set("posts_per_page", "2")
	set("blog_title", "Fixture")
	set("blog_subtitle", "a fixed site")
	set("author_name", "Author")
	set("show_view_counts", "true")
	set("tags_visibility", "all")
	set("plugin.tags-graph.enabled", "true")
	set("plugin.tags-atlas.enabled", "false")
	set("plugin.tags-map.enabled", "false")

	tag := func(p services.CreateTagParams) int64 {
		t.Helper()
		created, err := h.tagSvc.CreateTag(ctx, p)
		if err != nil {
			t.Fatalf("CreateTag(%s): %v", p.Name, err)
		}
		return created.ID
	}
	coord := func(v float64) *float64 { return &v }

	nature := tag(services.CreateTagParams{Name: "Nature", Slug: "nature", InBreadcrumbs: true})
	botany := tag(services.CreateTagParams{Name: "Botany", Slug: "botany", ParentIDs: []int64{nature}})
	country := tag(services.CreateTagParams{Name: "Country", Slug: "country", InBreadcrumbs: true})
	france := tag(services.CreateTagParams{
		Name: "France", Slug: "france", Kind: "geo", InBreadcrumbs: true,
		Latitude: coord(46.6), Longitude: coord(2.2), ParentIDs: []int64{country},
	})
	// Paris hangs off both France and Botany, so the breadcrumb `path` has a
	// branch to choose between.
	tag(services.CreateTagParams{
		Name: "Paris", Slug: "paris", Kind: "geo",
		Latitude: coord(48.85), Longitude: coord(2.35), ParentIDs: []int64{france, botany},
	})
	tag(services.CreateTagParams{Name: "2024", Slug: "2024", Kind: "year"})
	tag(services.CreateTagParams{Name: "Quiet", Slug: "quiet", Hidden: true})
	tag(services.CreateTagParams{Name: "Vault", Slug: "vault", HidesPosts: true})

	post := func(p services.CreatePostParams) {
		t.Helper()
		p.AuthorID = userID
		if _, _, err := h.postSvc.CreatePost(ctx, p); err != nil {
			t.Fatalf("CreatePost(%s): %v", p.Title, err)
		}
	}
	post(services.CreatePostParams{Title: "Alpha", Slug: "alpha", Status: "published", Tags: []string{"Botany", "2024"}})
	post(services.CreatePostParams{
		Title: "Beta", Slug: "beta", Status: "published", Tags: []string{"Paris", "2024"},
		ThumbnailPath: "/media/originals/beta.jpg",
	})
	post(services.CreatePostParams{Title: "Gamma", Slug: "gamma", Status: "published", Tags: []string{"Vault"}})
	post(services.CreatePostParams{Title: "Delta", Slug: "delta", Status: "published", Tags: []string{"Quiet"}})
	post(services.CreatePostParams{Title: "Epsilon", Slug: "epsilon", Status: "draft"})
	soon := time.Now().Add(24 * time.Hour)
	post(services.CreatePostParams{
		Title: "Zeta", Slug: "zeta", Status: "scheduled", Tags: []string{"France"}, ScheduledAt: &soon,
	})
	post(services.CreatePostParams{
		Title: "Welcome", Slug: "welcome", Status: "published", Type: "page",
		Content: "Hello from the pinned page.",
	})

	return payloadFixture{franceID: france}
}

// timestampRe matches the timestamp formats the payloads carry, which move with
// the clock and say nothing about the shape being pinned.
var timestampRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}`)

// canonicalPayload replaces timestamps with a placeholder and sorts the named
// top-level arrays, so what is left is exactly the part of the payload that is
// supposed to be stable.
func canonicalPayload(v interface{}, sortKeys []string) interface{} {
	obj, ok := v.(map[string]interface{})
	if !ok {
		return normaliseTimestamps(v)
	}
	out := make(map[string]interface{}, len(obj))
	for k, val := range obj {
		val = normaliseTimestamps(val)
		for _, sk := range sortKeys {
			if k != sk {
				continue
			}
			if arr, ok := val.([]interface{}); ok {
				sort.Slice(arr, func(i, j int) bool {
					a, _ := json.Marshal(arr[i])
					b, _ := json.Marshal(arr[j])
					return string(a) < string(b)
				})
			}
		}
		out[k] = val
	}
	return out
}

func normaliseTimestamps(v interface{}) interface{} {
	switch t := v.(type) {
	case map[string]interface{}:
		for k, val := range t {
			t[k] = normaliseTimestamps(val)
		}
		return t
	case []interface{}:
		for i, val := range t {
			t[i] = normaliseTimestamps(val)
		}
		return t
	case string:
		if timestampRe.MatchString(t) {
			return "<timestamp>"
		}
		return t
	default:
		return v
	}
}
