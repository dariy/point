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
- **Editor** (`PostEditPage.js`): every block is one group — content (Text/Visual),
  title, tags, status & visibility, schedule, slug, excerpt, immersive mode, custom
  CSS, Instagram — rendered by `_renderGroup()` with a one-line summary and a drag
  handle. Two stored preferences describe the layout, both global (how this user
  works, not a property of one post):
  - **Side** (`point:editor:pinned`): a block is either on the canvas in
    `#pinned-fields` or in the **Details** rail (wide) / bottom sheet (narrow).
    Content is always on the canvas — it is what the page is for — so a move into
    Details is refused.
  - **Order** (`point:editor:field-order`): one sequence spanning both sides, so a
    block moved across and back lands where it belongs. `DEFAULT_ORDER` seeds it and
    orders anything a stored one doesn't mention.
  - **Arrange mode** (menu → Arrange fields, Esc or Done to leave) is the only place
    either is changed — there is deliberately no second, always-visible control for
    it. Blocks collapse to labelled bars with drag handles; drag to reorder within a
    list or across the two, since landing in the other list *is* the statement about
    which side a block is on. Dragging is pointer-based (`utils/pointerReorder.js`,
    with edge auto-scroll) rather than HTML5 DnD, which does not exist on iOS; handles
    also take ArrowUp/ArrowDown to reorder and ArrowLeft/ArrowRight to change side.
    Below 64em the sheet drops into the page flow for the duration, since a sheet
    would cover the list being dragged to.
  - Moves *move the live element* rather than re-rendering, so unflushed edits, focus
    and listeners survive.
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
  through `_renderGroup()` so they get a summary and a drag handle like every other
  block. Plugin-provided groups need no extra wiring: the reorder handlers are
  delegated, and a key missing from `DEFAULT_ORDER` sorts last.
