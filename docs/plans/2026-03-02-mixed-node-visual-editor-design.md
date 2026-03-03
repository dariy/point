# Mixed-Node Visual Editor — Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:writing-plans to create the implementation plan.

**Goal:** Extend Visual mode to support interleaved text nodes and image nodes in a single ordered list.

**Architecture:** Node model replaces the flat image-path array. Content is serialized to the same plain-text format (no backend changes). VisualEditor renders both card types with shared drag-and-drop. Text content is uncontrolled inside VisualEditor; the parent reads it via `serializeNodes()` at save time.

---

## Node Model

Each node is one of:

```js
{ type: 'image', path: '/2026/02/photo.jpg' }
{ type: 'text',  text: 'Some prose.\nCan be multiline.' }
```

### Serialization (nodes → content string)

Image node → its path on a single line.
Text node → its raw text (which may contain internal newlines).
Nodes are joined with `\n`.

Example:
```
/2026/02/photo1.jpg
This caption appears between images.
/2026/02/photo2.jpg
/2026/02/photo3.jpg
A second text block at the end.
```

### Parsing (content string → nodes)

Scan lines one by one:
- A line matching `IMAGE_PATH_RE` (`/^\d{4}\/\d{2}\/.+$/`) flushes any accumulated text buffer as a text node, then pushes an image node.
- Any other non-empty line accumulates into the text buffer.
- At end of input, flush the remaining text buffer if non-empty.

No backend changes. The format is backward-compatible with existing image-only posts.

---

## VisualEditor Component

### Props (updated)

| Prop | Type | Description |
|------|------|-------------|
| `nodes` | `Node[]` | Ordered mixed list (replaces `images`) |
| `onChange` | `fn(Node[])` | Called on structural changes (insert/remove/reorder) |
| `onAdd` | `fn` | Opens media picker (images appended by parent) |
| `onRename` | `async fn(oldPath, newFilename)` | Inline image rename |

### Card layout

**Image card** (unchanged):
```
[handle] [thumb 80×56] [path label] [×]
```

**Text card** (new):
```
[handle] [¶ icon] [textarea flex-1] [×]
```

Both use `.ve-card` base class. Text card uses `.ve-card--text` modifier.
Textarea: transparent background, no border, `--font-sans`, auto-resizes with content, placeholder "Add text…".

### Insert zones

A `.ve-insert-zone` sits before the first card, between every adjacent pair, and after the last card. They are hidden by default and revealed on `.ve-list:hover`. Each contains a `+` button.

Clicking a `+` button:
1. Creates `{ type: 'text', text: '' }` at that index
2. Calls `onChange` with the new node array
3. Parent calls `setProps` which re-renders
4. VisualEditor focuses the new textarea after render

### Text content — uncontrolled

Text node textareas are **not** re-synced through props on every keystroke. VisualEditor exposes:

```js
serializeNodes()  // reads current textarea DOM values → returns content string
```

`PostEditPage._collectFormData()` calls `this._visualEditorRef?.serializeNodes()` at save time.

### Drag-and-drop

Unchanged. Both card types use `data-index` and `.ve-card`. Drag is enabled via `mousedown` on `.ve-handle`. Insert zones (`.ve-insert-zone`) are not `.ve-card` elements, so slot calculation is unaffected.

---

## PostEditPage Changes

| Field | Before | After |
|-------|--------|-------|
| Canonical visual state | `_visualImages: string[]` | `_nodes: Node[]` |
| Parse helper | `parseContent(content)` → `{ paths, hasText }` | `parseNodes(content)` → `Node[]` |
| Serialize helper | `_visualImages.join('\n')` | `serializeNodes(nodes)` |

### Method-by-method

**`parseNodes(content)`** — module-level helper, replaces `parseContent`.
Returns `Node[]` preserving order of all content.

**`serializeNodes(nodes)`** — module-level helper.
Returns `nodes.map(n => n.type === 'image' ? n.path : n.text).join('\n')`.

**`_loadPost()`** — uses `parseNodes`; auto-detect visual stays conservative:
```js
const nodes = parseNodes(post.content);
const editorMode = nodes.length > 0 && nodes.every(n => n.type === 'image') ? 'visual' : 'text';
```

**`_mountVisualEditor()`** — passes `nodes: this._nodes` instead of `images`.

**`_insertMediaPaths(items)`** — appends `{ type: 'image', path }` nodes to `_nodes`; calls `setProps`.

**`_handleRename(oldPath, newFilename)`** — finds node by `node.type === 'image' && node.path === oldPath`.

**`_extractImagePath()`** — returns `this._nodes.find(n => n.type === 'image')?.path ?? null`.

**`_switchMode(targetMode)`** — text→visual calls `parseNodes()` on textarea value; **no confirm dialog** (text is preserved as text nodes).

**`_collectFormData()`**:
```js
content: this.state.editorMode === 'visual'
  ? (this._visualEditorRef?.serializeNodes() ?? serializeNodes(this._nodes))
  : (this.$('#content-editor')?.value || '')
```

---

## CSS additions (`editor.css`)

```
.ve-card--text          text card modifier (no thumb, different left icon)
.ve-text-icon           ¶ icon zone — same dimensions as .ve-handle
.ve-text-area           auto-resizing textarea inside text card
.ve-insert-zone         8px slim zone, hidden by default
.ve-insert-btn          + button inside insert zone
.ve-list:hover .ve-insert-zone   revealed on list hover
```
