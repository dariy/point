/**
 * In-memory data model for the static demo.
 *
 * Seeded from recorded fixtures (demo/scripts/record-fixtures.ts) and mutated
 * in place, so create/edit/delete in the demo actually change what the rest of
 * the UI shows. A reload re-seeds from the fixture and the demo is pristine
 * again. That is the whole reset story — there is no server to roll back.
 *
 * Four things are held in sessionStorage rather than being re-seeded, because
 * the store is module state that dies on every full page load and the demo does
 * plenty of those — the admin's login redirects, and the walk from /light back
 * out to the public site. Without them an edit is undone by the very navigation
 * taken to go and look at it:
 *
 *   demo-authenticated  whether the visitor is logged in
 *   demo-active-theme   the theme they activated
 *   demo-active-plugins the plugins they turned on
 *   demo-content        their edits to the posts and tags
 *
 * The first three outlive a reload; the content does not — see storeContent.
 * All four end with the tab, and the reset control clears them.
 *
 * The theme catalogue is the one collection that does not come from the fixture
 * at all: the backend derives it from the theme files on every request, so the
 * demo reads the build's equivalent (demo/scripts/build-themes.ts) instead of
 * a recording that would freeze the list.
 *
 * Entities (posts/tags/media/settings) live here as mutable collections.
 * Genuinely derived views — the tag graph, the timeline — stay as recorded
 * blobs; recomputing them in the browser would be a second implementation of
 * real backend work that no demo visitor would notice. The Atlas's per-place
 * cloud is the exception and is computed (routes.ts atlasCloud): it is one
 * payload per place *and* per timeline range, so there is no single blob to
 * record.
 */

import type { User } from "../../frontend/src/api/auth.ts";
import type { Media } from "../../frontend/src/api/media.ts";
import type { NavTagNode } from "../../frontend/src/api/nav.ts";
import type { TagCloudItem } from "../../frontend/src/api/pages.ts";
import type { PluginView } from "../../frontend/src/api/plugins.ts";
import type { Post, PostStub } from "../../frontend/src/api/posts.ts";
import type { Settings } from "../../frontend/src/api/settings.ts";
import type { Tag } from "../../frontend/src/api/tags.ts";
import type { Theme } from "../../frontend/src/api/themes.ts";
import type { LocationLink, TimelinePayload } from "../../frontend/src/api/timeline.ts";
import { applyDemoSettings, applyDemoSettingsDeep } from "../settings.ts";

// ── Types ─────────────────────────────────────────────────────────────────
//
// The recorded fixtures are API responses, so the frontend's API types describe
// them. The recorded blobs the demo only passes through stay `unknown`.

/** A nav menu node: a tag (NavTagNode) or an authored `{name, url}` link. */
export type NavItem = Partial<Omit<NavTagNode, "children">> & {
  name: string;
  children: NavItem[];
};

/** One tag node of the recorded tag graph (GET /api/pages/graph). */
export interface GraphTag {
  id: number;
  is_hidden?: boolean;
  post_count?: number;
  [key: string]: unknown;
}

/** One post node of the recorded tag graph. */
export interface GraphPost {
  id: number;
  status?: string;
  is_hidden?: boolean;
  [key: string]: unknown;
}

/** The recorded tag graph. */
export interface Graph {
  tags?: GraphTag[];
  hierarchyEdges?: { parent: number; child: number }[];
  posts?: GraphPost[];
  membershipEdges?: { post: number; tag: number }[];
  [key: string]: unknown;
}

/** The recorded page payloads (GET /api/pages/*). */
export interface Pages {
  home?: { tag_cloud?: TagCloudItem[]; menu?: NavItem[]; [key: string]: unknown };
  tags?: { tags?: Tag[]; [key: string]: unknown };
  map?: unknown;
  graph?: Graph;
  nav?: { menu: NavItem[]; tags?: NavItem[] };
}

/** The recorded system payloads (GET /api/system/*). */
export interface SystemBlobs {
  stats?: unknown;
  health?: unknown;
  disk?: unknown;
  migrations?: unknown;
}

/** demo/mock/fixtures/fixtures.json, as record-fixtures.ts writes it. */
export interface Fixtures {
  recordedAt?: string;
  settings?: Settings;
  publicSettings?: Settings;
  user?: User | null;
  posts?: ListPost[];
  postDetail?: Record<string, Post>;
  postNavigation?: Record<string, { prev?: PostStub | null; next?: PostStub | null }>;
  tags?: Tag[];
  media?: Media[];
  plugins?: PluginView[];
  themes?: Theme[];
  activeTheme?: Theme | null;
  customCss?: { css: string };
  pages?: Pages;
  timeline?: Partial<TimelinePayload>;
  timelineLocations?: Record<string, LocationLink[]>;
  tagCloud?: State["tagCloud"];
  analytics?: unknown;
  mediaStats?: unknown;
  mediaFolders?: unknown[];
  system?: SystemBlobs;
}

/**
 * A post in the list shape (toListShape). A post the demo created has no
 * `type`, `view_count` or `updated_at` until a recorded row supplies them.
 */
export type ListPost = Omit<Post, "type" | "view_count" | "updated_at"> &
  Partial<Pick<Post, "type" | "view_count" | "updated_at">>;

/** The demo's mutable store: the fixtures as seeded, then edited. */
export interface State {
  settings: Settings;
  publicSettings: Settings;
  user: User | null;
  authenticated: boolean;
  posts: ListPost[];
  /** Single-post shapes, by post id. */
  postDetail: Record<string, Post>;
  postNavigation: NonNullable<Fixtures["postNavigation"]>;
  tags: Tag[];
  media: Media[];
  plugins: PluginView[];
  pluginPresets: Record<string, string[]>;
  activePreset: string;
  themes: Theme[];
  activeTheme: Theme | null;
  customCss: { css: string };
  pages: Pages;
  navTagTree: NavItem[];
  timeline: Partial<TimelinePayload>;
  timelineLocations: Record<string, LocationLink[]>;
  /** Recorded as `{tags}`; an older bundle recorded the bare array. */
  tagCloud: TagCloudItem[] | { tags?: TagCloudItem[] };
  analytics: unknown;
  mediaStats: unknown;
  mediaFolders: unknown[];
  system: SystemBlobs;
}

/** The content snapshot storeContent writes (see CONTENT_KEY). */
interface ContentSnapshot {
  v: number;
  recordedAt: string | null;
  posts: ListPost[];
  postDetail: Record<string, Post>;
  tags: Tag[];
}

let fixtures: Fixtures | null = null;
let themeCatalog: Theme[] | null = null;
let state: State | null = null;

/**
 * Whether the visitor has "logged in".
 *
 * Kept in sessionStorage because the store itself is module state that dies on
 * every full page load — and the admin UI does hard navigations (app.ts sends
 * any login-required signal through window.location.assign). Without this, a
 * visitor who logs in and then reloads, deep-links, or follows one of those
 * navigations is bounced straight back to the login page.
 *
 * sessionStorage rather than localStorage so the session ends with the tab,
 * matching the banner's promise that nothing outlives it.
 */
const AUTH_KEY = "demo-authenticated";

export function isAuthenticated(): boolean {
  try {
    return sessionStorage.getItem(AUTH_KEY) === "1";
  } catch {
    return false;
  }
}

export function setAuthenticated(value: boolean): void {
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

export function storedThemeName(): string | null {
  try {
    return sessionStorage.getItem(THEME_KEY) || null;
  } catch {
    return null;
  }
}

export function storeThemeName(name: string | null): void {
  try {
    if (name) sessionStorage.setItem(THEME_KEY, name);
    else sessionStorage.removeItem(THEME_KEY);
  } catch {
    /* private browsing — the theme just won't survive a reload */
  }
}

/**
 * The plugins the visitor activated, kept for the same reason.
 * 
 * When a plugin's state changes, the UI reloads the page. Without storing
 * the active plugins in sessionStorage, the mock state would reset to the
 * fixtures on reload, and the change would be lost.
 */
const PLUGINS_KEY = "demo-active-plugins";

export function storedPlugins(): string[] | null {
  try {
    const val = sessionStorage.getItem(PLUGINS_KEY);
    return val ? (JSON.parse(val) as string[]) : null;
  } catch {
    return null;
  }
}

export function storePlugins(plugins: PluginView[] | null): void {
  try {
    if (plugins) {
      sessionStorage.setItem(PLUGINS_KEY, JSON.stringify(plugins.filter((p) => p.enabled).map((p) => p.id)));
    } else {
      sessionStorage.removeItem(PLUGINS_KEY);
    }
  } catch {
    /* private browsing */
  }
}

/**
 * The visitor's own edits to the content: the post and tag stores as they stand
 * after every write the demo has answered.
 *
 * Everything else in the demo survives a page load because it is a *setting* —
 * one flag, one theme name, one list of plugin ids. Content is the collection
 * itself, so there is nothing smaller to keep: this holds the two stores whole,
 * which at demo size is a hundred kilobytes or so and re-seeds in one parse.
 *
 * `postDetail` travels with `posts` because they are two shapes of the same
 * thing (see toListShape): keeping one without the other produces a post that
 * reads correctly on the feed and reverts the moment it is opened.
 *
 * **A full page reload still resets it.** That is the demo's promise — a reload
 * re-seeds the store and the next visitor gets a pristine archive — and it is
 * the reason this is scoped to a page *load* rather than the tab: the edit has
 * to survive the navigation out of the admin to the public site, which is the
 * only way to see what the edit did, and it has to not survive the reload
 * people reach for to start over. `performance`'s navigation entry is what
 * separates the two; the reset control drops the key outright.
 */
const CONTENT_KEY = "demo-content";

/**
 * Bumped when the shape below changes. A snapshot from an older build is
 * dropped rather than merged — it re-seeds from the fixture, which is the same
 * thing a reload does.
 */
const CONTENT_VERSION = 1;

/**
 * Was this page load a reload, as opposed to a navigation?
 *
 * `back_forward` counts as a navigation: stepping back into the demo is not a
 * request to start it over. A browser too old for the Navigation Timing entry
 * falls back to the deprecated enum, and one with neither keeps its edits —
 * the failure that leaves the demo working.
 */
function isReload(): boolean {
  try {
    const [nav] = performance.getEntriesByType("navigation");
    if (nav) return (nav as PerformanceNavigationTiming).type === "reload";
    // The deprecated fallback: gone from the DOM types, still there in an old
    // enough browser.
    const legacy = performance as { navigation?: { type: number } };
    return legacy.navigation?.type === 1;
  } catch {
    return false;
  }
}

export function clearContent(): void {
  try {
    sessionStorage.removeItem(CONTENT_KEY);
  } catch {
    /* private browsing — there was nothing stored to clear */
  }
}

// Module evaluation is the earliest the mock runs in a document's life, and
// this has to happen before the first handler can write a snapshot back.
if (isReload()) clearContent();

/**
 * The snapshot for this fixture bundle, or null.
 *
 * Rejected when it came from a different recording: a rebuilt bundle is a
 * different archive, and restoring the old posts over it would show content the
 * build no longer has the photographs for.
 */
function storedContent(fx: Fixtures): ContentSnapshot | null {
  try {
    const raw = sessionStorage.getItem(CONTENT_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<ContentSnapshot> | null;
    if (saved?.v !== CONTENT_VERSION) return null;
    if (saved.recordedAt !== (fx.recordedAt ?? null)) return null;
    if (!Array.isArray(saved.posts) || !Array.isArray(saved.tags)) return null;
    if (!saved.postDetail || typeof saved.postDetail !== "object") return null;
    return saved as ContentSnapshot;
  } catch {
    return null;
  }
}

/**
 * Write the content stores back, called after every request that could have
 * changed them (shim.ts dispatch).
 *
 * Serialising the whole of both on each write rather than tracking a diff:
 * a hundred kilobytes of JSON.stringify is a fraction of a millisecond and the
 * demo has already spent 90ms pretending to be a network. Every write path —
 * including any handler added later — is covered without having to remember to
 * call anything.
 */
export function storeContent(s: State | null): void {
  if (!s) return;
  try {
    sessionStorage.setItem(
      CONTENT_KEY,
      JSON.stringify({
        v: CONTENT_VERSION,
        recordedAt: fixtures?.recordedAt ?? null,
        posts: s.posts,
        postDetail: s.postDetail,
        tags: s.tags,
      }),
    );
  } catch {
    // Quota or private browsing: the edit still stands in this document, it
    // just will not survive the next navigation. Nothing to tell the visitor.
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
function defaultPresets(plugins: PluginView[]): Record<string, string[]> {
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
const DEMO_NAV_LINKS: NavLink[] = [
  { name: "Portugal", url: "/tags/portugal" },
  { name: "Reykjavík", url: "/tags/reykjavik" },
  { name: "2024", url: "/tags/2024" },
  { name: "Light", url: "/tags/light" },
];

/** An authored nav menu link. */
export interface NavLink {
  name: string;
  url: string;
}

/** `{name,url}` → the NavTagNode shape the nav endpoints speak. */
function navNodes(links: NavLink[]): NavItem[] {
  return links.map(({ name, url }) => ({ name, url, children: [] }));
}

/** `{name,url}` → the `- [Label](url)` source the menu editor round-trips. */
export function navMarkdown(links: NavLink[]): string {
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
export function applyNavMenu(
  s: State,
  { mode, items, markdown }: { mode: string; items: NavItem[]; markdown: string },
): void {
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
export function findTheme(themes: Theme[], name: unknown): Theme | null {
  const wanted = String(name || "").toLowerCase();
  return themes.find((t) => String(t.name || "").toLowerCase() === wanted) || null;
}

/**
 * Resolve which theme the demo opens on: the one the visitor activated in this
 * tab, else the recorded one, else the first in the catalogue so the page is
 * never left without a theme.
 */
function initialTheme(themes: Theme[], fx: Fixtures): Theme | null {
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
 * The demo's own settings (demo/settings.ts) are overlaid on every settings
 * map on the way in — they were already baked into the fixture at record time,
 * so this only bites when that file has been edited since, which is the point:
 * change a demo string, rebuild, see it. Nothing here re-records.
 *
 * `catalog` is the build's theme list (demo/scripts/build-themes.ts); the
 * fixture's own list is the fallback for a build that predates it.
 */
function seed(fx: Fixtures, catalog: Theme[] | null): State {
  // The visitor's edits, if this document was navigated to rather than
  // reloaded. Replaces the recorded collections wholesale: the snapshot *is*
  // the fixture as edited, so there is nothing to merge.
  const edited = storedContent(fx);

  const plugins = structuredClone(fx.plugins || []);
  const storedPluginIds = storedPlugins();
  if (storedPluginIds) {
    const activeSet = new Set(storedPluginIds);
    plugins.forEach((p) => {
      p.enabled = activeSet.has(p.id);
    });
  }

  const themes = structuredClone(catalog?.length ? catalog : fx.themes || []);
  const activeTheme = initialTheme(themes, fx);
  const s: State = {
    settings: { ...fx.settings },
    publicSettings: { ...fx.publicSettings },
    user: fx.user ? { ...fx.user } : null,
    // Fresh tabs start logged out, so visitors meet the public site first and
    // logging in is a real step rather than a detail they skip past.
    authenticated: isAuthenticated(),
    posts: edited?.posts ?? structuredClone(fx.posts || []),
    postDetail: edited?.postDetail ?? structuredClone(fx.postDetail || {}),
    postNavigation: structuredClone(fx.postNavigation || {}),
    tags: edited?.tags ?? structuredClone(fx.tags || []),
    media: structuredClone(fx.media || []),
    plugins,
    pluginPresets: defaultPresets(plugins),
    // No preset has been applied to the recorded catalog, so it starts diverged
    // — the same "custom" the backend reports before the first apply.
    activePreset: storedPluginIds ? "custom" : "custom", // keep it as custom
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
 * (demo/scripts/build-themes.ts), fetched rather than bundled so it stays the
 * same list the CSS files next to it describe.
 *
 * Fetched through the *patched* window.fetch, which passes /assets/ straight to
 * the network — the shim owns /api/ and theme.css, nothing else.
 */
async function loadThemeCatalog(): Promise<Theme[] | null> {
  try {
    const res = await fetch("/assets/themes/index.json");
    if (!res.ok) return null;
    const list: unknown = await res.json();
    return Array.isArray(list) && list.length ? (list as Theme[]) : null;
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
export async function getState(): Promise<State> {
  if (state) return state;
  if (!fixtures) {
    const [mod, catalog] = await Promise.all([
      // @ts-ignore — fixtures.json is generated and gitignored, so it is not
      // there in a clean clone; the typecheck must not depend on it being built.
      import("./fixtures/fixtures.json") as Promise<{ default?: unknown }>,
      loadThemeCatalog(),
    ]);
    fixtures = (mod.default || mod) as Fixtures;
    themeCatalog = catalog;
  }
  state = seed(fixtures as Fixtures, themeCatalog);
  return state;
}

/** Re-seed from the fixture. Backs the demo's "reset" control. */
export async function resetState(): Promise<State> {
  state = null;
  setAuthenticated(false);
  // Reset means the recorded state, and the theme is part of it.
  storeThemeName(null);
  storePlugins(null);
  clearContent();
  return getState();
}

/** A request's query string, as the shim parses it. */
export type Query = Record<string, string>;

/** The query fields the paging helpers read; each goes through Number(). */
export type PageQuery = Partial<Record<string, string | number>>;

// ── Helpers ───────────────────────────────────────────────────────────────

export function nextId(collection: { id?: number }[]): number {
  return collection.reduce((max, row) => Math.max(max, row.id || 0), 0) + 1;
}

// Who may see which posts and tags is worked out in routes.ts (hiddenSets and
// friends), not here: it is a walk over the tag graph rather than a property of
// a row, and the same walk answers for tags, for posts, and for the scheduled
// queue.

/** The dates byNewest reads. */
type Dated = { published_at?: string | null; created_at?: string | null };

/**
 * Sort newest-first by publish date, falling back to creation date.
 *
 * Some posts carry a null published_at (the engine's standalone "about" page,
 * for one), so an unguarded Date parse yields NaN and scrambles the order.
 */
export function byNewest(a: Dated, b: Dated): number {
  const at = Date.parse(a.published_at || a.created_at || "") || 0;
  const bt = Date.parse(b.published_at || b.created_at || "") || 0;
  return bt - at;
}

/** `{page, pages, per_page, <key>}` — the shape of the admin list endpoints. */
export function paginate<T>(
  rows: T[],
  query: PageQuery,
  key: string,
  defaultPerPage = 20,
): { page: number; pages: number; per_page: number; total: number; [key: string]: number | T[] } {
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
export function withinYears<T extends Pick<Post, "tags">>(rows: T[], query: PageQuery): T[] {
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

// The feed's own pagination lives in routes.ts (feedPage): it spans both halves
// of the feed — the published pages and the scheduled queue left of page 1 —
// which needs the queue, and the queue is a visibility question.

/**
 * Project a detail-shaped post back onto the list shape.
 *
 * The list and detail endpoints return different fields (list carries
 * `media_url`, detail carries `media[]` and `content`), so a post created or
 * edited in the demo has to be written back to both stores or it appears
 * correct on one screen and broken on the next.
 */
export function toListShape(detail: Post, previous: Partial<ListPost> = {}): ListPost {
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
