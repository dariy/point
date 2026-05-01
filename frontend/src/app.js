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
import { getNavMenu } from './api/pages.js';
import { normalizeSettings } from './utils/helpers.js';
import { ToastContainer } from './components/shared/Toast.js';
import { NotificationLogButton } from './components/shared/NotificationLogButton.js';
import { initNotificationLog } from './utils/notificationLog.js';
import { syncQueue } from './utils/sync.js';

// ── Theming Foundation ────────────────────────────────────────────────────
import './utils/PointBus.js';
import { parseTheme } from './utils/themeParser.js';
import { PointPostList } from './components/shared/PointPostList.js';
import { PointLightbox } from './components/shared/PointLightbox.js';

if (typeof customElements !== 'undefined') {
  customElements.define('point-post-list', PointPostList);
  customElements.define('point-lightbox', PointLightbox);
}

// Initialise theme immediately to prevent FOUC
parseTheme();


// ── Login overlay ─────────────────────────────────────────────────────────

const _loginOverlayEl = document.createElement('div');
_loginOverlayEl.id = 'login-overlay';
document.body.appendChild(_loginOverlayEl);

let _loginModalInstance = null;

async function _showLoginOverlay(next) {
  if (_loginModalInstance) return;

  const appEl = document.getElementById('app');

  // If #app has no content yet (e.g. direct navigation to /light/login),
  // render the home page as the blurred background.
  if (!appEl || appEl.children.length === 0) {
    const homeRoute = routes.find((r) => r.path === '/');
    if (homeRoute) {
      try {
        const mod = await homeRoute.load();
        const PageClass = mod.default;
        const bgPage = new PageClass(appEl, { params: {}, query: {} });
        bgPage.mount();
        _applySection('/');
        store.set('route', { pathname: '/', params: {}, query: {} });
      } catch { /* ignore */ }
    }
  }

  if (appEl) appEl.classList.add('login-blur');

  const { default: LoginPage } = await import('./pages/light/LoginPage.js');
  _loginModalInstance = new LoginPage(_loginOverlayEl, {
    next,
    onSuccess: () => {
      _hideLoginOverlay(false);
      router.navigate(next || '/light', { replace: true });
    },
    onCancel: _hideLoginOverlay,
  });
  _loginModalInstance.mount();
}

function _hideLoginOverlay(restoreUrl = true) {
  const appEl = document.getElementById('app');
  if (appEl) appEl.classList.remove('login-blur');

  _loginModalInstance?.unmount();
  _loginModalInstance = null;

  if (restoreUrl && location.pathname.startsWith('/light/login')) {
    const route = store.get('route');
    history.replaceState(null, '', route?.pathname || '/');
  }
}

window.addEventListener('app:login-required', ({ detail }) => {
  _showLoginOverlay(detail?.next || null);
});

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
  const isLight = pathname.startsWith('/light') || pathname === '/setup';
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

  // 0.1 Handle offline Treated as unauthenticated if network fails
  try {
    const lastSync = await (await import('./utils/offlineStore.js')).getMeta('last_sync');
    if (lastSync) {
      store.set('offline_status', { available: true, last_sync: lastSync });
    }
  } catch { /* ignore */ }

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

  // 3.5 Load auth-scoped nav tag hierarchy so all pages have it from first render.
  try {
    const navData = await getNavMenu();
    store.set('navTags', navData.menu || []);
  } catch { /* ignore — pages fall back to store or empty */ }

  // 4. Mount toast container and initialise the notification log.
  const toastsEl = document.getElementById('toasts');
  if (toastsEl) {
    const toastContainer = new ToastContainer(toastsEl);
    toastContainer.mount();
  }
  initNotificationLog(store);
  if (user) {
    const notificationLogBtn = new NotificationLogButton();
    notificationLogBtn.mount();
  }

  // 5. Subscribe to route changes to swap CSS bundles before each page mounts.
  store.subscribe('route', ({ pathname }) => _applySection(pathname));

  // 6. Start the router.
  router.init(routes, {
    mountPoint: document.getElementById('app'),
    authGuard: () => !!store.get('user'),
    loginPath: '/light/login',
  });

  // 6.5 Refresh auth-scoped nav tags on login/logout.
  store.subscribe('user', async () => {
    try {
      const navData = await getNavMenu();
      store.set('navTags', navData.menu || []);
    } catch { /* ignore */ }
  });

  // 7. Sync queue when online
  window.addEventListener('online', syncQueue);
  if (navigator.onLine) syncQueue();
}

// ── Route table ───────────────────────────────────────────────────────────
//
// All page modules are lazy-loaded via dynamic import() so only the code
// for the current page is parsed on first visit.
//
// public: true  →  accessible without authentication
// (absent)      →  requires authentication (authGuard redirect)

const routes = [
  // First-run setup wizard (public — no auth required)
  { path: '/setup',       load: () => import('./pages/light/SetupPage.js'),   public: true },

  // Public blog
  { path: '/',            load: () => import('./pages/public/HomePage.js'),   public: true },
  { path: '/post/:slug',  load: () => import('./pages/public/PostPage.js'),   public: true },
  { path: '/tag/:slug',   load: () => import('./pages/public/TagPage.js'),    public: true },
  { path: '/tags',        load: () => import('./pages/public/TagsPage.js'),   public: true },
  { path: '/map/:year',   load: () => import('./pages/public/MapPage.js'),    public: true },
  { path: '/map',         load: () => import('./pages/public/MapPage.js'),    public: true },
  { path: '/search',      load: () => import('./pages/public/SearchPage.js'), public: true },
  { path: '/preview/:token', load: () => import('./pages/public/PreviewPage.js'), public: true },

  // Admin (Light) — protected
  { path: '/light',       load: () => import('./pages/light/DashboardPage.js') },
  { path: '/light/posts', load: () => import('./pages/light/PostsListPage.js') },
  { path: '/light/posts/new',      load: () => import('./pages/light/PostEditPage.js') },
  { path: '/light/posts/:id/edit', load: () => import('./pages/light/PostEditPage.js') },
  { path: '/light/media',          load: () => import('./pages/light/MediaPage.js') },
  { path: '/light/tags',           load: () => import('./pages/light/TagsManagerPage.js') },
  { path: '/light/tags/:slug',     load: () => import('./pages/light/TagsManagerPage.js') },
  { path: '/light/themes',         load: () => import('./pages/light/ThemesPage.js') },
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
