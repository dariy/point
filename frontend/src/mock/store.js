/**
 * In-memory data model for the static demo.
 *
 * Seeded from recorded fixtures (scripts/record-demo-fixtures.mjs) and mutated
 * in place, so create/edit/delete in the demo actually change what the rest of
 * the UI shows. Nothing is persisted: a reload re-seeds from the fixture and the
 * demo is pristine again. That is the whole reset story — there is no server to
 * roll back.
 *
 * Entities (posts/tags/media/settings) live here as mutable collections.
 * Genuinely derived views — the tag graph, the atlas — stay as recorded blobs;
 * recomputing them in the browser would be a second implementation of real
 * backend work that no demo visitor would notice.
 */

let fixtures = null;
let state = null;

/**
 * Whether the visitor has "logged in".
 *
 * Kept in sessionStorage because the store itself is module state that dies on
 * every full page load — and the admin UI does hard navigations (app.js sends
 * any login-required signal through window.location.assign). Without this, a
 * visitor who logs in and then reloads, deep-links, or follows one of those
 * navigations is bounced straight back to the login page.
 *
 * sessionStorage rather than localStorage so the session ends with the tab,
 * matching the banner's promise that nothing outlives it.
 */
const AUTH_KEY = "demo-authenticated";

export function isAuthenticated() {
  try {
    return sessionStorage.getItem(AUTH_KEY) === "1";
  } catch {
    return false;
  }
}

export function setAuthenticated(value) {
  try {
    if (value) sessionStorage.setItem(AUTH_KEY, "1");
    else sessionStorage.removeItem(AUTH_KEY);
  } catch {
    /* private browsing — auth just won't survive a reload */
  }
}

/** Structured-clone the seed so mutations never touch the imported module. */
function seed(fx) {
  return {
    settings: { ...fx.settings },
    publicSettings: { ...fx.publicSettings },
    user: fx.user ? { ...fx.user } : null,
    // Fresh tabs start logged out, so visitors meet the public site first and
    // logging in is a real step rather than a detail they skip past.
    authenticated: isAuthenticated(),
    posts: structuredClone(fx.posts || []),
    postDetail: structuredClone(fx.postDetail || {}),
    postNavigation: structuredClone(fx.postNavigation || {}),
    tags: structuredClone(fx.tags || []),
    media: structuredClone(fx.media || []),
    plugins: structuredClone(fx.plugins || []),
    themes: structuredClone(fx.themes || []),
    activeTheme: structuredClone(fx.activeTheme || null),
    customCss: structuredClone(fx.customCss || { css: "" }),
    pages: structuredClone(fx.pages || {}),
    timeline: structuredClone(fx.timeline || {}),
    timelineLocations: structuredClone(fx.timelineLocations || {}),
    tagCloud: structuredClone(fx.tagCloud || []),
    analytics: structuredClone(fx.analytics || {}),
    mediaStats: structuredClone(fx.mediaStats || {}),
    mediaFolders: structuredClone(fx.mediaFolders || []),
    system: structuredClone(fx.system || {}),
  };
}

/**
 * Load fixtures on first use.
 *
 * Dynamically imported so esbuild emits the fixture JSON as its own chunk
 * instead of inlining ~750KB into app.js — the shell paints while it loads.
 */
export async function getState() {
  if (state) return state;
  if (!fixtures) {
    const mod = await import("./fixtures/fixtures.json");
    fixtures = mod.default || mod;
  }
  state = seed(fixtures);
  return state;
}

/** Re-seed from the fixture. Backs the demo's "reset" control. */
export async function resetState() {
  state = null;
  setAuthenticated(false);
  return getState();
}

// ── Helpers ───────────────────────────────────────────────────────────────

export function nextId(collection) {
  return collection.reduce((max, row) => Math.max(max, row.id || 0), 0) + 1;
}

/** Posts a logged-out visitor may see. */
export function visiblePosts(s) {
  return s.posts.filter(
    (p) => p.status === "published" && !p.is_hidden && !p.is_hidden_by_tag,
  );
}

/**
 * Sort newest-first by publish date, falling back to creation date.
 *
 * Some posts carry a null published_at (the engine's standalone "about" page,
 * for one), so an unguarded Date parse yields NaN and scrambles the order.
 */
export function byNewest(a, b) {
  const at = Date.parse(a.published_at || a.created_at || 0) || 0;
  const bt = Date.parse(b.published_at || b.created_at || 0) || 0;
  return bt - at;
}

/** `{page, pages, per_page, <key>}` — the shape of the admin list endpoints. */
export function paginate(rows, query, key, defaultPerPage = 20) {
  const perPage = Number(query.per_page) || defaultPerPage;
  const page = Number(query.page) || 1;
  const start = (page - 1) * perPage;
  return {
    page,
    pages: Math.max(1, Math.ceil(rows.length / perPage)),
    per_page: perPage,
    total: rows.length,
    [key]: rows.slice(start, start + perPage),
  };
}

/** `{posts, pagination:{...}}` — the shape the public page payloads use. */
export function paginatedPage(rows, query, perPageDefault) {
  const perPage = Number(query.per_page) || perPageDefault;
  const page = Number(query.page) || 1;
  const start = (page - 1) * perPage;
  return {
    posts: rows.slice(start, start + perPage),
    pagination: {
      page,
      pages: Math.max(1, Math.ceil(rows.length / perPage)),
      per_page: perPage,
      total: rows.length,
    },
  };
}

/**
 * Project a detail-shaped post back onto the list shape.
 *
 * The list and detail endpoints return different fields (list carries
 * `media_url`, detail carries `media[]` and `content`), so a post created or
 * edited in the demo has to be written back to both stores or it appears
 * correct on one screen and broken on the next.
 */
export function toListShape(detail, previous = {}) {
  return {
    ...previous,
    id: detail.id,
    slug: detail.slug,
    title: detail.title,
    excerpt: detail.excerpt ?? previous.excerpt ?? "",
    status: detail.status,
    formatter: detail.formatter ?? "markdown",
    published_at: detail.published_at ?? null,
    scheduled_at: detail.scheduled_at ?? null,
    created_at: detail.created_at ?? previous.created_at ?? new Date().toISOString(),
    is_featured: !!detail.is_featured,
    is_hidden: !!detail.is_hidden,
    is_hidden_by_tag: !!detail.is_hidden_by_tag,
    immersive_mode: detail.immersive_mode ?? "",
    meta_description: detail.meta_description ?? null,
    media_url:
      detail.media?.[0]?.path ?? detail.thumbnail_path ?? previous.media_url ?? null,
    tags: detail.tags ?? previous.tags ?? [],
  };
}
