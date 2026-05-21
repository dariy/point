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
  }

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
   * Override to unsubscribe from store, cancel timers, etc.
   */
  beforeUnmount() {}

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
   * Cleans up: call beforeUnmount on self and all children, clear container.
   */
  unmount() {
    this._unmountChildren();
    this.beforeUnmount();
    this.container.textContent = '';
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _rerender() {
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
        |-- _unmountChildren()        (clean up any previous children)
        |-- container.innerHTML = render()
        `-- afterRender()             (attach events, mount children)
                |
                v (user interaction or async data)
        .setState(delta)
                |
                |-- merge state
                `-- _rerender()
                        |
                        |-- _unmountChildren()
                        |-- container.innerHTML = render()
                        `-- afterRender()
                |
                v (navigation away or parent re-renders)
        .unmount()
                |
                |-- _unmountChildren()
                |-- beforeUnmount()    (clean up subscriptions, timers)
                `-- container.textContent = ''
```

### 2.3 — Example: Simple Component

```javascript
// frontend/src/components/Pagination.js
import { Component } from './Component.js';
import { escapeHtml } from '../utils/helpers.js';

export class Pagination extends Component {
  // props: { page, totalPages, onPageChange }

  render() {
    const { page, totalPages } = this.props;
    if (totalPages <= 1) return '';

    const prev = page > 1
      ? `<button class="btn btn-ghost" data-page="${page - 1}">&larr; Prev</button>`
      : `<button class="btn btn-ghost" disabled>&larr; Prev</button>`;

    const next = page < totalPages
      ? `<button class="btn btn-ghost" data-page="${page + 1}">Next &rarr;</button>`
      : `<button class="btn btn-ghost" disabled>Next &rarr;</button>`;

    return `
      <nav class="pagination">
        ${prev}
        <span class="pagination__info">
          Page ${escapeHtml(String(page))} of ${escapeHtml(String(totalPages))}
        </span>
        ${next}
      </nav>
    `;
  }

  afterRender() {
    this.$$('button[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.props.onPageChange(parseInt(btn.dataset.page, 10));
      });
    });
  }
}
```

### 2.4 — Example: Async Component (loads data)

```javascript
// frontend/src/pages/public/HomePage.js
import { Component } from '../../components/Component.js';
import { PostGrid } from '../../components/PostGrid.js';
import { pagesApi } from '../../api/pages.js';

export class HomePage extends Component {
  // props: {} (no external props)

  constructor(container, props) {
    super(container, props);
    this.state = { loading: true, data: null, error: null };
  }

  render() {
    const { loading, data, error } = this.state;
    if (loading) return '<div class="loading-spinner"></div>';
    if (error)   return `<div class="error-state"><p class="error-message"></p></div>`;
    return `
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

    // Auth guard for admin routes
    if (isAdminRoute && !isPublicRoute) {
      const user = store.get('user');
      if (!user) {
        this.navigate('/light/login', { replace: true });
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
    if (this._listeners[key]) {
      this._listeners[key].forEach(fn => fn(value));
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

All `/light/*` pages (except login) are wrapped in `AdminLayout`:

```
AdminLayout renders:
  <div class="admin-layout">
    <aside class="sidebar" id="sidebar-mount"></aside>
    <main class="admin-main" id="page-content-mount"></main>
  </div>

Then mounts:
  - Sidebar into #sidebar-mount
  - The actual page component into #page-content-mount
```

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
      router.navigate('/light/login');
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
    // Build empty state with DOM methods (no innerHTML needed for simple content)
    return `<div class="empty-state"><p class="empty-state__text"></p></div>`;
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
