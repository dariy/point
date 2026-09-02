import { test, describe } from "node:test";
import assert from "node:assert";

import { routes } from "../../demo/mock/routes.js";

// The demo's search is the two endpoints the search page fetches in parallel —
// GET /api/posts?q= for the grid and GET /api/tags?q= for the chip strip. Both
// stand in for SQL (buildPostsQuery in api/internal/repository/queries_posts.go,
// TagHandler.ListTags in api/internal/api/tags.go), so what is asserted here is
// that the mock narrows results the same way the backend does: a query that
// matches nothing must come back empty rather than returning the whole site.

/** Call a mock endpoint the way shim.js does, and return its body. */
function call(method, path, { state, query = {}, params = {} } = {}) {
  const entry = routes.find(([m, p]) => m === method && p === path);
  assert.ok(entry, `no mock route for ${method} ${path}`);
  return entry[2]({ state, query, params, body: null }).body;
}

const post = (id, extra = {}) => ({
  id,
  slug: `post-${id}`,
  title: `Post ${id}`,
  status: "published",
  published_at: `2024-01-0${id}T00:00:00Z`,
  tags: [],
  ...extra,
});

const tag = (id, name, slug, extra = {}) => ({
  id,
  name,
  slug,
  post_count: 1,
  children: [],
  effective_hidden: false,
  ...extra,
});

/** A guest's view of a small site: three posts, a two-level tag tree. */
function searchState() {
  const japan = tag(1, "Japan", "japan", { children: [{ id: 2 }] });
  const kyoto = tag(2, "Kyoto", "kyoto");
  return {
    authenticated: false,
    tags: [japan, kyoto, tag(3, "Reykjavík", "reykjavik"), tag(4, "Empty", "empty", { post_count: 0 })],
    posts: [
      post(1, { title: "Silent storytellers", excerpt: "Shot on film in Kyoto.", tags: [{ name: "Kyoto", slug: "kyoto" }] }),
      post(2, { title: "Harbour light", excerpt: "Iceland, in the blue hour.", tags: [{ name: "Reykjavík", slug: "reykjavik" }] }),
      post(3, { title: "Terminal", excerpt: "Nothing to do with any of it.", tags: [] }),
    ],
  };
}

describe("GET /api/posts?q=", () => {
  const search = (q, query = {}) =>
    call("GET", "/api/posts", { state: searchState(), query: { q, ...query } }).posts.map((p) => p.id);

  test("matches the title, case-insensitively", () => {
    assert.deepEqual(search("SILENT"), [1]);
  });

  test("matches the excerpt", () => {
    assert.deepEqual(search("blue hour"), [2]);
  });

  test("matches a tag the post carries, by name or slug", () => {
    // Searching a place finds the photographs taken there, not only the posts
    // that name it in their title — post 2 says "Iceland", never "Reykjavík".
    assert.deepEqual(search("Reykjavík"), [2]);
    assert.deepEqual(search("reykjavik"), [2]);
  });

  test("matches the slug", () => {
    assert.deepEqual(search("post-3"), [3]);
  });

  test("returns nothing when nothing matches", () => {
    // The failure this endpoint used to have: an unrecognised filter fell
    // through and the search page rendered the entire site as "results".
    assert.deepEqual(search("kangaroo"), []);
  });

  test("combines with a tag filter, including the tag's descendants", () => {
    assert.deepEqual(search("film", { tag: "japan" }), [1]);
    assert.deepEqual(search("film", { tag: "reykjavik" }), []);
  });

  test("treats status=all as no status filter", () => {
    const state = searchState();
    state.posts[2].status = "draft";
    const out = call("GET", "/api/posts", { state, query: { q: "Terminal", status: "all" } });
    // The draft is still invisible to a guest — but not because "all" was
    // compared against p.status, which matches nothing at all.
    assert.deepEqual(out.posts, []);
    assert.equal(out.total, 0);
  });

  test("paginates the matches, not the whole collection", () => {
    const out = call("GET", "/api/posts", {
      state: searchState(),
      query: { q: "Kyoto", per_page: 10 },
    });
    assert.equal(out.total, 1);
    assert.equal(out.pages, 1);
  });
});

describe("GET /api/tags?q=", () => {
  const state = searchState();
  const search = (query) => call("GET", "/api/tags", { state, query }).tags.map((t) => t.slug);

  test("matches name or slug", () => {
    assert.deepEqual(search({ q: "kyo" }), ["kyoto"]);
    // The unaccented spelling is what a visitor can actually type.
    assert.deepEqual(search({ q: "reykjavik" }), ["reykjavik"]);
  });

  test("returns nothing when nothing matches", () => {
    assert.deepEqual(search({ q: "kangaroo" }), []);
  });

  test("include_empty=false drops tags that would lead to an empty page", () => {
    assert.ok(search({}).includes("empty"));
    assert.ok(!search({ include_empty: "false" }).includes("empty"));
  });

  // `hidden` is the flag an author sets; `effective_hidden` is what the backend
  // works out from it and the tag graph, and the mock recomputes rather than
  // trusting the recorded value — so a tag hidden inside the demo takes its
  // descendants with it. The child here is only hidden by inheritance.
  test("hides hidden tags, and their children, from a guest but not from an admin", () => {
    const hidden = {
      ...state,
      tags: [
        tag(9, "Secret", "secret", { hidden: true, children: [{ id: 10 }] }),
        tag(10, "Under it", "under-it"),
      ],
    };
    assert.deepEqual(call("GET", "/api/tags", { state: hidden, query: {} }).tags, []);

    const admin = call("GET", "/api/tags", {
      state: { ...hidden, authenticated: true },
      query: {},
    }).tags;
    assert.deepEqual(admin.map((t) => t.slug), ["secret", "under-it"]);
    // The inherited flags come back computed, with the ancestor named.
    assert.equal(admin[1].effective_hidden, true);
    assert.equal(admin[1].hidden_via, 9);
  });
});
