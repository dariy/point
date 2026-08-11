/**
 * Endpoint handlers for the static demo.
 *
 * Each entry is [method, pattern, handler]. Patterns use `:name` segments;
 * handlers receive `{ state, params, query, body }` and return either a plain
 * value (serialised as 200 JSON) or `{ status, body }` for anything else.
 *
 * Ordering matters — the first match wins, so literal-prefixed patterns must
 * precede parameterised siblings (`/api/posts/slug/:slug` before
 * `/api/posts/:id`).
 *
 * Coverage is deliberately partial. The full REST surface is ~110 endpoints;
 * this covers what the UI actually exercises. Everything else falls through to
 * the shim's soft default rather than erroring — see shim.js.
 */

import {
  applyNavMenu,
  byNewest,
  findTheme,
  nextId,
  paginate,
  paginatedPage,
  setAuthenticated,
  storeThemeName,
  storePlugins,
  toListShape,
  visiblePosts,
  withinYears,
} from "./store.js";

// ── Helpers ───────────────────────────────────────────────────────────────

const ok = (body) => ({ status: 200, body });
const noContent = () => ({ status: 204, body: null });
const notFound = (msg = "not found") => ({ status: 404, body: { detail: msg } });

/** Settings rows hold JSON as text; a malformed row degrades to the default. */
function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Links shown inline before "More ▾" — out-of-range or unset means 4. */
function inlineMaxOrDefault(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 4;
}

/** Posts visible to the current principal — admins additionally see drafts. */
function readablePosts(state) {
  return state.authenticated ? state.posts.slice() : visiblePosts(state);
}

function findPost(state, idOrSlug) {
  const id = Number(idOrSlug);
  return state.posts.find((p) =>
    Number.isFinite(id) && id > 0 ? p.id === id : p.slug === idOrSlug,
  );
}

/** Detail payload for a post, synthesising one for posts created in-demo. */
function postDetail(state, post) {
  const recorded = state.postDetail[String(post.id)];
  if (recorded) return { ...recorded, ...post, content: recorded.content, content_html: recorded.content_html };
  return {
    ...post,
    title: post.title || "Untitled",
    content: post.content || "",
    content_html: post.content_html || `<p>${post.excerpt || ""}</p>`,
    css: post.css || "",
    media: post.media || [],
    tags: post.tags || [],
    view_count: 0,
    type: "post",
    updated_at: new Date().toISOString(),
  };
}

/**
 * A tag and every tag beneath it.
 *
 * The tree is a DAG — a city is a child of both its country and the flat `city`
 * index — so a tag is reachable by more than one path; `seen` terminates the
 * walk and keeps each tag visited once.
 */
function tagSubtree(state, tag) {
  const out = [];
  const seen = new Set();
  const walk = (t) => {
    if (!t || seen.has(t.id)) return;
    seen.add(t.id);
    out.push(t);
    for (const ref of t.children || []) {
      walk(state.tags.find((x) => x.id === ref.id));
    }
  };
  walk(tag);
  return out;
}

/**
 * A tag's own slug plus every descendant's.
 *
 * A parent tag page lists everything filed anywhere beneath it: /tags/light
 * shows the posts of morning-light, mist, sky and twilight, not only the posts
 * carrying `light` itself. TagService.GetPostsByTag does the same closure over
 * the real graph, so without this the demo's inner tags each work while every
 * grouping tag above them reads as empty.
 */
function tagSlugClosure(state, tag) {
  return new Set(tagSubtree(state, tag).map((t) => t.slug));
}

/**
 * The slug set a `?tag=` filter selects: the named tag and everything beneath
 * it, or nothing at all when no such tag exists — the recursive CTE in
 * buildPostsQuery (api/internal/repository/queries_posts.go) yields an empty id
 * list for an unknown slug, so an unrecognised filter matches no posts rather
 * than quietly matching all of them.
 */
function tagFilterSlugs(state, slug) {
  const tag = state.tags.find((t) => t.slug === slug);
  return tag ? tagSlugClosure(state, tag) : new Set();
}

/** Whether a post carries any of `slugs`, directly. */
function taggedWithAny(post, slugs) {
  return (post.tags || []).some((t) => slugs.has(t.slug));
}

/** Posts filed under a tag or any of its descendants, newest first. */
function postsForTag(state, slug) {
  const slugs = tagFilterSlugs(state, slug);
  return readablePosts(state)
    .filter((p) => taggedWithAny(p, slugs))
    .sort(byNewest);
}

/**
 * Does a post match a free-text query?
 *
 * The real search is one SQL predicate over the post's title, slug and content
 * plus the names and slugs of its tags (buildPostsQuery,
 * api/internal/repository/queries_posts.go) — which is why searching for a
 * place finds the photographs taken there, not just the posts that happen to
 * name it in their title.
 *
 * Content is the one column with no counterpart here: the recorded list shape
 * carries only the excerpt the cards render, and the bodies live in a separate
 * detail map the list never loads. The excerpt stands in for it, which narrows
 * the demo's matches rather than widening them — everything found is something
 * a visitor can see the reason for on the results grid.
 */
function postMatchesQuery(post, search) {
  const needle = String(search || "").trim().toLowerCase();
  if (!needle) return true;
  const has = (value) => String(value || "").toLowerCase().includes(needle);
  return (
    has(post.title) ||
    has(post.slug) ||
    has(post.excerpt) ||
    (post.tags || []).some((t) => has(t.name) || has(t.slug))
  );
}

/**
 * Rewrite a media URL the way atlasThumbURL (api/internal/api/pages.go) does,
 * so a cloud chip requests the same square thumbnail the recorded graph blob
 * already points at. A static host ignores the query and serves the (already
 * downscaled) original — the demo's documented `?thumb` limitation rather than
 * a new one.
 */
function atlasThumbUrl(url) {
  if (!url) return null;
  if (/^https?:\/\//.test(url)) return url;
  return url.split("?")[0] + "?thumb=128";
}

/**
 * The Atlas cloud for one place: the most recent posts filed anywhere beneath
 * it, the tags those posts most often carry, and the edges wiring the two
 * together — PagesHandler.GetTagCloud (api/internal/api/pages.go).
 *
 * Derived rather than recorded, unlike the graph blob it sits beside. The
 * payload is per place *and* per timeline range, so recording it would mean one
 * fixture per combination — and a place would still answer with a stale cloud
 * after the visitor retagged a post inside the demo. Deriving it keeps every
 * marker on the map clickable, including tags created in the demo itself.
 *
 * Posts are year-scoped and the related tags are not, matching the backend:
 * narrowing the timeline changes which photographs a place offers, not what the
 * place is about.
 */
function atlasCloud(state, tag, query) {
  // atlasCloudLimit, which is also the atlas_post_limit default.
  const LIMIT = 10;

  const inSubtree = new Set(tagSubtree(state, tag).map((t) => t.slug));
  const subtreePosts = readablePosts(state).filter((p) =>
    (p.tags || []).some((t) => inSubtree.has(t.slug)),
  );

  const recent = withinYears(subtreePosts, query).sort(byNewest).slice(0, LIMIT);
  const posts = recent.map((p) => ({
    id: p.id,
    slug: p.slug,
    title: p.title,
    media_url: atlasThumbUrl(p.media_url),
  }));

  // Related tags, ranked by how many of the place's posts carry them and tied
  // on name. The place itself is dropped; its descendants stay, since a
  // country's own cities are what make its cloud read as geography. Counted
  // over every post in the sub-tree, not only the few returned above.
  const counts = new Map();
  for (const p of subtreePosts) {
    for (const t of p.tags || []) {
      if (t.slug === tag.slug || t.slug.startsWith("_")) continue;
      counts.set(t.slug, (counts.get(t.slug) || 0) + 1);
    }
  }
  const bySlug = new Map(state.tags.map((t) => [t.slug, t]));
  const tags = [...counts]
    .map(([slug, count]) => ({ tag: bySlug.get(slug), count }))
    .filter((row) => row.tag)
    .sort((a, b) => b.count - a.count || a.tag.name.localeCompare(b.tag.name))
    .slice(0, LIMIT)
    .map(({ tag: t }) => {
      const node = { id: t.id, name: t.name, slug: t.slug, kind: t.kind };
      // Coordinates are what make a chip render as a place rather than a plain
      // tag (utils/tags.js tagKind).
      const at = (t.locations || [])[0];
      if (at) {
        node.latitude = at.latitude;
        node.longitude = at.longitude;
      }
      return node;
    });

  // Edges only ever join nodes this payload carries, so the cloud wires itself
  // without the caller holding the whole graph. The centre is always wired.
  const wired = new Map(tags.map((t) => [t.slug, t.id]));
  wired.set(tag.slug, tag.id);
  const wiredIds = new Set(wired.values());

  const membershipEdges = [];
  for (const p of recent) {
    for (const t of p.tags || []) {
      if (wired.has(t.slug)) membershipEdges.push({ post: p.id, tag: wired.get(t.slug) });
    }
  }

  const hierarchyEdges = [];
  for (const id of wiredIds) {
    const t = state.tags.find((x) => x.id === id);
    for (const parent of t?.parents || []) {
      if (wiredIds.has(parent.id)) {
        hierarchyEdges.push({ parent: parent.id, child: id });
      }
    }
  }

  return { tags, posts, membershipEdges, hierarchyEdges };
}

/**
 * The tag graph narrowed to a timeline range — PagesHandler.GetTagsGraph with
 * `year_from`/`year_to` (api/internal/api/pages.go).
 *
 * The graph is one of the recorded blobs, but the range can't be: it is a
 * payload per range, and the Atlas redraws its markers from this on every move
 * of the timeline. So the blob supplies the nodes and the store supplies the
 * arithmetic — tags with nothing left in range drop out, the rest carry their
 * in-range count (which is what sizes a marker).
 *
 * Counts roll up the sub-tree, matching GetHierarchicalPostCountsInYearRange:
 * a post is usually tagged with its city and not its country, so counting only
 * direct tags would drop every country shape the moment the timeline narrowed —
 * emptying the Atlas of the very thing it draws.
 */
function scopedGraph(state, query) {
  const graph = state.pages.graph || {};
  const from = Number(query.year_from);
  const to = Number(query.year_to);
  if (!(from > 0 && to > 0 && from <= to)) return graph;

  const inRange = withinYears(readablePosts(state), query);
  const inRangeIds = new Set(inRange.map((p) => p.id));

  const counts = new Map();
  for (const tag of state.tags) {
    const slugs = tagSlugClosure(state, tag);
    const n = inRange.filter((p) =>
      (p.tags || []).some((t) => slugs.has(t.slug)),
    ).length;
    if (n > 0) counts.set(tag.id, n);
  }

  const tags = (graph.tags || [])
    .filter((t) => counts.has(t.id))
    .map((t) => ({ ...t, post_count: counts.get(t.id) }));
  const kept = new Set(tags.map((t) => t.id));

  const scoped = {
    ...graph,
    tags,
    hierarchyEdges: (graph.hierarchyEdges || []).filter(
      (e) => kept.has(e.parent) && kept.has(e.child),
    ),
  };

  // The force-graph's post nodes, when the blob carries them (the Atlas asks
  // for `posts=0` and never sees these). Edges only ever join surviving nodes.
  if (graph.posts) {
    scoped.posts = graph.posts.filter((p) => inRangeIds.has(p.id));
    scoped.membershipEdges = (graph.membershipEdges || []).filter(
      (e) => inRangeIds.has(e.post) && kept.has(e.tag),
    );
  }

  return scoped;
}

/**
 * Walk a tag's ancestry for breadcrumbs.
 *
 * Recorded tags carry `parents[]`, so this follows the first parent up to the
 * root. Guarded against cycles — the tag graph allows multiple parents and a
 * malformed demo edit could otherwise hang the page.
 */
function breadcrumbsFor(state, tag) {
  const chain = [];
  const seen = new Set();
  let current = tag;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const parentRef = (current.parents || [])[0];
    if (!parentRef) break;
    const parent = state.tags.find((t) => t.id === parentRef.id);
    if (!parent) break;
    chain.unshift({ id: parent.id, name: parent.name, slug: parent.slug });
    current = parent;
  }
  return chain;
}

/** `{presets, active}` — the shape of GET /api/plugins/presets. */
function presetsView(state) {
  return { presets: state.pluginPresets, active: state.activePreset };
}

/**
 * Recompute each core plugin's `locked` flag.
 *
 * Mirrors plugins.IsLockedOff: the sole enabled member of a core area may not
 * be disabled, and the Plugins page renders that row read-only. The frontend
 * recomputes this itself after a single toggle, but a preset apply takes the
 * server's word for it — and a page revisit re-reads GET /api/plugins — so the
 * store has to keep the flag true.
 */
function relockPlugins(state) {
  const REQUIRED_SLOT = new Set(["1", "1+"]);
  for (const p of state.plugins) {
    if (!REQUIRED_SLOT.has(p.slot_rule)) continue;
    const enabled = state.plugins.filter((q) => q.slot === p.slot && q.enabled);
    p.locked = !!p.enabled && enabled.length === 1;
  }
}

/**
 * Set every plugin's enabled state from a preset's membership.
 *
 * Mirrors PluginsHandler.ApplyPreset (api/internal/api/plugin_presets.go),
 * including the two corrections it applies to the raw membership list: a core
 * area a preset leaves empty falls back to its default member (Minimalistic
 * names no immersive viewer, yet one has to stay on), and an exclusive area
 * keeps only its first enabled member (Fully featured names all three tag
 * visualizations, but only one can own /tags). Without both, the demo would
 * show states the real backend refuses to produce.
 */
function applyPluginPreset(state, list) {
  const want = new Set(list);
  const REQUIRED_SLOT = new Set(["1", "1+"]);
  const SINGLE_CLAIM_SLOT = new Set(["0-1", "1"]);

  const membersOf = (slot) => state.plugins.filter((p) => p.slot === slot);

  for (const p of state.plugins) {
    if (!REQUIRED_SLOT.has(p.slot_rule) || !p.slot) continue;
    const members = membersOf(p.slot);
    if (members.some((m) => want.has(m.id))) continue;
    want.add((members.find((m) => m.default_enabled) || members[0]).id);
  }

  const seenSlots = new Set();
  for (const p of state.plugins) {
    if (!SINGLE_CLAIM_SLOT.has(p.slot_rule) || !p.slot || seenSlots.has(p.slot)) continue;
    seenSlots.add(p.slot);
    let kept = false;
    for (const m of membersOf(p.slot)) {
      if (!want.has(m.id)) continue;
      if (kept) want.delete(m.id);
      else kept = true;
    }
  }

  for (const p of state.plugins) p.enabled = want.has(p.id);
  relockPlugins(state);
}

// ── Routes ────────────────────────────────────────────────────────────────

export const routes = [
  // ── Bootstrap ───────────────────────────────────────────────────────────

  ["GET", "/api/setup/status", () => ok({ setup_complete: true })],

  ["GET", "/api/settings/public", ({ state }) => ok(state.publicSettings)],

  [
    "GET",
    "/api/auth/me",
    ({ state }) =>
      state.authenticated
        ? ok(state.user)
        : // client.js exempts /api/auth/me from the global api:unauthorized
          // event, so a 401 here is the honest answer and costs nothing.
          { status: 401, body: { detail: "authentication required" } },
  ],

  [
    "GET",
    "/api/system/version",
    () => ok({ current: "demo", latest: "demo", update_available: false }),
  ],

  // ── Auth ────────────────────────────────────────────────────────────────

  [
    "POST",
    "/api/auth/login",
    ({ state }) => {
      // Any password is accepted: there is no credential to protect, and a
      // visitor who mistypes the hint should still get into the demo.
      state.authenticated = true;
      setAuthenticated(true);
      return ok({ user: state.user, message: "ok" });
    },
  ],

  [
    "POST",
    "/api/auth/logout",
    ({ state }) => {
      state.authenticated = false;
      setAuthenticated(false);
      return noContent();
    },
  ],

  [
    "GET",
    "/api/auth/sessions",
    () =>
      ok({
        sessions: [
          {
            id: 1,
            // TEST-NET-3 (RFC 5737) — a documentation address, so the Security
            // page shows a plausible session without inventing a real one.
            ip_address: "203.0.113.10",
            user_agent: navigator.userAgent,
            location: "Demo",
            created_at: new Date().toISOString(),
            last_activity: new Date().toISOString(),
            current: true,
          },
        ],
        total: 1,
      }),
  ],

  ["GET", "/api/auth/webauthn/status", () => ok({ enabled: false, credentials: [] })],
  ["GET", "/api/auth/api-keys", () => ok({ api_keys: [], total: 0 })],

  // ── Public page payloads ────────────────────────────────────────────────
  //
  // `menu`, `settings` and `tag_cloud` come from the recording; `posts` and
  // `pagination` are computed so posts created or unpublished inside the demo
  // show up on the public site the way they really would.

  [
    "GET",
    "/api/pages/home",
    ({ state, query }) => {
      const perPage = Number(state.publicSettings?.posts_per_page) || 6;
      const rows = readablePosts(state).sort(byNewest);
      return ok({
        ...state.pages.home,
        ...paginatedPage(rows, query, perPage),
      });
    },
  ],

  ["GET", "/api/pages/tags", ({ state }) => ok(state.pages.tags)],
  ["GET", "/api/pages/graph", ({ state, query }) => ok(scopedGraph(state, query))],
  [
    "GET",
    "/api/pages/graph/tag/:id",
    ({ state, params, query }) => {
      const tag = state.tags.find((t) => t.id === Number(params.id));
      // A real 404 rather than the soft empty 200: the Atlas catches the
      // rejection and leaves the place unselected, where an empty body would
      // spawn a cloud of nothing around it.
      if (!tag) return notFound("tag not found");
      return ok(atlasCloud(state, tag, query));
    },
  ],
  ["GET", "/api/pages/map", ({ state }) => ok(state.pages.map ?? { locations: [] })],
  // `menu` is the header's tree and `tags` the site-title dropdown's; api/nav.js
  // falls back to `menu` when `tags` is absent, which is what the server sends
  // in the default "tags" mode. The empty fallback has to use the same key —
  // `{items: []}` would leave navTags undefined and refetch on every mount.
  ["GET", "/api/pages/nav", ({ state }) => ok(state.pages.nav ?? { menu: [] })],

  // Admin menu editor (/light/menu). Mirrors NavMenuHandler in
  // api/internal/api/nav_menu.go: the config lives in settings rows, and
  // `tag_items` is the tags-mode tree so the editor can preview a mode switch
  // before saving. Handled rather than left to the shim's empty-200 default so
  // a visitor can actually re-author the menu and watch the header follow.
  [
    "GET",
    "/api/nav-menu",
    ({ state }) => {
      const s = state.settings;
      return ok({
        mode: s.nav_menu_mode || "tags",
        items: parseJson(s.custom_nav_menu, []),
        custom_markdown: s.custom_markdown || "",
        inline_max: inlineMaxOrDefault(s.nav_inline_max),
        more_title: s.nav_more_title || "More",
        tag_items: state.navTagTree,
      });
    },
  ],
  [
    "PUT",
    "/api/nav-menu",
    ({ state, body }) => {
      const mode = ["tags", "custom", "none"].includes(body.mode) ? body.mode : "tags";
      const items = Array.isArray(body.items) ? body.items : [];
      applyNavMenu(state, { mode, items, markdown: body.custom_markdown || "" });

      if (body.inline_max >= 1 && body.inline_max <= 10) {
        state.settings.nav_inline_max = String(body.inline_max);
      }
      state.settings.nav_more_title = body.more_title || "More";

      return ok({
        mode,
        items,
        custom_markdown: state.settings.custom_markdown,
        inline_max: inlineMaxOrDefault(state.settings.nav_inline_max),
        more_title: state.settings.nav_more_title,
      });
    },
  ],

  [
    "GET",
    "/api/pages/tags/:slug",
    ({ state, params, query }) => {
      const tag = state.tags.find((t) => t.slug === params.slug);
      if (!tag) return notFound("tag not found");
      const perPage = Number(state.publicSettings?.posts_per_page) || 6;
      const rows = postsForTag(state, params.slug);
      return ok({
        tag,
        menu: state.pages.home?.menu ?? [],
        breadcrumbs: breadcrumbsFor(state, tag),
        nav_children: (tag.children || []).map((c) => ({
          id: c.id,
          name: c.name,
          slug: c.slug,
        })),
        ...paginatedPage(rows, query, perPage),
      });
    },
  ],

  // ── Timeline ────────────────────────────────────────────────────────────

  ["GET", "/api/timeline", ({ state }) => ok(state.timeline)],
  [
    "GET",
    "/api/timeline/locations",
    ({ state, query }) => ok(state.timelineLocations[query.tag] ?? []),
  ],

  // ── Posts ───────────────────────────────────────────────────────────────

  ["GET", "/api/posts/analytics", ({ state }) => ok(state.analytics)],

  [
    "GET",
    "/api/posts/slug/:slug",
    ({ state, params }) => {
      const post = state.posts.find((p) => p.slug === params.slug);
      return post ? ok(postDetail(state, post)) : notFound("post not found");
    },
  ],

  [
    // Which page of the home listing a given post falls on — used to send a
    // visitor back to the right page after opening a post. Returns position,
    // not content.
    "GET",
    "/api/posts/:slug/page",
    ({ state, params }) => {
      const perPage = Number(state.publicSettings?.posts_per_page) || 6;
      const rows = readablePosts(state).sort(byNewest);
      const idx = rows.findIndex((p) => p.slug === params.slug);
      if (idx === -1) return notFound("post not found");
      return ok({ page: Math.floor(idx / perPage) + 1, per_page: perPage });
    },
  ],

  [
    "GET",
    "/api/posts/:id/navigation",
    ({ state, params }) => ok(state.postNavigation[params.id] ?? {}),
  ],

  [
    // What the admin editor loads a post with (PostEditPage → api/posts.js
    // getPost). Missing, it fell to the soft empty 200 and the edit form opened
    // with every field blank — a post that reads fine on the public site and
    // has no title, slug or excerpt the moment you edit it.
    //
    // Registered after `/api/posts/analytics`: matching is first-hit in table
    // order, and this pattern would otherwise swallow that literal path.
    "GET",
    "/api/posts/:id",
    ({ state, params }) => {
      const post = findPost(state, params.id);
      // A logged-out visitor gets a 404 for drafts and hidden posts, the way
      // PostHandler.GetPostByID does — readablePosts holds the same references.
      if (!post || !readablePosts(state).includes(post)) {
        return notFound("post not found");
      }
      return ok(postDetail(state, post));
    },
  ],

  [
    "GET",
    "/api/posts",
    ({ state, query }) => {
      let rows = readablePosts(state);
      // "all" is the admin's explicit "don't filter" (PostHandler.ListPosts),
      // not a status any post carries.
      if (query.status && query.status !== "all") {
        rows = rows.filter((p) => p.status === query.status);
      }
      if (query.tag) {
        const slugs = tagFilterSlugs(state, query.tag);
        rows = rows.filter((p) => taggedWithAny(p, slugs));
      }
      // `q` is what every caller sends — the search page, the header typeahead,
      // the admin list and the command palette all name it that.
      if (query.q) rows = rows.filter((p) => postMatchesQuery(p, query.q));
      rows = rows.sort(byNewest);
      // A caller that sends no per_page gets the site's own page size, which is
      // what PostHandler.ListPosts falls back to. The header typeahead is that
      // caller (it asks for `limit`, which the real endpoint ignores too), so
      // the generic 20 made the demo's dropdown twice the length of a real
      // one's.
      const perPage = Number(state.settings?.posts_per_page) || 10;
      return ok(paginate(rows, query, "posts", perPage));
    },
  ],

  [
    "POST",
    "/api/posts",
    ({ state, body }) => {
      const id = nextId(state.posts);
      const now = new Date().toISOString();
      const detail = {
        ...body,
        id,
        slug: body.slug || `demo-post-${id}`,
        title: body.title || "Untitled",
        status: body.status || "draft",
        created_at: now,
        published_at: body.status === "published" ? now : null,
        tags: body.tags || [],
        media: [],
      };
      state.postDetail[String(id)] = detail;
      state.posts.unshift(toListShape(detail));
      return { status: 201, body: detail };
    },
  ],

  [
    "PUT",
    "/api/posts/:id",
    ({ state, params, body }) => {
      const post = findPost(state, params.id);
      if (!post) return notFound("post not found");
      const merged = { ...postDetail(state, post), ...body, id: post.id };
      state.postDetail[String(post.id)] = merged;
      Object.assign(post, toListShape(merged, post));
      return ok(merged);
    },
  ],

  [
    "PATCH",
    "/api/posts/:id/status",
    ({ state, params, body }) => {
      const post = findPost(state, params.id);
      if (!post) return notFound("post not found");
      post.status = body.status;
      if (body.status === "published" && !post.published_at) {
        post.published_at = new Date().toISOString();
      }
      const detail = state.postDetail[String(post.id)];
      if (detail) Object.assign(detail, { status: post.status, published_at: post.published_at });
      return ok(post);
    },
  ],

  [
    "PATCH",
    "/api/posts/:id/tags",
    ({ state, params, body }) => {
      const post = findPost(state, params.id);
      if (!post) return notFound("post not found");
      const ids = body.tag_ids || body.tags || [];
      post.tags = ids
        .map((id) => state.tags.find((t) => t.id === id || t.slug === id))
        .filter(Boolean)
        .map((t) => ({ name: t.name, slug: t.slug, kind: t.kind, is_hidden_posts: false }));
      const detail = state.postDetail[String(post.id)];
      if (detail) detail.tags = post.tags;
      return ok(post);
    },
  ],

  [
    "DELETE",
    "/api/posts/:id",
    ({ state, params }) => {
      const post = findPost(state, params.id);
      if (!post) return notFound("post not found");
      post.status = "trashed";
      return noContent();
    },
  ],

  [
    "POST",
    "/api/posts/:id/restore",
    ({ state, params }) => {
      const post = findPost(state, params.id);
      if (!post) return notFound("post not found");
      post.status = "draft";
      return ok(post);
    },
  ],

  [
    "DELETE",
    "/api/posts/:id/permanent",
    ({ state, params }) => {
      const idx = state.posts.findIndex((p) => p.id === Number(params.id));
      if (idx === -1) return notFound("post not found");
      state.posts.splice(idx, 1);
      delete state.postDetail[params.id];
      return noContent();
    },
  ],

  [
    "POST",
    "/api/posts/preview-render",
    ({ body }) => ok({ html: renderMarkdown(body?.content ?? "") }),
  ],

  // ── Tags ────────────────────────────────────────────────────────────────

  ["GET", "/api/tags/cloud", ({ state }) => ok(state.tagCloud)],

  [
    "GET",
    "/api/tags/slug/:slug",
    ({ state, params }) => {
      const tag = state.tags.find((t) => t.slug === params.slug);
      return tag ? ok(tag) : notFound("tag not found");
    },
  ],

  [
    "GET",
    "/api/tags/:id",
    ({ state, params }) => {
      const tag = state.tags.find((t) => t.id === Number(params.id));
      return tag ? ok(tag) : notFound("tag not found");
    },
  ],

  [
    "GET",
    "/api/tags",
    ({ state, query }) => {
      let rows = state.tags.slice();
      if (query.q) {
        // Name *and* slug, like TagHandler.ListTags: "reykjavik" has to find
        // Reykjavík, which is exactly the query a visitor without the accent
        // available types.
        const q = String(query.q).trim().toLowerCase();
        rows = rows.filter(
          (t) =>
            (t.name || "").toLowerCase().includes(q) ||
            (t.slug || "").toLowerCase().includes(q),
        );
      }
      // A logged-out visitor never sees a hidden tag; `include_empty=false` (the
      // search page and the header typeahead, which offer tags as links) drops
      // the ones that would lead to an empty page.
      if (!state.authenticated) rows = rows.filter((t) => !t.effective_hidden);
      if (query.include_empty === "false") rows = rows.filter((t) => t.post_count > 0);
      // The real endpoint returns the full set; the admin page paginates client
      // side. Matching that keeps the tag manager's counts honest.
      return ok({ tags: rows, total: rows.length });
    },
  ],

  [
    "POST",
    "/api/tags",
    ({ state, body }) => {
      const id = nextId(state.tags);
      const tag = {
        id,
        name: body.name || "new-tag",
        slug: body.slug || String(body.name || `tag-${id}`).toLowerCase().replace(/\s+/g, "-"),
        kind: body.kind || "tag",
        description: body.description ?? null,
        post_count: 0,
        parents: [],
        children: [],
        locations: [],
        hidden: false,
        hides_posts: false,
        effective_hidden: false,
        effective_hides_posts: false,
        in_breadcrumbs: true,
        in_ancestor_flyout: true,
        created_at: new Date().toISOString(),
      };
      state.tags.push(tag);
      return { status: 201, body: tag };
    },
  ],

  [
    "PUT",
    "/api/tags/:id",
    ({ state, params, body }) => {
      const tag = state.tags.find((t) => t.id === Number(params.id));
      if (!tag) return notFound("tag not found");
      Object.assign(tag, body);
      return ok(tag);
    },
  ],

  [
    "PATCH",
    "/api/tags/:id",
    ({ state, params, body }) => {
      const tag = state.tags.find((t) => t.id === Number(params.id));
      if (!tag) return notFound("tag not found");
      Object.assign(tag, body);
      return ok(tag);
    },
  ],

  [
    "DELETE",
    "/api/tags/:id",
    ({ state, params }) => {
      const idx = state.tags.findIndex((t) => t.id === Number(params.id));
      if (idx === -1) return notFound("tag not found");
      state.tags.splice(idx, 1);
      return noContent();
    },
  ],

  // ── Media ───────────────────────────────────────────────────────────────

  ["GET", "/api/media/stats", ({ state }) => ok(state.mediaStats)],
  ["GET", "/api/media/folders", ({ state }) => ok(state.mediaFolders)],
  ["GET", "/api/media/orphaned", () => ok({ media: [], total: 0 })],

  [
    "GET",
    "/api/media/:id",
    ({ state, params }) => {
      const m = state.media.find((x) => x.id === Number(params.id));
      return m ? ok(m) : notFound("media not found");
    },
  ],

  [
    "GET",
    "/api/media",
    ({ state, query }) => {
      let rows = state.media.slice();
      if (query.search) {
        const q = query.search.toLowerCase();
        rows = rows.filter((m) => (m.filename || "").toLowerCase().includes(q));
      }
      if (query.file_type) rows = rows.filter((m) => m.file_type === query.file_type);
      return ok(paginate(rows, query, "media", 50));
    },
  ],

  [
    "PATCH",
    "/api/media/:id",
    ({ state, params, body }) => {
      const m = state.media.find((x) => x.id === Number(params.id));
      if (!m) return notFound("media not found");
      Object.assign(m, body);
      return ok(m);
    },
  ],

  [
    "DELETE",
    "/api/media/:id",
    ({ state, params }) => {
      const idx = state.media.findIndex((x) => x.id === Number(params.id));
      if (idx === -1) return notFound("media not found");
      state.media.splice(idx, 1);
      return noContent();
    },
  ],

  // ── Settings, themes, plugins ───────────────────────────────────────────

  ["GET", "/api/settings", ({ state }) => ok(state.settings)],

  [
    "PUT",
    "/api/settings",
    ({ state, body }) => {
      Object.assign(state.settings, body);
      // Public settings are a projection of the same table, so keep the keys
      // the public site reads in step — otherwise changing the blog title in
      // the admin leaves the public header stale.
      for (const key of Object.keys(state.publicSettings)) {
        if (key in body) state.publicSettings[key] = body[key];
      }
      return ok(state.settings);
    },
  ],
  ["PATCH", "/api/settings", ({ state, body }) => {
    Object.assign(state.settings, body);
    return ok(state.settings);
  }],

  ["GET", "/api/themes/active", ({ state }) => ok(state.activeTheme)],
  ["GET", "/api/themes/custom-css", ({ state }) => ok(state.customCss)],
  ["GET", "/api/themes", ({ state }) => ok(state.themes)],

  [
    "PUT",
    "/api/themes/active",
    ({ state, body }) => {
      // Resolve against the catalogue rather than renaming the previous entry:
      // the response carries the theme's own description and swatch colours,
      // which the Themes page shows next to the highlight it just moved.
      const theme = findTheme(state.themes, body.name);
      if (!theme) return notFound("theme not found");

      state.activeTheme = { ...theme };
      state.settings.active_css_theme = theme.name;
      state.publicSettings.active_css_theme = theme.name;
      // Outlive this document: shim.js composes theme.css from the store, and
      // the store is re-seeded by every full page load — including the walk
      // from /light back out to the public site.
      storeThemeName(theme.name);
      return ok(state.activeTheme);
    },
  ],

  [
    "PUT",
    "/api/themes/custom-css",
    ({ state, body }) => {
      state.customCss = { css: body.css ?? "" };
      return ok(state.customCss);
    },
  ],

  ["GET", "/api/plugins", ({ state }) => ok(state.plugins)],
  ["GET", "/api/plugins/presets", ({ state }) => ok(presetsView(state))],

  // Preset membership editing. Unknown plugin ids are dropped rather than
  // rejected: the Plugins page only ever sends ids it just rendered.
  [
    "PUT",
    "/api/plugins/presets/:id",
    ({ state, params, body }) => {
      if (!state.pluginPresets[params.id]) return notFound("unknown preset");
      const known = new Set(state.plugins.map((p) => p.id));
      const wanted = Array.isArray(body?.plugins) ? body.plugins : [];
      state.pluginPresets[params.id] = [...new Set(wanted)].filter((id) => known.has(id));
      return ok(presetsView(state));
    },
  ],

  // Applying returns the whole catalog, which is what makes the site map, the
  // group cards and the toggles below re-render together in one round-trip.
  [
    "POST",
    "/api/plugins/presets/:id/apply",
    ({ state, params }) => {
      const list = state.pluginPresets[params.id];
      if (!list) return notFound("unknown preset");
      applyPluginPreset(state, list);
      state.activePreset = params.id;
      storePlugins(state.plugins);
      return ok(state.plugins);
    },
  ],

  [
    "PATCH",
    "/api/plugins/:id",
    ({ state, params, body }) => {
      const plugin = state.plugins.find((p) => p.id === params.id);
      if (!plugin) return notFound("plugin not found");
      plugin.enabled = !!body.enabled;
      // Single-claim slots allow only one member enabled at a time —
      // mirroring that here keeps the Plugins page's radio behaviour honest.
      if (plugin.enabled && plugin.slot_rule && (plugin.slot_rule === "0-1" || plugin.slot_rule === "1") && plugin.slot) {
        for (const other of state.plugins) {
          if (other !== plugin && other.slot === plugin.slot) other.enabled = false;
        }
      }
      relockPlugins(state);
      // An individual toggle diverges from whatever preset was applied — the
      // backend rewrites plugins.active_preset to "custom" for the same reason.
      state.activePreset = "custom";
      storePlugins(state.plugins);
      return ok(plugin);
    },
  ],

  // ── System ──────────────────────────────────────────────────────────────

  ["GET", "/api/system/stats", ({ state }) => ok(state.system.stats ?? {})],
  ["GET", "/api/system/health", ({ state }) => ok(state.system.health ?? {})],
  ["GET", "/api/system/disk", ({ state }) => ok(state.system.disk ?? {})],
  ["GET", "/api/system/migrations", ({ state }) => ok(state.system.migrations ?? [])],
  ["GET", "/api/system/backups", () => ok({ backups: [], total: 0 })],
  ["GET", "/api/system/audit/post-links", () => ok({ issues: [], checked: 0 })],
  ["GET", "/api/system/offline/stats", () => ok({ posts: 0, media: 0, bytes: 0 })],
  [
    "GET",
    "/api/system/logs",
    () =>
      ok({
        lines: [
          "This is a static demo — there is no server, so no live log to tail.",
        ],
      }),
  ],
  [
    "GET",
    "/api/system/photo-library",
    () => ok({ configured: false, files: [], total: 0 }),
  ],

  // ── Instagram ───────────────────────────────────────────────────────────

  ["GET", "/api/instagram/status", () => ok({ connected: false })],
  ["GET", "/api/instagram/import/status", () => ok({ running: false })],

  // ── Utilities ───────────────────────────────────────────────────────────

  ["GET", "/api/util/parse-maps-coords", () => ok({ latitude: null, longitude: null })],
];

/**
 * Minimal Markdown → HTML for the editor's live preview.
 *
 * Deliberately small: it exists so typing in the editor visibly renders, not to
 * reproduce the server's full pipeline. Recorded posts already carry real
 * `content_html` from the backend, so this only ever runs on text a visitor
 * typed themselves.
 */
function renderMarkdown(src) {
  const escape = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return escape(src)
    .replace(/^###### (.*)$/gm, "<h6>$1</h6>")
    .replace(/^##### (.*)$/gm, "<h5>$1</h5>")
    .replace(/^#### (.*)$/gm, "<h4>$1</h4>")
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/^&gt; (.*)$/gm, "<blockquote>$1</blockquote>")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .split(/\n{2,}/)
    .map((block) =>
      /^\s*<(h\d|blockquote|img|ul|ol|pre)/.test(block)
        ? block
        : `<p>${block.replace(/\n/g, "<br>")}</p>`,
    )
    .join("\n");
}
