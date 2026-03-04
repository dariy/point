# Visual Post Editor Design

**Date**: 2026-03-02
**Status**: Approved
**Branch**: experiment-go

## Overview

Add a visual editing mode to `/light/posts/:id/edit`. Instead of a plain textarea, users see the ordered set of images that will appear in the public immersive view — with drag-to-reorder and an image picker to add new photos.

The editor toggles between two modes: **text mode** (existing textarea) and **visual mode** (new image list editor).

---

## Data Flow & State

`PostEditPage.js` gains one new state variable: `editorMode` (`'text' | 'visual'`), auto-detected on load:

- Content with only bare image paths → start in `'visual'`
- Content with any non-image text → start in `'text'`

A utility `parseContent(content)` handles detection, returning `{ paths: string[], hasText: boolean }`.

The visual editor reads from and writes to the same `content` string as the textarea — paths are newline-joined on write, split on read. No separate visual state, no conversion step. Switching modes is always lossless (visual → text) or warned (text → visual with text content).

---

## Mode Toggle & Warning

A **Text / Visual** two-segment toggle button appears above the content area.

- **Text → Visual** (content has non-image text): modal warning dialog — *"Visual mode will discard all text content on save. Switch anyway?"* Confirm switches, Cancel stays.
- **Text → Visual** (content is image-only): instant switch, no warning.
- **Visual → Text**: instant switch, no warning.

---

## VisualEditor Component

New file: `frontend/src/components/light/VisualEditor.js`

**Props:**
- `images: string[]` — ordered list of bare paths (e.g. `/2026/02/photo.jpg`)
- `onChange(images: string[])` — called on any reorder or removal
- `onAddImages()` — triggers the existing MediaPickerDialog from PostEditPage

**Card layout (per image):**

```
┌─────────────────────────────────────────────────┐
│ ┆┆┆ │ [thumbnail 80×60] │ /2026/02/photo.jpg [✕] │
└─────────────────────────────────────────────────┘
```

- **Left zone** (`┆┆┆`): dotted drag handle, `cursor: grab`
- **Thumbnail**: click → lightbox (full-size image overlay)
- **Path**: filename shown for orientation
- **Remove button** (`✕`): removes item from list immediately
- **Drop indicator**: 2px colored horizontal line rendered between cards during drag

New images are appended to the end via the existing Media picker button in `PostEditPage`.

---

## Drag & Drop

Uses the HTML5 native drag API (no library — project is vanilla JS).

- `draggable="true"` on each card
- `dragstart` → record dragged index
- `dragover` → compute insertion slot from mouse Y (top half = above card, bottom half = below card), render drop indicator line
- `drop` → splice array, call `onChange`
- `dragend` → clear drop indicator

---

## Lightbox

Clicking a thumbnail opens a simple full-screen overlay showing the full-size image. Follows the same pattern as the existing lightbox in `MediaBrowser`. Closes on click outside or Escape key.

---

## Files

| File | Change |
|---|---|
| `frontend/src/pages/light/PostEditPage.js` | Add `editorMode` state, auto-detect on load, toggle button, warning dialog, wire `VisualEditor`, pass `onAddImages` callback |
| `frontend/src/components/light/VisualEditor.js` | New component — image card list, drag-and-drop, lightbox |
| `frontend/css/light/` (existing or new file) | Styles for cards, drag handle zone, drop indicator line, lightbox overlay, toggle button |
