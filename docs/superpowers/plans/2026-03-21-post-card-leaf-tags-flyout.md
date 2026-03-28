# Post Card Leaf Tags + Ancestor Flyout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show only leaf tags on post cards in a single scrollable line; first tap reveals an upward flyout of ancestor tags, second tap navigates.

**Architecture:** Pure frontend change — no API modifications. The `navTags` tree already in `store.get('navTags')` provides the full `_root` hierarchy. New utility functions derive leaf/ancestor relationships from that tree. `PostCard` uses them to filter rendered tags and drive the flyout. CSS makes the tag strip scrollable.

**Tech Stack:** Vanilla JS (ES modules, no build step), CSS custom properties, `position: fixed` flyout matching existing `PublicHeaderTagsBar` dropdown pattern.

**Spec:** `docs/superpowers/specs/2026-03-21-post-card-leaf-tags-flyout-design.md`

---

## File Map

| File | Change |
|---|---|
| `frontend/src/utils/tags.js` | Add `buildTagIndex()` and `getTagAncestors()` |
| `frontend/src/components/public/PostCard.js` | Add `store` import; leaf filter in `render()`; flyout + `beforeUnmount()` in `afterRender()` |
| `frontend/css/public/post-grid.css` | Make `.post-card-tags` scrollable; add `.post-card-tag-flyout` + animation |
| `frontend/css/public.bundle.css` | Regenerate after CSS edit (run `scripts/build-css.sh`) |

---

## Task 1 — Tag index utilities

**Files:**
- Modify: `frontend/src/utils/tags.js`

Add two exported functions after the existing `renderTagLink` export. No other files change in this task.

- [ ] **Step 1.1 — Add `buildTagIndex` and `getTagAncestors` to `tags.js`**

Open `frontend/src/utils/tags.js`. After the closing `}` of `renderTagLink` (currently the last line), append:

```js
/**
 * Build a flat lookup map from the navTags tree.
 * navTags is a strict tree (each node has exactly one parent).
 *
 * @param {object[]} navTags  Root-level tag nodes with nested .children[]
 * @param {string|null} [parentSlug]  Internal — parent slug for recursive calls
 * @param {Map} [map]  Internal — accumulator
 * @returns {Map<string, { tag: {name:string,slug:string}, parentSlug: string|null, isLeaf: boolean }>}
 */
export function buildTagIndex(navTags, parentSlug = null, map = new Map()) {
  for (const tag of navTags) {
    const isLeaf = !tag.children?.length;
    map.set(tag.slug, { tag: { name: tag.name, slug: tag.slug }, parentSlug, isLeaf });
    if (!isLeaf) buildTagIndex(tag.children, tag.slug, map);
  }
  return map;
}

/**
 * Return the ancestor chain of a tag in root-first order,
 * skipping system tags (slug starts with '_').
 *
 * @param {string} slug  The leaf tag's slug
 * @param {Map} index    Result of buildTagIndex()
 * @returns {{ name: string, slug: string }[]}  Root-first, immediate parent last
 */
export function getTagAncestors(slug, index) {
  const ancestors = [];
  let entry = index.get(slug);
  while (entry?.parentSlug) {
    entry = index.get(entry.parentSlug);
    if (entry && !entry.tag.slug.startsWith('_')) {
      ancestors.unshift(entry.tag);
    }
  }
  return ancestors;
}
```

- [ ] **Step 1.2 — Manual smoke test in browser console**

Start the API if not already running (`cd api && go run ./cmd/api` from `point/`).
Open the blog in a browser, open DevTools console, and run:

```js
import('/src/utils/tags.js').then(m => {
  const idx = m.buildTagIndex([
    { name: 'Travel', slug: 'travel', children: [
      { name: 'Ukraine', slug: 'ukraine', children: [
        { name: 'Kyiv', slug: 'kyiv', children: [] }
      ]}
    ]}
  ]);
  console.log('isLeaf kyiv:', idx.get('kyiv').isLeaf);           // true
  console.log('isLeaf ukraine:', idx.get('ukraine').isLeaf);     // false
  console.log('ancestors kyiv:', m.getTagAncestors('kyiv', idx));   // [{name:'Travel',...},{name:'Ukraine',...}]
  console.log('ancestors travel:', m.getTagAncestors('travel', idx)); // []
});
```

Expected: all four assertions match the comments.

- [ ] **Step 1.3 — Commit**

```bash
git add frontend/src/utils/tags.js
git commit -m "feat: add buildTagIndex and getTagAncestors utilities"
```

---

## Task 2 — CSS: scrollable tag strip + flyout

**Files:**
- Modify: `frontend/css/public/post-grid.css`
- Regenerate: `frontend/css/public.bundle.css`

CSS is done before PostCard JS changes so the browser shows correct styles immediately when testing Task 3.

- [ ] **Step 2.1 — Make `.post-card-tags` a single scrollable line**

In `frontend/css/public/post-grid.css`, find the `.post-card-tags` rule (lines 298–305):

```css
.post-card-tags {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: var(--spacing-sm);
    margin-top: auto;
    /* Push to bottom in flex container */
}
```

Replace it with:

```css
.post-card-tags {
    display: flex;
    justify-content: flex-end;
    flex-wrap: nowrap;
    gap: var(--spacing-sm);
    margin-top: auto;
    overflow-x: auto;
    scrollbar-width: none;          /* Firefox */
    -webkit-overflow-scrolling: touch;
    /* Right-edge fade signals scrollability */
    mask-image: linear-gradient(to right, black 85%, transparent 100%);
    -webkit-mask-image: linear-gradient(to right, black 85%, transparent 100%);
}

.post-card-tags::-webkit-scrollbar {
    display: none;                  /* Chrome/Safari */
}
```

- [ ] **Step 2.2 — Add flyout styles at the end of the tags section**

After the commented-out light overlay block (around line 351), add:

```css
/* ===========================
   Post Card Tag Flyout
   (ancestor chain, upward flyout on first tap)
   =========================== */
.post-card-tag-flyout {
    position: fixed;
    z-index: 500;
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-xs);
    padding: var(--spacing-xs) var(--spacing-sm);
    background: var(--surface-card);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-md);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    animation: flyout-up 150ms ease;
}

@keyframes flyout-up {
    from { opacity: 0; transform: translateY(4px); }
    to   { opacity: 1; transform: translateY(0); }
}
```

- [ ] **Step 2.3 — Rebuild CSS bundle**

From the project root:

```bash
./scripts/build-css.sh
```

Expected: no errors; `frontend/css/public.bundle.css` is updated.

- [ ] **Step 2.4 — Visual check in browser**

Hard-reload the blog. Verify that post cards with multiple tags show them on one line with a right-edge fade. Confirm they swipe/scroll horizontally.

- [ ] **Step 2.5 — Commit**

```bash
git add frontend/css/public/post-grid.css frontend/css/public.bundle.css
git commit -m "feat: scrollable post-card-tags strip and flyout styles"
```

---

## Task 3 — PostCard: leaf filter in render()

**Files:**
- Modify: `frontend/src/components/public/PostCard.js`

This task covers only `render()` — no flyout interaction yet. After this task, the tag strip shows leaf-only tags.

- [ ] **Step 3.1 — Add imports**

At the top of `frontend/src/components/public/PostCard.js`, the current import for `tags.js` is:

```js
import { renderTagLink } from '../../utils/tags.js';
```

Replace it with:

```js
import { renderTagLink, buildTagIndex, getTagAncestors } from '../../utils/tags.js';
```

After the existing import block (after the `import { LOCK_SVG }` line), add:

```js
import { store } from '../../store.js';
```

- [ ] **Step 3.2 — Filter tags to leaves in render()**

In `render()`, find this line:

```js
const tags = (post.tags || []).map((t) => renderTagLink(t)).join('');
```

Replace it with:

```js
const navTags = store.get('navTags') || [];
const tagIndex = navTags.length ? buildTagIndex(navTags) : null;
const visibleTags = (post.tags || []).filter((t) => {
  if (!tagIndex) return true;           // navTags not loaded — show all
  const entry = tagIndex.get(t.slug);
  return !entry || entry.isLeaf;        // not in tree → treat as leaf
});
const tags = visibleTags.map((t) => renderTagLink(t)).join('');
```

- [ ] **Step 3.3 — Visual check in browser**

Hard-reload. On any post card that has hierarchical tags, confirm only the leaf tags appear. Parent tags should not be shown if their children are also present.

To test without real hierarchical data, paste this in DevTools console and navigate to the home page:

```js
store.set('navTags', [
  { name: 'Places', slug: 'places', children: [
    { name: 'Kyiv', slug: 'kyiv', children: [] }
  ]}
]);
```

Then navigate away and back. Post cards tagged with `places` should have that tag hidden (it's a parent); post cards tagged with `kyiv` should still show it (it's a leaf).

- [ ] **Step 3.4 — Commit**

```bash
git add frontend/src/components/public/PostCard.js
git commit -m "feat: filter post card tags to leaf tags only"
```

---

## Task 4 — PostCard: flyout interaction in afterRender()

**Files:**
- Modify: `frontend/src/components/public/PostCard.js`

Read `afterRender()` in full before making changes (lines 74–130). The flyout code goes at the end of `afterRender()`.

- [ ] **Step 4.1 — Add module-level shared flyout helpers**

At the **module level** (outside the class, after the imports), add:

```js
// Single shared flyout element reused across all PostCard instances.
// Built with DOM methods to avoid XSS risks.
let _flyoutEl = null;

function getFlyoutEl() {
  if (!_flyoutEl) {
    _flyoutEl = document.createElement('div');
    _flyoutEl.className = 'post-card-tag-flyout';
    _flyoutEl.style.display = 'none';
    document.body.appendChild(_flyoutEl);
  }
  return _flyoutEl;
}

function showFlyout(anchorEl, ancestors) {
  const flyout = getFlyoutEl();

  // Rebuild links using safe DOM construction (no innerHTML with user data).
  while (flyout.firstChild) flyout.removeChild(flyout.firstChild);
  ancestors.forEach((t) => {
    const a = document.createElement('a');
    a.href = `/tag/${encodeURIComponent(t.slug)}`;
    a.className = 'tag-link';
    a.textContent = t.name;
    flyout.appendChild(a);
  });

  flyout.style.display = 'flex';

  // Position above the anchor tag.
  const anchorRect = anchorEl.getBoundingClientRect();
  const gap = 6;
  const flyH = flyout.offsetHeight;
  const flyW = flyout.offsetWidth;

  let top = anchorRect.top - flyH - gap;
  top = Math.max(8, top);  // clamp — don't overflow above viewport

  let left = anchorRect.left;
  left = Math.max(8, Math.min(left, window.innerWidth - flyW - 8));

  flyout.style.top = `${top}px`;
  flyout.style.left = `${left}px`;
}

function hideFlyout() {
  if (_flyoutEl) _flyoutEl.style.display = 'none';
}
```

- [ ] **Step 4.2 — Add tag flyout logic to afterRender()**

At the end of `afterRender()`, before the closing `}`, add:

```js
// Tag flyout: first click shows ancestors, second click navigates.
const navTagsAR = store.get('navTags') || [];
const tagIndexAR = navTagsAR.length ? buildTagIndex(navTagsAR) : null;

card.querySelectorAll('.post-card-tags .tag-link').forEach((link) => {
  link.addEventListener('click', (e) => {
    if (!tagIndexAR) return; // no hierarchy — navigate normally

    const slug = link.getAttribute('href').replace('/tag/', '');
    const ancestors = getTagAncestors(slug, tagIndexAR);
    if (!ancestors.length) return; // no ancestors — navigate normally

    e.preventDefault();
    e.stopPropagation();

    if (link._flyoutShown) {
      // Second click — navigate to the leaf tag page.
      link._flyoutShown = false;
      hideFlyout();
      navigate(`/tag/${slug}`);
    } else {
      // First click — show the ancestor flyout.
      // Clear any other open flyout on this card first.
      card.querySelectorAll('.post-card-tags .tag-link').forEach((l) => { l._flyoutShown = false; });
      link._flyoutShown = true;
      showFlyout(link, ancestors);
    }
  });
});
```

- [ ] **Step 4.3 — Add dismiss listeners (still inside afterRender())**

Still inside `afterRender()`, immediately after the block from Step 4.2:

```js
this._dismissFlyout = (e) => {
  if (_flyoutEl && !_flyoutEl.contains(e.target) && !card.contains(e.target)) {
    hideFlyout();
    card.querySelectorAll('.post-card-tags .tag-link').forEach((l) => { l._flyoutShown = false; });
  }
};
this._dismissFlyoutOnScroll = () => {
  hideFlyout();
  card.querySelectorAll('.post-card-tags .tag-link').forEach((l) => { l._flyoutShown = false; });
};

document.addEventListener('click', this._dismissFlyout, true);
window.addEventListener('scroll', this._dismissFlyoutOnScroll, { passive: true });
```

- [ ] **Step 4.4 — Add beforeUnmount() to clean up listeners**

After the closing `}` of `afterRender()`, add:

```js
beforeUnmount() {
  if (this._dismissFlyout) {
    document.removeEventListener('click', this._dismissFlyout, true);
  }
  if (this._dismissFlyoutOnScroll) {
    window.removeEventListener('scroll', this._dismissFlyoutOnScroll);
  }
  hideFlyout();
}
```

- [ ] **Step 4.5 — Manual interaction test in browser**

Hard-reload. Find a post card with a hierarchical leaf tag. Verify each scenario:

| Action | Expected |
|---|---|
| Tap a leaf tag with ancestors | Flyout appears above the tag showing ancestor links |
| Tap an ancestor link in flyout | Navigate to that ancestor's tag page |
| Tap elsewhere | Flyout disappears |
| Tap the same leaf tag again (flyout gone) | Flyout reappears |
| Tap the leaf tag while flyout is showing | Navigate to leaf tag's page |
| Tap a leaf tag with NO ancestors | Navigate immediately — no flyout |
| Image card: tap card → overlay reveals → tap leaf tag | Flyout appears above the tag |
| Scroll page while flyout is open | Flyout disappears |

- [ ] **Step 4.6 — Commit**

```bash
git add frontend/src/components/public/PostCard.js
git commit -m "feat: add ancestor flyout to post card leaf tags"
```

---

## Task 5 — Final check and push

- [ ] **Step 5.1 — Run Go tests (verify nothing broke)**

```bash
./scripts/run-tests.sh
```

Expected: all tests pass (no backend code was changed).

- [ ] **Step 5.2 — Light and dark theme check**

Toggle the theme button in the header. Confirm the flyout background and borders look correct in both themes (uses `--bg-overlay` and `--border-color` tokens).

- [ ] **Step 5.3 — Push**

```bash
git pull --rebase
git push
```

---

## Notes for the Implementer

- The API runs on `http://localhost:8000` by default. Start with `cd api && go run ./cmd/api`.
- CSS changes require rebuilding the bundle: run `./scripts/build-css.sh` from the project root. The bundle at `frontend/css/public.bundle.css` is what the browser loads.
- CSS custom properties used in the flyout (`--bg-overlay`, `--border-color`, `--radius-sm`, `--shadow-md`) are defined in `frontend/css/public/tokens.css` — do not hardcode values.
- `Component.beforeUnmount()` is already called automatically by `Component.unmount()` — no extra wiring needed.
- `buildTagIndex` is called in both `render()` and `afterRender()`. This is intentional — the tree is small and the cost is negligible. The alternative (sharing state between the two methods) would complicate the component lifecycle.
- `store.get('navTags')` may be null/empty on cold loads to `/post/:slug` or `/preview/:slug`. The guards (`if (!tagIndex) return true` and `if (!tagIndexAR) return`) ensure graceful fallback: all tags shown, no flyout.
- The flyout element is a singleton appended to `document.body` on first use. It is never removed. This mirrors how the existing `PublicHeaderTagsBar` flyouts work (they are always in the DOM once mounted).
