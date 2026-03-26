# Tag Ancestor Flyout — Public Pages Design

**Date**: 2026-03-26
**Status**: Approved

## Problem

Tag ancestor flyout (click a leaf tag → see its parent chain) works only incidentally on image PostCards (due to a side-effect `stopPropagation` call). It fails everywhere else — post pages, text cards, TagCloud, TagsPage — because:

1. **Router bug**: `router.js` `_onLinkClick` ignores `event.defaultPrevented`. The flyout handler calls `e.preventDefault()` and shows the flyout, but the router fires next on the document and calls `this.navigate(href)` anyway, immediately navigating away.

2. **navTags not loaded**: `navTags` (the tag hierarchy needed to compute ancestors) is only written to the store when `HomePage` or `TagPage` loads. On direct `/post/:slug` access, it is never fetched → `tagIndex = null` → `setupTagFlyout` bails immediately.

## Solution

### Global navTags cache (auth-aware)

Load the full tag hierarchy once at app bootstrap, after the auth check, so the correct set is returned:
- **Guests**: only public/visible tags
- **Admin**: all tags including hidden ones

Refresh on:
- Login/logout (user store key changes)
- Admin tag edit/delete

### Components

**1. Go: `GET /api/pages/nav`**
- New lightweight endpoint, `OptionalAuthMiddleware`
- Returns `{ menu: TagNode[] }` — same nested tree already built by `GetHomePage` / `GetTagPage`
- No posts, no pagination

**2. Frontend: `src/api/pages.js`**
- Add `getNavMenu()` → calls `GET /api/pages/nav`

**3. `app.js` bootstrap**
- After `getMe()` / `store.set('user', user)`, fetch navTags:
  ```js
  const navData = await getNavMenu().catch(() => ({ menu: [] }));
  store.set('navTags', navData.menu || []);
  ```
- After `router.init()`, register a subscriber for login/logout — registering *after* the initial bootstrap `store.set('user', ...)` avoids a double-fetch:
  ```js
  store.subscribe('user', async () => {
    const navData = await getNavMenu().catch(() => ({ menu: [] }));
    store.set('navTags', navData.menu || []);
  });
  ```

**4. `router.js` — fix root cause of redirect-on-flyout**
```js
_onLinkClick(event) {
  if (event.defaultPrevented) return;  // respect flyout / other handlers
  ...
}
```

**5. `TagsManagerPage.js` — refresh after tag mutations**
After any successful tag mutation that changes the hierarchy, call:
```js
const fresh = await getNavMenu().catch(() => ({ menu: [] }));
store.set('navTags', fresh.menu || []);
```
This covers all five mutation call-sites:
- Modal save: `createTag` / `updateTag`
- Delete: `_handleDelete`
- Drag-and-drop reparent: `updateTag` call in the reparent branch (~line 550)
- Drag-and-drop reorder: `reorderTag` call in the reorder branch (~line 558)

`recalculateCounts` and `geocodeTag` do not change hierarchy — no refresh needed there.

**6. `TagCloud.js` — add flyout wiring**
Add `afterRender()` calling `setupTagFlyout` on `.tag-cloud`, and `beforeUnmount()` cleanup.

**7. `TagsPage.js` — add flyout wiring**
Add `setupTagFlyout` call in `afterRender()` on the `.tags-tree` element.

**8. Cleanup**
- `HomePage`: remove the `store.set('navTags', navTags)` write — now redundant.
- `TagPage`: remove only the `store.set('navTags', rootMenu)` write. Do NOT change what `TagPage` passes to `PublicHeader` — it intentionally passes `navChildren` (the current tag's children) to `PublicHeader` so the header tags bar shows child navigation on sub-tag pages, not the root tree. This behaviour must be preserved.

## Data flow

```
app bootstrap
  → getMe()
  → store.set('user', ...)
  → getNavMenu()          ← auth-scoped
  → store.set('navTags', menu)
  → router.init()         ← all pages already have navTags

tag click (any public page)
  → setupTagFlyout click handler: e.preventDefault(), show flyout
  → event bubbles to document
  → router._onLinkClick: event.defaultPrevented → return (no navigation)
  → flyout stays visible

user clicks ancestor in flyout
  → plain <a href="/tag/..."> click, no preventDefault
  → router navigates normally

admin edits tag
  → save API call succeeds
  → getNavMenu() → store.set('navTags', fresh)
  → all subscribed components re-render with updated hierarchy

login/logout
  → store.set('user', ...) fires subscriber
  → getNavMenu() → store.set('navTags', auth-scoped set)
```

## Files changed

| File | Change |
|------|--------|
| `api/cmd/api/main.go` | Register `GET /api/pages/nav` route |
| `api/internal/api/pages.go` | Add `GetNavMenu` handler |
| `frontend/src/api/pages.js` | Add `getNavMenu()` |
| `frontend/src/app.js` | Fetch navTags post-auth; subscribe to user changes |
| `frontend/src/router.js` | Check `event.defaultPrevented` in `_onLinkClick` |
| `frontend/src/components/public/TagCloud.js` | Wire `setupTagFlyout` |
| `frontend/src/pages/public/TagsPage.js` | Wire `setupTagFlyout` |
| `frontend/src/pages/public/HomePage.js` | Remove `store.set('navTags', ...)` |
| `frontend/src/pages/public/TagPage.js` | Remove `store.set('navTags', ...)` |
| `frontend/src/pages/light/TagsManagerPage.js` | Refresh navTags after mutations |

## Non-goals

- No changes to `PostContent` or `PublicFooter` flyout setup — already correct once navTags is loaded and router is fixed.
- No changes to `PublicHeaderTagsBar` — uses its own accordion groups, not the ancestor flyout.
- No changes to the flyout UI/CSS.
