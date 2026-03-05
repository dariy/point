# Visual Post Editor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a visual image-sequence editor to `/light/posts/:id/edit` that toggles with the existing textarea.

**Architecture:** In-place swap inside `PostEditPage.js` — an `editorMode` state (`'text'|'visual'`) swaps the textarea for a new `VisualEditor` component. Both modes read/write the same `content` string (bare image paths, newline-joined). A `parseContent()` helper determines auto-start mode and extracts the path list.

**Tech Stack:** Vanilla JS (Component base class, no framework), HTML5 drag API, CSS custom properties from `tokens.css`.

---

## Key context before starting

- `PostEditPage.js` uses `this.$()` for DOM queries, `mountChild()` for child components, `setState()` to re-render.
- Content is stored as bare lines: `/2026/02/photo.jpg` — identified by regex `/^\/\d{4}\/\d{2}\/.+$/`.
- `_collectFormData()` reads `#content-editor` textarea — must be updated to handle visual mode.
- `_insertMediaPaths(items)` appends to the textarea — must route to visual editor in visual mode.
- `MediaPickerDialog.open(onConfirmOverride)` accepts a one-shot callback override.
- CSS variables: `--border-primary`, `--surface-card`, `--surface-hover`, `--text-muted`, `--text-primary`, `--color-primary`, `--border-radius`, `--spacing-sm/md`, `--shadow-sm`, `--transition-fast`.
- Use DOM methods (`createElement`, `setAttribute`, `textContent`) instead of `innerHTML` for any dynamically-created elements that hold user/server data. `innerHTML` is acceptable only in the Component `render()` method where all user data is passed through `escapeHtml`.

---

## Task 1: `parseContent` helper + CSS for mode toggle

**Files:**
- Modify: `frontend/src/pages/light/PostEditPage.js` (add helper at module level)
- Modify: `frontend/css/light/editor.css` (add toggle button styles)

**Step 1: Add `parseContent` at the top of `PostEditPage.js`, after the imports**

```js
const IMAGE_PATH_RE = /^\/\d{4}\/\d{2}\/.+$/;

/**
 * Split content into ordered image paths + a flag for whether any non-path
 * text lines exist. Used to auto-detect editor mode and populate VisualEditor.
 */
function parseContent(content) {
  const lines = (content || '').split('\n');
  const paths = [];
  let hasText = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (IMAGE_PATH_RE.test(trimmed)) {
      paths.push(trimmed);
    } else {
      hasText = true;
    }
  }
  return { paths, hasText };
}
```

**Step 2: Add CSS for the mode toggle button to `editor.css`**

```css
/* ===========================
   Editor mode toggle (Text / Visual)
   =========================== */
.editor-mode-toggle {
    display: flex;
    align-items: center;
    border: 1px solid var(--border-primary);
    border-radius: var(--border-radius);
    overflow: hidden;
    flex-shrink: 0;
    align-self: flex-start;
    margin-bottom: var(--spacing-sm);
}

.editor-mode-toggle button {
    background: transparent;
    border: none;
    padding: 4px 12px;
    font-size: var(--font-size-sm);
    cursor: pointer;
    color: var(--text-muted);
    transition: background var(--transition-fast), color var(--transition-fast);
}

.editor-mode-toggle button.active {
    background: var(--color-primary);
    color: #fff;
}

.editor-mode-toggle button:not(.active):hover {
    background: var(--surface-hover);
    color: var(--text-primary);
}
```

**Step 3: Commit**

```bash
git add frontend/src/pages/light/PostEditPage.js frontend/css/light/editor.css
git commit -m "feat: add parseContent helper and mode toggle CSS"
```

---

## Task 2: `VisualEditor` component — render + remove

**Files:**
- Create: `frontend/src/components/light/VisualEditor.js`
- Modify: `frontend/css/light/editor.css` (add visual editor card styles)

**Step 1: Create `VisualEditor.js`**

```js
/**
 * VisualEditor — visual image-sequence editor for immersive posts.
 *
 * Props:
 *   images    {string[]}  Ordered list of bare image paths.
 *   onChange  {fn}        Called with new string[] on any mutation.
 *   onAdd     {fn}        Called when user clicks "Add images" — opens picker.
 */

import { Component } from '../Component.js';
import { escapeHtml } from '../../utils/helpers.js';

export class VisualEditor extends Component {
  render() {
    const { images = [] } = this.props;

    const cards = images.map((path, i) => {
      const thumb = `{node.path}?thumb`;
      const filename = path.split('/').pop();
      return `
        <div class="ve-card" data-index="${i}" draggable="true">
          <div class="ve-handle" title="Drag to reorder">
            <span class="ve-handle-dots"></span>
          </div>
          <img class="ve-thumb" src="${escapeHtml(thumb)}"
               alt="${escapeHtml(filename)}"
               data-full="/media/originals${escapeHtml(path)}"
               loading="lazy">
          <span class="ve-path">${escapeHtml(path)}</span>
          <button class="ve-remove" data-index="${i}" type="button"
                  aria-label="Remove image" title="Remove">&times;</button>
        </div>`;
    }).join('');

    const empty = images.length === 0
      ? `<p class="ve-empty">No images yet. Click <strong>Media</strong> to add some.</p>`
      : '';

    return `
      <div class="ve-root">
        <div class="ve-list" id="ve-list">${cards}${empty}</div>
      </div>`;
  }

  afterRender() {
    this._bindRemove();
    this._bindDrag();
    this._bindLightbox();
  }

  _bindRemove() {
    this.container.querySelectorAll('.ve-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.currentTarget.dataset.index, 10);
        const next = [...this.props.images];
        next.splice(idx, 1);
        this.props.onChange(next);
      });
    });
  }

  // Drag and lightbox wired in later tasks — stubs to avoid errors
  _bindDrag() {}
  _bindLightbox() {}
}
```

**Step 2: Add CSS for image cards to `editor.css`**

```css
/* ===========================
   VisualEditor
   =========================== */
.ve-root {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-sm);
}

.ve-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 80px;
    position: relative;
}

.ve-empty {
    color: var(--text-muted);
    font-size: var(--font-size-sm);
    padding: var(--spacing-md);
    text-align: center;
    border: 1px dashed var(--border-primary);
    border-radius: var(--border-radius);
}

.ve-card {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    background: var(--surface-card);
    border: 1px solid var(--border-primary);
    border-radius: var(--border-radius);
    padding: 6px 10px 6px 0;
    transition: background var(--transition-fast), opacity var(--transition-fast);
    user-select: none;
}

.ve-card:hover {
    background: var(--surface-hover);
}

.ve-card.dragging {
    opacity: 0.4;
}

/* Drag handle — dotted left zone */
.ve-handle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    flex-shrink: 0;
    align-self: stretch;
    border-right: 1px dotted var(--border-primary);
    cursor: grab;
    color: var(--text-muted);
}

.ve-handle:active {
    cursor: grabbing;
}

.ve-handle-dots {
    display: block;
    width: 6px;
    height: 20px;
    background-image: radial-gradient(circle, var(--text-muted) 1.2px, transparent 1.2px);
    background-size: 6px 6px;
}

.ve-thumb {
    width: 80px;
    height: 56px;
    object-fit: cover;
    border-radius: calc(var(--border-radius) - 2px);
    flex-shrink: 0;
    cursor: zoom-in;
    background: var(--surface-hover);
}

.ve-path {
    flex: 1;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

.ve-remove {
    flex-shrink: 0;
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 18px;
    line-height: 1;
    padding: 2px 4px;
    border-radius: var(--border-radius-sm, 4px);
    transition: color var(--transition-fast);
}

.ve-remove:hover {
    color: var(--color-danger, #ef4444);
}

/* Drop indicator line */
.ve-drop-indicator {
    height: 2px;
    background: var(--color-primary);
    border-radius: 2px;
    pointer-events: none;
    margin: 0 4px;
    flex-shrink: 0;
}
```

**Step 3: Commit**

```bash
git add frontend/src/components/light/VisualEditor.js frontend/css/light/editor.css
git commit -m "feat: add VisualEditor component with card render and remove"
```

---

## Task 3: `VisualEditor` — drag-and-drop reorder

**Files:**
- Modify: `frontend/src/components/light/VisualEditor.js` (replace `_bindDrag` stub)

**Step 1: Replace the `_bindDrag` stub with the full implementation**

The drop indicator is a separate DOM element (not a card) that gets inserted between cards during drag. We track the dragged index and the insertion slot.

```js
_bindDrag() {
  const list = this.$('#ve-list');
  if (!list) return;

  let dragIdx = null;
  let indicator = null;

  const getCards = () => [...list.querySelectorAll('.ve-card')];

  const removeIndicator = () => {
    indicator?.remove();
    indicator = null;
  };

  const insertIndicator = (referenceCard, before) => {
    removeIndicator();
    indicator = document.createElement('div');
    indicator.className = 've-drop-indicator';
    if (before) {
      list.insertBefore(indicator, referenceCard);
    } else {
      referenceCard.insertAdjacentElement('afterend', indicator);
    }
  };

  // Compute drop slot index (0 = before first card, n = after last card)
  const slotFromEvent = (e) => {
    const cards = getCards();
    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (e.clientY < mid) return i;
    }
    return cards.length;
  };

  // dragstart — only from the handle zone
  list.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.ve-card');
    if (!card) return;
    // Only start drag if initiated from the handle
    if (!e.target.closest('.ve-handle')) {
      e.preventDefault();
      return;
    }
    dragIdx = parseInt(card.dataset.index, 10);
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  list.addEventListener('dragover', (e) => {
    if (dragIdx === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const cards = getCards();
    const slot = slotFromEvent(e);

    if (slot === 0) {
      if (cards[0]) insertIndicator(cards[0], true);
    } else if (slot >= cards.length) {
      if (cards[cards.length - 1]) insertIndicator(cards[cards.length - 1], false);
    } else {
      insertIndicator(cards[slot], true);
    }
  });

  list.addEventListener('dragleave', (e) => {
    if (!list.contains(e.relatedTarget)) removeIndicator();
  });

  list.addEventListener('drop', (e) => {
    if (dragIdx === null) return;
    e.preventDefault();
    removeIndicator();

    const slot = slotFromEvent(e);
    const next = [...this.props.images];
    const [moved] = next.splice(dragIdx, 1);
    // Adjust insertion index after removal
    const insertAt = slot > dragIdx ? slot - 1 : slot;
    next.splice(insertAt, 0, moved);

    dragIdx = null;
    this.props.onChange(next);
  });

  list.addEventListener('dragend', () => {
    dragIdx = null;
    removeIndicator();
    list.querySelectorAll('.ve-card.dragging').forEach((c) => c.classList.remove('dragging'));
  });
}
```

**Step 2: Commit**

```bash
git add frontend/src/components/light/VisualEditor.js
git commit -m "feat: add drag-and-drop reorder to VisualEditor"
```

---

## Task 4: `VisualEditor` — lightbox

**Files:**
- Modify: `frontend/src/components/light/VisualEditor.js` (replace `_bindLightbox` stub)
- Modify: `frontend/css/light/editor.css` (add lightbox styles)

**Step 1: Replace `_bindLightbox` stub**

Use DOM methods (not innerHTML) to build the overlay safely:

```js
_bindLightbox() {
  this.container.querySelectorAll('.ve-thumb').forEach((img) => {
    img.addEventListener('click', () => {
      const full = img.dataset.full;
      if (!full) return;

      const overlay = document.createElement('div');
      overlay.className = 've-lightbox';

      const fullImg = document.createElement('img');
      fullImg.src = full;
      fullImg.alt = '';
      overlay.appendChild(fullImg);
      document.body.appendChild(overlay);

      const close = () => overlay.remove();
      overlay.addEventListener('click', close);
      const onKey = (e) => {
        if (e.key === 'Escape') {
          close();
          document.removeEventListener('keydown', onKey);
        }
      };
      document.addEventListener('keydown', onKey);
    });
  });
}
```

**Step 2: Add lightbox CSS to `editor.css`**

```css
/* VisualEditor lightbox */
.ve-lightbox {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.88);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
    cursor: zoom-out;
}

.ve-lightbox img {
    max-width: 92vw;
    max-height: 92vh;
    object-fit: contain;
    border-radius: var(--border-radius);
    box-shadow: var(--shadow-lg);
}
```

**Step 3: Commit**

```bash
git add frontend/src/components/light/VisualEditor.js frontend/css/light/editor.css
git commit -m "feat: add lightbox to VisualEditor"
```

---

## Task 5: Wire `VisualEditor` into `PostEditPage` — state + toggle

**Files:**
- Modify: `frontend/src/pages/light/PostEditPage.js`

**Step 1: Import `VisualEditor` at the top (after existing imports)**

```js
import { VisualEditor } from '../../components/light/VisualEditor.js';
```

**Step 2: Add `editorMode` to constructor state, and `_visualImages` instance variable**

In `constructor`, change the `this.state = { ... }` block to add `editorMode`:

```js
this.state = {
  loading: !!id,
  saving: false,
  analyzing: false,
  post: null,
  error: null,
  isNew: !id,
  postId: id,
  editorMode: 'text',   // 'text' | 'visual'  — updated after post loads
};
this._visualImages = []; // canonical image list for visual mode
```

**Step 3: Detect initial mode after loading the post**

In `_loadPost()`, after `const post = await getPost(id)`, add:

```js
const { paths, hasText } = parseContent(post.content);
const editorMode = (!hasText && paths.length > 0) ? 'visual' : 'text';
this._visualImages = paths;
this.setState({ loading: false, post, error: null, editorMode });
```

Remove the old `this.setState({ loading: false, post, error: null })` line.

**Step 4: Add the mode toggle to `render()`**

In `render()`, add this near the top of the method (after the `p` / `content` variable declarations):

```js
const modeToggle = `
  <div class="editor-mode-toggle">
    <button id="mode-text-btn" type="button"
            class="${this.state.editorMode === 'text' ? 'active' : ''}">Text</button>
    <button id="mode-visual-btn" type="button"
            class="${this.state.editorMode === 'visual' ? 'active' : ''}">Visual</button>
  </div>`;

const contentArea = this.state.editorMode === 'visual'
  ? `<div id="visual-editor-mount"></div>`
  : `<textarea id="content-editor" class="editor-content"
               rows="24" placeholder="Write your post content here\u2026">${escapeHtml(content)}</textarea>`;
```

Then replace the existing content `<div class="form-group">` block in the returned HTML:

```html
<div class="form-group">
  ${modeToggle}
  ${contentArea}
</div>
```

**Step 5: Wire toggle buttons and mount VisualEditor in `afterRender()`**

Add after the `$('#media-btn')` listener:

```js
this.$('#mode-text-btn')?.addEventListener('click', () => this._switchMode('text'));
this.$('#mode-visual-btn')?.addEventListener('click', () => this._switchMode('visual'));
```

And mount the VisualEditor when in visual mode (add this block inside the early-return guard):

```js
if (this.state.editorMode === 'visual') {
  this._mountVisualEditor();
}
```

Add the helper method:

```js
_mountVisualEditor() {
  this.mountChild(VisualEditor, '#visual-editor-mount', {
    images: this._visualImages,
    onChange: (imgs) => {
      this._visualImages = imgs;
      this._debouncedAutosave();
    },
    onAdd: () => this._mediaPicker.open(),
  });
}
```

**Step 6: Commit**

```bash
git add frontend/src/pages/light/PostEditPage.js
git commit -m "feat: add editorMode state and toggle button to PostEditPage"
```

---

## Task 6: Mode switching logic + warning dialog

**Files:**
- Modify: `frontend/src/pages/light/PostEditPage.js`

**Step 1: Add `_switchMode(targetMode)` method**

```js
_switchMode(targetMode) {
  if (this.state.editorMode === targetMode) return;

  if (targetMode === 'visual') {
    const content = this.$('#content-editor')?.value ?? (this.state.post?.content || '');
    const { paths, hasText } = parseContent(content);

    if (hasText) {
      const confirmed = window.confirm(
        'Visual mode only supports image sequences.\nAll text content will be discarded on save.\n\nSwitch anyway?'
      );
      if (!confirmed) return;
    }

    this._visualImages = paths;
    this.setState({ editorMode: 'visual' });
  } else {
    // visual → text: serialize image list back into content field
    const post = { ...(this.state.post || {}), content: this._visualImages.join('\n') };
    this.setState({ editorMode: 'text', post });
  }
}
```

**Step 2: Commit**

```bash
git add frontend/src/pages/light/PostEditPage.js
git commit -m "feat: implement mode switching with text-loss warning"
```

---

## Task 7: Wire form data collection and media insertion

**Files:**
- Modify: `frontend/src/pages/light/PostEditPage.js`

**Step 1: Update `_collectFormData()` to read visual images when in visual mode**

Find the line:
```js
content: this.$('#content-editor')?.value || '',
```

Replace with:
```js
content: this.state.editorMode === 'visual'
  ? this._visualImages.join('\n')
  : (this.$('#content-editor')?.value || ''),
```

**Step 2: Update `_insertMediaPaths()` to append to visual editor when in visual mode**

Replace the entire method:

```js
_insertMediaPaths(items) {
  if (!items.length) return;
  if (this.state.editorMode === 'visual') {
    this._visualImages = [...this._visualImages, ...items.map((item) => item.path)];
    this._mountVisualEditor();
    return;
  }
  const editor = this.$('#content-editor');
  if (!editor) return;
  const paths = items.map((item) => item.path).join('\n');
  editor.value = editor.value.trimEnd() + '\n' + paths;
  editor.scrollTop = editor.scrollHeight;
}
```

**Step 3: Update `_extractImagePath()` to use visual images when in visual mode**

Replace the entire method:

```js
_extractImagePath() {
  if (this.state.editorMode === 'visual') {
    return this._visualImages[0] || null;
  }
  const content = this.$('#content-editor')?.value || '';
  const match = content.match(
    /(?:^|["'\s(])(\/\d{4}\/\d{2}\/.+?\.(?:jpe?g|png|webp|gif|avif|heic|tiff|bmp))(?:["'\s)]|$)/i
  );
  return match ? match[1] : null;
}
```

**Step 4: Update `_uploadAndInsert()` to route through visual editor in visual mode**

Replace the inner block:
```js
const editor = this.$('#content-editor');
if (editor) {
  editor.value = editor.value.trimEnd() + `\n${result.path}`;
  editor.scrollTop = editor.scrollHeight;
}
```

With:
```js
if (this.state.editorMode === 'visual') {
  this._insertMediaPaths([{ path: result.path }]);
} else {
  const editor = this.$('#content-editor');
  if (editor) {
    editor.value = editor.value.trimEnd() + `\n${result.path}`;
    editor.scrollTop = editor.scrollHeight;
  }
}
```

**Step 5: Keep `_visualImages` in sync when `_handleAnalyze` updates `post.content`**

In `_handleAnalyze`, after the `post` object is built (before both `setState` calls), add:

```js
if (this.state.editorMode === 'visual') {
  this._visualImages = parseContent(post.content).paths;
}
```

Add this line in **both** the success path and the error/restore path.

**Step 6: Commit**

```bash
git add frontend/src/pages/light/PostEditPage.js
git commit -m "feat: route form data and media insertion through visual editor"
```

---

## Task 8: Smoke test

**Manual verification checklist:**

1. Open a post that has only image paths → editor opens in **visual mode**
2. Open a post with text content → editor opens in **text mode**
3. Toggle text → visual on a post with text → **warning dialog** appears; cancel stays in text, confirm switches
4. Toggle visual → text → paths appear correctly in textarea
5. In visual mode, drag a card by its handle zone → **drop indicator** appears between cards → release → order updates
6. Click a thumbnail → **lightbox** opens with full image; Escape or click closes it
7. Click **×** on a card → image removed from list
8. Click **Media** in visual mode → picker opens → selected images **append** to list
9. Drag-and-drop an image file onto the page while in visual mode → uploads and **appends card**
10. Click **Save** in visual mode → post saves with correct path-only content
11. Reload the page after saving a visual-mode post → reopens in **visual mode**
