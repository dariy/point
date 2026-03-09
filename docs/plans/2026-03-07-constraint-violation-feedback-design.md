# Constraint Violation Feedback — Design

**Date**: 2026-03-07
**Status**: Approved

## Problem

When a user submits a form in the admin UI that violates a database constraint (e.g. saving a post with a slug that already exists), the backend returns either a wrong HTTP status code, a raw SQLite error string, or a completely misleading message — and the frontend only shows a generic toast notification with no indication of which field caused the failure.

### Backend issues found

| Endpoint | Constraint | Current status | Current message | Problem |
|---|---|---|---|---|
| `POST /api/posts` | `posts.slug` UNIQUE | **500** | `"UNIQUE constraint failed: posts.slug"` | Wrong status, raw SQL leaked |
| `PUT /api/posts/:id` | `posts.slug` UNIQUE | **404** | `"Post not found or access denied"` | Completely wrong — user has no idea |
| `POST /api/tags` | `tags.name` / `tags.slug` UNIQUE | **409** | `"UNIQUE constraint failed: tags.name"` | Status correct, raw SQL exposed |
| `PUT /api/tags/:id` | `tags.name` / `tags.slug` UNIQUE | **404** | `"Tag not found"` | Completely wrong — user has no idea |
| Media rename | filename collision on disk | varies | generic | No field targeting |

Additionally, the backend mixes two error body formats: `{"message":"..."}` (Echo default) and `{"detail":"..."}` (project convention). The frontend `client.js` reads `body.detail || body.message` so errors do surface, but inconsistently.

### Frontend issues found

- **Zero field-level error patterns** — no CSS highlighting, no inline error text, no `aria-invalid`
- **Universal pattern**: all pages catch API errors and show `store.set('toast', ...)` — a 4-second toast
- **Only exception**: `LoginPage` uses inline `state.error` inside the card
- **No `field` key** on thrown error objects — even if the backend sent one, the frontend couldn't use it

## Goal

1. Backend returns `409 Conflict` with a human-readable `{"detail":"...", "field":"..."}` body for all uniqueness violations
2. Frontend highlights the specific failing field with a red border and inline error text below it
3. Error clears immediately when the user starts typing in that field
4. When the user leaves the slug blank and the auto-generated slug collides, auto-populate the slug field with the generated value so the user can edit it

## Scope

### Forms covered

| Page / Component | Fields at risk |
|---|---|
| `PostEditPage` | `#slug-input` (post slug uniqueness), `#title-input` (required) |
| `TagEditPage` (new page, replaces modal) | `[name="name"]` (tag name uniqueness), `[name="slug"]` (tag slug uniqueness) |
| `SecurityPage` | `#current-password` (wrong password), `#confirm-password` (mismatch) |
| `MediaBrowser` rename dialog | rename input (filename collision on disk) |

### Constraints that are already handled correctly (no change needed)

- `media.checksum` UNIQUE — pre-flight dedup returns existing record silently
- `blog_settings.key` PK — uses `ON CONFLICT DO UPDATE` upsert
- `post_tags` / `tag_relationships` / `tag_locations` — use `INSERT OR IGNORE` or upsert patterns

## Approach

### Backend: shared predicate + structured JSON responses

A single `isUniqueViolation(err error) bool` helper (string inspection of the SQLite error message `"UNIQUE constraint failed: ..."`) used by all four handlers. Each handler now:
1. Checks `isUniqueViolation(err)` before the generic error fallback
2. Parses the column name from the error string to select a human-readable message
3. Returns `c.JSON(409, map[string]string{"detail":"...", "field":"..."})` — NOT `echo.NewHTTPError` which would produce `{"message":"..."}` instead of `{"detail":"..."}`

For post slug collisions when the user left the slug blank, the handler also returns `"suggested_slug"` in the body so the frontend can auto-populate the field.

### Frontend: shared utility + existing CSS

A small utility module `frontend/src/utils/formErrors.js` exports three pure functions:
- `setFieldError(inputEl, message)` — finds nearest container, adds `has-error` class, appends `.form-error` span, registers `{ once: true }` input listener for auto-clear
- `clearFieldError(inputEl)` — removes error state
- `clearAllFieldErrors(containerEl)` — clears all errors in a container before each save attempt

**No new CSS required** — `.form-error` (red small text) and `.has-error .form-input` (red border) already exist in `frontend/css/common/forms.css`.

The `client.js` throw is changed to spread all body fields onto the error object: `throw { ...body, status, message }`. This makes `err.field`, `err.suggested_slug` etc. available to all callers with zero breaking changes.

### TagsManagerPage: modal → dedicated page

The tag editor is currently a modal built as a string of HTML injected into a DOM overlay — not a `Component` subclass. This architecture makes proper error state impossible without re-rendering. The tag editor becomes a dedicated page (`TagEditPage`) at `/light/tags/new` and `/light/tags/:id/edit`, following the exact same architecture as `PostEditPage`. The `TagsManagerPage` list view remains intact; its New/Edit buttons become `navigate()` calls.

## Files Changed

### New files

| File | Purpose |
|---|---|
| `api/internal/api/errors.go` | `isUniqueViolation(err) bool` predicate shared by all handlers |
| `frontend/src/utils/formErrors.js` | `setFieldError`, `clearFieldError`, `clearAllFieldErrors` |
| `frontend/src/pages/light/TagEditPage.js` | Full tag editor page replacing the TagsManagerPage modal |

### Modified files

| File | Change |
|---|---|
| `api/internal/api/posts.go` | `CreatePost`: 500→409 on slug conflict + `suggested_slug`; `UpdatePost`: 404→409+404 split |
| `api/internal/api/tags.go` | `CreateTag`: raw 409→structured 409 with `field`; `UpdateTag`: 404→409+404 split |
| `api/internal/api/media.go` | `RenameMedia`: detect filename collision→409 with `field:"filename"` |
| `frontend/src/api/client.js` | Spread body fields onto thrown error object (1 line) |
| `frontend/src/pages/light/PostEditPage.js` | Field errors in `_save()`; title validation as field error |
| `frontend/src/pages/light/SecurityPage.js` | Password mismatch + wrong password as field errors |
| `frontend/src/components/shared/PromptDialog.js` | Add `showError(msg)` public method; store input ref |
| `frontend/src/components/light/MediaBrowser.js` | Keep rename dialog open on 409; call `dialog.showError()` |
| `frontend/src/pages/light/TagsManagerPage.js` | Remove modal infrastructure; buttons become `navigate()` calls |
| `frontend/src/app.js` | Remove `/light/tags/:slug`; add `/light/tags/new` and `/light/tags/:id/edit` |

## Data Flow

### Slug collision on post create (blank slug)

```
User submits PostEditPage with empty slug input
  → createPost(data) → POST /api/posts
  → Service auto-generates slug via utils.Slugify(title)
  → DB insert hits UNIQUE constraint on posts.slug
  → Handler: isUniqueViolation(err) == true
  → Returns 409 {"detail":"This title's auto-generated slug is already taken. Please enter a custom slug.", "field":"slug", "suggested_slug":"my-post-title"}
  → client.js throws { status:409, message:"...", field:"slug", suggested_slug:"my-post-title" }
  → PostEditPage._save() catch: err.field === "slug"
  → setFieldError(#slug-input, err.message)
  → Since slugInput.value === "", populate it with err.suggested_slug
  → User sees: red border on slug field, error text below, slug field pre-filled
  → User edits slug → input event fires → clearFieldError() → error gone
  → User saves again with unique slug → success
```

### Tag name/slug collision

```
User submits TagEditPage with an already-taken tag name
  → createTag(payload) → POST /api/tags
  → DB insert hits UNIQUE constraint on tags.name
  → Handler: isUniqueViolation(err) == true, "tags.name" in err string
  → Returns 409 {"detail":"A tag with this name already exists.", "field":"name"}
  → client.js throws { status:409, message:"...", field:"name" }
  → TagEditPage._save() catch: fieldMap["name"]() → [name="name"] input
  → setFieldError(nameInput, err.message)
  → User sees: red border on name field, error text below
```

### Rename collision

```
User types a filename that exists on disk in the rename dialog
  → onConfirm callback (now async): renameMedia(id, newName)
  → Backend rename fails: OS error "file exists"
  → Handler returns 409 {"detail":"A file with that name already exists.", "field":"filename"}
  → client.js throws { status:409, message:"..." }
  → onConfirm catch: err.status === 409 → dialog.showError(err.message)
  → Dialog stays open, red border on input, error text below
  → User types new name → input event clears error
  → User submits → success → dialog closes
```

## Key Decisions

- **String inspection for SQLite errors** (`strings.Contains`) rather than typed `modernc.org/sqlite` error unwrapping — the `"UNIQUE constraint failed: table.column"` string is stable across SQLite versions and simpler to maintain
- **`c.JSON` not `echo.NewHTTPError`** for 409 responses — `echo.NewHTTPError` wraps in `{"message":"..."}` which mismatches project convention `{"detail":"..."}`
- **Existing CSS classes** (`.form-error`, `.has-error`) rather than new classes — avoids CSS bundle rebuild and is consistent with existing form validation patterns
- **DOM manipulation not component state** for error display — tracking errors in `this.state` would trigger `render()` → `afterRender()` re-render which would wipe the user's in-progress edits and the error display itself
- **`{ once: true }` input listener** for auto-clear — self-removing, no cleanup needed
- **TagEditPage uses `:id` not `:slug`** in the route — unambiguous, avoids a slug-lookup round-trip, matches PostEditPage's pattern
