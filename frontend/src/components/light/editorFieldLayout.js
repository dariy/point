/**
 * Where each editor field sits, and in what order.
 *
 * Every post property is one pinnable group. A pinned group sits on the canvas
 * (`.editor-main` → `#pinned-fields`), an unpinned one in the Details panel;
 * arrange mode moves it between the two.
 *
 * Two preferences describe the editor's layout, both persisted globally because
 * they are how this user works, not something about one post:
 *   - the pinned set  (`point:editor:pinned`)      — which side a field is on
 *   - the field order (`point:editor:field-order`) — one sequence spanning both
 *     sides, so a field pinned and unpinned again lands back where it belongs
 *
 * Each is stored twice: in the account settings (so it follows the user across
 * browsers) and in localStorage (so it survives a settings load failure and is
 * there before the first render). Settings win when both exist.
 */

import { store } from "../../store.js";

/**
 * Seeds the order, and orders anything missing from a stored one — a future
 * plugin section rendering through `renderGroup()` sorts last and is pinnable
 * and movable like the rest, with no extra wiring.
 */
export const DEFAULT_ORDER = ["title", "tags", "content", "status", "schedule", "slug", "excerpt", "immersive", "css", "instagram"];

/** Canvas layout before pinning existed: title and tags, everything else in Details. */
export const DEFAULT_PINNED = ["title", "tags"];

/**
 * The content editor is a block like the others — it can be moved among them —
 * but it is what the page is for, so it can never leave the canvas: no pin, and
 * a drop into the Details panel is refused.
 */
export const FIXED_TO_CANVAS = "content";

export const PINNED_STORAGE_KEY = "point:editor:pinned";
export const ORDER_STORAGE_KEY = "point:editor:field-order";

/** The stored value of one preference: account settings first, then localStorage. */
function readRaw(settingsKey, storageKey) {
  const settings = store.get("settings") || {};
  if (settings[settingsKey]) return settings[settingsKey];
  try { return localStorage.getItem(storageKey); } catch { return null; }
}

/** Write one preference to localStorage now and to the account settings when they answer. */
function persistRaw(settingsKey, storageKey, raw, label) {
  try { localStorage.setItem(storageKey, raw); } catch { /* ignore */ }
  import("../../api/settings.js").then(({ updateSettings }) => {
    updateSettings({ [settingsKey]: raw }).catch((err) => {
      console.error(`Failed to save ${label} to global set:`, err);
    });
    store.merge("settings", { [settingsKey]: raw });
  });
}

/** The stored order, with any key it doesn't mention appended in default order. */
export function readFieldOrder() {
  const raw = readRaw("editor_field_order", ORDER_STORAGE_KEY);
  let stored = [];
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) stored = parsed.filter((k) => typeof k === "string");
  } catch { /* fall through to the default */ }
  return [...stored, ...DEFAULT_ORDER.filter((k) => !stored.includes(k))];
}

export function persistFieldOrder(order) {
  persistRaw("editor_field_order", ORDER_STORAGE_KEY, JSON.stringify(order), "field order");
}

/** The pinned set, persisted across posts and sessions (an editor preference, not post data). */
export function readPinnedFields() {
  const raw = readRaw("editor_pinned", PINNED_STORAGE_KEY);
  let keys = DEFAULT_PINNED;
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      // An empty array is a real choice (everything in Details), so only a
      // malformed value falls back to the defaults.
      if (Array.isArray(parsed)) keys = parsed.filter((k) => typeof k === "string");
    } catch { /* keep the defaults */ }
  }
  // Content lives on the canvas by definition — being "pinned" is what puts a
  // block there, so it is always in the set whatever was stored.
  return new Set([...keys, FIXED_TO_CANVAS]);
}

export function persistPinnedFields(pinned) {
  persistRaw("editor_pinned", PINNED_STORAGE_KEY, JSON.stringify([...pinned]), "pinned fields");
}

/** Position of a group in the user's order; anything unknown sorts last. */
export function orderIndex(order, key) {
  const i = order.indexOf(key);
  if (i !== -1) return i;
  const d = DEFAULT_ORDER.indexOf(key);
  return order.length + (d === -1 ? DEFAULT_ORDER.length : d);
}

/**
 * `order` with `key` moved to sit directly after `afterKey` (or first, when
 * null) in the one order shared by both sides. Everything else keeps its
 * relative position, so a drag inside the Details panel doesn't disturb the
 * canvas and vice versa.
 */
export function moveInOrder(order, key, afterKey) {
  const rest = order.filter((k) => k !== key);
  const at = afterKey ? rest.indexOf(afterKey) + 1 : 0;
  rest.splice(at < 0 ? rest.length : at, 0, key);
  return rest;
}
