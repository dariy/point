/**
 * Client-side History API router.
 *
 * Routes are plain objects with a `path` pattern and an async `load` factory
 * that returns a { default: Component } module (for lazy loading via import()).
 *
 * Route matching supports:
 *   /exact/path
 *   /path/:param         (single named segment)
 *   /path/:param/rest    (params anywhere in the path)
 *
 * Usage:
 *   import { router } from './router.js';
 *
 *   router.init([
 *     { path: '/',             load: () => import('./pages/public/HomePage.js'),    public: true },
 *     { path: '/post/:slug',   load: () => import('./pages/public/PostPage.js'),    public: true },
 *     { path: '/light',        load: () => import('./pages/light/DashboardPage.js') },
 *     { path: '/light/login',  load: () => import('./pages/light/LoginPage.js'),    public: true },
 *   ], {
 *     mountPoint: document.getElementById('app'),
 *     authGuard: () => !!store.get('user'),
 *     loginPath: '/light/login',
 *   });
 *
 * The router also listens for the 'app:navigate' custom event dispatched by
 * the navigate() helper in utils/helpers.js, keeping components decoupled
 * from the router module.
 */

import { store } from './store.js';

class Router {
  constructor() {
    /** @type {Array<{ path: string, load: Function, public?: boolean }>} */
    this._routes = [];
    /** @type {HTMLElement|null} */
    this._mountPoint = null;
    /** @type {Function|null} returns true if user is authenticated */
    this._authGuard = null;
    /** @type {string} */
    this._loginPath = '/light/login';
    /** @type {string} */
    this._setupPath = '/setup';
    /** @type {import('./components/Component.js').Component|null} */
    this._currentPage = null;

    this._onPopState = this._onPopState.bind(this);
    this._onNavigate = this._onNavigate.bind(this);
    this._onUnauthorized = this._onUnauthorized.bind(this);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Initialise the router and render the current URL.
   *
   * @param {Array<{ path: string, load: Function, public?: boolean }>} routes
   * @param {{ mountPoint: HTMLElement, authGuard?: Function, loginPath?: string, setupPath?: string }} opts
   */
  init(routes, { mountPoint, authGuard = null, loginPath = '/light/login', setupPath = '/setup' } = {}) {
    this._routes = routes;
    this._mountPoint = mountPoint;
    this._authGuard = authGuard;
    this._loginPath = loginPath;
    this._setupPath = setupPath;

    window.addEventListener('popstate', this._onPopState);
    window.addEventListener('app:navigate', this._onNavigate);
    window.addEventListener('api:unauthorized', this._onUnauthorized);

    // Intercept <a> clicks for in-app navigation.
    document.addEventListener('click', this._onLinkClick.bind(this));

    // Render the current URL on boot.
    this._render(location.pathname + location.search);
  }

  /** Render the standard 404 fallback without changing the URL. */
  notFound() {
    this._showFallback('404', 'Page not found.');
  }

  /**
   * Programmatically navigate to a path.
   * @param {string} path
   * @param {{ replace?: boolean }} [opts]
   */
  navigate(path, { replace = false } = {}) {
    if (replace) {
      history.replaceState(null, '', path);
    } else {
      history.pushState(null, '', path);
    }
    this._render(path);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _onPopState() {
    this._render(location.pathname + location.search);
  }

  _onNavigate(event) {
    const { path, replace } = event.detail;
    this.navigate(path, { replace });
  }

  _onUnauthorized() {
    window.dispatchEvent(new CustomEvent('app:login-required', { detail: { next: null } }));
  }

  /** Intercept clicks on same-origin <a> elements. */
  _onLinkClick(event) {
    if (event.defaultPrevented) return;
    const anchor = event.target.closest('a[href]');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('http') || href.startsWith('//') ||
        href.startsWith('mailto:') || href.startsWith('#') ||
        anchor.hasAttribute('data-external') || anchor.target === '_blank') {
      return;
    }
    event.preventDefault();
    this.navigate(href);
  }

  /**
   * Match a route pattern against a pathname. Returns params object or null.
   *
   * @param {string} pattern   e.g. '/post/:slug'
   * @param {string} pathname  e.g. '/post/my-first-post'
   * @returns {Record<string,string>|null}
   */
  _match(pattern, pathname) {
    const patParts = pattern.split('/');
    const urlParts = pathname.split('/');
    if (patParts.length !== urlParts.length) return null;

    const params = {};
    for (let i = 0; i < patParts.length; i++) {
      if (patParts[i].startsWith(':')) {
        params[patParts[i].slice(1)] = decodeURIComponent(urlParts[i]);
      } else if (patParts[i] !== urlParts[i]) {
        return null;
      }
    }
    return params;
  }

  /**
   * Parse query string into a plain object.
   * @param {string} search  e.g. '?page=2&q=foo'
   * @returns {Record<string,string>}
   */
  _parseSearch(search) {
    const out = {};
    for (const [k, v] of new URLSearchParams(search)) {
      out[k] = v;
    }
    return out;
  }

  /**
   * Resolve the route for a path, unmount the current page, mount the new one.
   * @param {string} fullPath  pathname + optional search string
   */
  async _render(fullPath) {
    const qIndex = fullPath.indexOf('?');
    const pathname = qIndex === -1 ? fullPath : fullPath.slice(0, qIndex);
    const search = qIndex === -1 ? '' : fullPath.slice(qIndex);
    const query = this._parseSearch(search);

    // Login path: delegate entirely to the overlay system, never unmount current page.
    if (pathname === this._loginPath) {
      const next = query.next ? decodeURIComponent(query.next) : null;
      window.dispatchEvent(new CustomEvent('app:login-required', { detail: { next } }));
      return;
    }

    let matchedRoute = null;
    let params = {};
    for (const route of this._routes) {
      const p = this._match(route.path, pathname);
      if (p !== null) {
        matchedRoute = route;
        params = p;
        break;
      }
    }

    if (!matchedRoute) {
      if (pathname.startsWith('/light') && pathname !== '/light') {
        store.set('toast', { message: 'Page not found.', type: 'error' });
        this.navigate('/light', { replace: true });
      } else {
        this._showFallback('404', 'Page not found.');
      }
      return;
    }

    // Setup guard: if navigating to /light/* and setup is not complete, redirect to /setup.
    // If already on /setup but setup is complete, redirect to /light.
    if (pathname.startsWith('/light') || pathname === this._setupPath) {
      try {
        const res = await fetch('/api/setup/status', { credentials: 'include' });
        if (!res.ok) throw new Error('unavailable');
        const data = await res.json();
        if (!data.setup_complete && pathname !== this._setupPath) {
          this.navigate(this._setupPath, { replace: true });
          return;
        }
        if (data.setup_complete && pathname === this._setupPath) {
          this.navigate('/light', { replace: true });
          return;
        }
      } catch {
        // If the status check fails, proceed normally (e.g. network error).
      }
    }

    // Auth guard: show login overlay without unmounting the current page.
    if (!matchedRoute.public && this._authGuard && !this._authGuard()) {
      history.replaceState(null, '', `${this._loginPath}?next=${encodeURIComponent(fullPath)}`);
      window.dispatchEvent(new CustomEvent('app:login-required', { detail: { next: fullPath } }));
      return;
    }

    if (this._currentPage) {
      this._currentPage.unmount();
      this._currentPage = null;
    }

    store.set('route', { pathname, params, query });

    try {
      const mod = await matchedRoute.load();
      const PageClass = mod.default;
      this._currentPage = new PageClass(this._mountPoint, { params, query });
      this._currentPage.mount();
    } catch (err) {
      console.error('[Router] Failed to load page:', err);
      if (pathname.startsWith('/light') && pathname !== '/light') {
        store.set('toast', { message: 'Failed to load page. Please try again.', type: 'error' });
        this.navigate('/light', { replace: true });
      } else {
        this._showFallback('Error', 'Failed to load page. Please try again.');
      }
    }
  }

  /**
   * Render a simple static fallback (404 / error) using safe DOM methods.
   * No user content is interpolated here so no escaping is needed.
   *
   * @param {string} heading
   * @param {string} body
   */
  _showFallback(heading, body) {
    if (this._currentPage) {
      this._currentPage.unmount();
      this._currentPage = null;
    }
    if (!this._mountPoint) return;

    const wrap = document.createElement('div');
    wrap.className = 'error-page';

    const h1 = document.createElement('h1');
    h1.textContent = heading;

    const p = document.createElement('p');
    p.textContent = body;

    const link = document.createElement('a');
    link.href = '/';
    link.textContent = 'Go home';

    wrap.append(h1, p, link);
    this._mountPoint.textContent = '';
    this._mountPoint.appendChild(wrap);
  }
}

/** Singleton router instance. */
export const router = new Router();
