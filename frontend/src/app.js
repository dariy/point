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

import { store } from './store.js';
import { router } from './router.js';
import { getMe } from './api/auth.js';
import { getPublicSettings } from './api/settings.js';
import { normalizeSettings } from './utils/helpers.js';
import { ToastContainer } from './components/shared/Toast.js';

// ── CSS section switching ─────────────────────────────────────────────────
//
// The SPA uses two CSS bundles with incompatible :root token sets:
//   main.css  — public blog
//   light.css — admin interface
//
// Both <link> elements are present in index.html. The inactive one uses
// media="not all" so the browser downloads it eagerly (no flash on switch)
// but the browser does not apply its rules. We swap media attributes
// synchronously on every route change, before any page component mounts.

const _cssPublic = document.getElementById('css-public');
const _cssLight  = document.getElementById('css-light');

function _applySection(pathname) {
  const isLight = pathname.startsWith('/light');
  if (_cssPublic) _cssPublic.media = isLight ? 'not all' : 'all';
  if (_cssLight)  _cssLight.media  = isLight ? 'all' : 'not all';
  document.documentElement.dataset.section = isLight ? 'light' : 'public';
}

// Apply immediately so the initial paint uses the correct bundle.
_applySection(location.pathname);

// ── Theme ─────────────────────────────────────────────────────────────────

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme || 'auto');
  store.set('theme', theme || 'auto');
}

function loadTheme(settings) {
  const saved = localStorage.getItem('theme');
  applyTheme(saved || settings?.default_theme || 'auto');
}

store.subscribe('theme', (theme) => {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  // Notify components that the theme has changed
  document.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
});

// ── Bootstrap ─────────────────────────────────────────────────────────────

async function bootstrap() {
  // 0. Register service worker (PWA shell cache + Web Share Target).
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[SW] Registration failed:', err);
    });
  }

  // 1. Fetch public settings (best-effort — fall back to last cached values).
  let settings = {};
  try {
    settings = normalizeSettings(await getPublicSettings());
    localStorage.setItem('settings', JSON.stringify(settings));
  } catch {
    // Offline or server unreachable — use last successfully fetched settings.
    try { settings = JSON.parse(localStorage.getItem('settings') || '{}'); } catch { /* ignore */ }
  }
  store.set('settings', settings);
  if (settings.blog_title) {
    document.title = settings.blog_title;
  }

  // 2. Apply theme before first render to avoid flash.
  loadTheme(settings);

  // 3. Check auth session (best-effort — treat network errors as unauthenticated).
  let user = null;
  try {
    user = await getMe();
  } catch {
    // Offline or server unreachable — proceed as unauthenticated.
  }
  store.set('user', user);

  // 4. Mount toast container.
  const toastsEl = document.getElementById('toasts');
  if (toastsEl) {
    const toastContainer = new ToastContainer(toastsEl);
    toastContainer.mount();
  }

  // 5. Subscribe to route changes to swap CSS bundles before each page mounts.
  store.subscribe('route', ({ pathname }) => _applySection(pathname));

  // 6. Start the router.
  router.init(routes, {
    mountPoint: document.getElementById('app'),
    authGuard: () => !!store.get('user'),
    loginPath: '/light/login',
  });
}

// ── Route table ───────────────────────────────────────────────────────────
//
// All page modules are lazy-loaded via dynamic import() so only the code
// for the current page is parsed on first visit.
//
// public: true  →  accessible without authentication
// (absent)      →  requires authentication (authGuard redirect)

const routes = [
  // Public blog
  { path: '/',            load: () => import('./pages/public/HomePage.js'),   public: true },
  { path: '/post/:slug',  load: () => import('./pages/public/PostPage.js'),   public: true },
  { path: '/tag/:slug',   load: () => import('./pages/public/TagPage.js'),    public: true },
  { path: '/tags',        load: () => import('./pages/public/TagsPage.js'),   public: true },
  { path: '/map',         load: () => import('./pages/public/MapPage.js'),    public: true },
  { path: '/preview/:token', load: () => import('./pages/public/PreviewPage.js'), public: true },

  // Admin (Light) — protected
  { path: '/light/login', load: () => import('./pages/light/LoginPage.js'),   public: true },
  { path: '/light',       load: () => import('./pages/light/DashboardPage.js') },
  { path: '/light/posts', load: () => import('./pages/light/PostsListPage.js') },
  { path: '/light/posts/new',      load: () => import('./pages/light/PostEditPage.js') },
  { path: '/light/posts/:id/edit', load: () => import('./pages/light/PostEditPage.js') },
  { path: '/light/media',          load: () => import('./pages/light/MediaPage.js') },
  { path: '/light/tags',           load: () => import('./pages/light/TagsManagerPage.js') },
  { path: '/light/tags/:slug',     load: () => import('./pages/light/TagsManagerPage.js') },
  { path: '/light/settings',       load: () => import('./pages/light/SettingsPage.js') },
  { path: '/light/security',       load: () => import('./pages/light/SecurityPage.js') },
  { path: '/light/system',         load: () => import('./pages/light/SystemPage.js') },
];

// ── Run ───────────────────────────────────────────────────────────────────

bootstrap().catch((err) => {
  console.error('[App] Bootstrap failed:', err);
  const app = document.getElementById('app');
  if (app) {
    const p = document.createElement('p');
    p.className = 'error-page';
    p.textContent = 'Failed to start the application. Please reload the page.';
    app.appendChild(p);
  }
});
