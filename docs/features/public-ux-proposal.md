# Public Frontend — Best-in-Class UX Proposal

Sitewide UX proposal for the public (visitor-facing) frontend, desktop and
mobile. Proposal only — no implementation. Tracked under beads issue
**point-krcu**, companion to the
[Timeline proposal](timeline-ux-proposal.md), which owns all
timeline-control-specific decisions.

## Background

The public site is a client-side SPA with seven routes: `/` (HomePage),
`/posts/:slug` (PostPage), `/tags` (TagsPage), `/tags/:slug` (TagPage),
`/map[/:year]` (MapPage), `/search` (SearchPage), `/preview/:token`
(PreviewPage) — all under `frontend/src/pages/public/`. Shared chrome lives in
`frontend/src/components/public/`: PublicHeader (branding, breadcrumb, tag
bar, action icons), PublicHeaderTagsBar (root-tag chips with dropdowns),
PostGrid/PostCard, PostContent (normal + immersive carousel), Timeline,
TagCloud, PublicFooter (pagination or immersive EXIF/tags), MediaLightbox.

A lot is already best-in-class material: a coherent design-token system
(`frontend/css/common/tokens.css`), em-based breakpoints, safe-area insets,
disciplined `touch-action`, lazy-loaded page modules, rubber-band swipe
pagination, a progressive header fold with hamburger fallback, and a
theme system with proper dark mode. The gaps are **consistency and
legibility**, not engineering:

1. **Tags behave differently everywhere.** A pill on a post needs *two*
   clicks (first opens an ancestor flyout, second navigates —
   `frontend/src/utils/tags.js`); a header chip opens a *children* dropdown
   on first click and navigates only on a re-click within 300 ms
   (`PublicHeaderTagsBar.js`); the tag cloud does the flyout dance again.
   Three surfaces, three interaction models, none of them
   "click = go". Worse, `min_tag_posts_to_show` hides tags from tag pages
   while their pills still render on posts — clicking one 404s.
2. **Components don't share one filter language.** Active tag, timeline
   range, search query, and page are four separate mechanisms. The URL
   *almost* models them (`/tags/travel?timeline=2023-2024&page=2`), but
   nothing displays the combined state, search can't be scoped to a tag,
   search doesn't match tag names at all, and the only "reset" is editing
   the URL.
3. **Ultrawide screens get a 1200 px column.** `--content-max-width: 75rem`
   leaves ~680 px dead per side at 21:9 and ~1120 px at 32:9; the post grid
   never exceeds ~3 columns no matter how much glass is available.
4. **Touch is desktop-shrunk.** Tag pills are 32 px tall, header buttons
   40 px (44 px is the floor); there are no `pointer: coarse` or
   `orientation` queries; card edit buttons and dropdown affordances are
   hover-only.
5. **Some flows dead-end.** No share/copy-link anywhere; immersive mode is
   auto-detected with no visible way out other than Esc; search has no
   suggestions; a failed map fetch renders an empty map silently.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Component communication | **URL is the single source of truth** for `tag × years × query × page`; components read/write it through one shared context, never talk to each other directly | Predictable, deep-linkable, back-button-correct; kills component-pair special cases |
| Tag interaction | **One click/tap = navigate.** Ancestors/children move to a hover-intent flyout (desktop) and long-press sheet (touch) | The two-click pattern is undiscoverable and punishes the 95 % case (just go) to serve the 5 % case (browse hierarchy) |
| Ultrawide strategy | Grid container grows to **~1800 px** (more columns via existing `auto-fill`); reading column stays 800 px; map and immersive go full-bleed | Use the glass for *more content*, never for *wider text lines* |
| Pagination | **Keep pages, no infinite scroll**; keep swipe gestures | URL-addressable, footer stays reachable, predictable position |
| Tag surfaces | Each surface gets one job: header bar = *sections*, breadcrumb = *where am I*, pills = *what is this post*, tag cloud → replaced by an **Explore block** | Today three surfaces compete to be "the" tag navigation |

## Design principles

1. **The URL is the interface.** Every view state a visitor can reach —
   tag, year range, query, page, slide — is in the URL, restorable, and
   shareable. Back always means "where I just was".
2. **One mental model for tags.** A tag looks the same, clicks the same,
   and reveals its hierarchy the same way on every surface.
3. **Click is for going, hover/long-press is for peeking.** No primary
   action ever hides behind a second click or a hover-only control.
4. **Content leads, chrome recedes.** The header earns its height; filters
   appear only when active; empty space on big screens is filled with
   content, not decoration.
5. **Every screen is a first-class screen.** Phone landscape, tablet, and
   32:9 are designed states, not side effects of min/max-width math.

## Proposed design

### A. Unified filter context (the communication contract)

**A1. One context object, URL-backed.** Define a tiny shared module
(`frontend/src/utils/viewContext.js`-style) owning
`{ tag, years, query, page }` parsed from / serialized to the URL:

```
/                       → { }
/tags/travel            → { tag: travel }
/tags/travel?timeline=2023-2024&page=2
                        → { tag: travel, years: [2023,2024], page: 2 }
/search?q=lisbon&tag=travel
                        → { query: lisbon, tag: travel }
```

Pages render from the context; Timeline, header tag bar, search, and
pagination *request* context changes (replace/merge) and re-render on the
resulting URL change. No component holds private filter state, no
component calls another. This is the "predictable communication" rule:
**emit context change → router → everyone re-reads**.

**A2. Filter chips row.** When the context is non-default, a single slim
row appears between header and content showing each active facet as a
removable chip, plus "Clear all":

```
Travel ×   2023 – 2024 ×   “lisbon” ×          Clear all · 23 posts
```

This makes the combined state readable (today the timeline range is only
visible inside the timeline control), gives every facet an obvious undo,
and shows the result count. On HomePage with no filters the row doesn't
exist — zero idle cost. The chip row is the *only* new chrome this
proposal adds to every page.

**A3. Scoped search.** The header search submits within the current
context: searching from `/tags/travel` produces
`/search?q=…&tag=travel` with the tag chip pre-set (removable). The
search API gains a `tag` filter param; this is the bridge between the
two currently disconnected discovery systems.

**A4. Search knows tag names.** `/api/posts?q=` (or a sibling endpoint)
also matches tag names; SearchPage shows a compact "Tags" strip above
post results ("**lisbon** — tag · 5 posts → /tags/lisbon"). Searching
for a place a visitor saw as a pill must find it.

### B. Tag workflow

**B1. One click = navigate, everywhere.** Pills on posts/cards, tag cloud
entries, and header chips all navigate on first activation. Remove the
two-click ancestor-flyout pattern in `utils/tags.js` and the 300 ms
re-click rule in `PublicHeaderTagsBar.js`.

**B2. Hierarchy peek = hover intent / long-press.** One flyout component
(reuse the existing singleton flyout in `utils/tags.js`, restyled) serves
every surface and shows the *full* family: ancestor chain above, children
below, each with post counts:

```
        World › Europe › Portugal        ← ancestors (links)
        ┌──────────────────┐
        │  Lisbon · 5      │             ← the tag itself (header row)
        ├──────────────────┤
        │  Alfama · 2      │             ← children (links)
        │  Belém · 1       │
        └──────────────────┘
```

Desktop: opens after ~250 ms hover on any tag surface. Touch: opens on
long-press (≥350 ms) as a bottom sheet on phones (< 640 px), anchored
card on tablets. Header chips keep a dedicated `▾` caret as the visible,
tappable alternative (principle 3) — caret opens the same flyout, label
navigates.

**B3. No more tag 404s.** Tags below `min_tag_posts_to_show` either stop
rendering as pills (preferred — apply the same visibility filter to the
post payload) or resolve to a normal tag page with an honest empty state
("Nothing published under *Alfama* yet — see *Lisbon*", linking the first
visible ancestor). A visible link must never 404.

**B4. Tag page = context page.** `/tags/:slug` keeps its two modes (grid /
post-in-context) and gains: the filter chips row (A2), description,
children/related sub-nav as one wrapping pill row under the title, and the
tag-scoped Timeline it already has. The breadcrumb remains the single
"where am I" device; drop `in_breadcrumbs` level-skipping for the public
trail so the path shown always matches the flyout's ancestor chain.

**B5. Tags directory stays.** `/tags` remains the sitemap-style full tree —
it is the one place exhaustiveness beats curation. Add per-branch
collapse and an inline filter-as-you-type box (client-side; the payload
is already full).

### C. Navigation & header

**C1. Keep the fold ladder, make the burger canonical.** The progressive
fold (`fold-title → fold-nav → fold-tags`, `frontend/css/public/header.css`)
is the right idea. Specify the order explicitly as: title text → action
icons collapse into burger → tag bar folds into burger. Inside the burger,
order is always: search field (focused on open), tag tree, map / all-tags
/ about links, theme toggle. One predictable home for everything that
folded.

**C2. Search is always one tap.** The magnifier icon never folds. On
desktop it expands inline (current behavior); on `pointer: coarse` it
opens a full-width overlay under the header with the keyboard up,
suggestions below (F1).

**C3. Footer as quiet sitemap.** Footer keeps pagination as its center
slot and adds a right-side link set: All tags · Map · About · RSS (if
enabled). The footer is where "where else can I go?" lives, freeing the
header to stay minimal.

**C4. Map and Tags get stable entry points.** Today Map is an icon and
`/tags` is barely linked. With C3 plus the burger (C1), both are always
reachable within one interaction from any page.

### D. Layout & responsive

**D1. Breakpoint and input matrix.** Keep em-based widths; add the two
missing axes — pointer type and orientation:

| Class | Query | Layout |
|---|---|---|
| Phone portrait | ≤ 32em | 1-col grid, burger header, bottom sheets |
| Phone landscape | ≤ 48em **and** `orientation: landscape` | 2-col grid, **short header** (compact, title-less), side post-nav hidden |
| Tablet | 32–64em | 2-col grid, full header |
| Desktop 16:9 | 64em–~112em | 3-col grid, 1200 px container |
| Ultrawide 21:9 | ~112em–160em | container grows to ~1800 px → 4–5 cols |
| Super-ultrawide 32:9 | > 160em | container caps at ~1800 px, **centered**; map/immersive full-bleed |
| Touch | `pointer: coarse` (any width) | ≥ 44 px targets, long-press flyouts, no hover-only UI |

Implementation is cheap: `--content-max-width: clamp(75rem, 90vw, 112rem)`
on grid pages plus the existing `auto-fill, minmax(20rem, 1fr)` already
yields 4–5 columns; nothing else reflows.

**D2. Per-page wide-screen behavior.**

- **Grid pages** (home, tag, search): wider container, more columns; the
  hero/featured card spans 2 columns instead of full row above 4 columns
  (a 1700 px full-bleed hero is a billboard, not a card).
- **Post page**: prose stays at `--content-narrow` (800 px). On ≥ 112em,
  media inside the post may break out to ~1200 px (`figure` breakout),
  and post meta (date, tags, EXIF) moves to a sticky side rail beside the
  text instead of inline — the classic comfortable-reading + wide-margins
  pattern.
- **Map**: full-bleed at every width (it's the one page that should eat
  32:9 whole); controls and popovers stay within safe margins.
- **Immersive carousel**: already `100vw` — correct; only the info
  overlay gets a max-width so captions don't span 3440 px.

**D3. Touch targets.** Raise tag pills and header/footer icon buttons to
≥ 44 px effective size on `pointer: coarse` via hit-slop (pseudo-element
or padding), keeping visual size; same technique the Timeline proposal
uses for year pills.

**D4. Hover parity.** Every hover-revealed control gets a touch path:
card edit button always visible at low opacity on coarse pointers;
dropdown carets always rendered (B2); flyouts via long-press. Tooltips
become non-essential (information they carry must exist elsewhere).

### E. Reading & immersive

**E1. Visible mode toggle.** Immersive auto-detection stays, but the post
view gets a small persistent toggle (⤢ / ☰) to switch between carousel
and article layout. Auto-detection chooses the default; the visitor gets
the override. Esc keeps exiting.

**E2. Share / copy link.** One share button on PostPage and in the
immersive info overlay: native `navigator.share` where available, copy-
to-clipboard + toast fallback. In immersive mode it shares the current
slide URL (`#3` hash already exists). This is the single most glaring
missing feature for a public site.

**E3. Slide progress.** Replace the "3 of 5" counter with thin dot/segment
indicators (counter stays as accessible text). Tappable on touch,
clickable on desktop.

**E4. Lightbox and carousel converge.** MediaLightbox and the immersive
carousel duplicate gesture/keyboard logic; long-term, one media-viewer
component with two entry modes. (Engineering note, but it guarantees the
two viewers never drift apart in UX.)

### F. Search

**F1. Typeahead.** As the visitor types (≥ 2 chars, debounced): matching
tags (with counts) first, then top 3 post-title matches, then "Search
everything for *q* ↵". Powered by the already-loaded tag index plus one
lightweight endpoint. Recent searches (localStorage, 5 max) shown on
focus before typing.

**F2. Honest empty state.** No results → say so, show "Clear filters"
when chips are active (a scoped search may fail only because of the
scope), and offer the top-level tag list as escape hatch.

### G. Accessibility & motion

- Filter chips row is an `aria-live="polite"` region: "Showing Travel,
  2023 to 2024 — 23 posts" announces every context change for free.
- Flyout/bottom sheet: `role="dialog"`, focus trapped while open,
  returns to the invoking tag on close; arrow keys traverse entries.
- Header fold never changes DOM order — tab order is identical folded
  and unfolded; burger button is `aria-expanded`-correct.
- `prefers-reduced-motion`: skip carousel slide animation, sheet slide-up,
  rubber-band, chip enter/exit; instant state changes instead.
- Map page: fetch failure renders a visible error card with retry — never
  a silent empty map.

### Add / remove summary

**Add:** filter chips row (A2) · scoped + tag-aware search (A3/A4) ·
share button (E2) · search typeahead (F1) · immersive toggle (E1) ·
footer sitemap links (C3) · ultrawide grid tier (D1).

**Remove / simplify:** two-click tag flyout pattern (B1) · 300 ms
re-click chip rule (B1) · tag-visibility 404s (B3) · breadcrumb
level-skipping on public pages (B4) · **TagCloud** in its current form —
replaced by an "Explore" block on HomePage (top tags as plain pills +
"All tags →" link); weighted font-size clouds read as noise and
duplicate the header bar's job.

## Mockups

### Desktop 16:9 — home with active filters

```
┌────────────────────────────────────────────────────────────────────────┐
│ ◉ Site Title      Travel ▾  Photos ▾  Projects ▾        ⌕  ◐  🗺  ≡   │ header
├────────────────────────────────────────────────────────────────────────┤
│  Travel ×   2023 – 2024 ×                       Clear all · 23 posts   │ chips (A2)
├────────────────────────────────────────────────────────────────────────┤
│  ‹ ──────────────────  timeline (see timeline proposal) ───────────── ›│
│                                                                        │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐                        │
│  │  post      │  │  post      │  │  post      │   3 columns @1200px    │
│  │  [pill][pill]  │  [pill]   │  │  [pill]    │   pills: 1 click = go  │
│  └────────────┘  └────────────┘  └────────────┘   hover = family flyout│
│                                                                        │
│            ‹ prev      page 2 / 4 · 23 posts      next ›               │
│  © Author                                   All tags · Map · About     │ footer (C3)
└────────────────────────────────────────────────────────────────────────┘
```

### Ultrawide 21:9 / 32:9 — home

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│        │ ◉ Site Title   Travel ▾ Photos ▾        ⌕ ◐ 🗺 ≡ │        │
│  empty │  ┌────────────────────────┐ ┌──────────┐ ┌──────────┐      │  empty         │
│  (32:9 │  │   featured (2 cols)    │ │  post    │ │  post    │      │  (capped at    │
│  only) │  └────────────────────────┘ └──────────┘ └──────────┘      │  ~1800px,      │
│        │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────┐│  centered)     │
│        │  │  post    │ │  post    │ │  post    │ │  post    │ │post││                │
│        │  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └────┘│                │
└──────────────────────────────────────────────────────────────────────────────────────┘
   21:9: container ~1800px → 4–5 columns, hero spans 2.   Map page: full-bleed instead.
```

### Phone portrait — home + long-press tag sheet

```
┌──────────────────────┐        ┌──────────────────────┐
│ ◉ Title       ⌕  ≡  │        │ ░░ page dimmed ░░░░░ │
│ Travel × 2023–24 × ✕ │  long- │ ┌──────────────────┐ │
├──────────────────────┤  press │ │      ────        │ │
│ ┌──────────────────┐ │  pill  │ │ World › Europe   │ │ ← ancestors
│ │   post card      │ │ [Lisbon│ │ Lisbon       5 ● │ │ ← tap = go
│ │   [Lisbon][2024] │ │  ───►  │ │ ──────────────── │ │
│ └──────────────────┘ │        │ │ Alfama       2   │ │ ← children
│ ┌──────────────────┐ │        │ │ Belém        1   │ │
│ │   post card      │ │        │ └─ swipe down ─────┘ │
│ └──────────────────┘ │        └──────────────────────┘
│  ‹  page 2/4  ›      │          tap pill (short) = navigate
└──────────────────────┘          long-press = this sheet
```

### Phone landscape — compact header

```
┌────────────────────────────────────────────────┐
│ ◉   Travel ▾  Photos ▾              ⌕  ≡      │  ← single short row,
│ ┌──────────────────┐ ┌──────────────────┐      │    no title text
│ │    post card     │ │    post card     │      │  2 columns
│ └──────────────────┘ └──────────────────┘      │
└────────────────────────────────────────────────┘
```

### Post page ≥ 21:9 — reading column + side rail

```
┌────────────────────────────────────────────────────────────────┐
│            │  Post Title                      │ 12 Jun 2024    │
│            │  Prose stays at 800px for        │ [Lisbon][2024] │
│   empty    │  comfortable line length.        │ ⤢ immersive    │
│            │  ┌────────────────────────────┐  │ ⇪ share        │
│            │  │   figure breakout ~1200px  │  │ EXIF ▾         │
│            │  └────────────────────────────┘  │  (sticky rail) │
└────────────────────────────────────────────────────────────────┘
```

## Prioritized roadmap

**P0 — stop harming (small, high-impact)**

1. One click = navigate on all tag surfaces; remove two-click flyout and
   300 ms chip re-click (B1)
2. Fix tag-visibility 404s (B3)
3. ≥ 44 px touch targets on pills and icon buttons via hit-slop (D3)
4. Hover parity: visible carets, always-visible touch controls (D4)
5. Map fetch error state (G)

**P1 — make it legible**

6. URL-backed view context module; Timeline / tag bar / search /
   pagination all speak it (A1)
7. Filter chips row + Clear all + aria-live (A2, G)
8. Scoped search + tag-name matching with tag results strip (A3, A4)
9. Ultrawide grid tier: `clamp()` container + hero-spans-2 (D1, D2)
10. Phone-landscape compact header; `pointer: coarse` styles (D1)
11. Share / copy-link on posts and immersive slides (E2)
12. Footer sitemap links; burger canonical ordering (C1, C3)

**P2 — make it delightful**

13. Unified family flyout (hover-intent / long-press bottom sheet) (B2)
14. Search typeahead + recent searches (F1)
15. Immersive mode toggle + slide progress dots (E1, E3)
16. Post-page side rail + figure breakout on ultrawide (D2)
17. Replace TagCloud with Explore block (add/remove summary)
18. `/tags` directory: collapse + filter box (B5)
19. Lightbox/carousel component convergence (E4)

## Considered and rejected

- **Infinite scroll**: breaks URL-addressability, footer reachability, and
  "where was I" — pagination + swipe already feels fluid here.
- **Multi-tag AND/OR filtering UI**: real gap (you can't refine "camping"
  within "travel"), but it needs API support (`/api/tags/slug/:slug/posts`
  is single-tag) and a query-builder UI that fights the distraction-free
  goal. The context model (A1) is designed so `tag` can become `tags[]`
  later without rework. Deferred, not rejected forever.
- **Mega-menu for the header tag bar**: heavier than the chips + flyout
  model and collapses badly on mobile.
- **Masonry grid**: visual interest at the cost of scan order and layout
  shift; uniform cards + featured slot read better.
- **Server-side rendering for SEO**: out of UX scope; orthogonal
  infrastructure decision.
- **Sticky sidebar on ultrawide** (timeline/tag tree pinned in the dead
  space): tested badly against principle 4 — it's chrome filling space
  for its own sake; more columns is the honest use of width.
