/**
 * In-memory data model for the static demo.
 *
 * Seeded from recorded fixtures (demo/scripts/record-fixtures.mjs) and mutated
 * in place, so create/edit/delete in the demo actually change what the rest of
 * the UI shows. A reload re-seeds from the fixture and the demo is pristine
 * again. That is the whole reset story — there is no server to roll back.
 *
 * Two things are held in sessionStorage across that reload rather than being
 * re-seeded, because both are site-wide state that a page load would otherwise
 * silently undo: whether the visitor is logged in, and which theme they
 * activated. Both end with the tab, and the reset control clears them.
 *
 * The theme catalogue is the one collection that does not come from the fixture
 * at all: the backend derives it from the theme files on every request, so the
 * demo reads the build's equivalent (demo/scripts/build-themes.mjs) instead of
 * a recording that would freeze the list.
 *
 * Entities (posts/tags/media/settings) live here as mutable collections.
 * Genuinely derived views — the tag graph, the timeline — stay as recorded
 * blobs; recomputing them in the browser would be a second implementation of
 * real backend work that no demo visitor would notice. The Atlas's per-place
 * cloud is the exception and is computed (routes.js atlasCloud): it is one
 * payload per place *and* per timeline range, so there is no single blob to
 * record.
 */

import { applyDemoSettings, applyDemoSettingsDeep } from "../settings.mjs";

let fixtures = null;
let themeCatalog = null;
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

/**
 * The theme the visitor activated, kept for the same reason as the auth flag.
 *
 * On a real deployment the active theme is a stored setting the server applies
 * to every response, admin and public alike. Here it is store state, and the
 * store dies on every full page load — so activating a theme in /light and then
 * going to look at the public site (a hard navigation from the admin, or simply
 * a reload) repainted it back to the recorded default, which reads as the theme
 * switch having applied to the admin only.
 *
 * sessionStorage, like the auth flag: a theme the visitor picked lasts as long
 * as the tab and no longer, so the demo is still pristine for the next one and
 * the banner's reset control still returns to the recorded state.
 */
const THEME_KEY = "demo-active-theme";

export function storedThemeName() {
  try {
    return sessionStorage.getItem(THEME_KEY) || null;
  } catch {
    return null;
  }
}

export function storeThemeName(name) {
  try {
    if (name) sessionStorage.setItem(THEME_KEY, name);
    else sessionStorage.removeItem(THEME_KEY);
  } catch {
    /* private browsing — the theme just won't survive a reload */
  }
}

/**
 * Seed plugin presets, mirroring plugins.DefaultPresets()
 * (api/internal/plugins/registry.go), which the real backend derives from its
 * registry the first time the Plugins page is opened. Deriving them from the
 * recorded catalog rather than hardcoding ids keeps "Fully featured" honest
 * when the fixture is re-recorded against a registry that grew a plugin.
 *
 * Core areas are re-filled by the apply logic whatever the membership says, so
 * a preset only has to enumerate the rest.
 */
function defaultPresets(plugins) {
  const all = plugins.map((p) => p.id);
  const advanced = new Set(["ai-analysis", "instagram", "immersive-sheet"]);
  return {
    minimalistic: ["immersive-sheet"],
    standalone: all.filter((id) => !advanced.has(id)),
    "fully-featured": all,
  };
}

/**
 * The demo runs the nav-menu plugin in "custom" mode rather than the recorded
 * "tags" tree: four authored links into the demo's own tags. It puts the
 * feature in front of a visitor who would otherwise have to go and configure
 * it to know it exists, and pins the header to a known set of links instead of
 * whatever shape the tag universe happens to have after a re-record.
 *
 * The tag tree is not lost — in custom mode the backend sends it separately for
 * the site-title dropdown (GetNavMenu in api/internal/api/pages.go), which
 * applyNavMenu below mirrors.
 */
const DEMO_NAV_LINKS = [
  { name: "Portugal", url: "/tags/portugal" },
  { name: "Reykjavík", url: "/tags/reykjavik" },
  { name: "2024", url: "/tags/2024" },
  { name: "Light", url: "/tags/light" },
];

/** `{name,url}` → the NavTagNode shape the nav endpoints speak. */
function navNodes(links) {
  return links.map(({ name, url }) => ({ name, url, children: [] }));
}

/** `{name,url}` → the `- [Label](url)` source the menu editor round-trips. */
export function navMarkdown(links) {
  return links.map(({ name, url }) => `- [${name}](${url})`).join("\n");
}

/**
 * Write a nav menu configuration into the store the way the backend does: the
 * settings rows the admin editor reads back, plus the derived /api/pages/nav
 * payload the public header renders. Keeping both in one place is what lets a
 * visitor switch modes on /light/menu and watch the header follow.
 *
 * `navTagTree` is the recorded tags-mode tree, held aside so switching away
 * from custom mode and back restores it.
 */
export function applyNavMenu(s, { mode, items, markdown }) {
  s.settings.nav_menu_mode = mode;
  s.settings.custom_nav_menu = JSON.stringify(items);
  s.settings.custom_markdown = markdown;

  if (mode === "none") s.pages.nav = { menu: [] };
  else if (mode === "custom") s.pages.nav = { menu: items, tags: s.navTagTree };
  else s.pages.nav = { menu: s.navTagTree };
}

/**
 * Find a theme by name, case-insensitively — the comparison the backend makes
 * when it resolves a theme name to a file.
 */
export function findTheme(themes, name) {
  const wanted = String(name || "").toLowerCase();
  return themes.find((t) => String(t.name || "").toLowerCase() === wanted) || null;
}

/**
 * Resolve which theme the demo opens on: the one the visitor activated in this
 * tab, else the recorded one, else the first in the catalogue so the page is
 * never left without a theme.
 */
function initialTheme(themes, fx) {
  return (
    findTheme(themes, storedThemeName()) ||
    findTheme(themes, fx.activeTheme?.name) ||
    structuredClone(fx.activeTheme || null) ||
    themes[0] ||
    null
  );
}

/**
 * Structured-clone the seed so mutations never touch the imported module.
 *
 * The demo's own settings (demo/settings.mjs) are overlaid on every settings
 * map on the way in — they were already baked into the fixture at record time,
 * so this only bites when that file has been edited since, which is the point:
 * change a demo string, rebuild, see it. Nothing here re-records.
 *
 * `catalog` is the build's theme list (demo/scripts/build-themes.mjs); the
 * fixture's own list is the fallback for a build that predates it.
 */
function seed(fx, catalog) {
  const plugins = structuredClone(fx.plugins || []);
  const themes = structuredClone(catalog?.length ? catalog : fx.themes || []);
  const activeTheme = initialTheme(themes, fx);
  const s = {
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
    plugins,
    pluginPresets: defaultPresets(plugins),
    // No preset has been applied to the recorded catalog, so it starts diverged
    // — the same "custom" the backend reports before the first apply.
    activePreset: "custom",
    themes,
    activeTheme: structuredClone(activeTheme),
    customCss: structuredClone(fx.customCss || { css: "" }),
    pages: structuredClone(fx.pages || {}),
    // The recorded tags-mode menu, kept aside so a mode switch can restore it.
    navTagTree: structuredClone(fx.pages?.nav?.menu || []),
    timeline: structuredClone(fx.timeline || {}),
    timelineLocations: structuredClone(fx.timelineLocations || {}),
    tagCloud: structuredClone(fx.tagCloud || []),
    analytics: structuredClone(fx.analytics || {}),
    mediaStats: structuredClone(fx.mediaStats || {}),
    mediaFolders: structuredClone(fx.mediaFolders || []),
    system: structuredClone(fx.system || {}),
  };

  // Only `pages` needs the shape-based walk — the two top-level settings maps
  // are settings by definition, and no other collection holds one.
  s.settings = applyDemoSettings(s.settings);
  s.publicSettings = applyDemoSettings(s.publicSettings);
  s.pages = applyDemoSettingsDeep(s.pages);

  // The active theme is a setting as far as the rest of the API is concerned,
  // so a theme carried over from the visitor's last page has to land in both
  // maps too — the same two writes PUT /api/themes/active makes.
  if (s.activeTheme?.name) {
    s.settings.active_css_theme = s.activeTheme.name;
    s.publicSettings.active_css_theme = s.activeTheme.name;
  }

  applyNavMenu(s, {
    mode: "custom",
    items: navNodes(DEMO_NAV_LINKS),
    markdown: navMarkdown(DEMO_NAV_LINKS),
  });

  return s;
}

/**
 * The theme catalogue the build derived from frontend/themes/
 * (demo/scripts/build-themes.mjs), fetched rather than bundled so it stays the
 * same list the CSS files next to it describe.
 *
 * Fetched through the *patched* window.fetch, which passes /assets/ straight to
 * the network — the shim owns /api/ and theme.css, nothing else.
 */
async function loadThemeCatalog() {
  try {
    const res = await fetch("/assets/themes/index.json");
    if (!res.ok) return null;
    const list = await res.json();
    return Array.isArray(list) && list.length ? list : null;
  } catch {
    // A build predating the manifest, or an offline reload: fall back to the
    // themes recorded in the fixture rather than leaving the page with none.
    return null;
  }
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
    const [mod, catalog] = await Promise.all([
      import("./fixtures/fixtures.json"),
      loadThemeCatalog(),
    ]);
    fixtures = mod.default || mod;
    themeCatalog = catalog;
  }
  state = seed(fixtures, themeCatalog);
  return state;
}

/** Re-seed from the fixture. Backs the demo's "reset" control. */
export async function resetState() {
  state = null;
  setAuthenticated(false);
  // Reset means the recorded state, and the theme is part of it.
  storeThemeName(null);
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

/**
 * Restrict rows to the `year_from`..`year_to` window the timeline sends.
 *
 * The real filter is not a comparison against published_at: buildPostsQuery
 * (api/internal/repository/queries_posts.go) keeps posts carrying a
 * `kind: "year"` tag whose slug casts to a year inside the range. Matching the
 * same tag here keeps the demo honest — filtering on the date column instead
 * would disagree with the archive for any post whose date and year tag differ,
 * and would silently pass while the tag-driven views disagreed with it.
 *
 * An absent or partial range means "all years", which is what the timeline
 * sends when it is showing everything.
 */
export function withinYears(rows, query) {
  const from = Number(query.year_from);
  const to = Number(query.year_to);
  if (!(from > 0 && to > 0)) return rows;
  return rows.filter((p) =>
    (p.tags || []).some((t) => {
      if (t.kind !== 'year') return false;
      const year = parseInt(t.slug, 10);
      return Number.isFinite(year) && year >= from && year <= to;
    }),
  );
}

/** `{posts, pagination:{...}}` — the shape the public page payloads use. */
export function paginatedPage(rows, query, perPageDefault) {
  const matching = withinYears(rows, query);
  const perPage = Number(query.per_page) || perPageDefault;
  const page = Number(query.page) || 1;
  const start = (page - 1) * perPage;
  return {
    posts: matching.slice(start, start + perPage),
    pagination: {
      page,
      pages: Math.max(1, Math.ceil(matching.length / perPage)),
      per_page: perPage,
      total: matching.length,
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
