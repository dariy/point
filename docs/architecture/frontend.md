# Frontend Architecture — Vanilla JS Component System

> **Created**: 2026-02-19
> **Status**: Design Specification
> **Companion**: [backend.md](./backend.md), [REFACTORING.md](./REFACTORING.md)

---

## Table of Contents

1. [Design Philosophy](#design-philosophy)
2. [Component System](#component-system)
3. [Client-Side Router](#client-side-router)
4. [Global State Store](#global-state-store)
5. [API Client Layer](#api-client-layer)
6. [Directory Structure](#directory-structure)
7. [Page Components — Public Blog](#page-components--public-blog)
8. [Page Components — Admin Panel](#page-components--admin-panel)
9. [Shared UI Components](#shared-ui-components)
10. [CSS Architecture](#css-architecture)
11. [Security Model](#security-model)
12. [Development Workflow](#development-workflow)
13. [Build & Deployment](#build--deployment)
14. [Conventions & Patterns](#conventions--patterns)

---

## Design Philosophy

The frontend is **framework-inspired, framework-free**:

- No build step required (ES modules natively in modern browsers)
- No virtual DOM — components own real DOM nodes and re-render in place
- No JSX — components return HTML strings via template literals
- No third-party dependencies (except Leaflet for maps, already vendored)
- Components are **classes** with a consistent lifecycle interface
- State flows **down** via props; events flow **up** via callbacks or the store
- The router is the single source of truth for which page is visible

This mirrors the mental model of React/Angular without their complexity or
build tooling.

---

## Component System

### 2.1 — Base Component Class

Every UI element inherits from `Component`. The class handles the contract
between a component and its DOM node.

```javascript
// frontend/src/components/Component.js

export class Component {
  /**
   * @param {HTMLElement} container - The DOM node this component renders into
   * @param {object} props - Initial properties (treated as immutable by component)
   */
  constructor(container, props = {}) {
    this.container = container;
    this.props = props;
    this.state = {};
    this._children = []; // child Component instances for lifecycle propagation
    this._cleanups = [];        // teardowns for THIS render's resources (see 2.3)
    this._actionTeardowns = []; // the delegated `actions` listeners (see 2.4)
    this._unmounted = false;
  }

  /**
   * Optional: delegated handlers keyed by `data-action` value (see 2.4).
   * @type {Object<string, function(Event, HTMLElement): void>|undefined}
   */

  /**
   * Returns an HTML string describing this component.
   * MUST be overridden by subclasses.
   * SECURITY: This string is set via innerHTML. Only include trusted,
   * server-sanitized HTML. Never interpolate raw user input directly —
   * always use escapeHtml() for any user-provided text values.
   * @returns {string}
   */
  render() {
    throw new Error(`${this.constructor.name}.render() not implemented`);
  }

  /**
   * Called after the component's HTML is written to the DOM.
   * Override to attach event listeners, mount child components.
   */
  afterRender() {}

  /**
   * Called before the component is removed from the DOM.
   * Override to release what outlives a single render — a poll timer started
   * in the constructor, say. Anything afterRender() acquires belongs in
   * registerCleanup() instead, which also runs BETWEEN renders.
   */
  beforeUnmount() {}

  /**
   * Optional hook, called before every render including the first.
   * The imperative sibling of registerCleanup(); override it when the teardown
   * is easier to write as one method than as a closure per resource.
   */
  beforeRender() {}

  /**
   * Merges newState into this.state and re-renders.
   * @param {object} newState
   */
  setState(newState) {
    this.state = { ...this.state, ...newState };
    this._rerender();
  }

  /**
   * Updates props and re-renders.
   * @param {object} newProps
   */
  setProps(newProps) {
    this.props = { ...this.props, ...newProps };
    this._rerender();
  }

  /**
   * Performs the initial render: write HTML and call afterRender.
   */
  mount() {
    this._rerender();
  }

  /**
   * Cleans up: release this render's resources, unmount children, call
   * beforeUnmount, clear container.
   */
  unmount() {
    this._unmounted = true;
    this._runCleanups();
    this._unmountChildren();
    this.beforeUnmount();
    this.container.textContent = '';
  }

  /**
   * Helper: register a teardown for something this render acquired.
   * Runs before the next re-render, or on unmount — whichever comes first —
   * and is then forgotten, so afterRender() re-registers freely.
   */
  registerCleanup(fn) {
    if (typeof fn === 'function') this._cleanups.push(fn);
  }

  /**
   * Helper: subscribe to a store key for the lifetime of the current render.
   */
  subscribeStore(storeInstance, key, callback) {
    this.registerCleanup(storeInstance.subscribe(key, callback));
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _rerender() {
    // Release the previous render while its DOM is still in place.
    this._runCleanups();
    this.beforeRender?.();
    this._unmountChildren();
    this._children = [];
    // SECURITY: render() returns trusted HTML only (see Security Model section)
    this.container.innerHTML = this.render();
    this.afterRender();
  }

  _unmountChildren() {
    for (const child of this._children) {
      child.unmount();
    }
    this._children = [];
  }

  _runCleanups() {
    const fns = this._cleanups;
    this._cleanups = [];   // cleared first: a teardown may re-render
    for (const fn of fns) {
      try { fn(); } catch (err) { console.error('cleanup failed', err); }
    }
  }

  /**
   * Helper: mount a child component into a DOM node inside this component.
   * Automatically registers it for cleanup on re-render.
   * @param {typeof Component} ComponentClass
   * @param {string|HTMLElement} target - CSS selector or element inside this.container
   * @param {object} props
   * @returns {Component} the mounted child instance
   */
  mountChild(ComponentClass, target, props = {}) {
    const el = typeof target === 'string'
      ? this.container.querySelector(target)
      : target;
    if (!el) throw new Error(`mountChild: target "${target}" not found`);
    const child = new ComponentClass(el, props);
    child.mount();
    this._children.push(child);
    return child;
  }

  /**
   * Resource helpers — registerCleanup() with the acquisition folded in, so
   * each releases at the next render boundary. See 2.3.
   */
  on(target, type, handler, options) { /* addEventListener + removeEventListener */ }
  timer(fn, ms) { /* setTimeout + clearTimeout */ }
  interval(fn, ms) { /* setInterval + clearInterval */ }
  observe(observer) { /* returns it; disconnect() on release */ }
  raf(fn) { /* requestAnimationFrame + cancelAnimationFrame */ }

  /**
   * Helper: query within this component's container.
   * @param {string} selector
   * @returns {HTMLElement|null}
   */
  $(selector) {
    return this.container.querySelector(selector);
  }

  /**
   * Helper: query all within this component's container.
   * @param {string} selector
   * @returns {NodeList}
   */
  $$(selector) {
    return this.container.querySelectorAll(selector);
  }
}
```

### 2.2 — Component Lifecycle

```
new Component(container, props)
        |
        v
  .mount()
        |
        |-- _bindActions()            (one delegated listener per event type,
        |                              on the container — see 2.4)
        |-- _runCleanups()            (empty on the first pass)
        |-- beforeRender()            (imperative teardown hook)
        |-- _unmountChildren()        (clean up any previous children)
        |-- container.innerHTML = render()
        `-- afterRender()             (attach events, mount children,
                |                      registerCleanup() what you acquire)
                v (user interaction or async data)
        .setState(delta)
                |
                |-- merge state
                `-- _rerender()
                        |
                        |-- _runCleanups()   <- releases the PREVIOUS render
                        |-- beforeRender()
                        |-- _unmountChildren()
                        |-- container.innerHTML = render()
                        `-- afterRender()
                |
                v (navigation away or parent re-renders)
        .unmount()
                |
                |-- _unbindActions()   (the delegated listeners, bound at mount)
                |-- _runCleanups()     (the last render's resources)
                |-- _unmountChildren()
                |-- beforeUnmount()    (whatever outlived a single render)
                `-- container.textContent = ''
```

Note where `_runCleanups()` sits: at the *top* of `_rerender()`, not the
bottom. A teardown therefore runs while the DOM it was wired to is still on
screen, which is what makes `removeEventListener` and observer `disconnect()`
land on the right nodes.

### 2.3 — Resource Lifetime

`afterRender()` runs again on **every** `setState()` / `setProps()`, so it is
not a mount hook. Anything it acquires — a `ResizeObserver`, a store
subscription, a listener on `document`/`window`, a node appended outside the
container, an `AbortController`, a timer — has to be released before the next
pass acquires its own copy. `registerCleanup()` is how:

```javascript
afterRender() {
  const ro = new ResizeObserver(() => this._refit());
  ro.observe(this.$('.panel'));
  this.registerCleanup(() => ro.disconnect());

  const onKey = (e) => this._onKey(e);
  document.addEventListener('keydown', onKey);
  this.registerCleanup(() => document.removeEventListener('keydown', onKey));

  // subscribeStore() and mountChild() are already built on it.
  this.subscribeStore(store, 'settings', () => this.setState({}));
}
```

The list is drained before each re-render and again on `unmount()`, then
forgotten — so re-registering on every pass is correct and expected.

Five helpers are that same registration with the acquisition folded in, which
matters because the shortest thing to type is what actually gets typed —
`frontend/src` carries 539 `addEventListener` calls against 102
`removeEventListener`:

| Helper | Acquires | Releases with |
|---|---|---|
| `on(target, type, fn, opts)` | `addEventListener` | `removeEventListener` (same `opts`) |
| `timer(fn, ms)` | `setTimeout` | `clearTimeout` |
| `interval(fn, ms)` | `setInterval` | `clearInterval` |
| `observe(observer)` | nothing — takes one you built | `observer.disconnect()` |
| `raf(fn)` | `requestAnimationFrame` | `cancelAnimationFrame` |

So the block above is really:

```javascript
afterRender() {
  this.observe(new ResizeObserver(() => this._refit())).observe(this.$('.panel'));
  this.on(document, 'keydown', (e) => this._onKey(e));
  this.subscribeStore(store, 'settings', () => this.setState({}));
}
```

`on()` treats a missing target as a no-op and returns `null`, so the result of
`this.$('.maybe')` can go straight in. `observe()` returns its argument, which
is what lets the observer line stay one statement. Everything they hold is
render-scoped: a resource that must outlive renders — a poll started once in the
constructor — belongs in `beforeUnmount()`, not in these.

**Do not guard an acquisition with an "already done this" flag.** It looks like
it prevents a leak and does the opposite now: the flag survives the cleanup
that released the resource, so the second render gets neither the old
subscription nor a new one. Twelve admin pages carried the mirror-image bug —
they stored `setupAdminLayout`'s teardown in an instance field, overwrote it on
every render and only ever called the last one, leaking an observer and two
store subscriptions per `setState()`. Each leaked subscription closed over the
same live page, so a single `autosave_status` update rewrote the header once
per leaked copy (`frontend/test/componentCleanup.test.js`).

Use `beforeRender()` instead when the teardown is genuinely one method rather
than one closure per resource (`PostContent`, `PublicHeader`, `BackupsSection`).
It runs in the same place, right after the cleanup list.

Reach for `beforeUnmount()` only for what outlives a render — a poll timer
started in the constructor, a portal node created once.

### 2.4 — Event Delegation with `data-action`

A component may declare an `actions` map instead of wiring buttons one at a
time. `mount()` binds **one** listener per event type to `this.container`, and
`unmount()` releases it:

```javascript
export class CommentRows extends Component {
  actions = {
    delete(e, el) { this._delete(Number(el.dataset.i)); },
    block(e, el) { this._block(Number(el.dataset.i)); },
    'change:select-all'(e, el) { this._selectAll(el.checked); },
  };

  render() {
    return html`
      <input type="checkbox" data-action="select-all">
      ${rows.map((r, i) => html`
        <button data-action="delete" data-i="${i}">${raw(TRASH_SVG)}</button>
        <button data-action="block"  data-i="${i}">Block</button>
      `)}`;
  }
}
```

The rules, all of them:

- A **bare key answers `click`**. Any other event type is written into the key
  as `'<type>:<name>'`, and the set of types to delegate is read off the map —
  there is no second list to keep in sync, because a second list is a thing to
  forget, and forgetting it yields a control that silently does nothing.
- The handler is called with `this` bound to the component, the event, and the
  nearest `[data-action]` **ancestor** of `event.target` — so a click landing on
  an icon inside the button still finds the button.
- An event originating inside a child mounted with `mountChild()` belongs to
  that child and is not dispatched again by the parent.

Why this and not `afterRender()`: `this.container` is the one node that survives
a re-render, so the binding happens once instead of being re-attached on every
pass. That retires both halves of the usual pair of bugs — a listener never
re-attached is a dead button, and one attached twice fires twice — along with
the `querySelector` + `addEventListener` pair per control.

Keep `on()` for what delegation cannot express: a listener on `document` or
`window`, one that needs `capture` or `passive`, or a handler on a specific node
rather than a class of them.

### 2.5 — Example: Simple Component

```javascript
// frontend/src/components/shared/Pagination.js
import { Component } from '../Component.js';
import { html } from '../../utils/helpers.js';

export class Pagination extends Component {
  // props: { page, pages, total, minPage, onPage }

  render() {
    const { page, pages, total } = this.props;
    const minPage = this._minPage();
    // A markup helper with nothing to render returns '' — html`` yields a
    // String OBJECT, so an empty one is still truthy to a caller testing it.
    if (!pages || pages - minPage < 1) return html``;

    const buttons = this._buildItems(page, pages, minPage).map((item) => html`
      <button class="page-btn${item === page ? ' active' : ''}"
              data-action="page" data-page="${item}" type="button">${item}</button>`);

    return html`
      <nav class="pagination" aria-label="Page navigation">
        <button class="page-btn page-prev" data-action="page" data-page="${page - 1}"
                type="button"${page <= minPage ? html` disabled` : ''}
                aria-label="Previous page">&#8592;</button>
        <span class="page-numbers">${buttons}</span>
        <button class="page-btn page-next" data-action="page" data-page="${page + 1}"
                type="button"${page >= pages ? html` disabled` : ''}
                aria-label="Next page">&#8594;</button>
        <span class="page-info" aria-live="polite">${total} items</span>
      </nav>`;
  }

  // One listener on the container for the whole strip, bound at mount() — the
  // buttons themselves are rebuilt on every render (see 2.4).
  actions = {
    page(e, el) {
      if (el.disabled) return;
      const p = parseInt(el.dataset.page, 10);
      if (p >= this._minPage() && p <= this.props.pages && this.props.onPage) {
        this.props.onPage(p);
      }
    },
  };
}
```

Note what `render()` does *not* do: no `escapeHtml()` by hand. The html tagged
template escapes every interpolation on the way through, and
`Component._rerender()` rejects anything that is not its output — see
[Security Model](#security-model).

### 2.6 — Example: Async Component (loads data)

```javascript
// frontend/src/pages/public/HomePage.js
import { Component } from '../../components/Component.js';
import { PostGrid } from '../../components/public/PostGrid.js';
import { html } from '../../utils/helpers.js';
import { pagesApi } from '../../api/pages.js';

export class HomePage extends Component {
  // props: {} (no external props)

  constructor(container, props) {
    super(container, props);
    this.state = { loading: true, data: null, error: null };
  }

  render() {
    const { loading, data, error } = this.state;
    if (loading) return html`<div class="loading-spinner"></div>`;
    if (error)   return html`<div class="error-state"><p class="error-message"></p></div>`;
    return html`
      <div class="home-page">
        <div class="home-posts" id="post-grid-mount"></div>
        <div class="home-sidebar" id="tag-cloud-mount"></div>
      </div>
    `;
  }

  afterRender() {
    const { data, error } = this.state;

    // Set error text via textContent (safe, no XSS risk)
    if (error) {
      const el = this.$('.error-message');
      if (el) el.textContent = error;
      return;
    }

    if (!data) return;

    this.mountChild(PostGrid, '#post-grid-mount', {
      posts: data.posts,
      pagination: data.pagination,
      onPageChange: (page) => this._loadPage(page),
    });
  }

  mount() {
    super.mount();          // renders loading state immediately
    this._loadPage(1);
  }

  async _loadPage(page) {
    this.setState({ loading: true, error: null });
    try {
      const data = await pagesApi.getHome({ page });
      this.setState({ loading: false, data });
    } catch (err) {
      this.setState({ loading: false, error: err.message });
    }
  }
}
```

---

## Client-Side Router

### 3.1 — Route Table

```javascript
// frontend/src/router.js

import { store } from './store.js';

// Public routes (no auth required)
const PUBLIC_ROUTES = [
  {
    pattern: /^\/$/,
    component: () => import('./pages/public/HomePage.js').then(m => m.HomePage),
  },
  {
    pattern: /^\/posts\/([^/]+)$/,
    component: () => import('./pages/public/PostPage.js').then(m => m.PostPage),
    params: ['slug'],
  },
  {
    pattern: /^\/tag\/([^/]+)$/,
    component: () => import('./pages/public/TagPage.js').then(m => m.TagPage),
    params: ['slug'],
  },
  {
    pattern: /^\/tags$/,
    component: () => import('./pages/public/TagsPage.js').then(m => m.TagsPage),
  },
  {
    pattern: /^\/map$/,
    component: () => import('./pages/public/MapPage.js').then(m => m.MapPage),
  },
  {
    pattern: /^\/preview\/([^/]+)$/,
    component: () => import('./pages/public/PreviewPage.js').then(m => m.PreviewPage),
    params: ['token'],
  },
];

// Admin routes (auth required unless marked public: true)
const LIGHT_ROUTES = [
  {
    pattern: /^\/light\/login$/,
    component: () => import('./pages/light/LoginPage.js').then(m => m.LoginPage),
    public: true,
  },
  {
    pattern: /^\/light\/?$/,
    component: () => import('./pages/light/DashboardPage.js').then(m => m.DashboardPage),
  },
  {
    pattern: /^\/light\/posts$/,
    component: () => import('./pages/light/PostsListPage.js').then(m => m.PostsListPage),
  },
  {
    pattern: /^\/light\/posts\/new$/,
    component: () => import('./pages/light/PostEditPage.js').then(m => m.PostEditPage),
  },
  {
    pattern: /^\/light\/posts\/(\d+)$/,
    component: () => import('./pages/light/PostEditPage.js').then(m => m.PostEditPage),
    params: ['id'],
  },
  {
    pattern: /^\/light\/media$/,
    component: () => import('./pages/light/MediaPage.js').then(m => m.MediaPage),
  },
  {
    pattern: /^\/light\/tags$/,
    component: () => import('./pages/light/TagsManagerPage.js').then(m => m.TagsManagerPage),
  },
  {
    pattern: /^\/light\/settings$/,
    component: () => import('./pages/light/SettingsPage.js').then(m => m.SettingsPage),
  },
  {
    pattern: /^\/light\/security$/,
    component: () => import('./pages/light/SecurityPage.js').then(m => m.SecurityPage),
  },
  {
    pattern: /^\/light\/system$/,
    component: () => import('./pages/light/SystemPage.js').then(m => m.SystemPage),
  },
];

const ALL_ROUTES = [...PUBLIC_ROUTES, ...LIGHT_ROUTES];
```

### 3.2 — Router Implementation

```javascript
export class Router {
  constructor(appEl) {
    this.appEl = appEl;       // #app DOM node
    this.current = null;      // currently mounted Component instance
    this._listen();
  }

  _listen() {
    window.addEventListener('popstate', () => this._resolve());
    // Intercept all <a> clicks within the app
    document.addEventListener('click', (e) => {
      const link = e.target.closest('a[href]');
      if (!link) return;
      const href = link.getAttribute('href');
      if (href && href.startsWith('/') && !href.startsWith('/api/')) {
        e.preventDefault();
        this.navigate(href);
      }
    });
  }

  /**
   * Programmatic navigation (e.g., after login).
   */
  navigate(path, { replace = false } = {}) {
    if (replace) {
      history.replaceState(null, '', path);
    } else {
      history.pushState(null, '', path);
    }
    this._resolve();
  }

  async _resolve() {
    const path = window.location.pathname;
    const match = this._match(path);

    if (!match) {
      this._render404();
      return;
    }

    const { route, params } = match;
    const isAdminRoute = path.startsWith('/light');
    const isPublicRoute = route.public === true;

    // Auth guard for admin routes. This is a HARD navigation
    // (window.location.assign), not this.navigate() — the login form must load in
    // its own fresh document, isolated from any third-party markup injected into
    // the guest shell via HEAD_HTML (see features/syndication.md).
    if (isAdminRoute && !isPublicRoute) {
      const user = store.get('user');
      if (!user) {
        window.location.assign(`/light/login?next=${encodeURIComponent(path)}`);
        return;
      }
    }

    // Lazy-load the component class
    const ComponentClass = await route.component();

    // Unmount current page
    if (this.current) {
      this.current.unmount();
    }

    // Mount new page
    this.current = new ComponentClass(this.appEl, params);
    this.current.mount();
  }

  _match(path) {
    for (const route of ALL_ROUTES) {
      const m = path.match(route.pattern);
      if (m) {
        const params = {};
        (route.params || []).forEach((name, i) => {
          params[name] = m[i + 1];
        });
        return { route, params };
      }
    }
    return null;
  }

  _render404() {
    if (this.current) this.current.unmount();
    // Use textContent for safe text rendering
    this.appEl.textContent = '';
    const h1 = document.createElement('h1');
    h1.textContent = '404';
    const p = document.createElement('p');
    p.textContent = 'Page not found.';
    const wrapper = document.createElement('div');
    wrapper.className = 'error-page';
    wrapper.appendChild(h1);
    wrapper.appendChild(p);
    this.appEl.appendChild(wrapper);
    this.current = null;
  }
}
```

### 3.3 — App Entry Point

```javascript
// frontend/src/app.js
import { Router } from './router.js';
import { store } from './store.js';
import { authApi } from './api/auth.js';

const router = new Router(document.getElementById('app'));

// On load, check if we have an active session
async function bootstrap() {
  try {
    const user = await authApi.me();
    store.set('user', user);
  } catch {
    store.set('user', null);
  }
  router._resolve();
}

bootstrap();
```

---

## Global State Store

A minimal reactive key-value store. Components subscribe to changes in
specific keys.

```javascript
// frontend/src/store.js

class Store {
  constructor() {
    this._state = {};
    this._listeners = {};   // key => Set of callback functions
  }

  get(key) {
    return this._state[key];
  }

  set(key, value) {
    this._state[key] = value;
    const listeners = this._listeners[key];
    if (!listeners) return;
    // Snapshot, and skip anyone unsubscribed along the way. Subscribers
    // re-render, and a re-render swaps this render's subscription for a fresh
    // one — iterating the live Set would visit the replacement (and its
    // replacement, forever), while calling a callback torn down earlier in
    // the same dispatch would run it against a dead component.
    for (const fn of [...listeners]) {
      if (this._listeners[key]?.has(fn)) fn(value);
    }
  }

  subscribe(key, callback) {
    if (!this._listeners[key]) this._listeners[key] = new Set();
    this._listeners[key].add(callback);
    // Return unsubscribe function
    return () => this._listeners[key].delete(callback);
  }
}

export const store = new Store();
```

**Store keys used across the app:**

| Key | Type | Description |
|---|---|---|
| `user` | `object or null` | Current authenticated user |
| `settings` | `object` | Public blog settings (title, description) |
| `theme` | `'dark' or 'light'` | UI theme |
| `toast` | `{message, type}` | Active toast notification |

---

## API Client Layer

### 5.1 — Base Client

```javascript
// frontend/src/api/client.js

export class ApiError extends Error {
  constructor(status, data) {
    super(data?.detail || `HTTP ${status}`);
    this.status = status;
    this.data = data;
  }
}

async function request(path, options = {}) {
  const url = `/api${path}`;

  const headers = { ...options.headers };
  // Only set Content-Type for JSON bodies (not FormData)
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, {
    ...options,
    headers,
    credentials: 'include',   // always send session cookie
  });

  if (res.status === 204) return null;

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    throw new ApiError(res.status, data);
  }

  return data;
}

export const api = {
  get: (path, params) => {
    const url = params
      ? `${path}?${new URLSearchParams(params)}`
      : path;
    return request(url, { method: 'GET' });
  },
  post: (path, body) => request(path, {
    method: 'POST',
    body: body instanceof FormData ? body : JSON.stringify(body),
  }),
  put: (path, body) => request(path, {
    method: 'PUT',
    body: JSON.stringify(body),
  }),
  patch: (path, body) => request(path, {
    method: 'PATCH',
    body: JSON.stringify(body),
  }),
  delete: (path) => request(path, { method: 'DELETE' }),
};
```

### 5.2 — Resource Modules

Each module mirrors its backend router:

```javascript
// frontend/src/api/posts.js
import { api } from './client.js';

export const postsApi = {
  list:      (params) => api.get('/posts', params),
  get:       (id)     => api.get(`/posts/${id}`),
  getBySlug: (slug)   => api.get(`/posts/slug/${slug}`),
  create:    (data)   => api.post('/posts', data),
  update:    (id, data) => api.put(`/posts/${id}`, data),
  delete:    (id)     => api.delete(`/posts/${id}`),
  publish:   (id)     => api.post(`/posts/${id}/publish`),
  withdraw:  (id)     => api.post(`/posts/${id}/withdraw`),
  preview:   (id)     => api.post(`/posts/${id}/preview`),
};
```

```javascript
// frontend/src/api/pages.js
import { api } from './client.js';

export const pagesApi = {
  getHome: (params)      => api.get('/pages/home', params),
  getTag:  (slug, params) => api.get(`/pages/tags/${slug}`, params),
  getTags: ()            => api.get('/pages/tags'),
};
```

---

## Directory Structure

```
frontend/
|-- index.html                      <- SPA shell (never changes)
|
|-- src/
|   |-- app.js                      <- Bootstrap: auth check + router start
|   |-- router.js                   <- Router class + route table
|   |-- store.js                    <- Global reactive state
|   |
|   |-- api/
|   |   |-- client.js               <- Base fetch wrapper
|   |   |-- auth.js                 <- /api/auth/*
|   |   |-- posts.js                <- /api/posts/*
|   |   |-- media.js                <- /api/media/*
|   |   |-- tags.js                 <- /api/tags/*
|   |   |-- settings.js             <- /api/settings/*
|   |   |-- system.js               <- /api/system/*
|   |   `-- pages.js                <- /api/pages/* (compound)
|   |
|   |-- components/                 <- Reusable UI components
|   |   |-- Component.js            <- Base class
|   |   |
|   |   |-- shared/                 <- Used in both public + light
|   |   |   |-- Modal.js
|   |   |   |-- Toast.js
|   |   |   |-- Pagination.js
|   |   |   |-- TagBadge.js
|   |   |   |-- ThemeToggle.js
|   |   |   |-- ConfirmDialog.js
|   |   |   `-- LoadingSpinner.js
|   |   |
|   |   |-- public/                 <- Public blog components
|   |   |   |-- PublicHeader.js
|   |   |   |-- PublicFooter.js
|   |   |   |-- PostCard.js
|   |   |   |-- PostGrid.js
|   |   |   |-- PostContent.js
|   |   |   |-- MediaLightbox.js
|   |   |   |-- TagCloud.js
|   |   |   `-- ImmersiveViewer.js
|   |   |
|   |   `-- light/                  <- Admin panel components
|   |       |-- AdminLayout.js
|   |       |-- Sidebar.js
|   |       |-- StatusSelect.js
|   |       |-- TagSelector.js
|   |       |-- MediaPicker.js
|   |       |-- MediaDropZone.js
|   |       |-- MarkdownEditor.js
|   |       |-- DataTable.js
|   |       |-- TreeView.js
|   |       |-- StatCard.js
|   |       |-- BackupsCard.js
|   |       `-- LogViewer.js
|   |
|   |-- pages/
|   |   |-- public/
|   |   |   |-- HomePage.js
|   |   |   |-- PostPage.js
|   |   |   |-- TagPage.js
|   |   |   |-- TagsPage.js
|   |   |   |-- MapPage.js
|   |   |   `-- PreviewPage.js
|   |   |
|   |   `-- light/
|   |       |-- LoginPage.js
|   |       |-- DashboardPage.js
|   |       |-- PostsListPage.js
|   |       |-- PostEditPage.js
|   |       |-- MediaPage.js
|   |       |-- TagsManagerPage.js
|   |       |-- SettingsPage.js
|   |       |-- SecurityPage.js
|   |       `-- SystemPage.js
|   |
|   `-- utils/
|       |-- formatters.js           <- Date, file size, truncation
|       |-- helpers.js              <- DOM helpers, escapeHtml, debounce
|       `-- validators.js          <- Client-side input validation
|
`-- css/
    |-- main.css                    <- Entry: imports everything
    |-- common/                     <- Shared design tokens + utilities
    |   |-- reset.css
    |   |-- tokens.css
    |   |-- utilities.css
    |   |-- badges.css
    |   |-- buttons.css
    |   |-- forms.css
    |   |-- modals.css
    |   |-- pagination.css
    |   |-- flash-messages.css
    |   |-- empty-state.css
    |   |-- category-chips.css
    |   `-- theme-toggle.css
    |-- light/                      <- Admin panel styles
    |   `-- (migrated from app/static/css/light/)
    `-- public/                     <- Public blog styles
        `-- (migrated from app/static/css/public/)
```

---

## Page Components — Public Blog

### HomePage

- Fetches `GET /api/pages/home`
- Renders `PostGrid` with paginated posts
- Renders `TagCloud` in sidebar
- Pagination triggers new fetch, replaces grid in place

### PostPage

- Fetches `GET /api/posts/slug/:slug`
- Renders post `content_html` directly into `PostContent`
- `PostContent` scans HTML for `img` elements and attaches `MediaLightbox`
- `PostContent` enhances `video` and `audio` elements with controls
- If post has `is_immersive` flag, wraps in `ImmersiveViewer`
- Updates `document.title` (via `textContent`, safe) and meta description

### TagPage

- Fetches `GET /api/pages/tags/:slug`
- Renders breadcrumb for tag hierarchy
- Renders `PostGrid` with posts for this tag

### TagsPage

- Fetches `GET /api/pages/tags`
- Renders hierarchical tag tree with thumbnails and post counts

### MapPage

- Fetches `GET /api/tags` (tags with location data)
- Initializes Leaflet map (already vendored)
- Places markers for each tag with a location
- Clicking a marker navigates to `/tags/:slug`

---

## Page Components — Admin Panel

### AdminLayout

`AdminLayout` is not a wrapper component but a pair of helpers each `/light/*`
page calls itself — a template for `render()` and a setup for `afterRender()`:

```javascript
render() {
  return adminLayoutTemplate({ title: 'Tags', actions, content });
}

afterRender() {
  setupAdminLayout(this, { currentPath: '/light/tags', publicUrl });
  // ...the page's own wiring
}
```

`adminLayoutTemplate` emits the shell — `.light-header` with its title row and
sync pill, `.light-content`, and mount points for the sidebar, bottom bar,
command palette and shortcut help. `setupAdminLayout` fills those in, adds the
public-site link, and takes out the header's resize observer and the two store
subscriptions behind the sync pill.

**It returns nothing on purpose.** Everything it acquires is registered on the
page's per-render cleanup list (see [2.3](#23--resource-lifetime)), so the next
re-render releases it. Pages must not store a teardown handle or call anything
from `beforeUnmount()` — that is precisely the shape that leaked.

### PostEditPage

The most complex admin component:

- If `props.id` is set: fetch post, populate form
- Textarea for content (Markdown or HTML)
- `TagSelector` with autocomplete
- `MediaDropZone` for inline media upload
- `StatusSelect` for draft/published/hidden/page
- Save button calls PUT or POST to API
- Auto-save draft every 30 seconds (debounced)

### TagsManagerPage

- Renders `TreeView` with full tag hierarchy
- Inline CRUD (add, edit, delete tags)
- Reorder support via `POST /api/tags/:id/reorder`

---

## Shared UI Components

### Modal

```javascript
// Usage example:
const modal = new Modal(document.body, {
  title: 'Confirm Delete',
  bodyText: 'This cannot be undone.',
  actions: [
    { label: 'Cancel', onClick: () => modal.close() },
    { label: 'Delete', variant: 'danger', onClick: () => handleDelete() },
  ],
});
modal.open();
```

Note: Modal body text is set via `textContent` (safe). If HTML body content
is needed, it must be server-generated and sanitized.

### Toast

```javascript
// Global toast system via store:
import { store } from '../store.js';
store.set('toast', { message: 'Post saved!', type: 'success' });
```

A `ToastContainer` component subscribes to `store.get('toast')` and renders
notifications in the corner. All toast messages are set via `textContent`.

### ThemeToggle

- Reads and writes `localStorage.theme`
- Toggles `data-theme="dark"` attribute on `document.documentElement`
- Subscribes to store key `theme`

---

## CSS Architecture

The CSS is **migrated unchanged** from `app/static/css/` to `frontend/css/`.
CSS custom properties (tokens) already provide the theming system. No
changes needed to CSS during the refactoring.

### Theme system

```css
/* frontend/css/common/tokens.css */
:root {
  --color-bg: #ffffff;
  --color-text: #1a1a1a;
}

[data-theme="dark"] {
  --color-bg: #0f0f0f;
  --color-text: #e0e0e0;
}
```

JavaScript sets the theme attribute:
```javascript
document.documentElement.setAttribute('data-theme', theme);
```

---

## Security Model

### innerHTML policy

The component system uses `container.innerHTML = this.render()` for
performance. This is safe **only** when the following rules are followed:

1. **Server-generated HTML** (`content_html` from the API): Post content is
   converted from Markdown server-side by a trusted formatter. The backend
   is responsible for sanitizing any user-submitted HTML before storage.
   The frontend renders `content_html` directly.

2. **User-input text in templates**: ALL user-input values interpolated into
   template literal HTML strings MUST be escaped with `escapeHtml()`:
   ```javascript
   // frontend/src/utils/helpers.js
   export function escapeHtml(str) {
     return String(str)
       .replace(/&/g, '&amp;')
       .replace(/</g, '&lt;')
       .replace(/>/g, '&gt;')
       .replace(/"/g, '&quot;')
       .replace(/'/g, '&#39;');
   }
   ```

3. **Dynamic text nodes**: Prefer setting text via `element.textContent = value`
   over interpolating into HTML strings when possible (e.g., error messages,
   user names, toast notifications).

4. **Attribute values**: URL values in `href` or `src` attributes must be
   validated to start with `/` or `https://` — never allow `javascript:`.

5. **No eval, no Function()**: Never execute strings as code.

### Auth security

- Sessions use HTTP-only cookies (set by server, invisible to JS)
- `credentials: 'include'` on all fetch calls to send the cookie
- CSRF protection: FastAPI + same-site cookie policy handles this
- The frontend never stores auth tokens in `localStorage`

### Content Security Policy (recommended)

Add a `Content-Security-Policy` header on the server:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'sha256-+20twPiohHfGLZsSvahDBaYeh7l+te5yNz5UDCAfqsA=';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:;
  media-src 'self' blob:;
  connect-src 'self';
  frame-ancestors 'none'
```

---

## Development Workflow

### Running backend

```bash
cd /home/light/src/blog/point
uvicorn app.main:app --reload --port 8000
```

### Running frontend (development)

Since there is no build step, serve `frontend/` as static files. The
simplest approach is to have the backend serve the frontend directory
(enabled by default after Phase A6):

```bash
# Just run the backend — it serves frontend/ at /assets/ and index.html as fallback
uvicorn app.main:app --reload --port 8000
# Visit http://localhost:8000
```

For standalone frontend development (talking to a remote backend):

```bash
cd /home/light/src/blog/point/frontend
python3 -m http.server 3000
# Visit http://localhost:3000
# API calls go to http://localhost:8000 via CORS
```

### No build step

ES modules are imported natively in the browser. There is no webpack,
vite, esbuild, or babel in the development workflow. This keeps the
project simple and debuggable.

For production, the same files are served as-is. If minification is ever
desired, it can be added as an optional pre-deployment step without
changing the architecture.

---

## Build & Deployment

### Single-container deployment

```
Docker container
|-- uvicorn (FastAPI, port 8000)
|   |-- /api/* -> JSON API
|   |-- /assets/* -> frontend/ static files
|   `-- /{any} -> frontend/index.html (SPA fallback)
`-- /data/ (volume: SQLite DB, media files, backups)
```

No nginx required for basic deployment. For scale, put nginx in front:

```
nginx
|-- /api/* -> proxy to uvicorn:8000
|-- /assets/* -> static file serve from frontend/
`-- / -> frontend/index.html
```

### Docker changes

```dockerfile
# Dockerfile (addition to existing COPY statements)
COPY frontend/ /app/frontend/
```

### Environment config

The frontend has no environment variables. The API base URL is always
`/api` (same origin). The backend's `CORS_ORIGINS` setting controls
cross-origin access during development.

---

## Conventions & Patterns

### Naming

| Item | Convention | Example |
|---|---|---|
| Component files | PascalCase | `PostCard.js` |
| Component classes | PascalCase | `class PostCard` |
| API modules | camelCase | `postsApi` |
| CSS classes | BEM-ish kebab | `.post-card__title` |
| Store keys | camelCase string | `blogSettings` |
| Route params | camelCase | `{ slug, page }` |

### Error handling pattern

```javascript
async _loadData() {
  this.setState({ loading: true, error: null });
  try {
    const data = await someApi.get();
    this.setState({ loading: false, data });
  } catch (err) {
    if (err.status === 401) {
      // Hard navigation, not router.navigate() — see the auth-guard note in 3.2.
      window.location.assign('/light/login');
      return;
    }
    this.setState({ loading: false, error: err.message });
  }
}
```

### Empty states

Every list or grid component renders a descriptive empty state:

```javascript
render() {
  if (!this.state.data?.length) {
    return html`<div class="empty-state"><p class="empty-state__text"></p></div>`;
  }
  // normal render
}

afterRender() {
  const emptyText = this.$('.empty-state__text');
  if (emptyText) {
    emptyText.textContent = 'No posts yet. Create your first post!';
  }
  // ...rest of afterRender
}
```

### Optimistic updates

For fast-feeling UI in the admin, use optimistic updates where safe:

```javascript
async _deleteTag(id) {
  const previousTags = this.state.tags;
  // Remove from list immediately
  this.setState({ tags: this.state.tags.filter(t => t.id !== id) });
  try {
    await tagsApi.delete(id);
  } catch (err) {
    // Revert and show error
    this.setState({ tags: previousTags });
    store.set('toast', { message: err.message, type: 'error' });
  }
}
```

### Link navigation

Always use `<a href="/path">` for internal links, not onclick navigation.
The router intercepts all internal `<a>` clicks automatically (see
Router section 3.2). This preserves browser back/forward behavior and
allows middle-click to open in a new tab.
