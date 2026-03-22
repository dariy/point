# Post Card Leaf Tags + Ancestor Flyout

**Date**: 2026-03-21
**Status**: approved
**Area**: Frontend — public post grid

---

## Problem

Post cards currently show all tags assigned to a post in a wrapping flex row. This has two issues:

1. Tags wrap onto multiple lines and push card content around, especially on dense grids.
2. All tags are shown — including parent/ancestor tags — which adds noise. If a post is tagged "Kyiv", showing "Ukraine" alongside it is redundant; the hierarchy is implicit.

## Goal

- Show only **leaf tags** on a post card (tags with no children in the public hierarchy).
- Show tags on a **single scrollable line** — no wrapping.
- On **first tap** of a leaf tag: show its **ancestor chain** in an upward flyout.
- On **second tap** of the same tag (flyout already showing): navigate to that tag's page.
- Ancestor tags in the flyout are also clickable (navigate directly to them).

---

## Tag Hierarchy Rules

- The canonical public tag tree is rooted at `_root` (a system tag). The tree is a strict tree (each node has exactly one parent), not a DAG.
- Tags excluded from public display: descendants of `_hidden` / `_hide_posts`, any tag whose slug starts with `_` (system tags).
- `navTags` from `store.get('navTags')` already represents this filtered tree; it is populated by `HomePage` and `TagPage` from the `menu` field of their API responses.
- **Leaf tag**: a tag node with `children.length === 0` in the navTags tree.
- When `store.get('navTags')` is `null`, `undefined`, or `[]` (e.g. direct cold navigation to `/post/:slug` or `/preview/:slug`): all post tags are shown as-is, no leaf filtering, no flyout. This is the correct graceful fallback.
- A tag on a post that does not appear in navTags is treated as a leaf with no ancestors (shown, no flyout).

---

## Architecture

No API changes. All logic is client-side, using the `navTags` tree already in the store.

### 1. Tag index utility — `frontend/src/utils/tags.js`

Add two exported functions:

**`buildTagIndex(navTags)`**

Recursively walks the navTags tree (which is a strict tree — each node has at most one parent) and returns a flat `Map<slug, { tag, parentSlug, isLeaf }>`:

```
slug         → the tag's slug (key)
tag          → { name, slug }
parentSlug   → parent's slug, or null for root-level tags
isLeaf       → tag.children.length === 0
```

**`getTagAncestors(slug, index)`**

Walks the parent chain from `slug` toward the root. Returns an array of tag objects in **root-first order**, omitting any system tags (slug starts with `_`).

Example: if the tree is `_root → country → Ukraine → Kyiv`, then `getTagAncestors('kyiv', index)` returns `[{name:'country',slug:'country'}, {name:'Ukraine',slug:'ukraine'}]` — immediate parent `Ukraine` is last, root-level `country` is first.

---

### 2. PostCard — `frontend/src/components/public/PostCard.js`

**New import required**: `import { store } from '../../store.js';` must be added to PostCard.

**Slug extraction**: rather than extending `renderTagLink`, the click handler derives the tag slug from the link's `href` attribute: `link.getAttribute('href').replace('/tag/', '')`. No changes to `renderTagLink` are needed.

#### render()

- Get `navTags = store.get('navTags') || []`.
- If `navTags` is empty: show `post.tags` as-is with no filtering (graceful fallback).
- Otherwise: build tag index with `buildTagIndex(navTags)`, filter `post.tags` to leaf tags: include the tag if `index.get(t.slug)?.isLeaf !== false` (leaf in tree, or not in tree).
- Render tags inside `.post-card-tags` — a single-line scrollable strip.

#### afterRender()

Intercepts clicks on `.post-card-tags .tag-link`. Tag slug is derived from `link.href` (not `data-slug`).

**Interaction logic**:
- **Click on a tag with no ancestors** (empty ancestor list from `getTagAncestors`): navigate immediately via `link.href`.
- **Click on a tag with ancestors, flyout not showing** (`link._flyoutShown` is falsy): `e.preventDefault()`, show flyout, set `link._flyoutShown = true`.
- **Click on a tag with ancestors, flyout showing** (`link._flyoutShown` is true): navigate to `link.href`.

Flyout state is tracked via a JS property on the link element (`link._flyoutShown`), not a DOM attribute. This property is cleared to `false` whenever the flyout is dismissed (click outside, scroll, or navigation).

**`beforeUnmount()`** must be implemented (or extended if it already exists) to remove the `window` scroll listener registered in `afterRender()`.

**Dismissal**:
- `document` click outside any `.post-card-tag-flyout`: hide flyout, clear `_flyoutShown` on all tag links.
- `window` `scroll` event (passive): same — hide and clear. Listener added in `afterRender()`, removed in `beforeUnmount()`.

**Interaction with image-card overlay** (existing `.is-touched` two-tap):
The flyout click handler calls `e.stopPropagation()` to prevent the card's own click handler from firing simultaneously. This is safe because the flyout's ancestor tag links are appended to `document.body` (outside the card DOM), so they will never trigger `go()` on the card — but `e.stopPropagation()` on the in-card leaf tag click still prevents the card's handler from seeing the same event.

Only one flyout can be open at a time. Opening a new flyout closes any existing one and clears its `_flyoutShown`.

#### Flyout rendering

A single shared `div.post-card-tag-flyout` is created once, appended to `document.body`, and reused (updated in place). It contains the ancestor chain rendered with `renderTagLink`, root-first order.

**Positioning** (position: fixed, appears above the clicked tag):

```
anchorRect = clickedLink.getBoundingClientRect()
flyoutHeight = flyoutEl.offsetHeight   // measured after content is set, before final placement
top = anchorRect.top - flyoutHeight - gap
// Clamp to avoid overflowing above the viewport:
top = Math.max(8, top)
left = anchorRect.left
left = Math.max(8, Math.min(left, window.innerWidth - flyoutEl.offsetWidth - 8))
```

Use `top` (not `bottom`) to handle viewport-overflow cleanly.

---

### 3. CSS changes

#### `frontend/css/public/post-grid.css`

`.post-card-tags`:
- Remove `flex-wrap: wrap`
- Add `flex-wrap: nowrap`, `overflow-x: auto`, `scrollbar-width: none`, `-webkit-overflow-scrolling: touch`
- Right-edge static fade: `mask-image: linear-gradient(to right, black 85%, transparent 100%)`. This fade is static (always present at the right edge) regardless of scroll position — no scroll listener is added to the tag strip. This is an accepted simplification: the fade signals "scrollable" and the hidden scrollbar makes it swipeable. No left-edge fade is added since the assumption is the user starts at the left.

#### New rule — `.post-card-tag-flyout`

```css
.post-card-tag-flyout {
  position: fixed;
  z-index: 500;
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-xs);
  padding: var(--spacing-xs) var(--spacing-sm);
  /* visual style matches .tag-children dropdown */
  background: var(--bg-overlay);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-md);
  animation: flyout-up 150ms ease;
}
@keyframes flyout-up {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}
```

---

## Interaction Summary

| User action | Result |
|---|---|
| Open post grid | Only leaf tags shown in a single scrollable line per card |
| Swipe tag bar | Tags scroll horizontally; right-edge fade indicates more content |
| Tap leaf tag (no ancestors) | Navigate to tag page immediately |
| Tap leaf tag (has ancestors) | Flyout appears above: `[country] [Ukraine] [city]` (root-first) |
| Tap an ancestor in flyout | Navigate to that ancestor's tag page |
| Tap same leaf tag again | Navigate to leaf tag's page |
| Tap elsewhere / scroll | Flyout dismisses; `_flyoutShown` cleared |
| navTags not yet loaded | All post tags shown as-is, no flyout |

---

## Edge Cases

| Case | Behavior |
|---|---|
| Tag not in navTags tree | Shown as leaf, no flyout |
| Tag's only ancestor is a system tag (`_` prefix) | Ancestor is skipped; if all ancestors are system, flyout is not shown (tag navigates immediately) |
| Flyout taller than distance to viewport top | `top` clamped to `8px` — flyout may overlap the tag |
| navTags is empty (cold load on post/preview page) | All tags shown, no filtering, no flyout |

---

## Files Changed

| File | Change |
|---|---|
| `frontend/src/utils/tags.js` | Add `buildTagIndex`, `getTagAncestors` |
| `frontend/src/components/public/PostCard.js` | Add `store` import; leaf filter; scrollable bar; flyout logic; `beforeUnmount()` for scroll listener cleanup |
| `frontend/css/public/post-grid.css` | Scrollable `.post-card-tags`; new `.post-card-tag-flyout` + `@keyframes flyout-up` |

No backend changes. No new files.
