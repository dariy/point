/**
 * Application bootstrap.
 *
 * Entry point loaded by frontend/index.html via:
 *   <script type="module" src="/assets/js/app.js">
 *
 * Responsibilities:
 *   1. Load public blog settings into the store.
 *   2. Check for an active session (GET /api/auth/me).
 *   3. Apply the saved theme.
 *   4. Mount the ToastContainer.
 *   5. Define all routes and start the router.
 */

import {
  getSettings,
  getUser,
  onRoute,
  onTheme,
  setAppVersion,
  setSettings,
  setTheme,
  setUser,
} from "./store.js";
import { router } from "./router.js";
import { getMe } from "./api/auth.js";
import { getPublicSettings } from "./api/settings.js";

import { getVersion } from "./api/system.js";
import { normalizeSettings } from "./utils/helpers.js";
import { setPageTitle } from "./utils/documentTitle.js";
import { pluginHost } from "./core/pluginHost.js";
import { ToastContainer } from "./components/shared/Toast.js";
import { NotificationLogButton } from "./components/shared/NotificationLogButton.js";
import { initNotificationLog } from "./utils/notificationLog.js";

// ── Theming Foundation ────────────────────────────────────────────────────
import { loadThemeCss } from "./utils/themeLoader.js";
import { initPointerMode } from "./utils/pointerMode.js";

// Load the active theme CSS immediately to prevent FOUC
loadThemeCss();

// Decide touch-vs-pointer styling before anything renders, for the same reason:
// the cached verdict has to be on <html> ahead of first paint.
initPointerMode();

// Initialise the plugin host from the server-injected, enabled-only manifest
// (window.__PLUGINS__). Done at module load so the route table and shell slots
// can consult it synchronously. Inert when no manifest is present.
pluginHost.init();

// ── Login trigger ─────────────────────────────────────────────────────────
//
// Login is a standalone, hard-loaded page (/light/login), not an in-document
// modal. Any "login required" signal performs a full-page navigation to it, so
// the credential form always loads in a fresh document served without the
// deployment-injected third-party markup (analytics, etc.). This tears down the
// guest UI — and anything running in it — before a password is ever typed, and
// keeps that markup out of the authenticated session that follows.
window.addEventListener("app:login-required", (event) => {
  const { detail } = /** @type {CustomEvent} */ (event);
  const next = detail?.next || null;
  const target =
    "/light/login" + (next ? `?next=${encodeURIComponent(next)}` : "");
  // Already on the login document? Do nothing — avoid a reload loop.
  if (location.pathname === "/light/login") return;
  window.location.assign(target);
});

// ── CSS section switching ─────────────────────────────────────────────────
//
// The SPA uses two section CSS bundles with incompatible :root token sets:
//   main.css  — public blog
//   light.css — admin interface
// (viewer.css — shared media viewers — is a third, always-active bundle.)
//
// Both <link> elements are present in index.html. The inactive one uses
// media="not all" so the browser downloads it eagerly (no flash on switch)
// but the browser does not apply its rules. We swap media attributes
// synchronously on every route change, before any page component mounts.

const _cssPublic = /** @type {HTMLLinkElement|null} */ (document.getElementById("css-public"));
const _cssLight = /** @type {HTMLLinkElement|null} */ (document.getElementById("css-light"));

function _applySection(pathname) {
  const isLight = pathname.startsWith("/light") || pathname === "/setup";
  const pubMedia = isLight ? "not all" : "all";
  const lgtMedia = isLight ? "all" : "not all";
  if (_cssPublic && _cssPublic.media !== pubMedia) _cssPublic.media = pubMedia;
  if (_cssLight && _cssLight.media !== lgtMedia) _cssLight.media = lgtMedia;
  document.documentElement.dataset.section = isLight ? "light" : "public";
}

// Apply immediately so the initial paint uses the correct bundle.
_applySection(location.pathname);

// ── Theme ─────────────────────────────────────────────────────────────────

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme || "auto");
  setTheme(theme || "auto");
}

function loadTheme(settings) {
  // The first-run wizard runs before any setting exists, and setup seeds
  // default_theme: dark (api/internal/api/setup.go) — so render it in the theme
  // the install is about to have, instead of filling in a white form and
  // landing in a dark admin. Set on the element only, not through applyTheme():
  // this is a seeded default, not a choice the owner made, so it must not be
  // written to localStorage as if they had picked it. index.html's inline
  // bootstrap does the same thing before first paint.
  if (location.pathname === "/setup") {
    document.documentElement.setAttribute("data-theme", "dark");
    return;
  }
  const saved = localStorage.getItem("theme");
  applyTheme(saved || settings?.default_theme || "auto");
}

onTheme((theme) => {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);
  // Notify components that the theme has changed
  document.dispatchEvent(new CustomEvent("themechange", { detail: { theme } }));
});

// ── Bootstrap ─────────────────────────────────────────────────────────────

async function bootstrap() {
  // 0. Init offline sync plugin if enabled
  const offlineEntry = pluginHost._byId.get("offline-sync");
  if (offlineEntry && offlineEntry.entry) {
    try {
      const mod = await pluginHost.loadEntry(offlineEntry);
      if (mod && mod.mount) await mod.mount();
    } catch { /* ignore */ }
  } else if (!pluginHost.size || pluginHost.isEnabled("offline-sync")) {
    try {
      const mod = await import("./plugins/offline-sync/index.js");
      if (mod && mod.mount) await mod.mount();
    } catch { /* ignore */ }
  }



  // 1. Fetch public settings (best-effort — fall back to last cached values).
  let settings = {};
  try {
    settings = normalizeSettings(await getPublicSettings());
    localStorage.setItem("settings", JSON.stringify(settings));
  } catch {
    // Offline or server unreachable — use last successfully fetched settings.
    try {
      settings = JSON.parse(localStorage.getItem("settings") || "{}");
    } catch {
      /* ignore */
    }
  }
  setSettings(settings);
  // The shell ships a generic <title>; now that the blog's own name is in the
  // store, show it. Every later navigation goes through the router, which resets
  // the title per route (see the `title` field in the route table below).
  setPageTitle();

  // 2. Apply theme before first render to avoid flash.
  loadTheme(settings);

  // 3. Check auth session (best-effort — treat network errors as unauthenticated).
  let user = null;
  try {
    user = await getMe();
  } catch {
    // Offline or server unreachable — proceed as unauthenticated.
  }
  setUser(user);

  // 3.1 Fetch version info (non-blocking). Admin-only: /api/system/version
  // returns 401 for guests, and that 401 would otherwise resolve after the
  // router has registered its api:unauthorized listener and pop the login
  // overlay on the public site. Only the admin sidebar consumes it.
  if (user) {
    getVersion()
      .then((ver) => {
        setAppVersion(ver.current);
      })
      .catch(() => {
        // If it fails, we can try to fall back to the stamped version in index.html if we want,
        // but the API is more reliable for the actual running binary.
      });
  }



  // 4. Mount toast container and initialise the notification log.
  const toastsEl = document.getElementById("toasts");
  if (toastsEl) {
    const toastContainer = new ToastContainer(toastsEl);
    toastContainer.mount();
  }
  initNotificationLog();
  if (user) {
    const notificationLogBtn = new NotificationLogButton();
    notificationLogBtn.mount();
  }

  // 5. Subscribe to route changes to swap CSS bundles before each page mounts.
  onRoute(({ pathname }) => _applySection(pathname));

  // 6. Start the router.
  router.init(routes, {
    mountPoint: document.getElementById("app"),
    authGuard: () => !!getUser(),
    loginPath: "/light/login",
  });



}

// ── Route table ───────────────────────────────────────────────────────────
//
// All page modules are lazy-loaded via dynamic import() so only the code
// for the current page is parsed on first visit.
//
// public: true  →  accessible without authentication
// (absent)      →  requires authentication (authGuard redirect)

// The tag-viz plugins that may own each public viz route, in the order the
// backend resolves them (registry order). Both slots are single-claim
// (plugins.SlotCardinality on the backend), so at most one member of each list
// is enabled — but the graph and the maps no longer compete with each other.
const TAGS_VIZ_PLUGINS = ["tags-graph"];
const MAP_VIZ_PLUGINS = ["tags-atlas", "tags-map"];

/**
 * Resolve the lazy module for a public viz route. `slot` is single-claim: the
 * single enabled plugin among `candidates` owns the path — that enabled plugin
 * IS the selection (the old `tags_module` setting is gone). Mirrors the backend
 * gate in TagVizAccessible: no enabled viz (or admins-only for a logged-out
 * visitor) sends the visitor home.
 *
 * @param {string} slot - "tags-route" or "map-route"
 * @param {string[]} candidates - the slot's members in registry order; the
 *   first is the slot's default, used as the fallback before the manifest lands.
 */
async function resolveVizModule(slot, candidates) {
  /** @type {Record<string, any>} */
  const settings = getSettings() || {};
  const visibility = settings.tags_visibility || "hidden";
  const isAdmin = !!getUser();

  // Active viz = the enabled member of the slot. Before the manifest loads
  // (size 0) fall back to the slot's default so the route still resolves.
  const active =
    pluginHost.size === 0
      ? candidates[0]
      : candidates.find((id) => pluginHost.isEnabled(id)) || "";

  if (!active || (visibility !== "all" && !isAdmin)) {
    return import("./pages/public/RedirectHome.js");
  }

  const claimed = await pluginHost.claimRoute(slot, (entries) =>
    entries.find((e) => e.id === active),
  );
  if (claimed) return claimed;

  return import("./pages/public/RedirectHome.js");
}

/** /tags — the tag-cloud graph, the sole `tags-route` claimant. */
const resolveTagsModule = () => resolveVizModule("tags-route", TAGS_VIZ_PLUGINS);

/** /map — the atlas or the plain map, whichever claims `map-route`. */
const resolveMapModule = () => resolveVizModule("map-route", MAP_VIZ_PLUGINS);

// The route table. `title` is the tab title's page-specific part; the router
// applies it on every mount, so a page with a fixed name needs nothing else.
// Pages whose name is only known after a fetch (a post, a tag, a search query)
// leave it unset and call setPageTitle() themselves once loaded.
const routes = [
  // Standalone login page (public — no auth required). Reached via a hard
  // navigation so it loads in its own document, isolated from the guest UI and
  // any third-party markup injected into it.
  {
    path: "/light/login",
    load: () => import("./pages/light/LoginPage.js"),
    public: true,
    title: "Sign in · Light",
  },

  // First-run setup wizard (public — no auth required)
  {
    path: "/setup",
    load: () => import("./pages/light/SetupPage.js"),
    public: true,
    title: "Setup",
  },

  // Password reset (public — no auth required)
  {
    path: "/light/pss",
    load: () => import("./pages/light/PasswordResetPage.js"),
    public: true,
    title: "Password reset · Light",
  },
  {
    path: "/light/pss/:token",
    load: () => import("./pages/light/PasswordResetPage.js"),
    public: true,
    title: "Password reset · Light",
  },

  // Public blog
  { path: "/", load: () => import("./pages/public/HomePage.js"), public: true },
  {
    path: "/posts/:slug",
    load: () => import("./pages/public/PostPage.js"),
    public: true,
  },
  {
    path: "/tags/:slug",
    load: () => import("./pages/public/TagPage.js"),
    public: true,
  },
  // Two public viz pages, each owned by a single-claim slot and gated by
  // `tags_visibility`: /tags shows the tag-cloud graph, /map shows the atlas or
  // the plain map. Either resolves to RedirectHome when its slot is unclaimed —
  // see resolveVizModule().
  {
    path: "/tags",
    load: () => resolveTagsModule(),
    public: true,
  },
  {
    path: "/map",
    load: () => resolveMapModule(),
    public: true,
  },
  {
    path: "/search",
    load: () => import("./pages/public/SearchPage.js"),
    public: true,
  },
  {
    path: "/preview/:token",
    load: () => import("./pages/public/PreviewPage.js"),
    public: true,
  },

  // Admin (Light) — protected
  {
    path: "/light",
    load: () => import("./pages/light/DashboardPage.js"),
    title: "Light",
  },
  {
    path: "/light/posts",
    load: () => import("./pages/light/PostsListPage.js"),
    title: "Posts · Light",
  },
  {
    path: "/light/media",
    load: () => import("./pages/light/MediaPage.js"),
    title: "Media · Light",
  },
  {
    path: "/light/posts/new",
    load: () => import("./pages/light/PostEditPage.js"),
    title: "New post · Light",
  },
  {
    path: "/light/posts/:id/edit",
    load: () => import("./pages/light/PostEditPage.js"),
    title: "Edit post · Light",
  },
  {
    path: "/light/tags",
    load: () => import("./pages/light/TagsManagerPage.js"),
    title: "Tags · Light",
  },
  {
    path: "/light/tags/:slug",
    load: () => import("./pages/light/TagsManagerPage.js"),
    title: "Tags · Light",
  },

  {
    path: "/light/themes",
    load: () => import("./pages/light/ThemesPage.js"),
    title: "Themes · Light",
  },
  {
    path: "/light/plugins",
    load: () => import("./pages/light/PluginsPage.js"),
    title: "Plugins · Light",
  },
  {
    path: "/light/settings",
    load: () => import("./pages/light/SettingsPage.js"),
    title: "Settings · Light",
  },
  {
    path: "/light/security",
    load: () => import("./pages/light/SecurityPage.js"),
    title: "Security · Light",
  },
  {
    path: "/light/system",
    load: () => import("./pages/light/SystemPage.js"),
    title: "System · Light",
  },
];

/** "/light/comments" → "Comments" — a readable name for a plugin admin page. */
function adminRouteLabel(path) {
  const segment = path.split("/").filter(Boolean).pop() || "";
  const words = segment.replace(/[-_]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Merge manifest-provided plugin routes into the static table. Each route plugin
// (with a built chunk) contributes its declared paths, loaded from its chunk.
// The single-claim public slots (`tags-route`, `map-route`) are handled by
// resolveVizModule and excluded by pluginHost.routes(). No-op until Phase 4
// ships route-plugin chunks; a plugin route never overrides a core path of the
// same pattern.
for (const entry of pluginHost.routes()) {
  for (const path of entry.routes) {
    // A plugin's `routes` mixes frontend paths, server API prefixes and
    // server-proxied paths (e.g. the comments plugin's /comments reverse
    // proxy); only /light admin pages belong in the client router — public
    // route plugins go through their slot's claimRoute instead.
    if (!path.startsWith("/light")) continue;
    if (routes.some((r) => r.path === path)) continue;
    routes.push({
      path,
      load: () => pluginHost.loadEntry(entry),
      public: !path.startsWith("/light"),
      // The manifest carries no display name, so the path's last segment is the
      // best available one: /light/comments → "Comments · Light". Without it a
      // plugin page would inherit whatever title the previous page left.
      title: `${adminRouteLabel(path)} · Light`,
    });
  }
}

// ── Run ───────────────────────────────────────────────────────────────────

bootstrap().catch((err) => {
  console.error("[App] Bootstrap failed:", err);
  const app = document.getElementById("app");
  if (app) {
    const p = document.createElement("p");
    p.className = "error-page";
    p.textContent = "Failed to start the application. Please reload the page.";
    app.appendChild(p);
  }
});
