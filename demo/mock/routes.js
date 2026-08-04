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
  byNewest,
  nextId,
  paginate,
  paginatedPage,
  setAuthenticated,
  toListShape,
  visiblePosts,
} from "./store.js";

// ── Helpers ───────────────────────────────────────────────────────────────

const ok = (body) => ({ status: 200, body });
const noContent = () => ({ status: 204, body: null });
const notFound = (msg = "not found") => ({ status: 404, body: { detail: msg } });

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

/** Tags carrying a given post, by slug match against the post's tag list. */
function postsForTag(state, slug) {
  return readablePosts(state)
    .filter((p) => (p.tags || []).some((t) => t.slug === slug))
    .sort(byNewest);
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
  ["GET", "/api/pages/graph", ({ state }) => ok(state.pages.graph)],
  ["GET", "/api/pages/map", ({ state }) => ok(state.pages.map ?? { locations: [] })],
  ["GET", "/api/pages/nav", ({ state }) => ok(state.pages.nav ?? { items: [] })],

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
    "GET",
    "/api/posts",
    ({ state, query }) => {
      let rows = readablePosts(state);
      if (query.status) rows = rows.filter((p) => p.status === query.status);
      if (query.search) {
        const q = query.search.toLowerCase();
        rows = rows.filter(
          (p) =>
            (p.title || "").toLowerCase().includes(q) ||
            (p.excerpt || "").toLowerCase().includes(q),
        );
      }
      rows = rows.sort(byNewest);
      return ok(paginate(rows, query, "posts"));
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
      if (query.search) {
        const q = query.search.toLowerCase();
        rows = rows.filter((t) => (t.name || "").toLowerCase().includes(q));
      }
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
      state.activeTheme = { ...(state.activeTheme || {}), name: body.name };
      state.settings.active_css_theme = body.name;
      state.publicSettings.active_css_theme = body.name;
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
  ["GET", "/api/plugins/presets", () => ok([])],

  [
    "PATCH",
    "/api/plugins/:id",
    ({ state, params, body }) => {
      const plugin = state.plugins.find((p) => p.id === params.id);
      if (!plugin) return notFound("plugin not found");
      plugin.enabled = !!body.enabled;
      // Exclusive areas (tags-viz) allow only one member enabled at a time —
      // mirroring that here keeps the Plugins page's radio behaviour honest.
      if (plugin.enabled && plugin.exclusive && plugin.area) {
        for (const other of state.plugins) {
          if (other !== plugin && other.area === plugin.area) other.enabled = false;
        }
      }
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
