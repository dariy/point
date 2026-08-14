import { test, describe } from "node:test";
import assert from "node:assert";

import { byNewest, nextId, paginate, toListShape } from "../../demo/mock/store.js";
import {
  feedPage,
  feedPosts,
  hiddenSets,
  scheduledQueue,
} from "../../demo/mock/routes.js";

// The static demo (demo/scripts/build.sh) answers every API call from these
// helpers, so their edge cases are the demo's edge cases: a wrong sort or a
// dropped field shows up as a visibly broken page with no server log to explain
// it.

describe("byNewest", () => {
  test("orders newest first by published_at", () => {
    const rows = [
      { id: 1, published_at: "2019-01-01T00:00:00Z" },
      { id: 2, published_at: "2024-06-01T00:00:00Z" },
      { id: 3, published_at: "2021-03-01T00:00:00Z" },
    ];
    assert.deepEqual(rows.sort(byNewest).map((r) => r.id), [2, 3, 1]);
  });

  test("falls back to created_at when published_at is null", () => {
    // Point's standalone pages (the "about" post) carry a null published_at.
    const rows = [
      { id: 1, published_at: null, created_at: "2025-01-01T00:00:00Z" },
      { id: 2, published_at: "2020-01-01T00:00:00Z" },
    ];
    assert.deepEqual(rows.sort(byNewest).map((r) => r.id), [1, 2]);
  });

  test("treats an unparseable date as oldest rather than producing NaN", () => {
    const rows = [
      { id: 1, published_at: "not-a-date" },
      { id: 2, published_at: "2020-01-01T00:00:00Z" },
    ];
    // A NaN comparator return leaves order undefined; assert the good row wins.
    assert.equal(rows.sort(byNewest)[0].id, 2);
  });
});

// The demo's archive is not uniformly public: it carries hidden posts, posts
// filed under a hidden place, and a scheduled queue. Who sees which is worked
// out from the tag graph on every read (routes.js), because a visitor can
// change the graph from /light/tags — and the revelio switch asks for the whole
// answer again as a guest.

/** A tree where `secret` hides its posts and everything under it. */
function visibilityState({ authenticated = false } = {}) {
  return {
    authenticated,
    tags: [
      { id: 1, slug: "japan", children: [{ id: 2 }] },
      { id: 2, slug: "kyoto", children: [] },
      { id: 3, slug: "secret", hidden: true, hides_posts: true, children: [{ id: 4 }] },
      { id: 4, slug: "under-it", children: [] },
    ],
    posts: [
      { id: 1, status: "published", tags: [{ slug: "kyoto" }] },
      { id: 2, status: "draft", tags: [] },
      { id: 3, status: "hidden", tags: [] },
      { id: 4, status: "published", tags: [{ slug: "secret" }] },
      { id: 5, status: "trashed", tags: [] },
      { id: 6, status: "scheduled", scheduled_at: "2030-01-02T00:00:00Z", tags: [] },
      // Filed under a *descendant* of the hidden tag: withheld by inheritance.
      { id: 7, status: "published", tags: [{ slug: "under-it" }] },
      { id: 8, status: "scheduled", scheduled_at: "2030-01-01T00:00:00Z", tags: [] },
    ],
  };
}

describe("hiddenSets", () => {
  test("propagates both flags to descendants and names the ancestor", () => {
    const sets = hiddenSets(visibilityState());
    assert.deepEqual([...sets.hidden].sort(), [3, 4]);
    assert.deepEqual([...sets.hidesPostsSlugs].sort(), ["secret", "under-it"]);
    assert.equal(sets.via.get(4), 3);
    // The tag that carries the flag itself is not "hidden via" anything.
    assert.equal(sets.via.has(3), false);
  });

  test("terminates on a cycle rather than hanging the page", () => {
    // The graph is a DAG in practice, but a demo edit could produce anything,
    // and an unguarded walk would spin instead of rendering.
    const state = {
      tags: [
        { id: 1, slug: "a", hidden: true, children: [{ id: 2 }] },
        { id: 2, slug: "b", children: [{ id: 1 }] },
      ],
    };
    assert.deepEqual([...hiddenSets(state).hidden].sort(), [1, 2]);
  });
});

describe("feedPosts", () => {
  test("a guest gets published posts that no tag withholds", () => {
    const state = visibilityState();
    assert.deepEqual(feedPosts(state).map((p) => p.id), [1]);
  });

  test("the owner additionally gets the hidden ones, but never the queue", () => {
    // Drafts and the scheduled queue are not feed content for anybody: the
    // queue is a separate read, left of page 1.
    const state = visibilityState({ authenticated: true });
    assert.deepEqual(feedPosts(state).map((p) => p.id), [1, 3, 4, 7]);
  });
});

describe("scheduledQueue", () => {
  test("is soonest-first, and empty for a guest", () => {
    assert.deepEqual(
      scheduledQueue(visibilityState({ authenticated: true })).map((p) => p.id),
      [8, 6],
    );
    assert.deepEqual(scheduledQueue(visibilityState()), []);
  });
});

describe("paginate", () => {
  test("slices the requested page under the collection key", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }));
    const out = paginate(rows, { page: 2, per_page: 10 }, "posts");
    assert.equal(out.page, 2);
    assert.equal(out.pages, 3);
    assert.equal(out.total, 25);
    assert.deepEqual(out.posts.map((r) => r.id), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  });

  test("reports one page for an empty collection", () => {
    // pages: 0 makes paginators render "page 1 of 0".
    const out = paginate([], {}, "posts");
    assert.equal(out.pages, 1);
    assert.deepEqual(out.posts, []);
  });
});

describe("feedPage", () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ id: i + 1 }));
  const queue = Array.from({ length: 3 }, (_, i) => ({ id: 100 + i }));
  const owner = { authenticated: true };

  test("nests pagination the way the public payloads do", () => {
    const out = feedPage(owner, rows, [], { page: 2 }, 6);
    assert.deepEqual(out.posts.map((r) => r.id), [7]);
    assert.deepEqual(out.pagination, {
      page: 2,
      pages: 2,
      per_page: 6,
      total: 7,
      min_page: 1,
      scheduled: false,
    });
  });

  test("min_page opens the feed left of page 1 when a queue exists", () => {
    const out = feedPage(owner, rows, queue, {}, 6);
    assert.equal(out.pagination.min_page, 0);
    assert.equal(out.pagination.scheduled, false);
    // total and pages keep describing the published half, on both sides, so the
    // paginator spans the whole range.
    assert.equal(out.pagination.total, 7);
  });

  test("page 0 serves the queue, and reports which half it came from", () => {
    const out = feedPage(owner, rows, queue, { page: 0 }, 6);
    assert.deepEqual(out.posts.map((r) => r.id), [100, 101, 102]);
    assert.equal(out.pagination.scheduled, true);
    assert.equal(out.pagination.total, 7);
  });

  test("a page past the end of the queue clamps to its last one", () => {
    const out = feedPage(owner, rows, queue, { page: -9 }, 6);
    assert.equal(out.pagination.page, 0);
    assert.equal(out.posts.length, 3);
  });

  test("a timeline scope turns the left half off", () => {
    // An unpublished post has no year to be scoped by, so the queue cannot be
    // in range — offering it would be a page of posts the filter cannot reach.
    const out = feedPage(owner, rows, queue, { year_from: 2020, year_to: 2021 }, 6);
    assert.equal(out.pagination.min_page, 1);
  });
});

describe("nextId", () => {
  test("is one past the highest existing id", () => {
    assert.equal(nextId([{ id: 3 }, { id: 9 }, { id: 5 }]), 10);
  });

  test("starts at 1 for an empty collection", () => {
    assert.equal(nextId([]), 1);
  });
});

describe("toListShape", () => {
  test("derives media_url from the first attached media", () => {
    const out = toListShape({
      id: 1,
      slug: "s",
      title: "T",
      status: "published",
      media: [{ path: "/2024/05/a.jpg" }, { path: "/2024/05/b.jpg" }],
    });
    assert.equal(out.media_url, "/2024/05/a.jpg");
  });

  test("keeps the previous media_url when the detail has no media", () => {
    // An edit that does not touch media must not blank the list thumbnail.
    const out = toListShape(
      { id: 1, slug: "s", title: "T", status: "published" },
      { media_url: "/2024/05/existing.jpg", created_at: "2024-01-01T00:00:00Z" },
    );
    assert.equal(out.media_url, "/2024/05/existing.jpg");
    assert.equal(out.created_at, "2024-01-01T00:00:00Z");
  });

  test("coerces the hidden flags to booleans", () => {
    const out = toListShape({ id: 1, slug: "s", title: "T", status: "draft" });
    assert.equal(out.is_hidden, false);
    assert.equal(out.is_featured, false);
    assert.deepEqual(out.tags, []);
  });
});
