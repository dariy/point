# Tag Ancestor Flyout — Public Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the tag ancestor flyout work reliably on all public pages (post page, TagCloud, TagsPage) by fixing the router bug and loading the tag hierarchy globally at bootstrap.

**Architecture:** A new lightweight `GET /api/pages/nav` endpoint returns the auth-scoped tag tree. `app.js` fetches it after the auth check and stores it globally; all existing flyout code (`setupTagFlyout`, `setupTagStrip`) already reads from `store.get('navTags')` and works correctly once the store is populated. The router is patched to respect `event.defaultPrevented` so the flyout isn't dismissed by SPA navigation.

**Tech Stack:** Go 1.25 + Echo v4 (backend), Vanilla JS SPA (frontend), SQLite via sqlc.

---

## File Map

| File | Change |
|------|--------|
| `api/internal/api/pages.go` | Add `GetNavMenu` handler |
| `api/internal/api/pages_test.go` | Add test for `GetNavMenu` |
| `api/cmd/api/main.go` | Register `GET /api/pages/nav` route |
| `frontend/src/api/pages.js` | Add `getNavMenu()` |
| `frontend/src/router.js` | Check `event.defaultPrevented` in `_onLinkClick` |
| `frontend/src/app.js` | Fetch navTags post-auth; subscribe after `router.init()` |
| `frontend/src/components/public/TagCloud.js` | Add imports + `afterRender()` + `beforeUnmount()` |
| `frontend/src/pages/public/TagsPage.js` | Update imports + add flyout in `afterRender()` + `beforeUnmount()` |
| `frontend/src/pages/light/TagsManagerPage.js` | Add import + `_refreshNavHierarchy()` + 3 call sites |
| `frontend/src/pages/public/HomePage.js` | Remove redundant `store.set('navTags', ...)` |
| `frontend/src/pages/public/TagPage.js` | Remove redundant `store.set('navTags', ...)` |

---

## Task 1: Go — `GetNavMenu` handler + test

**Files:**
- Modify: `api/internal/api/pages.go`
- Modify: `api/internal/api/pages_test.go`

### Background

`GetHomePage` calls `h.tagService.GetHierarchicalNavTags(ctx, nil, publicOnly, minPosts)` to build the nav tree and returns it as `"menu"`. `GetNavMenu` does the same thing but returns *only* that — no posts, no pagination.

Helpers `getSettingOr` (in `feeds.go`) and `getMinTagPostsSetting` (in `pages.go`) are in the same `api` package and can be called directly.

- [ ] **Step 1: Write the failing test** — add to `api/internal/api/pages_test.go`:

```go
func TestPagesHandler_GetNavMenu(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	tagSvc := services.NewTagService(repo)
	postService := services.NewPostService(repo)
	settingsService := services.NewSettingsService(repo)
	cacheService := services.NewCacheService(t.TempDir())
	handler := NewPagesHandler(repo, postService, tagSvc, settingsService, cacheService)

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/pages/nav", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := handler.GetNavMenu(c); err != nil {
		t.Fatalf("GetNavMenu failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	var result map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if _, ok := result["menu"]; !ok {
		t.Error("expected 'menu' key in response")
	}
}
```

(Verify that `pages_test.go` already imports `encoding/json`, `net/http`, `net/http/httptest`, `testing`, `github.com/labstack/echo/v4`, and the `services` package. Add any that are missing before running the test.)

- [ ] **Step 2: Run test — expect compile error** (method does not exist yet)

```bash
cd /home/light/src/blog/point/api && go test ./internal/api/... -run TestPagesHandler_GetNavMenu -v
```

Expected: `handler.GetNavMenu undefined`

- [ ] **Step 3: Implement `GetNavMenu`** — add after `GetHomePage` in `api/internal/api/pages.go`:

```go
// GetNavMenu returns the auth-scoped navigation tag hierarchy.
// Lightweight — no posts, no pagination.
func (h *PagesHandler) GetNavMenu(c echo.Context) error {
	ctx := c.Request().Context()
	user := c.Get("user")
	publicOnly := user == nil

	allSettings, _ := h.settingsService.GetAllSettings(ctx)
	minPosts := getMinTagPostsSetting(allSettings)

	navTags, _ := h.tagService.GetHierarchicalNavTags(ctx, nil, publicOnly, minPosts)

	return c.JSON(http.StatusOK, map[string]interface{}{
		"menu": navTags,
	})
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
cd /home/light/src/blog/point/api && go test ./internal/api/... -run TestPagesHandler_GetNavMenu -v
```

Expected: `PASS`

- [ ] **Step 5: Run full test suite**

```bash
cd /home/light/src/blog/point && ./scripts/run-tests.sh
```

Expected: all tests pass, no regressions.

- [ ] **Step 6: Commit**

```bash
git add api/internal/api/pages.go api/internal/api/pages_test.go
git commit -m "feat: add GetNavMenu handler returning auth-scoped tag tree"
```

---

## Task 2: Go — Register route

**Files:**
- Modify: `api/cmd/api/main.go:283-286`

The `pagesGroup` block currently has 4 routes (home, tag/:slug, tags, map). Add nav after map.

- [ ] **Step 1: Register the route** — in `api/cmd/api/main.go`, after the `/map` line:

```go
pagesGroup.GET("/nav", pagesHandler.GetNavMenu, api.OptionalAuthMiddleware(svcs.Auth))
```

The block becomes:
```go
pagesGroup.GET("/home", pagesHandler.GetHomePage, api.OptionalAuthMiddleware(svcs.Auth))
pagesGroup.GET("/tag/:slug", pagesHandler.GetTagPage, api.OptionalAuthMiddleware(svcs.Auth))
pagesGroup.GET("/tags", pagesHandler.GetTagsPage, api.OptionalAuthMiddleware(svcs.Auth))
pagesGroup.GET("/map", pagesHandler.GetMapPage, api.OptionalAuthMiddleware(svcs.Auth))
pagesGroup.GET("/nav", pagesHandler.GetNavMenu, api.OptionalAuthMiddleware(svcs.Auth))
```

- [ ] **Step 2: Build check**

```bash
cd /home/light/src/blog/point/api && go build ./...
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add api/cmd/api/main.go
git commit -m "feat: register GET /api/pages/nav route"
```

---

## Task 3: Frontend — `getNavMenu()` API helper

**Files:**
- Modify: `frontend/src/api/pages.js`

- [ ] **Step 1: Add the function** — append to `frontend/src/api/pages.js`:

```js
/**
 * Auth-scoped navigation tag hierarchy.
 * Guests receive only public tags; admin receives all tags.
 *
 * @returns {Promise<{ menu: object[] }>}
 */
export function getNavMenu() {
  return api.get('/api/pages/nav');
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/api/pages.js
git commit -m "feat: add getNavMenu() API helper"
```

---

## Task 4: Fix router — respect `event.defaultPrevented`

**Files:**
- Modify: `frontend/src/router.js:114`

### Background

`setupTagFlyout` calls `e.preventDefault()` on tag link clicks that have ancestors, then shows the flyout. The router's `_onLinkClick` does not check `event.defaultPrevented`, so it calls `this.navigate(href)` anyway — immediately navigating away and destroying the flyout. Adding the guard is a one-line fix.

- [ ] **Step 1: Add the guard** — in `frontend/src/router.js`, change `_onLinkClick`:

```js
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
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/router.js
git commit -m "fix: router respects event.defaultPrevented — fixes tag flyout being dismissed by navigation"
```

---

## Task 5: App bootstrap — load navTags globally

**Files:**
- Modify: `frontend/src/app.js`

Two changes:
1. Add `getNavMenu` to the import line.
2. Fetch navTags right after `store.set('user', user)` (step 3 in bootstrap).
3. Subscribe to `user` changes *after* `router.init()` to avoid a double-fetch on the initial `store.set('user', user)`.

- [ ] **Step 1: Update import** — change the `pages.js` import at the top of `app.js`. Currently there is no pages import; add one:

```js
import { getNavMenu } from './api/pages.js';
```

Add it after the existing imports (e.g., after `import { syncQueue } from './utils/sync.js';`).

- [ ] **Step 2: Fetch navTags after auth** — after line `store.set('user', user);` (currently step 3 in bootstrap), add step 3.5:

```js
  // 3.5 Fetch auth-scoped tag hierarchy — available on every page, used by flyout.
  try {
    const navData = await getNavMenu();
    store.set('navTags', navData.menu || []);
  } catch { /* offline — flyout gracefully absent */ }
```

- [ ] **Step 3: Subscribe after router.init()** — after the `router.init(...)` block (currently step 6), add step 6.5:

```js
  // 6.5 Refresh navTags on login/logout (registered after bootstrap to avoid double-fetch).
  store.subscribe('user', async () => {
    try {
      const navData = await getNavMenu();
      store.set('navTags', navData.menu || []);
    } catch { /* ignore */ }
  });
```

- [ ] **Step 4: Verify bootstrap order is correct**

The final bootstrap sequence in `bootstrap()` should be:
1. Fetch settings
2. Apply theme
3. Check auth → `store.set('user', user)`
3.5. Fetch navTags → `store.set('navTags', ...)`
4. Mount toasts
5. Subscribe to route changes
6. `router.init()`
6.5. Subscribe to user changes for navTags refresh
7. Sync queue

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app.js
git commit -m "feat: load auth-scoped navTags at bootstrap, refresh on login/logout"
```

---

## Task 6: Wire flyout in `TagCloud`

**Files:**
- Modify: `frontend/src/components/public/TagCloud.js`

`TagCloud` renders `.tag-cloud > li > a.tag-link` elements. `setupTagFlyout` looks for `.tag-link` within its container — passing `.tag-cloud` directly works.

- [ ] **Step 1: Update imports** — current imports are `Component` and `escapeHtml`. Add:

```js
import { escapeHtml, navigate } from '../../utils/helpers.js';
import { buildTagIndex, setupTagFlyout } from '../../utils/tags.js';
import { store } from '../../store.js';
```

(Replace the existing `import { escapeHtml } from '../../utils/helpers.js';` line.)

- [ ] **Step 2: Add `afterRender()` and `beforeUnmount()`** — after the closing `}` of `render()`, before the closing `}` of the class:

```js
  afterRender() {
    const navTags = store.get('navTags') || [];
    const tagIndex = navTags.length ? buildTagIndex(navTags) : null;
    const tagsEl = this.$('.tag-cloud');
    if (tagsEl) {
      this._cleanupFlyout = setupTagFlyout(tagsEl, tagIndex, navigate);
    }
  }

  beforeUnmount() {
    this._cleanupFlyout?.();
  }
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/public/TagCloud.js
git commit -m "feat: wire tag ancestor flyout in TagCloud"
```

---

## Task 7: Wire flyout in `TagsPage`

**Files:**
- Modify: `frontend/src/pages/public/TagsPage.js`

`TagsPage` renders a `.tags-tree` `<ul>` whose `<li>` elements each contain a `.tag-link` anchor. `setupTagFlyout` with `.tags-tree` as container finds all `.tag-link` descendants.

- [ ] **Step 1: Update imports**

Change:
```js
import { escapeHtml } from '../../utils/helpers.js';
import { renderTagLink } from '../../utils/tags.js';
```

To:
```js
import { escapeHtml, navigate } from '../../utils/helpers.js';
import { renderTagLink, buildTagIndex, setupTagFlyout } from '../../utils/tags.js';
```

- [ ] **Step 2: Add flyout setup in `afterRender()`** — current `afterRender()` only mounts header and footer children. Add flyout wiring after the child mounts:

```js
  afterRender() {
    const settings = store.get('settings') || {};
    const navTags = store.get('navTags') || [];
    this.mountChild(PublicHeader, '#header-mount', { settings, navTags, currentPath: '/tags' });
    this.mountChild(PublicFooter, '#footer-mount', { settings });

    const tagIndex = navTags.length ? buildTagIndex(navTags) : null;
    const tree = this.$('.tags-tree');
    if (tree) {
      this._cleanupFlyout = setupTagFlyout(tree, tagIndex, navigate);
    }
  }
```

- [ ] **Step 3: Add `beforeUnmount()`** — add after `afterRender()`:

```js
  beforeUnmount() {
    this._cleanupFlyout?.();
  }
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/public/TagsPage.js
git commit -m "feat: wire tag ancestor flyout in TagsPage"
```

---

## Task 8: Refresh navTags after tag mutations in `TagsManagerPage`

**Files:**
- Modify: `frontend/src/pages/light/TagsManagerPage.js`

Three mutation sites need a navTags refresh after success:
- Modal save (`createTag` / `updateTag`) — around line 1050
- Delete (`_handleDelete`) — around line 1081
- Drag-and-drop reparent/reorder — around line 564

### Steps

- [ ] **Step 1: Add `getNavMenu` import** — `TagsManagerPage` does not currently import from `pages.js`. Add to the imports block:

```js
import { getNavMenu } from '../../api/pages.js';
```

- [ ] **Step 2: Add `_refreshNavHierarchy()` helper method** — add anywhere in the class (e.g., just before `_handleDelete`):

```js
  /** Re-fetch and store the nav tag hierarchy after any mutation that changes it. */
  async _refreshNavHierarchy() {
    try {
      const navData = await getNavMenu();
      store.set('navTags', navData.menu || []);
    } catch { /* ignore — non-critical */ }
  }
```

- [ ] **Step 3: Call after modal save** — in the modal save `try` block (around line 1055), after the success toast and before `this._closeModal()`:

Current code:
```js
      if (tagId) {
        await updateTag(tagId, payload);
        store.set('toast', { message: 'Tag updated.', type: 'success' });
      } else {
        await createTag(payload);
        store.set('toast', { message: 'Tag created.', type: 'success' });
      }
      this._closeModal();
      this._load();
```

Change to:
```js
      if (tagId) {
        await updateTag(tagId, payload);
        store.set('toast', { message: 'Tag updated.', type: 'success' });
      } else {
        await createTag(payload);
        store.set('toast', { message: 'Tag created.', type: 'success' });
      }
      this._refreshNavHierarchy();
      this._closeModal();
      this._load();
```

- [ ] **Step 4: Call after delete** — in `_handleDelete` (around line 1082), after the success toast:

Current code:
```js
      await deleteTag(id);
      store.set('toast', { message: 'Tag deleted.', type: 'success' });
      this._load();
```

Change to:
```js
      await deleteTag(id);
      store.set('toast', { message: 'Tag deleted.', type: 'success' });
      this._refreshNavHierarchy();
      this._load();
```

- [ ] **Step 5a: Call after drag-and-drop reparent** — the reparent branch calls `updateTag` (~line 550). After the `updateTag` await and before `this._load()` in that branch:

Current code:
```js
          await updateTag(tagId, { parent_slug: targetSlug });
          this._load();
        } catch (err) {
          store.set('toast', { message: err.message || 'Move failed.', type: 'error' });
        }
```

Change to:
```js
          await updateTag(tagId, { parent_slug: targetSlug });
          this._refreshNavHierarchy();
          this._load();
        } catch (err) {
          store.set('toast', { message: err.message || 'Move failed.', type: 'error' });
        }
```

- [ ] **Step 5b: Call after drag-and-drop reorder** — the reorder branch calls `reorderTag` (~line 558). After the `reorderTag` await and before `this._load()` in that branch:

Current code:
```js
          await reorderTag(tagId, position);
          this._load();
        } catch (err) {
          store.set('toast', { message: err.message || 'Move failed.', type: 'error' });
        }
```

Change to:
```js
          await reorderTag(tagId, position);
          this._refreshNavHierarchy();
          this._load();
        } catch (err) {
          store.set('toast', { message: err.message || 'Move failed.', type: 'error' });
        }
```

Note: The exact variable names (`tagId`, `position`, `targetSlug`) and surrounding structure may differ slightly from the snippets above — read the actual drag-and-drop handler to confirm before editing.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/light/TagsManagerPage.js
git commit -m "feat: refresh navTags after tag mutations in TagsManagerPage"
```

---

## Task 9: Cleanup — remove redundant navTags writes

**Files:**
- Modify: `frontend/src/pages/public/HomePage.js:69`
- Modify: `frontend/src/pages/public/TagPage.js:90`

These lines were defensive writes to populate `navTags` from page API responses. Bootstrap now handles this, so they're redundant.

**Important for `TagPage`**: Only remove the `store.set('navTags', rootMenu)` line. Do NOT touch how `TagPage` passes `navChildren` to `PublicHeader` — that controls the header tags bar showing child tags on sub-tag pages and is intentional.

- [ ] **Step 1: `HomePage.js`** — remove line 69:

```js
if (navTags.length) store.set('navTags', navTags);
```

The surrounding code before:
```js
    const navTags = (this.state.data?.menu) || store.get('navTags') || [];
    if (navTags.length) store.set('navTags', navTags);   // ← remove this line
    this.mountChild(PublicHeader, '#header-mount', { settings, currentPath: '/', navTags });
```

After:
```js
    const navTags = (this.state.data?.menu) || store.get('navTags') || [];
    this.mountChild(PublicHeader, '#header-mount', { settings, currentPath: '/', navTags });
```

- [ ] **Step 2: `TagPage.js`** — remove line 90:

```js
if (rootMenu.length && this.state.data?.menu) store.set('navTags', rootMenu);
```

The surrounding code before:
```js
    const rootMenu = this.state.data?.menu || store.get('navTags') || [];
    if (rootMenu.length && this.state.data?.menu) store.set('navTags', rootMenu);  // ← remove
    const navChildren = this.state.data?.nav_children || [];
    const navTags = navChildren.length ? navChildren : rootMenu;
```

After:
```js
    const rootMenu = this.state.data?.menu || store.get('navTags') || [];
    const navChildren = this.state.data?.nav_children || [];
    const navTags = navChildren.length ? navChildren : rootMenu;
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/public/HomePage.js frontend/src/pages/public/TagPage.js
git commit -m "refactor: remove redundant per-page navTags writes (bootstrap now owns this)"
```

---

## Task 10: End-to-end verification

- [ ] **Step 1: Run all Go tests**

```bash
cd /home/light/src/blog/point && ./scripts/run-tests.sh
```

Expected: all pass.

- [ ] **Step 2: Build and start the dev server**

```bash
cd /home/light/src/blog/point/api && go run ./cmd/api
```

- [ ] **Step 3: Manual smoke tests**

Test the following scenarios:

| Scenario | Expected |
|----------|----------|
| Navigate directly to `/post/:slug` (fresh load) | Tags appear; clicking a leaf tag with ancestors shows flyout, does NOT navigate |
| Click ancestor link in flyout | Navigates to the ancestor tag page |
| Click a tag with no ancestors | Navigates directly to tag page (no flyout) |
| `/tag/:slug` page — click a tag in a post card | Flyout shows ancestors |
| Tag cloud on homepage | Clicking leaf tag shows flyout |
| `/tags` directory page | Clicking a leaf tag shows flyout |
| Immersive post page | Tags in footer bar show flyout |
| Admin: edit a tag (rename, reparent, drag-drop) | navTags refreshes; flyout reflects change without page reload |
| Admin: log out, log back in | navTags reloads with correct auth scope |
| Offline / API unreachable | Bootstrap continues without navTags; flyout absent but navigation works normally |

- [ ] **Step 4: Push**

```bash
git push
```
