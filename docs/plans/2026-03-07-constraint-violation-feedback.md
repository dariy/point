# Constraint Violation Feedback — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When a user violates a database or application constraint in any admin form, the specific field is highlighted with a red border and an inline error message. Errors clear as soon as the user starts typing. The backend returns proper `409 Conflict` with human-readable, field-identified JSON.

**Architecture:** Shared `isUniqueViolation()` Go helper + shared `formErrors.js` JS utility + `TagEditPage` replacing the TagsManagerPage modal. Uses existing `.has-error` / `.form-error` CSS — no new CSS required.

**Tech Stack:** Go + Echo v4 backend, Vanilla JS SPA frontend (no build step)

---

## Phase 1 — Backend constraint infrastructure

### Task 1.1: Create `api/internal/api/errors.go`

**Files:**
- Create: `api/internal/api/errors.go`

Create the file with this content:

```go
package api

import "strings"

// isUniqueViolation reports whether err is a SQLite UNIQUE constraint violation.
// The error string from modernc.org/sqlite contains "UNIQUE constraint failed: table.column".
func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}

// uniqueViolationResponse builds a structured 409 response body for a UNIQUE constraint error.
// It parses the column name from the SQLite error string and maps it to a human-readable message.
// Returns map with "detail" and "field" keys. "field" is empty string if column is unrecognized.
func uniqueViolationResponse(err error) map[string]string {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "posts.slug"):
		return map[string]string{
			"detail": "A post with this slug already exists.",
			"field":  "slug",
		}
	case strings.Contains(msg, "tags.name"):
		return map[string]string{
			"detail": "A tag with this name already exists.",
			"field":  "name",
		}
	case strings.Contains(msg, "tags.slug"):
		return map[string]string{
			"detail": "A tag with this slug already exists.",
			"field":  "slug",
		}
	default:
		return map[string]string{
			"detail": "A record with these values already exists.",
			"field":  "",
		}
	}
}
```

### Task 1.2: Fix `CreatePost` in `api/internal/api/posts.go`

**Files:**
- Modify: `api/internal/api/posts.go`

Read the file first. Find `CreatePost` handler. The error branch after `h.postService.CreatePost(...)` currently returns `echo.NewHTTPError(http.StatusInternalServerError, err.Error())`.

Replace that error branch with:

```go
if isUniqueViolation(err) {
    body := uniqueViolationResponse(err)
    // If user left slug blank, the service auto-generated one — tell them what it was
    if req.Slug == "" {
        body["detail"] = "This title's auto-generated slug is already taken. Please enter a custom slug."
        body["suggested_slug"] = utils.Slugify(req.Title)
    }
    return c.JSON(http.StatusConflict, body)
}
return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
```

Add `"point-api/internal/utils"` to the import block if not already present.

### Task 1.3: Fix `UpdatePost` in `api/internal/api/posts.go`

**Files:**
- Modify: `api/internal/api/posts.go`

Find `UpdatePost` handler. The error branch after `h.postService.UpdatePost(...)` currently returns `echo.NewHTTPError(http.StatusNotFound, "Post not found or access denied")` for ALL errors.

Replace that error branch with:

```go
if isUniqueViolation(err) {
    return c.JSON(http.StatusConflict, uniqueViolationResponse(err))
}
return echo.NewHTTPError(http.StatusNotFound, "Post not found or access denied")
```

### Task 1.4: Fix `CreateTag` in `api/internal/api/tags.go`

**Files:**
- Modify: `api/internal/api/tags.go`

Find `CreateTag` handler. It currently returns `echo.NewHTTPError(http.StatusConflict, err.Error())` — correct status but raw SQL message.

Replace with:

```go
if isUniqueViolation(err) {
    return c.JSON(http.StatusConflict, uniqueViolationResponse(err))
}
return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
```

### Task 1.5: Fix `UpdateTag` in `api/internal/api/tags.go`

**Files:**
- Modify: `api/internal/api/tags.go`

Find `UpdateTag` handler. The error branch after `h.tagService.UpdateTag(...)` currently returns `echo.NewHTTPError(http.StatusNotFound, "Tag not found")` for ALL errors.

Replace with:

```go
if isUniqueViolation(err) {
    return c.JSON(http.StatusConflict, uniqueViolationResponse(err))
}
return echo.NewHTTPError(http.StatusNotFound, "Tag not found")
```

### Task 1.6: Fix `RenameMedia` in `api/internal/api/media.go`

**Files:**
- Modify: `api/internal/api/media.go`

Read the file. Find the `RenameMedia` handler. Locate the error branch after `h.mediaService.RenameMedia(...)`.

Add `"strings"` to imports if not present. Replace the error branch with:

```go
if strings.Contains(err.Error(), "file exists") || strings.Contains(err.Error(), "already exists") {
    return c.JSON(http.StatusConflict, map[string]string{
        "detail": "A file with that name already exists in this folder.",
        "field":  "filename",
    })
}
return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
```

### Task 1.7: Run tests

```bash
./scripts/run-tests.sh
```

All existing tests must pass. If any test checks for specific status codes on the affected endpoints, update those assertions to expect 409 instead of 404/500 where appropriate.

---

## Phase 2 — Frontend shared infrastructure

### Task 2.1: Create `frontend/src/utils/formErrors.js`

**Files:**
- Create: `frontend/src/utils/formErrors.js`

```js
/**
 * Finds the best container element for a field error display.
 * Walks up the DOM looking for recognized container classes.
 * @param {HTMLElement} inputEl
 * @returns {HTMLElement}
 */
function _findContainer(inputEl) {
  const candidates = ['.form-group', '.slug-row', '.title-row', '.title-input-wrapper'];
  let el = inputEl.parentElement;
  while (el && el !== document.body) {
    if (candidates.some((cls) => el.matches(cls))) return el;
    el = el.parentElement;
  }
  return inputEl.parentElement;
}

/**
 * Shows a field-level error on an input element.
 * Adds .has-error to the container, appends a .form-error span after the input,
 * and registers a one-time input listener to auto-clear the error.
 * @param {HTMLElement} inputEl
 * @param {string} message
 */
export function setFieldError(inputEl, message) {
  if (!inputEl) return;
  const container = _findContainer(inputEl);

  container.classList.add('has-error');
  inputEl.setAttribute('aria-invalid', 'true');

  // Remove any existing error for this input
  const existingId = inputEl.getAttribute('aria-describedby');
  if (existingId) document.getElementById(existingId)?.remove();

  const id = `field-error-${inputEl.id || inputEl.name || Math.random().toString(36).slice(2)}`;
  inputEl.setAttribute('aria-describedby', id);

  const span = document.createElement('span');
  span.className = 'form-error';
  span.setAttribute('role', 'alert');
  span.id = id;
  span.textContent = message;
  inputEl.insertAdjacentElement('afterend', span);

  inputEl.addEventListener('input', () => clearFieldError(inputEl), { once: true });
}

/**
 * Removes the field-level error state from an input element.
 * @param {HTMLElement} inputEl
 */
export function clearFieldError(inputEl) {
  if (!inputEl) return;
  const container = _findContainer(inputEl);
  container.classList.remove('has-error');
  inputEl.removeAttribute('aria-invalid');

  const errorId = inputEl.getAttribute('aria-describedby');
  if (errorId) {
    document.getElementById(errorId)?.remove();
    inputEl.removeAttribute('aria-describedby');
  }
}

/**
 * Clears all field-level errors within a container element.
 * Call this before each save attempt to reset prior error state.
 * @param {HTMLElement} containerEl
 */
export function clearAllFieldErrors(containerEl) {
  if (!containerEl) return;
  containerEl.querySelectorAll('[aria-invalid="true"]').forEach((el) => clearFieldError(el));
}
```

### Task 2.2: Modify `frontend/src/api/client.js`

**Files:**
- Modify: `frontend/src/api/client.js`

Read the file. Find the error throw in `ApiClient.request()`. It currently reads:
```js
throw { status: response.status, message };
```

Replace with:
```js
throw { ...(typeof body === 'object' && body !== null ? body : {}), status: response.status, message };
```

This spreads all JSON body fields (`field`, `suggested_slug`, etc.) onto the error object. All existing callers that only read `err.message` are unaffected.

---

## Phase 3 — PostEditPage integration

### Task 3.1: Add field error handling to `PostEditPage._save()`

**Files:**
- Modify: `frontend/src/pages/light/PostEditPage.js`

Read the file. Make these changes:

**Step 1:** Add import at the top of the file (with the other imports):
```js
import { setFieldError, clearAllFieldErrors } from '../../utils/formErrors.js';
```

**Step 2:** In `_save()`, find the title validation check that currently does a toast on empty title:
```js
if (!data.title) {
  store.set('toast', { message: 'Title is required.', type: 'error' });
  return;
}
```
Replace with:
```js
if (!data.title) {
  setFieldError(this.$('#title-input'), 'Title is required.');
  return;
}
```

**Step 3:** At the top of `_save()`, before the title check, add:
```js
clearAllFieldErrors(this.container);
```

**Step 4:** In the catch block of `_save()`, before the existing toast line, add:
```js
if (err.status === 409 && err.field === 'slug') {
  const slugInput = this.$('#slug-input');
  setFieldError(slugInput, err.message);
  // Auto-populate the slug field if the user left it blank (auto-generated slug collided)
  if (slugInput && !slugInput.value.trim() && err.suggested_slug) {
    slugInput.value = err.suggested_slug;
  }
  return;
}
if (err.status === 409 && err.field === 'title') {
  setFieldError(this.$('#title-input'), err.message);
  return;
}
```

---

## Phase 4 — SecurityPage integration

### Task 4.1: Add field error handling to `SecurityPage`

**Files:**
- Modify: `frontend/src/pages/light/SecurityPage.js`

Read the file. Make these changes:

**Step 1:** Add import:
```js
import { setFieldError, clearAllFieldErrors } from '../../utils/formErrors.js';
```

**Step 2:** In `_handlePasswordChange()`, at the very top, add:
```js
clearAllFieldErrors(this.$('#password-form'));
```

**Step 3:** Find the confirm-mismatch check that currently shows a toast:
```js
store.set('toast', { message: 'New passwords do not match.', type: 'error' });
return;
```
Replace with:
```js
setFieldError(this.$('#confirm-password'), 'Passwords do not match.');
return;
```

**Step 4:** In the catch block, before the existing toast, add:
```js
if (err.status === 400 || err.status === 401) {
  setFieldError(this.$('#current-password'), err.message || 'Incorrect password.');
  return;
}
```

---

## Phase 5 — MediaBrowser rename dialog

### Task 5.1: Add `showError()` to `PromptDialog`

**Files:**
- Modify: `frontend/src/components/shared/PromptDialog.js`

Read the file. Make these changes:

**Step 1:** In `afterRender()`, find where the prompt input element is queried (e.g. `this.$('#prompt-input')` or similar). Store a reference as an instance property:
```js
this._promptInput = this.$('#prompt-input'); // adjust selector to match actual ID
```

**Step 2:** In `afterRender()`, attach a clear-on-input listener on the input:
```js
this._promptInput?.addEventListener('input', () => {
  this._promptInput.parentElement?.classList.remove('has-error');
  this._promptInput.parentElement?.querySelector('.form-error')?.remove();
});
```

**Step 3:** Add a public `showError(message)` method to the class:
```js
showError(message) {
  if (!this._promptInput) return;
  const parent = this._promptInput.parentElement;
  parent?.querySelector('.form-error')?.remove();
  const span = document.createElement('span');
  span.className = 'form-error';
  span.textContent = message;
  parent?.appendChild(span);
  parent?.classList.add('has-error');
  this._promptInput.focus();
}
```

### Task 5.2: Keep rename dialog open on collision

**Files:**
- Modify: `frontend/src/components/light/MediaBrowser.js`

Read the file. Rewrite `_showRenamePrompt` to keep the dialog open on a 409 error:

```js
_showRenamePrompt(id, oldName) {
  const mountEl = document.createElement('div');
  document.body.appendChild(mountEl);
  const dialog = new PromptDialog(mountEl, {
    title: 'Rename file',
    message: 'Enter new name:',
    defaultValue: oldName,
    confirmText: 'Rename',
    onConfirm: async (newName) => {
      if (!newName || newName.trim() === '' || newName === oldName) {
        dialog.unmount();
        mountEl.remove();
        return;
      }
      try {
        await renameMedia(id, newName.trim());
        dialog.unmount();
        mountEl.remove();
        store.set('toast', { message: 'File renamed.', type: 'success' });
        this._load();
        this._loadFolders();
      } catch (err) {
        if (err.status === 409) {
          dialog.showError(err.message || 'A file with that name already exists.');
        } else {
          dialog.unmount();
          mountEl.remove();
          store.set('toast', { message: err.message || 'Rename failed.', type: 'error' });
        }
      }
    },
    onCancel: () => {
      dialog.unmount();
      mountEl.remove();
    },
  });
  dialog.mount();
}
```

Remove the separate `_renameMedia` method if it is only called from `_showRenamePrompt` (confirm by checking for other callers first).

---

## Phase 6 — TagEditPage (new page)

### Task 6.1: Create `frontend/src/pages/light/TagEditPage.js`

**Files:**
- Create: `frontend/src/pages/light/TagEditPage.js`

Read `frontend/src/pages/light/PostEditPage.js` for the full page structure pattern (light-layout, LightSidebar mount, header with Save/Cancel, content card).

Read `frontend/src/pages/light/TagsManagerPage.js` for the modal's inner HTML (name, slug, description, parents/children pickers, flags, coordinates) — this becomes the page body.

Also read:
- `frontend/src/api/tags.js` — for `createTag`, `updateTag`, `getTag`, `listTags`
- `frontend/src/api/client.js` — for navigate helper or router import pattern

Build the page with:

**State:**
```js
this.state = {
  loading: !!this.props.params?.id,
  saving: false,
  tag: null,
  allTags: [],
  isNew: !this.props.params?.id,
  tagId: this.props.params?.id ? parseInt(this.props.params.id, 10) : null,
  error: null,
};
```

**`render()`:** Return `light-layout` HTML with:
- `#sidebar-mount`
- `.light-main` > `.light-header` (h1 "New Tag" or "Edit: {name}", Save button, Cancel link to `/light/tags`) + `.light-content` > `.card` > `.card-body` with the form

The form fields (ported from the modal):
- `.title-row`: name input (`type="text"`, `name="name"`, `class="form-input editor-title"`, `required`)
- `.slug-row`: `/tag/` prefix text + slug input (`type="text"`, `name="slug"`, `class="form-input editor-slug"`, `spellcheck="false"`)
- `.form-group`: description textarea (`name="description"`, `class="form-input editor-excerpt"`)
- Collapsible sections: Parents, Children, Flags, Coordinates (same HTML structure as current modal, using `tm-collapsible-section` / `tm-section-toggle` class pattern)

**`afterRender()`:**
- Mount `LightSidebar` via `this.mountChild(LightSidebar, '#sidebar-mount', {})`
- Wire Save button → `this._save()`
- Wire name input → auto-slug: `if (!slugInput.dataset.manual) slugInput.value = this._slugify(nameInput.value)`
- Wire slug input → set `slugInput.dataset.manual = '1'` on first edit
- Wire collapsible section toggles
- Wire geocode/parse button (port the `_parseCoordinates` logic from the modal)
- Populate form with `this.state.tag` values if in edit mode

**`_slugify(name)`:** Port the slugify logic from `TagsManagerPage` (lowercase, replace spaces with hyphens, remove special chars).

**`_save()`:**
```js
async _save() {
  clearAllFieldErrors(this.container);
  const payload = this._collectFormData();
  this.setState({ saving: true });
  try {
    if (this.state.isNew) {
      await createTag(payload);
    } else {
      await updateTag(this.state.tagId, payload);
    }
    store.set('toast', { message: `Tag ${this.state.isNew ? 'created' : 'updated'}.`, type: 'success' });
    navigate('/light/tags');
  } catch (err) {
    this.setState({ saving: false });
    const fieldMap = {
      name: () => this.$('[name="name"]'),
      slug: () => this.$('[name="slug"]'),
    };
    if (err.status === 409 && err.field && fieldMap[err.field]) {
      setFieldError(fieldMap[err.field](), err.message);
    } else {
      store.set('toast', { message: err.message || 'Save failed.', type: 'error' });
    }
  }
}
```

**`_collectFormData()`:** Collect name, slug, description, selected parent_ids (checkbox values), selected child_ids, all boolean flags, latitude, longitude.

**`mount()`:**
```js
mount() {
  super.mount();
  this._loadData();
}

async _loadData() {
  try {
    const [allTagsData, tagData] = await Promise.all([
      listTags({ include_empty: true }),
      this.state.tagId ? getTag(this.state.tagId) : Promise.resolve(null),
    ]);
    this.setState({
      loading: false,
      allTags: allTagsData.tags || [],
      tag: tagData,
    });
    // Pre-select parent from ?parent= query param (Add Child flow)
    const parentId = this.props.query?.parent ? parseInt(this.props.query.parent, 10) : null;
    if (parentId && this.state.isNew) {
      const checkbox = this.$(`[name="parent_ids"][value="${parentId}"]`);
      if (checkbox) checkbox.checked = true;
    }
  } catch (err) {
    this.setState({ loading: false, error: err.message || 'Failed to load.' });
  }
}
```

Import `setFieldError`, `clearAllFieldErrors` from `../../utils/formErrors.js`.

---

## Phase 7 — TagsManagerPage modal removal + routing

### Task 7.1: Strip modal from `TagsManagerPage.js`

**Files:**
- Modify: `frontend/src/pages/light/TagsManagerPage.js`

Read the file first. Remove:
- `_openModal()` method
- `_closeModal()` method
- `_handleSave()` method (or any method that calls `createTag`/`updateTag` from the modal)
- `_renderTagToggles()` method
- `_renderFlagCheckbox()` method
- `_slugify()` method
- `this._modal`, `this._modalKeyHandler`, `this._didPushUrl` instance fields
- The `beforeUnmount()` call to `_closeModal()` (remove the method or empty it)
- In `_load()`: remove the block that checks `this.props?.params?.slug` to auto-open the modal

Change the "New Tag" button click handler:
```js
// Before: this._openModal()
// After:
navigate('/light/tags/new');
```

Change edit button click handler (`edit-tag-btn`):
```js
// Before: this._openModal(tag)
// After:
navigate(`/light/tags/${tag.id}/edit`);
```

Change add-child button click handler (`add-child-btn`):
```js
// Before: this._openModal(null, parentId)
// After:
navigate(`/light/tags/new?parent=${parentId}`);
```

Clean up any imports that are now unused (e.g. `createTag`, `updateTag`, geocode-related imports that were only used in the modal).

### Task 7.2: Update routes in `frontend/src/app.js`

**Files:**
- Modify: `frontend/src/app.js`

Read the file. Find the tag routes section.

Remove:
```js
{ path: '/light/tags/:slug', ... }
```

Add (after `/light/tags`):
```js
{ path: '/light/tags/new',      load: () => import('./pages/light/TagEditPage.js') },
{ path: '/light/tags/:id/edit', load: () => import('./pages/light/TagEditPage.js') },
```

**Route order matters:** `/light/tags/new` must appear before `/light/tags/:id/edit`. Both must appear after `/light/tags` (exact match). The router matches literal segments before parameter segments, so `/light/tags/new` will not be captured by `/:id/edit`.

---

## Verification Checklist

After completing all phases:

- [ ] `./scripts/run-tests.sh` passes with no failures
- [ ] Create a post with a slug that already exists → slug field turns red with "A post with this slug already exists."
- [ ] Create a post with empty slug where the title matches an existing post → slug field is highlighted and auto-populated with the suggested slug
- [ ] Edit a post and change slug to an existing one → slug field turns red (not "Post not found")
- [ ] Create a tag with a name that already exists → name field turns red
- [ ] Create a tag with a unique name but slugifies to existing slug → slug field turns red
- [ ] Edit a tag with conflicting name/slug → correct field turns red (not "Tag not found")
- [ ] SecurityPage: enter wrong current password → current-password field turns red
- [ ] SecurityPage: enter mismatched new passwords → confirm-password field turns red (not toast)
- [ ] Media rename: rename to existing filename → dialog stays open, input turns red
- [ ] All field errors clear immediately on typing in the affected field
- [ ] Navigate to `/light/tags/new` → TagEditPage renders
- [ ] Navigate to `/light/tags/:id/edit` → TagEditPage loads and populates with tag data
- [ ] "Add Child" button → navigates to `/light/tags/new?parent=:id` with parent pre-selected
- [ ] Cancel on TagEditPage → returns to `/light/tags`
