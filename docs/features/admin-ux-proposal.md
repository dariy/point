# Admin Frontend (`/light`) — Best-in-Class UX Proposal

UX proposal for the admin frontend, desktop and mobile. Proposal only — no
implementation. Tracked under beads issue **point-krcu**, companion to the
[Public UX proposal](public-ux-proposal.md) and the
[Timeline proposal](timeline-ux-proposal.md).

## Background

The admin is a client-side SPA under `/light` with a fixed left sidebar
(`frontend/src/components/light/LightSidebar.js`) listing **ten flat nav
items**: Dashboard, Posts, Media, Tags, Analytics, Menu, Themes, Settings,
Security, System. Pages live in `frontend/src/pages/light/`; the heavy ones
are PostEditPage (1305 lines), PostsListPage (773), TagsManagerPage (1158),
and the shared MediaBrowser component (786).

A lot of strong machinery already exists: 30 s debounced autosave + Ctrl+S,
window-wide drag-and-drop upload, a Web Share Target queue (post photos from
the phone share sheet), per-field AI fill buttons, an offline op queue with a
sync pill, Text/Visual editor modes, a textarea maximizer, `headerCompact.js`
(buttons collapse to icons when the title would collide), and a folder-tree
media library reused as a picker. The gaps are **hierarchy and platform fit,
not features**:

1. **Everything has equal weight.** The daily job — write a post, drop in
   photos, tag it, publish — sits in the same flat nav as Migrations and
   Session Management. The editor header shows Delete / Preview link /
   Analyze / Save / Cancel as five near-equal buttons; the form shows slug,
   excerpt, schedule, and featured before you reach the content. Dashboard
   greets you with stat cards, not with "write".
2. **Saving is two competing models.** Autosave runs silently every 30 s
   (drafts), while a manual Save button and a status `<select>` carry the
   real state transitions. Nothing tells you whether your work is safe, and
   "publishing" is a dropdown mutation, not an action.
3. **Mobile is a shrunken desktop.** One breakpoint ladder
   (`css/light/responsive.css`: 64/48/40/30 em) moves the sidebar behind a
   hamburger and stacks things, but: the posts table keeps its two-row
   `<table>` layout, the tags tree silently *removes* capability on phones
   (drag handles and flag buttons are `display:none` at 40 em with no
   replacement), modals stay modals, and there are no `pointer: coarse` or
   `orientation` queries. Bottom of the screen — the thumb zone — is unused.
4. **Wide screens get a centered 1400 px strip.** `--content-max-width:
   87.5rem` with no use of the remaining glass at 21:9/32:9 — while the
   editor is exactly the page that could show a live preview beside the form.
5. **The tag workflow splits across three disconnected surfaces.** TagsInput
   autocompletes flat names with no hierarchy context and silently creates
   new root tags; TagsManager is where structure lives, but reordering is
   drag-only (impossible on touch) and new tags born in the editor land
   unparented with no queue to file them; the posts list can't filter by tag
   at all (the tag manager's count badge deep-links to
   `/light/posts?search=<slug>` — a text-search hack).
6. **Small duplications add noise.** Theme toggle exists twice (sidebar
   footer *and* header); Dashboard stat cards duplicate Analytics; every
   page hand-rolls its own `light-layout` markup instead of using
   `AdminLayout.js`, so chrome drifts (Dashboard re-implements the sync
   pill).

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Two complexity layers | **Progressive disclosure in one app**, not two apps/modes: a compose-first daily layer (Home, editor essentials, primary nav) over a full Manage layer (grouped nav, Details rail, full pages) | A "simple/advanced" mode switch creates two UIs to learn and a setting to forget; disclosure keeps one mental model |
| Daily layer scope | Posting + managing **posts / photos / tags** only | Matches the stated main goal; everything else is fine-tuning |
| Save model | **Autosave is the only save** (with a visible state chip); the primary button is **Publish / Update** (split: now / schedule) | One model instead of two; "is my work safe?" always answered; publishing becomes a deliberate verb |
| Phone navigation | **Bottom tab bar** (Home · Posts · Media · Tags · Manage), editor goes full-screen over it | Thumb-zone navigation; hamburger drawer demoted to the Manage tab |
| Wide screens | Editor gains a **live preview pane** ≥ ~112 em; other pages cap and center | Preview is the one admin surface that earns the glass; tables/forms must not stretch |
| Tag model | **Assign in the editor, curate in the Manager**, with a bridge: hierarchy-aware autocomplete + an "Unfiled" queue | Each surface gets one job; new-tag debt becomes visible instead of silent |

## Design principles

1. **The next post is always one action away.** From any screen, on any
   device: one tap/click to a ready editor.
2. **Frequency earns proximity.** Daily actions sit in the first visual
   layer; weekly ones one step away; rare ones (migrations, sessions) are
   findable but never in the way.
3. **Never lose work, always say so.** Autosave everywhere, and its state is
   visible (saved / saving / offline-queued) at all times.
4. **No capability cliffs between devices.** Everything possible on desktop
   is possible on a phone — the *gesture* may differ (Move dialog instead of
   drag), the capability may not vanish.
5. **Tags are one vocabulary.** The same tag, with the same hierarchy
   context, in the editor, the posts list, and the manager.

## Proposed design

### A. Information architecture — the two layers

**A1. Nav groups.** Replace the ten-item flat list in `LightSidebar.js` with
two groups:

```
WRITE  (layer 1)            MANAGE  (layer 2, collapsible)
  ✎ New post  ← button        Analytics
  Home                        Menu
  Posts                       Themes
  Media                       Settings
  Tags                        Security
                              System
```

"New post" becomes a real button at the top of the sidebar (not just a
header action on two pages). The Manage group renders collapsed by default
(persisted in localStorage), expanded while any of its pages is active. No
pages are deleted — Security and System stay exactly as they are, one click
deeper in visual weight only.

**A2. Home = compose-first.** DashboardPage becomes Home:

- Top: a **compose strip** — "What's new?" title field + photo drop zone;
  typing or dropping navigates into the full editor with content carried
  over (the Web Share Target flow already proves the pattern).
- Middle: **Continue writing** — up to 5 most recent drafts/scheduled posts
  with thumbnail, title, autosave age. This is the real daily resume point.
- Bottom: a compact health row — storage bar (only when > 70 %), sync pill,
  version banner. The stat cards and Top Posts table move to Analytics,
  which already owns that data (`getPostAnalytics`, `getTopPosts` are
  fetched by both pages today).

**A3. One layout component.** All pages adopt `AdminLayout.js` instead of
duplicating `light-layout` markup (PostEditPage, PostsListPage,
TagsManagerPage, DashboardPage all hand-roll it today). Engineering enabler
for everything below: bottom bar, autosave chip, and header behavior get
implemented once. Remove the duplicate theme toggle (keep the sidebar/Manage
one; on phones it lives in the Manage tab).

### B. Navigation per device

| Device | Primary nav | Manage layer |
|---|---|---|
| Phone portrait | **Bottom tab bar**: Home · Posts · ➕ (center, prominent) · Media · ⋯ More | "More" tab opens a sheet: Tags, Analytics, Menu, Themes, Settings, Security, System, theme toggle, view-site, logout |
| Phone landscape | Same bottom bar (it's short); header drops the title row | same |
| Tablet portrait | **Icon rail** (~64 px): logo, ✎, 5 icons + Manage chevron; labels in tooltips | Manage chevron expands rail in place |
| Tablet landscape & desktop | Full 240 px sidebar (A1) | collapsed group |
| Desktop, user-collapsed | Sidebar collapses to the same icon rail (toggle persisted) | chevron |

The hamburger + slide-over drawer (`_setupMobileToggle` in
`LightSidebar.js`) is removed on phones in favor of the bottom bar — the
drawer pattern hides navigation behind a tap and occludes content; tabs are
one tap and always visible. The editor and any open sheet cover the bottom
bar (full-screen compose). Tags moves into "More" on phones only because the
center slot goes to ➕ New post; on rail/sidebar it stays first-layer.

### C. The editor — distraction-free core + Details

**C1. The core is three fields.** What stays on the canvas: **title**,
**content** (Visual/Text toggle as today), **tags**. Everything else —
slug row, excerpt, featured star, schedule row, immersive mode, custom CSS,
Instagram — moves into a **Details** surface. The `advanced-options-details`
disclosure already exists for the last three; this finishes the thought.

**C2. Details = right rail on wide, sheet on narrow.** ≥ 64 em: a 320 px
right rail, toggled by a "Details" header button, open state persisted.
< 64 em: the same content as a bottom sheet. Order: Status & visibility
(incl. featured + schedule), Slug, Excerpt (+ AI), Immersive mode, Custom
CSS, Instagram. Each section a collapsible group with a one-line summary
when closed (e.g. "Slug · `my-trip`", "Excerpt · auto") so the rail reads as
a checklist, not a wall of forms.

**C3. Publish model.** The editor header becomes:

```
←  Trip to Lisbon            ✓ Saved · 12s ago     [⋯]  [Publish ▾]
```

- **Autosave chip** replaces the Save button. States: `Saving…` →
  `✓ Saved · Xs ago` → `⚠ Offline — queued` (wired to the existing
  `offline_status` store) → `⚠ Save failed — retry`. `aria-live="polite"`.
  Autosave debounce drops from 30 s to ~5 s after idle; Ctrl+S stays as
  "save now".
- **Primary button is contextual**: drafts get `Publish ▾` (split: Publish
  now / Schedule… / Mark hidden); published posts get `Update` plus an
  `Unpublish` item in the menu. The raw status `<select>` moves to Details
  for the rare states (`page`).
- **⋯ overflow** holds Delete, Preview link, Analyze (AI fill-all), and
  View on site. Cancel becomes `←` back (with autosave there is nothing to
  cancel — leaving is always safe).

**C4. Phone editor = full-screen sheet.** Covers the bottom bar; header is
`← · saved-chip · Publish`; tags input docks above the keyboard; Details is
the bottom sheet (C2); the media-add button is a persistent toolbar item
(window drag-and-drop has no touch equivalent — today phones can only add
media through the picker inside Visual mode).

**C5. Live preview ≥ ~112 em (21:9 and up).** A toggleable right pane
rendering the post through the same renderer the public PostPage uses,
updating on autosave ticks. Form column stays ~720 px for comfortable line
length; preview takes the remainder (capped ~900 px, centered beyond — see
G). This is the honest use of ultrawide glass and removes the
write-save-switch-tab-reload loop entirely.

### D. Posts list

**D1. Filter bar instead of select + search.** Status becomes **segmented
chips** (`All · Drafts · Published · Scheduled · …` with counts) — one tap,
visible current state — plus the search field and a **tag filter** chip
(reusing TagsInput in single-pick mode). Requires `tag=` support on
`GET /api/posts`; the tag manager's count badge then deep-links properly
instead of via `?search=`.

**D2. Cards on touch, table on desktop.** The two-`<tr>`-per-post table
collapses terribly. < 48 em each post renders as a card: thumbnail left,
title + tag chips + updated date right, status pill top-right; tap = edit;
swipe-left or long-press = quick actions (status, trash). Select mode and
the bulk toolbar work on cards identically (long-press enters selection —
the platform-native pattern).

**D3. Keep the good parts.** Inline per-row status change, select/bulk mode,
and the trash flow are right; they survive restyled (status pill opens the
same options as the editor's Publish menu, for one vocabulary).

### E. Media

**E1. Phone capture path.** On `pointer: coarse`, the upload zone becomes
two explicit buttons — **Take photo** (`capture` input) and **Photo
library** — plus the existing share-target path. Desktop keeps drag-drop +
browse.

**E2. Folder tree → breadcrumb + chips on narrow.** The left folder tree
doesn't fit phones; < 48 em it becomes a breadcrumb (`2026 / 06`) with
child-folder chips beneath — same data, one-hand navigation. The tree stays
≥ 48 em.

**E3. Selection parity.** Long-press enters select mode on touch (checkbox
overlay), matching D2. Grid stays `auto-fill, minmax(…)` so it already
scales from 2 columns (phone) to many (ultrawide) — just raise the minmax on
≥ 112 em so thumbnails grow instead of multiplying into a contact sheet.

### F. Tag workflow

The model: **assign** (editor, posts list) vs **curate** (Tags Manager),
bridged so assignment never silently creates taxonomy debt.

**F1. Hierarchy-aware autocomplete.** TagsInput suggestions show the parent
path and count: `Lisbon — Travel › Portugal · 12`. Disambiguates duplicates,
teaches the taxonomy where it's used, costs one API field (the editor
already loads the tag list for autocomplete).

**F2. Deliberate creation.** When the entered text matches no tag, the
suggestion list ends with `＋ Create "Alfama"…` opening a 2-field inline
popover: name + **parent picker** (same autocomplete, optional). Enter-enter
keeps the fast path (creates unfiled); the parent field makes filing-at-birth
one keystroke away instead of a trip to the Manager.

**F3. The Unfiled queue.** Tags Manager gets a pinned **Unfiled (N)** group
at the top of the tree listing parentless, non-system tags (today they're
invisible unless you notice them at root level). Each row: file-under
(parent picker), merge-into, delete. This turns F2's fast path into visible,
batchable debt — the missing bridge between assigning and curating.

**F4. No capability cliffs in the Manager.** Every drag affordance gets a
dialog twin: a **Move…** action (new parent + position) on each row — which
also fixes phones, where `tm-drag-handle` is hidden today with no
replacement. The flags row (hidden at 40 em) folds into the existing tag
editor modal instead of disappearing. Tree rows get ≥ 44 px touch targets.

**F5. Merge tags.** `Merge into…` action (Manager + Unfiled queue): re-tags
all posts, optionally keeps the loser as a redirect. Today cleaning up
`lisboa`/`Lisbon` duplicates is manual post-by-post editing — the single
most painful taxonomy chore.

**F6. One tag chip everywhere.** Posts-list tag chips, TagsInput badges, and
Manager rows share one component: click filters the posts list by that tag
(D1), and a small `›` affordance opens the same family popover the public
proposal defines (B2 there) showing ancestors/children.

### G. Layout & responsive matrix

| Class | Query | Layout |
|---|---|---|
| Phone portrait | ≤ 40 em | Bottom tab bar; cards not tables; modals → bottom sheets; editor full-screen |
| Phone landscape | ≤ 48 em and `orientation: landscape` | Bottom bar stays; single-row header (no title row); editor hides chrome except `← · chip · Publish` |
| Tablet portrait | 40–64 em | Icon rail; content single column; Details as overlay sheet |
| Tablet landscape | 48–80 em | Full sidebar; posts table returns; Details rail overlays |
| Desktop 16:9 | 80–112 em | Sidebar + content (max 87.5 rem); Details rail inline (push, not overlay) |
| Ultrawide 21:9 | ~112–160 em | Editor: form + live preview split (C5). Other pages: content stays capped and **left-anchored next to the sidebar** (no center-strip orphaning) |
| Super-ultrawide 32:9 | > 160 em | Same as 21:9 with preview capped ~900 px; remaining space stays margin — admin forms must never stretch |
| Touch | `pointer: coarse` (any width) | ≥ 44 px targets; no hover-only actions (row actions always visible at low opacity); long-press = select/quick-actions; no drag-only features (F4) |

All current hover-revealed affordances (table row action buttons, media item
overlays, tree-row actions) get the same treatment as the public proposal's
D4: always rendered on coarse pointers.

### H. Cross-cutting

- **Command palette (Ctrl+K / ⌘K)**: jump to any post by title, any tag,
  any admin page; actions ("New post", "Open settings › Instagram"). This
  is the power-user escape hatch that makes the calm layer-1 nav acceptable
  to experts — depth without visual cost.
- **Keyboard map**: `Ctrl+S` save-now (exists), `Ctrl+Enter` publish/update,
  `Ctrl+K` palette, `/` focuses list search, `n` new post from lists. A `?`
  overlay documents them.
- **Accessibility**: autosave chip `aria-live`; bottom bar = `<nav>` with
  `aria-current`; sheets/rails are `role="dialog"` focus traps that return
  focus; tree keyboard-navigable (arrows expand/collapse — the roving
  tabindex the tree lacks today); `prefers-reduced-motion` skips
  sheet/rail/tab transitions.

### Add / remove summary

**Add:** nav grouping + sidebar New-post button (A1) · compose-first Home
(A2) · bottom tab bar (B) · autosave chip + Publish split-button (C3) ·
Details rail/sheet (C2) · live preview ≥ 21:9 (C5) · posts tag filter +
status chips (D1) · phone cards + long-press select (D2) · phone capture
buttons (E1) · hierarchy-aware tag autocomplete + create popover (F1/F2) ·
Unfiled queue (F3) · Move…/Merge… dialogs (F4/F5) · command palette (H).

**Remove / simplify:** manual Save button and the save/autosave dual model
(C3) · status `<select>` as primary control (→ Details; rare states only) ·
Dashboard stat cards + Top Posts (→ Analytics, A2) · hamburger drawer on
phones (→ bottom bar, B) · duplicate theme toggle (A3) · slug/excerpt/
featured/schedule from the editor canvas (→ Details, C1) · `?search=<slug>`
tag deep-link hack (D1) · hidden-on-mobile drag handles & flag buttons as a
"responsive strategy" (F4) · per-page hand-rolled layout markup (A3).

## Mockups

### Desktop 16:9 — editor, Details rail open

```
┌──────────┬──────────────────────────────────────────────┬───────────────┐
│ ✎ New    │ ←   ✓ Saved · 8s        [⋯]  [ Publish ▾ ]   │ DETAILS       │
│          ├──────────────────────────────────────────────┤ ▸ Status      │
│ Home     │  Trip to Lisbon                          ⌁AI │   draft ★     │
│ Posts ◀  │  ───────────────────────────────────────     │ ▸ Slug        │
│ Media    │  [travel ×] [portugal ×] [lisbon ×] + tag    │   trip-to-…   │
│ Tags     │  ┌────────────────────────────────────────┐  │ ▸ Excerpt     │
│          │  │  Text | Visual                         │  │   auto    ⌁AI │
│ MANAGE ▸ │  │                                        │  │ ▸ Immersive   │
│          │  │   /2026/06/alfama.jpg   [img]          │  │   auto        │
│          │  │   Morning in Alfama…                   │  │ ▸ Custom CSS  │
│ ◐  ↗  ⎋ │  │                              [+ media] │  │ ▸ Instagram   │
└──────────┴──────────────────────────────────────────────┴───────────────┘
  sidebar: WRITE group + collapsed MANAGE      canvas: title·tags·content only
```

### Ultrawide 21:9 — editor with live preview

```
┌────────┬────────────────────────────┬──────────────────────────┬────────┐
│ rail/  │ ←  ✓ Saved   [⋯][Publish▾] │  LIVE PREVIEW            │        │
│ side-  │  Trip to Lisbon            │  ┌────────────────────┐  │ margin │
│ bar    │  [travel ×][lisbon ×]      │  │  rendered as the   │  │ (32:9: │
│        │  ┌──────────────────────┐  │  │  public post page, │  │ grows; │
│        │  │ editor ~720px        │  │  │  updates on auto-  │  │ never  │
│        │  │                      │  │  │  save  (~900px cap)│  │ wider  │
│        │  └──────────────────────┘  │  └────────────────────┘  │ forms) │
└────────┴────────────────────────────┴──────────────────────────┴────────┘
```

### Phone portrait — Home and editor

```
   HOME                          EDITOR (full-screen, covers tab bar)
┌─────────────────────┐        ┌─────────────────────┐
│ Point        ⟳ sync │        │ ←   ✓ Saved   Publish│
├─────────────────────┤        ├─────────────────────┤
│ ┌─────────────────┐ │        │ Trip to Lisbon      │
│ │ What's new?     │ │  tap   │ [travel ×][+ tag]   │
│ │ ✎ … or 📷 drop  │ │  ───►  │ ┌─────────────────┐ │
│ └─────────────────┘ │        │ │ content         │ │
│ CONTINUE WRITING    │        │ │                 │ │
│ ▤ Alfama draft · 2h │        │ ├─────────────────┤ │
│ ▤ Sintra  sched·Fri │        │ │ 📷 add · Details │ │ ← toolbar
│ storage ▓▓▓░ 78%    │        │ └──[keyboard]─────┘ │
├─────────────────────┤        └─────────────────────┘
│  ⌂   ▤   ➕   ▣   ⋯ │ ← bottom tab bar              Details = bottom sheet
│ Home Posts New Media│   (More: Tags, Analytics, …)
└─────────────────────┘
```

### Phone portrait — posts as cards + long-press

```
┌─────────────────────┐
│ Posts            ⌕  │
│ (All 24)(Drafts 3)… │ ← status chips, swipe-scroll
├─────────────────────┤
│ ┌───┬─────────────┐ │
│ │img│ Trip to Li… │ │  tap = edit
│ │   │ [travel] 2h │●│  long-press = select mode
│ └───┴─────────────┘ │  swipe ← = status / trash
│ ┌───┬─────────────┐ │
│ │img│ Sintra      │ │
│ └───┴─────────────┘ │
├─────────────────────┤
│  ⌂   ▤   ➕   ▣   ⋯ │
└─────────────────────┘
```

### Tablet portrait — icon rail; Tags Manager with Unfiled queue

```
┌───┬───────────────────────────────────┐
│ ✎ │ Tags                 [Tree|List] +│
│ ⌂ │ ┌───────────────────────────────┐ │
│ ▤ │ │ ⚠ UNFILED (3)                 │ │ ← pinned queue
│ ▣ │ │  alfama   [File under…][Merge]│ │
│ # │ │  sintra…  [File under…][Merge]│ │
│ ⋯ │ ├───────────────────────────────┤ │
│   │ │ ▾ Travel · 48        [⋯ Move…]│ │ ← every row: 44px,
│   │ │   ▾ Portugal · 12    [⋯]      │ │   Move…/Merge…/Edit
│   │ │     Lisbon · 9       [⋯]      │ │   (no drag-only ops)
└───┴───────────────────────────────────┘
```

## Prioritized roadmap (task breakdown)

**P0 — the daily layer (highest leverage, mostly restructuring)**

1. Adopt `AdminLayout` on all pages; single theme toggle; shared header
   behaviors (A3) — *enabler for everything below*
2. Sidebar: WRITE/MANAGE groups + New-post button; collapsed-state
   persistence (A1)
3. Editor canvas reduction: move slug, excerpt, featured, schedule into a
   Details disclosure (C1; rail/sheet polish comes in P1)
4. Autosave chip + Publish/Update split-button; retire manual Save; demote
   status select (C3)
5. Phone bottom tab bar; remove hamburger drawer ≤ 48 em (B)
6. Posts list as cards < 48 em with always-visible actions (D2)
7. Touch pass: ≥ 44 px targets, no hover-only controls, `pointer: coarse`
   styles (G)

**P1 — the manage layer & tags**

8. Details right rail (≥ 64 em, persistent) / bottom sheet (< 64 em) with
   section summaries (C2)
9. Tag autocomplete with parent paths + counts (F1)
10. Create-tag popover with inline parent picker (F2)
11. Tags Manager: Unfiled queue (F3)
12. Tags Manager: Move… dialog; flags into editor modal; 44 px tree rows (F4)
13. Merge tags (API + UI) (F5)
14. Posts list: status chips + tag filter; `tag=` param on `GET /api/posts`;
    fix the `?search=` deep link (D1)
15. Home: compose strip + Continue-writing list; stats move to Analytics (A2)
16. Media on phones: capture/library buttons, breadcrumb + folder chips,
    long-press select (E1–E3)
17. Tablet icon rail + desktop sidebar collapse toggle (B)
18. Phone-landscape compact chrome (G)

**P2 — wide screens & power use**

19. Live preview pane ≥ 112 em, autosave-driven (C5)
20. Ultrawide caps: left-anchored content, preview cap, media minmax bump
    (G, E3)
21. Command palette (H)
22. Keyboard map + `?` overlay; `Ctrl+Enter` publish (H)
23. Quick-actions swipe on post cards (D2)
24. Tag chip unification + family popover shared with public frontend (F6)
25. Accessibility sweep: aria-live chip, focus traps, tree roving tabindex,
    reduced-motion (H)

## Considered and rejected

- **A separate "simple mode" toggle** (two switchable UIs): doubles every
  future design decision, and the user must discover and manage the mode
  itself; progressive disclosure gives the same calm without a fork.
- **Moving rare pages (Security/System) into a settings mega-page with
  tabs**: churns working pages for cosmetic gain; nav grouping (A1) buys
  the same calm for a fraction of the cost.
- **WYSIWYG/block editor rewrite**: the Visual/Text node model
  (`parseNodes`/`serializeNodes`) fits this content format (image sequences
  + text blocks) well; the problem is around the editor, not in it.
- **Floating action button (FAB) for New post on phones**: occludes content
  and collides with the editor toolbar; the dedicated center tab slot is
  always in the same place and never covers anything.
- **Infinite scroll for posts/media lists**: same verdict as the public
  proposal — pagination is URL-addressable and predictable; admin lists are
  worked, not browsed.
- **Three-pane master-detail (list | editor | preview) at 32:9**: tested
  against principle 2 — editing-while-listing is a rare workflow that costs
  a third navigation model; the editor preview split (C5) plus fast
  back/forward covers it.
- **Autosave for *published* posts writing live**: dangerous — edits to a
  published post autosave to a revision/pending state and go live only on
  "Update"; the chip says `Edited — not yet live` (folded into C3's design).
