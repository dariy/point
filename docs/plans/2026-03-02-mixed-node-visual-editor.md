# Mixed-Node Visual Editor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend the Visual editor to support interleaved text nodes and image nodes in a single drag-and-drop list.

**Architecture:** Node model (`{ type: 'image'|'text', path?|text? }`) replaces the flat `string[]` image array. Content is serialized to the same plain-text format (no backend changes). VisualEditor renders both card types with shared drag-and-drop. Text content is uncontrolled inside VisualEditor; the parent reads it via `serializeNodes()` at save time.

**Tech Stack:** Vanilla JS, no dependencies. Files: `frontend/src/components/light/VisualEditor.js`, `frontend/src/pages/light/PostEditPage.js`, `frontend/css/light/editor.css`.

**Design doc:** `docs/plans/2026-03-02-mixed-node-visual-editor-design.md`

---

### Task 1: Add `parseNodes` and `serializeNodes` helpers; update `_loadPost`

**Files:**
- Modify: `frontend/src/pages/light/PostEditPage.js` — top-level helpers and `_loadPost`

**Context:** Currently `parseContent(content)` returns `{ paths, hasText }` and is only used for mode detection. Replace it with `parseNodes` which returns an ordered `Node[]`, and add `serializeNodes`. The existing `IMAGE_PATH_RE` regex stays.

**Step 1: Replace `parseContent` with `parseNodes` + add `serializeNodes`**

In `PostEditPage.js`, replace the block at lines ~31-45 (the `parseContent` function and its JSDoc):

```js
/**
 * Parse content string into an ordered list of image and text nodes.
 * Consecutive non-image lines are grouped into a single text node.
 * @param {string} content
 * @returns {Array<{type:'image',path:string}|{type:'text',text:string}>}
 */
function parseNodes(content) {
  const lines = (content || '').split('\n');
  const nodes = [];
  let textBuf = [];

  const flushText = () => {
    const text = textBuf.join('\n').trim();
    if (text) nodes.push({ type: 'text', text });
    textBuf = [];
  };

  for (const line of lines) {
    if (IMAGE_PATH_RE.test(line.trim())) {
      flushText();
      nodes.push({ type: 'image', path: line.trim() });
    } else {
      textBuf.push(line);
    }
  }
  flushText();
  return nodes;
}

/**
 * Serialize an ordered node list back to the plain-text content format.
 * @param {Array<{type:string,path?:string,text?:string}>} nodes
 * @returns {string}
 */
function serializeNodes(nodes) {
  return nodes.map((n) => (n.type === 'image' ? n.path : n.text)).join('\n');
}
```

**Step 2: Update `_loadPost` to use `parseNodes`**

Find `_loadPost` (~line 402). Replace the `parseContent` call and the mode-detection line:

Old:
```js
const { paths, hasText } = parseContent(post.content);
const editorMode = (!hasText && paths.length > 0) ? 'visual' : 'text';
this._visualImages = paths;
this.setState({ loading: false, post, error: null, editorMode });
```

New:
```js
const nodes = parseNodes(post.content);
const editorMode = nodes.length > 0 && nodes.every((n) => n.type === 'image') ? 'visual' : 'text';
this._nodes = nodes;
this.setState({ loading: false, post, error: null, editorMode });
```

**Step 3: Update `_handleAnalyze` — both success and error paths**

Find the two lines `if (this.state.editorMode === 'visual') this._visualImages = parseContent(post.content).paths;` and replace both with:

```js
if (this.state.editorMode === 'visual') this._nodes = parseNodes(post.content);
```

**Step 4: Manual verify**

Open the browser console, load `/light/posts/new`. No JS errors. The Visual editor mounts (empty). Flip to text mode and back — no errors.

**Step 5: Commit**

```bash
git add frontend/src/pages/light/PostEditPage.js
git commit -m "refactor: replace parseContent with parseNodes/serializeNodes"
```

---

### Task 2: Migrate PostEditPage from `_visualImages` to `_nodes`

**Files:**
- Modify: `frontend/src/pages/light/PostEditPage.js` — constructor, all methods that reference `_visualImages`

**Context:** `_visualImages: string[]` is the canonical visual-mode state. It must become `_nodes: Node[]`. All reads/writes must switch over. VisualEditor props change from `images` to `nodes`.

**Step 1: Update constructor**

Find `this._visualImages = [];` in the constructor (~line 65). Replace:

```js
this._nodes = [];  // canonical node list for visual mode
```

**Step 2: Update `_mountVisualEditor`**

Full replacement of `_mountVisualEditor` (~lines 331-348):

```js
_mountVisualEditor() {
  if (this._visualEditorRef) {
    this._visualEditorRef.unmount();
    const idx = this._children.indexOf(this._visualEditorRef);
    if (idx !== -1) this._children.splice(idx, 1);
    this._visualEditorRef = null;
  }
  this._visualEditorRef = this.mountChild(VisualEditor, '#visual-editor-mount', {
    nodes: this._nodes,
    onChange: (nodes) => {
      this._nodes = nodes;
      this._visualEditorRef?.setProps({ nodes });
      this._debouncedAutosave();
    },
    onAdd: () => this._mediaPicker.open(),
    onRename: (oldPath, newFilename) => this._handleRename(oldPath, newFilename),
  });
}
```

**Step 3: Update `_handleRename`**

Replace the two lines that update `_visualImages` and call `setProps`:

Old:
```js
this._visualImages = this._visualImages.map((p) => (p === oldPath ? newPath : p));
this._visualEditorRef?.setProps({ images: this._visualImages });
```

New:
```js
this._nodes = this._nodes.map((n) =>
  n.type === 'image' && n.path === oldPath ? { ...n, path: newPath } : n
);
this._visualEditorRef?.setProps({ nodes: this._nodes });
```

**Step 4: Update `_insertMediaPaths`**

Replace the visual-mode branch (currently ~lines 315-323):

Old:
```js
if (this.state.editorMode === 'visual') {
  this._visualImages = [...this._visualImages, ...items.map((item) => item.path)];
  if (this._visualEditorRef) {
    this._visualEditorRef.setProps({ images: this._visualImages });
  } else if (this.$('#visual-editor-mount')) {
    this._mountVisualEditor();
  }
  return;
}
```

New:
```js
if (this.state.editorMode === 'visual') {
  this._nodes = [
    ...this._nodes,
    ...items.map((item) => ({ type: 'image', path: item.path })),
  ];
  if (this._visualEditorRef) {
    this._visualEditorRef.setProps({ nodes: this._nodes });
  } else if (this.$('#visual-editor-mount')) {
    this._mountVisualEditor();
  }
  return;
}
```

**Step 5: Update `_extractImagePath`**

Replace the visual-mode branch:

Old:
```js
return this._visualImages[0] || null;
```

New:
```js
return this._nodes.find((n) => n.type === 'image')?.path ?? null;
```

**Step 6: Update `_switchMode`**

Full replacement (removes the `window.confirm` warning — no data loss with mixed nodes):

```js
_switchMode(targetMode) {
  if (this.state.editorMode === targetMode) return;

  if (targetMode === 'visual') {
    const content = this.$('#content-editor')?.value ?? (this.state.post?.content || '');
    this._nodes = parseNodes(content);
    this.setState({ editorMode: 'visual' });
  } else {
    // visual → text: serialize current nodes (reads live textarea values if editor mounted)
    const content = this._visualEditorRef?.serializeNodes() ?? serializeNodes(this._nodes);
    const post = { ...(this.state.post || {}), content };
    this.setState({ editorMode: 'text', post });
  }
}
```

**Step 7: Update `_collectFormData`**

Replace the `content` field:

Old:
```js
content: this.state.editorMode === 'visual'
  ? this._visualImages.join('\n')
  : (this.$('#content-editor')?.value || ''),
```

New:
```js
content: this.state.editorMode === 'visual'
  ? (this._visualEditorRef?.serializeNodes() ?? serializeNodes(this._nodes))
  : (this.$('#content-editor')?.value || ''),
```

**Step 8: Manual verify**

- Open `/light/posts/new` in Visual mode. Add images via Media button. Remove one. Drag to reorder. Save. Reload — images restored. Switch to Text mode — content shows image paths. Switch back to Visual — images show.
- Open an existing image-only post — auto-detects Visual mode. ✓

**Step 9: Commit**

```bash
git add frontend/src/pages/light/PostEditPage.js
git commit -m "refactor: migrate PostEditPage from _visualImages to _nodes"
```

---

### Task 3: Update VisualEditor — render mixed nodes + insert zones

**Files:**
- Modify: `frontend/src/components/light/VisualEditor.js` — `render()`, `_bindRemove()`, `_bindDrag()`

**Context:** The `render()` method currently only handles image nodes. It needs to handle both card types and insert zones. `_bindRemove` and `_bindDrag` reference `this.props.images` — switch to `this.props.nodes`.

**Step 1: Rewrite `render()`**

Replace the entire `render()` method:

```js
render() {
  const { nodes = [] } = this.props;

  const insertZone = (index) =>
    `<div class="ve-insert-zone" data-insert-at="${index}">
       <button class="ve-insert-btn" type="button" title="Insert text node">+</button>
     </div>`;

  const cards = nodes.map((node, i) => {
    if (node.type === 'image') {
      const thumb = `/media/thumbnails${node.path}`;
      const filename = node.path.split('/').pop();
      return `
        ${insertZone(i)}
        <div class="ve-card" data-index="${i}">
          <div class="ve-handle" title="Drag to reorder">
            <span class="ve-handle-dots"></span>
          </div>
          <img class="ve-thumb" src="${escapeHtml(thumb)}"
               alt="${escapeHtml(filename)}"
               data-full="/media/originals${escapeHtml(node.path)}"
               loading="lazy">
          <span class="ve-path">${escapeHtml(node.path)}</span>
          <button class="ve-remove" data-index="${i}" type="button"
                  aria-label="Remove image" title="Remove">&times;</button>
        </div>`;
    } else {
      return `
        ${insertZone(i)}
        <div class="ve-card ve-card--text" data-index="${i}">
          <div class="ve-handle" title="Drag to reorder">
            <span class="ve-handle-dots"></span>
          </div>
          <span class="ve-text-icon" aria-hidden="true">¶</span>
          <textarea class="ve-text-area" placeholder="Add text\u2026" rows="1">${escapeHtml(node.text || '')}</textarea>
          <button class="ve-remove" data-index="${i}" type="button"
                  aria-label="Remove text block" title="Remove">&times;</button>
        </div>`;
    }
  }).join('');

  const empty = nodes.length === 0
    ? `<p class="ve-empty">No content yet. Click <strong>Media</strong> to add images.</p>`
    : '';

  return `
    <div class="ve-root">
      <div class="ve-list" id="ve-list">
        ${cards}
        ${insertZone(nodes.length)}
        ${empty}
      </div>
    </div>`;
}
```

**Step 2: Update `_bindRemove` — switch `this.props.images` to `this.props.nodes`**

```js
_bindRemove() {
  this.container.querySelectorAll('.ve-remove').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.dataset.index, 10);
      const next = [...this.props.nodes];
      next.splice(idx, 1);
      this.props.onChange(next);
    });
  });
}
```

**Step 3: Update `_bindDrag` — switch `this.props.images` to `this.props.nodes` in the `drop` handler**

Find the drop handler inside `_bindDrag`. Replace:

Old:
```js
const next = [...this.props.images];
```

New:
```js
const next = [...this.props.nodes];
```

The rest of the drop handler is unchanged.

**Step 4: Manual verify**

Open a post in Visual mode. The insert zones (`+` buttons) appear on hover. Image cards render normally. No JS errors.

**Step 5: Commit**

```bash
git add frontend/src/components/light/VisualEditor.js
git commit -m "feat: render mixed image/text cards and insert zones in VisualEditor"
```

---

### Task 4: VisualEditor — insert zones, text card bindings, `serializeNodes()`

**Files:**
- Modify: `frontend/src/components/light/VisualEditor.js` — `afterRender()` and new methods

**Context:** Wire up the `+` buttons to insert text nodes. Auto-resize textareas. Expose `serializeNodes()` for the parent to call at save time.

**Step 1: Update `afterRender()` to call new bind methods**

```js
afterRender() {
  this._bindRemove();
  this._bindDrag();
  this._bindLightbox();
  this._bindInlineRename();
  this._bindInsertZones();
  this._bindTextCards();
}
```

**Step 2: Add `_bindInsertZones()`**

Add this method after `_bindInlineRename`:

```js
_bindInsertZones() {
  this.container.querySelectorAll('.ve-insert-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const zone = btn.closest('.ve-insert-zone');
      if (!zone) return;
      const at = parseInt(zone.dataset.insertAt, 10);
      const next = [...this.props.nodes];
      next.splice(at, 0, { type: 'text', text: '' });
      this.props.onChange(next);
      // After parent re-renders via setProps, focus the new textarea
      requestAnimationFrame(() => {
        const cards = this.container.querySelectorAll('.ve-card');
        cards[at]?.querySelector('.ve-text-area')?.focus();
      });
    });
  });
}
```

**Step 3: Add `_bindTextCards()`**

Add this method after `_bindInsertZones`:

```js
_bindTextCards() {
  this.container.querySelectorAll('.ve-text-area').forEach((ta) => {
    const resize = () => {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
    };
    resize();
    ta.addEventListener('input', resize);
  });
}
```

**Step 4: Add `serializeNodes()`**

Add this method as a public method (after `afterRender`, before `_bindRemove`):

```js
/**
 * Read current node state from DOM (capturing live textarea values)
 * and serialize to the plain-text content format.
 * Called by PostEditPage at save time.
 * @returns {string}
 */
serializeNodes() {
  const nodes = this.props.nodes || [];
  return nodes.map((node, i) => {
    if (node.type === 'image') return node.path;
    const card = this.container.querySelector(`.ve-card[data-index="${i}"]`);
    const ta = card?.querySelector('.ve-text-area');
    return ta ? ta.value : (node.text || '');
  }).join('\n');
}
```

**Step 5: Manual verify**

- Hover the `.ve-list` area — `+` buttons appear between cards.
- Click a `+` between two image cards — a text card inserts at that position and the textarea is focused.
- Type in the textarea — it auto-resizes.
- Click `×` on the text card — it removes.
- Drag the text card's handle — it reorders among other cards.
- Save — text content is persisted. Reload — text node is restored.
- Switch to Text mode — raw content includes image paths + text lines. Switch back — mixed layout restored.

**Step 6: Commit**

```bash
git add frontend/src/components/light/VisualEditor.js
git commit -m "feat: add text node insert, auto-resize, and serializeNodes to VisualEditor"
```

---

### Task 5: CSS — text card and insert zone styles

**Files:**
- Modify: `frontend/css/light/editor.css` — add new rules

**Context:** The text card shares `.ve-card` base styles but needs overrides for its layout (no thumb, paragraph icon, full-width textarea). Insert zones need to be invisible by default, revealed on list hover.

**Step 1: Append new CSS rules**

Add at the end of `frontend/css/light/editor.css`:

```css
/* ===========================
   Text node card
   =========================== */
.ve-card--text {
    align-items: flex-start;
    padding-top: 6px;
    padding-bottom: 6px;
}

/* Paragraph icon — same width as drag handle, dotted right border */
.ve-text-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    flex-shrink: 0;
    align-self: stretch;
    border-right: 1px dotted var(--border-primary);
    color: var(--text-muted);
    font-size: 13px;
    user-select: none;
    padding-right: 2px;
}

/* Auto-resizing textarea inside text card */
.ve-text-area {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    font-family: var(--font-sans);
    font-size: var(--font-size-sm);
    line-height: 1.6;
    color: var(--text-primary);
    resize: none;
    overflow: hidden;
    min-height: 24px;
    padding: 2px 4px;
    outline: none;
    transition: color var(--transition-theme);
}

.ve-text-area::placeholder {
    color: var(--text-muted);
}

/* ===========================
   Insert zone — appears between cards on list hover
   =========================== */
.ve-insert-zone {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 20px;
    position: relative;
}

.ve-insert-zone::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    height: 1px;
    background: var(--border-primary);
    opacity: 0;
    transition: opacity var(--transition-fast);
}

.ve-insert-btn {
    position: relative;
    z-index: 1;
    background: var(--surface-card);
    border: 1px solid var(--border-primary);
    border-radius: 50%;
    width: 20px;
    height: 20px;
    font-size: 14px;
    cursor: pointer;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    padding: 0;
    line-height: 1;
    transition: opacity var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
}

.ve-list:hover .ve-insert-zone::before,
.ve-list:hover .ve-insert-btn {
    opacity: 1;
}

.ve-insert-btn:hover {
    color: var(--color-primary);
    border-color: var(--color-primary);
}
```

**Step 2: Manual verify**

- Image cards look identical to before.
- Text cards show: drag handle (dotted) | `¶` icon (dotted border) | textarea | `×` button.
- Textarea grows as you type.
- On list hover, a faint line and small `+` circle appear between cards.
- `+` button highlights blue on hover.
- Dark mode: all colors use CSS variables, so they adapt automatically.

**Step 3: Commit**

```bash
git add frontend/css/light/editor.css
git commit -m "feat: add CSS for text node cards and insert zones in VisualEditor"
```

---

## Done

After all 5 tasks:
- Mixed text+image posts can be created and edited in Visual mode
- Content serializes to the same plain-text format — no backend changes
- Existing image-only posts are unaffected
- Drag-and-drop works for both card types
- Text content is read from DOM at save time via `serializeNodes()`
