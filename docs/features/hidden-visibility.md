# Hidden Posts & Tags — Visibility Design

## Overview

Content visibility is controlled through two orthogonal boolean columns on the `tags` table:

- **`hidden`** — the tag itself is hidden from all public navigation (nav bar, tag cloud, tags page, tag detail page)
- **`hides_posts`** — posts carrying this tag are hidden from public view

Posts additionally have a **`status`** field (`draft`, `published`, `hidden`, `scheduled`). A published post can be effectively hidden either by its own status or by any of its tags having `hides_posts = true` (directly or through inheritance).

---

## Key Principle

**Access control lives entirely in the API.** The frontend renders what it receives; it never makes visibility decisions. Guests receive only public-safe content. Authenticated users receive full content plus metadata fields (`is_hidden`, `is_hidden_by_tag`) that drive lock icons in the UI.

---

## Inheritance

Both `hidden` and `hides_posts` propagate to **all descendants** through BFS in the in-memory `TagGraph`. Setting either flag on a parent tag automatically makes every tag in its subtree carry the effective version of that flag, without writing anything to the database:

- `g.EffectiveHidden[tagID]` — `true` if the tag or any ancestor has `hidden = true`
- `g.EffectiveHidesPosts[tagID]` — `true` if the tag or any ancestor has `hides_posts = true`
- `g.HiddenVia[tagID]` — ID of the ancestor that caused the effective hidden status

The `TagGraph` is built lazily on first read and invalidated by any tag write or post-tag mutation.

---

## Guest vs. Admin Responses

### Posts

| Field | Guest | Admin |
|---|---|---|
| `status="draft"` post | 404 | Included |
| `status="hidden"` post | 404 | Included + `is_hidden: true` |
| `status="scheduled"` post | 404 | Included (the negative pages of the home and tag feeds — see [Content & Publishing](publishing.md)) |
| Post with `hides_posts` tag (direct or inherited) | 404 | Included + `is_hidden_by_tag: true` |
| Published, public post | Included (no hidden fields) | Included + `is_hidden: false, is_hidden_by_tag: false` |

### Tags

| Field | Guest | Admin |
|---|---|---|
| `hidden=true` tag (or effectively hidden via ancestor) | 404 on detail/posts pages; omitted from lists | Included + `effective_hidden: true` |
| `hides_posts=true` tag | Visible in nav/cloud (tag itself shows) | Included + `hides_posts: true` |
| Tag with ancestor having `hides_posts=true` | Visible (tag is not hidden) | Included + `effective_hides_posts: true, hidden_via: <ancestorID>` |

---

## Tag Response Fields

Admin responses for tags include the full picture:

```json
{
  "id": 7,
  "name": "Friends",
  "hidden": false,
  "hides_posts": false,
  "effective_hidden": true,
  "effective_hides_posts": true,
  "hidden_via": 3
}
```

- `hidden` / `hides_posts` — the flag set directly on this tag
- `effective_hidden` / `effective_hides_posts` — the computed inherited value (always `true` if the direct flag is set)
- `hidden_via` — present only when `effective_hidden` is `true` and inherited; contains the ancestor tag ID that set `hidden = true`

---

## Response Field Injection Pattern

Base response builders (`postToResponse`, etc.) omit all hidden-status fields. Handlers inject them only for authenticated users:

```go
// In a list handler
isAdmin := c.Get("user") != nil
snap := h.tagService.GetSnapshot()
effectiveHiddenPosts := snap.EffectiveHidesPosts
for _, p := range posts {
    resp := postToResponse(p, tagInfos[p.ID])
    if isAdmin {
        injectPostHiddenFieldsFromInfo(resp, p.Status, tagInfos[p.ID], effectiveHiddenPosts)
    }
}
```

Two inject helpers exist for posts:

- `injectPostHiddenFields(resp, status, []models.Tag, effectiveHiddenPostsTagIDs)` — single-post detail endpoints
- `injectPostHiddenFieldsFromInfo(resp, status, []repository.PostTagInfo, effectiveHiddenPostsTagIDs)` — list endpoints

Both set `is_hidden` (from post status) and `is_hidden_by_tag` (from any tag's ID appearing in `effectiveHiddenPostsTagIDs`).

For tags, `effective_hidden`, `effective_hides_posts`, and `hidden_via` are written directly from the snapshot in each tag response builder — no separate inject helper.

---

## Access Control Enforcement Points

### `GetPostBySlug` / `GetPostByID`

Tags are fetched **before** the guest access check, allowing rejection based on tag hidden status:

```
1. Fetch post
2. Fetch tags
3. If guest:
   a. !isPubliclyReadableStatus(status) → 404  (draft / hidden / scheduled)
   b. any tag ID in snap.EffectiveHidesPosts → 404
4. Build response; inject hidden fields if admin
```

### `ListPosts`

The service `ListPosts` accepts `publicOnly bool`. Hidden posts are excluded at the query level for guests; inject helpers add fields per-item for admins.

### `GetTagPage` / `GetPostsByTag`

`g.EffectiveHidden` is checked first. If the requested tag is in the set and the user is a guest → 404.

### `isPubliclyReadableStatus` (`api/internal/api/visibility.go`)

The single status gate for a **direct** fetch by slug or id. Listing queries
filter by status themselves, so this is what a guessed or leaked URL runs into:
`draft`, `hidden` and `scheduled` are all withheld. A scheduled post is finished
writing and only waiting for its publish time — before this gate existed, anyone
who knew the slug could read it early.

### Struct-based responses (nav tags, tag cloud)

These are filtered at the source: the `TagGraph` methods that build nav trees and tag clouds skip entries where `g.EffectiveHidden[id]` is true before the guest even sees them.

---

## Frontend Behavior

The frontend is stateless with respect to visibility rules:

- `is_hidden` / `is_hidden_by_tag` absent → field is `undefined` → falsy → no lock icon
- `is_hidden: true` or `is_hidden_by_tag: true` → lock icon rendered

Lock icon is the shared `LOCK_SVG` constant from `frontend/src/utils/icons.js`, applied in:
`PostCard`, `PostContent`, `PublicHeader` (breadcrumb), `PublicHeaderTagsBar`, `TagCloud`, `TagsPage`.

The `is-hidden` CSS class is added to the article/list-item element for additional styling (e.g., dimming) for admin users viewing hidden content.

---

## Revelio — viewing the site as a guest

The owner browsing their own public site sees everything: hidden posts and tags,
private media, and the scheduled queue. **Revelio** is the switch in the public
footer (next to RSS, owner-only) that turns all of that off, so the site renders
exactly what a visitor gets.

It is implemented as a *narrowing* of the request, not a second rendering mode:

- The client stores the state in `localStorage` (`revelio`, absent = on) and
  `frontend/src/utils/revelio.js` adds `X-Point-Revelio: off` to every API
  request from `api/client.js`.
- `OptionalAuthMiddleware` resolves the principal as usual and then withholds
  it, so every downstream `c.Get("user") == nil` test takes the public branch.
  Nothing else in the codebase has to know the switch exists.
- Only routes behind `OptionalAuthMiddleware` (the public reads and media
  serving) are affected. The admin API keeps working — which is what lets the
  switch be turned back on.
- `IsGuestView(c)` reports that a real principal was dropped, so the owner
  previewing the guest view does not inflate post view counts.
- The tag visualisations scope themselves the same way, and the revealed view
  marks the places, co-tags and posts a guest would not get — otherwise
  concealing drops a marker or two out of hundreds and the map looks unchanged.
  See [tags-visualization.md](tags-visualization.md).
- Flipping the switch re-renders in the same document (`router.refresh()`) after
  dropping the client read caches and re-fetching the auth-scoped nav — no page
  reload, so the reader stays where they were and the footer drawer the button
  lives in stays open. A scheduled feed page is left on the way out, since it
  has no counterpart on the guest side.

Because it grants nothing, the header is honoured from any client; for an
anonymous request it changes nothing.

**Known gap:** media the browser fetches as `background-image` / `<img>` carries
the session cookie and no header, so a private image whose URL is already on the
page still loads. In practice media is private until it appears in a visible
published post, so a concealed post's media is never requested in the first
place.
