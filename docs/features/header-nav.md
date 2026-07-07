# Header navigation — four zones, one fold engine

The public header renders four zones on a single row:

| Zone     | Contents                                   | Width behavior            |
| -------- | ------------------------------------------ | ------------------------- |
| identity | logo (+ subtitle)                          | fixed                     |
| context  | breadcrumbs + count                        | elastic (grows with depth)|
| nav      | menu links, "More ▾" overflow              | fixed per site            |
| tools    | search, post actions, burger               | fixed, rightmost          |

A single controller — `frontend/src/utils/headerFold.js` — owns the space.
Components and plugins register ordered *fold providers*; when the row
overflows (measured, never device-sniffed), ops apply one at a time until it
fits:

1. subtitle hidden (`fold-title`)
2. ancestor crumbs fold left-to-right into "…" (existing crumb-pair folding)
3. nav links fold right-to-left into "More ▾" (nav-menu plugin, order 30)
4. the nav zone collapses into the burger (`fold-nav`)
5. brand text folds — logo remains the home link (site crumb pair)
6. current crumb ellipsizes; clicking it opens the full-path popover (`fold-current`)

Invariants: the current page's name is the last thing to degrade, and every
nav destination stays one tap away (inline → More → burger). Layout re-runs
on resize and on explicit `relayout()` after slot content changes, so data
that arrives after first paint (the nav fetch, auth state) re-flows the
header instead of being invisible.

## One menu, three sources

The nav zone renders "a list of links"; only the source differs
(`nav_menu_mode`):

- `tags` — the hierarchical nav-tag tree (curate with `nav_order` in the tag
  manager). The photoblog case: favorite tags visible, zero upkeep.
- `custom` — authored links with optional children (`/light/menu`). The
  plain-site case: landings, docs.
- `none` — no menu; the header is identity + crumbs + tools.

`nav_inline_max` (1–10, default 4) caps how many links render inline; the
rest live under "More ▾". Items with children get breadcrumb-style dropdowns:
hover-with-intent on fine pointers, tap-to-toggle on coarse. There are no
hover-only surfaces.

## Managing it

`/light/menu` is the single management surface: mode picker, inline cap, the
custom items editor (visual + markdown), and a live preview at three widths
(900 / 640 / 360 px) laid out by the real fold engine — what folds in the
preview is what folds on the site.

## History

Before this design the menu had no desktop surface: items lived in the mobile
burger and in a hover-only flyout on the site title, and that flyout was
attached once at first render — before the nav fetch resolved — so it never
appeared on a fresh page load. The fold controller's re-measure-on-change
contract removes that class of bug structurally.
