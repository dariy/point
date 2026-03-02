# Post Edit — Featured Star + Status in Title Row

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move the featured toggle and status selector into a title row inside the content area, auto-saving each on change for existing posts.

**Architecture:** Pure frontend change. The title row (`[★/☆] [status▾] [title input]`) replaces the plain title input at the top of `editor-main`. The "Publish" sidebar card is removed. A hidden checkbox keeps `_collectFormData()` unchanged. A new `_autoSaveField(patch)` method handles immediate partial PATCH for existing posts; new posts skip the API call.

**Tech Stack:** Vanilla JS (Component class), CSS custom properties, existing `badges.css` `.status-select` styles.

---

### Task 1: Add CSS for title row and featured button

**Files:**
- Modify: `frontend/css/light/editor.css`

No tests for CSS — verify visually in Task 4.

**Step 1: Add styles to `editor.css`**

Append at the bottom of `frontend/css/light/editor.css`:

```css
/* Title row: [★] [status] [title input] */
.title-row {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
}

.title-row .editor-title {
    flex: 1;
    min-width: 0;
}

/* Featured star toggle */
.featured-btn {
    flex-shrink: 0;
    background: transparent;
    border: none;
    cursor: pointer;
    font-size: 20px;
    line-height: 1;
    padding: 2px 4px;
    color: var(--text-muted);
    transition: color var(--transition-fast), transform 0.1s ease;
    border-radius: var(--border-radius-sm, 4px);
}

.featured-btn:hover {
    color: #f59e0b;
    transform: scale(1.15);
}

.featured-btn.is-featured {
    color: #f59e0b;
}

/* Full-width editor page — override the global max-width */
.editor-full-width {
    max-width: var(--content-max-width);
}
```

**Step 2: Commit**

```bash
git add frontend/css/light/editor.css
git commit -m "feat: add title-row and featured-btn CSS for post editor"
```

---

### Task 2: Refactor render() in PostEditPage.js

**Files:**
- Modify: `frontend/src/pages/light/PostEditPage.js`

**Step 1: Read the current render() method** (lines 45–164) to confirm exact strings before editing.

**Step 2: Add `editor-full-width` to the content div**

Find:
```js
          <main class="light-content">
```
Replace with:
```js
          <main class="light-content editor-full-width">
```

**Step 3: Replace the plain title form-group with the title row**

Find (in `editor-main`):
```js
              <div class="editor-main">
                <div class="form-group">
                  <input type="text" id="title-input" class="form-input editor-title"
                         placeholder="Post title" value="${title}" required>
                </div>
```

Replace with:
```js
              <div class="editor-main">
                <div class="title-row">
                  <input type="checkbox" id="featured-check" style="display:none"
                         ${featured ? 'checked' : ''}>
                  <button id="featured-toggle" type="button"
                          class="featured-btn${featured ? ' is-featured' : ''}"
                          title="${featured ? 'Unmark as featured' : 'Mark as featured'}">
                    ${featured ? '★' : '☆'}
                  </button>
                  <select id="status-select" class="status-select badge-${escapeHtml(status)}">
                    ${statusOpts}
                  </select>
                  <input type="text" id="title-input" class="form-input editor-title"
                         placeholder="Post title" value="${title}" required>
                </div>
```

**Step 4: Remove the "Publish" sidebar card**

Find:
```js
              <div class="editor-sidebar">
                <div class="card">
                  <div class="card-header"><h3>Publish</h3></div>
                  <div class="card-body">
                    <div class="form-group">
                      <label for="status-select">Status</label>
                      <select id="status-select" class="form-input">${statusOpts}</select>
                    </div>
                    <div class="form-group">
                      <label class="checkbox-label">
                        <input type="checkbox" id="featured-check"
                               ${featured ? 'checked' : ''}> Featured post
                      </label>
                    </div>
                  </div>
                </div>

                <div class="card">
                  <div class="card-header"><h3>Tags</h3></div>
```

Replace with:
```js
              <div class="editor-sidebar">
                <div class="card">
                  <div class="card-header"><h3>Tags</h3></div>
```

**Step 5: Verify render() produces no duplicate IDs** — `#status-select` and `#featured-check` now appear only once (in the title row).

**Step 6: Commit**

```bash
git add frontend/src/pages/light/PostEditPage.js
git commit -m "feat: move status+featured into title row, remove Publish sidebar card"
```

---

### Task 3: Add _autoSaveField() and wire up controls in afterRender()

**Files:**
- Modify: `frontend/src/pages/light/PostEditPage.js`

**Step 1: Add `_autoSaveField` method**

Add after the `_autosave()` method (around line 286):

```js
  async _autoSaveField(patch) {
    if (this.state.isNew) return;   // new post: wait for manual Save
    try {
      const post = await updatePost(this.state.postId, patch);
      this.setState({ post, saveStatus: 'saved' });
      setTimeout(() => this.setState({ saveStatus: null }), 2000);
    } catch (err) {
      store.set('toast', { message: err.message || 'Auto-save failed.', type: 'error' });
    }
  }
```

**Step 2: Wire featured toggle in afterRender()**

In `afterRender()`, after the save button listener (around line 186), add:

```js
    // Featured star toggle
    const featuredToggle = this.$('#featured-toggle');
    const featuredCheck  = this.$('#featured-check');
    featuredToggle?.addEventListener('click', () => {
      const newVal = !featuredCheck.checked;
      featuredCheck.checked = newVal;
      featuredToggle.textContent = newVal ? '★' : '☆';
      featuredToggle.classList.toggle('is-featured', newVal);
      featuredToggle.title = newVal ? 'Unmark as featured' : 'Mark as featured';
      this._autoSaveField({ is_featured: newVal });
    });
```

**Step 3: Wire status header select in afterRender()**

Add immediately after the featured toggle wiring:

```js
    // Status pill — auto-save on change
    const statusSelect = this.$('#status-select');
    statusSelect?.addEventListener('change', () => {
      const newStatus = statusSelect.value;
      statusSelect.className = `status-select badge-${newStatus}`;
      this._autoSaveField({ status: newStatus });
    });
```

**Step 4: Commit**

```bash
git add frontend/src/pages/light/PostEditPage.js
git commit -m "feat: wire featured toggle and status auto-save in post editor"
```

---

### Task 4: Manual verification

Open the dev server (or open `frontend/index.html` directly if static):

1. **New post** (`/light/posts/new`):
   - ☆ star shows (muted), status pill shows "Draft"
   - Click star → fills ★ (amber), no network request
   - Change status → pill colour changes, no network request
   - Enter title, click Save → post created with correct status + featured values

2. **Existing post** (`/light/posts/:id/edit`):
   - Star and status pill reflect saved values
   - Click star → fills/empties, network PATCH fires immediately, "Saved" flash appears
   - Change status → pill recolours, network PATCH fires, "Saved" flash appears
   - Title still editable; Save button still works for content changes

3. **Width** — content area reaches full viewport width (no max-width gap).

4. **No "Publish" card** in the sidebar — only Tags card remains.

---

### Task 5: Final commit + cleanup

```bash
git status   # confirm no untracked changes
git log --oneline -5
```

If everything looks good, push the branch:

```bash
git push -u origin experiment-go
```
