# Hidden Posts & Tags — Visibility Design

## Overview

Content visibility is controlled through two orthogonal mechanisms on tags:

- **`is_hidden`** — the tag itself is hidden from public navigation (nav bar, tag cloud, tags page, tag detail page)
- **`is_hidden_posts`** — posts carrying this tag are hidden from public view

Posts additionally have a **`status`** field (`draft`, `published`, `hidden`). A published post can be effectively hidden either by its own status or by any of its tags having `is_hidden_posts = true`.

---

## Key Principle

**Access control lives entirely in the API.** The frontend renders what it receives; it never makes visibility decisions. Guests receive only public-safe content. Authenticated users receive full content plus metadata fields (`is_hidden`, `is_hidden_by_tag`, `is_hidden_posts`) that drive lock icons in the UI.

---

## Guest vs. Admin Responses

### Posts

| Field | Guest | Admin |
|---|---|---|
| `status="draft"` post | 404 | Included |
| `status="hidden"` post | 404 | Included + `is_hidden: true` |
| Post with `is_hidden_posts` tag | 404 | Included + `is_hidden_by_tag: true` |
| Published, public post | Included (no hidden fields) | Included + `is_hidden: false, is_hidden_by_tag: false` |

### Tags

| Field | Guest | Admin |
|---|---|---|
| `is_hidden=true` tag | 404 on detail/posts pages; omitted from lists | Included + `is_hidden: true` |
| `is_hidden_posts=true` tag | Visible in nav/cloud (tag itself shows) | Included + `is_hidden_posts: true` |
| Hidden via parent (`EffectivelyHiddenIDs`) | 404 | Included |

---

## Effective Hidden Status

A tag is *effectively hidden* if it is hidden directly (`is_hidden = true`) **or** any of its ancestors is hidden. The service method `EffectivelyHiddenIDs()` returns a set of all such tag IDs. This is used to:

- Gate access to tag detail pages and tag post listings
- Filter tags from navigation, tag cloud, and tags-page lists for guests

Note: `is_hidden_posts` does **not** propagate to children — only `is_hidden` does.

---

## Response Field Injection Pattern

Base response builders (`postToResponse`, `tagToFullResponse`, etc.) omit all hidden-status fields. Handlers inject them back only for authenticated users:

```go
// In a list handler
isAdmin := c.Get("user") != nil
for i, p := range posts {
    resp := postToResponse(p, tagInfos[p.ID])
    if isAdmin {
        injectPostHiddenFieldsFromInfo(resp, p.Status, tagInfos[p.ID])
    }
}
```

Two inject helpers exist for posts, reflecting the two tag slice types available in different endpoints:

- `injectPostHiddenFields(resp, status, []models.Tag)` — single-post detail endpoints (full Tag objects)
- `injectPostHiddenFieldsFromInfo(resp, status, []repository.PostTagInfo)` — list endpoints (lightweight tag info)

Both set `is_hidden` (from post status) and `is_hidden_by_tag` (from any tag having `IsHiddenPosts = true`).

For tags:

```go
func injectTagHiddenFields(resp map[string]interface{}, t models.Tag) {
    resp["is_hidden"] = t.IsHidden
    resp["is_hidden_posts"] = t.IsHiddenPosts
}
```

---

## Access Control Enforcement Points

### `GetPostBySlug` / `GetPostByID`
Tags are fetched **before** the guest access check, allowing rejection based on tag hidden status:

```
1. Fetch post
2. Fetch tags
3. If guest:
   a. status == "draft" || "hidden" → 404
   b. any tag.IsHiddenPosts == true → 404
4. Build response; inject hidden fields if admin
```

### `ListPosts`
The service `ListPosts` accepts `IncludeHidden bool` — set to `!publicOnly`. Hidden posts are excluded at the query level for guests; injected fields are added per-item for admins.

### `GetTagPage` / `GetPostsByTag`
`EffectivelyHiddenIDs()` is called first. If the requested tag is in the set and the user is a guest → 404.

### Struct-based responses (nav tags, tag cloud)
These Go structs serialize all fields. Because guests only receive items that passed the `publicOnly` filter, `is_hidden` will always be `false` on returned items for guests — benign, no lock icon shown. Admins see `is_hidden: true` on hidden items — lock icon shown. No struct changes needed.

---

## Frontend Behavior

The frontend is stateless with respect to visibility rules:

- `is_hidden` / `is_hidden_by_tag` absent → field is `undefined` → falsy → no lock icon
- `is_hidden: true` or `is_hidden_by_tag: true` → lock icon rendered

Lock icon is the shared `LOCK_SVG` constant from `frontend/src/utils/icons.js`, applied in:
`PostCard`, `PostContent`, `PublicHeader` (breadcrumb), `PublicHeaderTagsBar`, `TagCloud`, `TagsPage`.

The `is-hidden` CSS class is added to the article/list-item element to allow additional styling (e.g., dimming) for admin users viewing hidden content.
