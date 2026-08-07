import { test, describe } from "node:test";
import assert from "node:assert";

import {
  byNewest,
  nextId,
  paginate,
  paginatedPage,
  toListShape,
  visiblePosts,
} from "../../demo/mock/store.js";

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

describe("visiblePosts", () => {
  test("hides drafts and both flavours of hidden", () => {
    const state = {
      posts: [
        { id: 1, status: "published" },
        { id: 2, status: "draft" },
        { id: 3, status: "published", is_hidden: true },
        { id: 4, status: "published", is_hidden_by_tag: true },
        { id: 5, status: "trashed" },
      ],
    };
    assert.deepEqual(visiblePosts(state).map((p) => p.id), [1]);
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

describe("paginatedPage", () => {
  test("nests pagination the way the public payloads do", () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ id: i + 1 }));
    const out = paginatedPage(rows, { page: 2 }, 6);
    assert.deepEqual(out.posts.map((r) => r.id), [7]);
    assert.deepEqual(out.pagination, { page: 2, pages: 2, per_page: 6, total: 7 });
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
