# Admin UX (`/light`)

Design system for the admin SPA. The 2026 redesign restructured
a flat ten-item admin into **two layers by frequency** — a compose-first daily layer
(Home, editor essentials, primary nav) over a full Manage layer — via progressive
disclosure in one app, deliberately *not* a "simple/advanced" mode switch (two UIs to
learn, a setting to forget).

## Design principles

1. The next post is always one action away, on any device.
2. Frequency earns proximity: daily actions first; rare ones (migrations, sessions)
   findable but out of the way.
3. Never lose work, always say so: autosave everywhere with visible state.
4. No capability cliffs between devices — gestures may differ (Move dialog vs. drag);
   the capability may not vanish.
5. Tags are one vocabulary across editor, lists, and manager.

## What is implemented

- **One layout component**: every page renders through `AdminLayout.js` (shared
  chrome, sync pill, header behavior implemented once).
- **Grouped sidebar** (`LightSidebar.js`): WRITE (New post button, Home, Posts, Media,
  Tags) over a collapsible MANAGE group (Analytics, Menu, Themes, Plugins, Settings,
  Security, System).
- **Bottom tab bar on phones** (`AdminBottomBar.js`) with a prominent center ➕; the
  editor goes full-screen over it; the hamburger drawer is gone on phones.
- **Editor** (`PostEditPage.js`):
  - Content (Text/Visual) always owns the canvas. Every other post property — title,
    tags, status & visibility, schedule, slug, excerpt, immersive mode, custom CSS,
    Instagram — is one collapsible group with a one-line summary, living either in the
    **Details** rail (wide) / bottom sheet (narrow) or, when **pinned**, on the canvas.
  - **Pinning** (`PIN_ORDER`, `point:editor:pinned`): every group header carries a pin
    toggle; pinned groups move into `#pinned-fields` above the content editor, in the
    canonical order, and the choice persists across posts and sessions. The default
    (title + tags pinned) is the pre-pinning canvas. Toggling *moves the live element*
    rather than re-rendering, so unflushed edits, focus and listeners survive.
  - **Autosave chip + contextual Publish ▾ / Update** split button — see
    [publishing.md](publishing.md) for the save model.
  - **Live preview pane** on wide screens (`showLivePreview`, `_isWide()`): renders
    through the same pipeline as the public post page, updating with autosave — the
    honest use of ultrawide glass (forms never stretch; other pages stay capped).
- **Posts list**: card layout with tag chips (chips open the `TagFamilyPopover`),
  status filtering, bulk/select mode.
- **Tag workflow bridge**: hierarchy-aware autocomplete, deliberate-create popover,
  pinned Unfiled queue, Move…/Merge… dialogs (see [tag-system.md](tag-system.md)).
- **Power-user layer**: `CommandPalette.js` (Ctrl+K — posts, tags, admin pages,
  actions) and `ShortcutHelp.js` (`?` overlay) — depth without visual cost.
- **Media on touch**: breadcrumb + a drill-down folder chip strip instead of the tree,
  long-press selection (see [media.md](media.md)).
- **Touch pass**: ≥44 px targets, no hover-only or drag-only affordances on coarse
  pointers.

## Considered and rejected (keep for future debates)

- Separate simple/advanced mode toggle (fork of every future decision).
- WYSIWYG/block editor rewrite — the node model fits image-sequence + text content;
  problems were *around* the editor, not in it.
- FAB for New post (occludes content; the center tab slot is stable).
- Infinite scroll in admin lists (lists are worked, not browsed).
- Three-pane master-detail at 32:9 (rare workflow, third navigation model).
- Live-writing autosave for **published** posts — dangerous; edits go live only on
  explicit Update.

## Notes for future development

- New admin pages must use `AdminLayout` — never hand-roll `light-layout` markup.
- Any new list/table needs its card form at phone widths and always-visible actions on
  coarse pointers.
- New editor fields belong in a Details group, not directly on the canvas — render them
  through `_renderGroup()` so they get a summary and a pin like every other property.
  Plugin-provided groups need no extra wiring: the pin handler is delegated.
