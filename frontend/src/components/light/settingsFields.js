/**
 * settingsFields — shared rendering & collection for admin settings inputs.
 *
 * Both the global Settings page and the per-plugin settings drawer
 * (PluginSettingsPanel) render the same key/value blog settings, so the per-key
 * markup, the toggle predicate and the FormData → updates collection live here
 * once. Each setting key maps to an input kind by the same heuristics the
 * Settings page has always used (select overrides, numeric keys, toggles,
 * secrets, then plain text).
 */

import { escapeHtml } from "../../utils/helpers.js";

// Friendlier labels for keys whose snake_case name reads poorly.
export const LABEL_OVERRIDES = {
  tags_module: "Show tags",
  tags_visibility: "Tags visible to",
  atlas_post_limit: "Atlas posts to fetch",
};

// Keys rendered as <input type="number">.
export const NUMERIC_KEYS = new Set([
  "posts_per_page",
  "min_tag_posts_to_show",
  "storage_quota_mb",
  "session_ttl_days",
  "cleanup_interval_days",
  "atlas_post_limit",
]);

/** Humanized label for a setting key (snake_case → Title Case), with overrides. */
export function labelFor(key) {
  return (
    LABEL_OVERRIDES[key] ||
    key
      .split("_")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ")
  );
}

/** Whether a key renders as an on/off checkbox (and so needs explicit collection). */
export function isToggleKey(key) {
  return (
    key.includes("enable") ||
    key.includes("show") ||
    key.includes("use") ||
    key === "multi_user_mode" ||
    key === "require_registration_code"
  );
}

function isNumericKey(key) {
  return (
    NUMERIC_KEYS.has(key) ||
    key.includes("per_page") ||
    key.includes("quota") ||
    key.includes("interval") ||
    key.includes("posts_to_show")
  );
}

function isSecretKey(key) {
  return key === "gemini_api_key" || key.includes("secret");
}

/** Markup for a single setting input (without its label wrapper). */
function inputHtml(key, value, { posts = [] }) {
  if (key === "about_post_id" || key === "home_page_post_id") {
    const options = posts
      .filter((p) => p.type === "page")
      .map((p) => {
        const slug = escapeHtml(p.slug);
        const title = escapeHtml(p.title || p.slug);
        const selected = p.slug === value ? " selected" : "";
        return `<option value="${slug}"${selected}>${title}</option>`;
      })
      .join("");
    const previewLink = value
      ? `<a href="/posts/${escapeHtml(String(value))}" target="_blank" class="settings-preview-link">Preview ↗</a>`
      : "";
    return `<div class="settings-input-with-preview">
        <select name="${key}" id="${key}" class="form-select">
          <option value="">— None —</option>
          ${options}
        </select>
        ${previewLink}
      </div>`;
  }
  if (key === "default_theme") {
    return `
      <select name="${key}" id="${key}" class="form-select">
        <option value="light"${value === "light" ? " selected" : ""}>Light</option>
        <option value="dark"${value === "dark" ? " selected" : ""}>Dark</option>
        <option value="auto"${value === "auto" ? " selected" : ""}>Auto (System)</option>
      </select>`;
  }
  if (key === "immersive_nav_direction") {
    const isFeed = value === "feed";
    return `
      <select name="${key}" id="${key}" class="form-select">
        <option value="chronological"${!isFeed ? " selected" : ""}>Chronological (◁ older, ▷ newer)</option>
        <option value="feed"${isFeed ? " selected" : ""}>Feed order (◁ newer, ▷ older)</option>
      </select>`;
  }
  if (key === "exif_visibility") {
    const v = value || "hide";
    return `
      <select name="${key}" id="${key}" class="form-select">
        <option value="hide"${v === "hide" ? " selected" : ""}>Hide</option>
        <option value="admin"${v === "admin" ? " selected" : ""}>Admins only</option>
        <option value="all"${v === "all" ? " selected" : ""}>Everyone</option>
      </select>`;
  }
  if (key === "tags_module") {
    // Single selector for the /tags page module. "None" hides the /tags entry
    // entirely and redirects /tags → home.
    const v = value || "atlas";
    return `
      <select name="${key}" id="${key}" class="form-select">
        <option value="none"${v === "none" ? " selected" : ""}>None (hidden)</option>
        <option value="cloud"${v === "cloud" ? " selected" : ""}>Tag cloud</option>
        <option value="map"${v === "map" ? " selected" : ""}>Map</option>
        <option value="atlas"${v === "atlas" ? " selected" : ""}>Atlas</option>
      </select>`;
  }
  if (key === "tags_visibility") {
    const v = value || "hidden";
    return `
      <select name="${key}" id="${key}" class="form-select">
        <option value="hidden"${v === "hidden" ? " selected" : ""}>Admins only</option>
        <option value="all"${v === "all" ? " selected" : ""}>Everyone</option>
      </select>`;
  }
  if (isNumericKey(key)) {
    return `<input type="number" name="${key}" id="${key}" class="form-input" value="${escapeHtml(String(value))}">`;
  }
  if (isSecretKey(key)) {
    return `<input type="password" name="${key}" id="${key}" class="form-input" value="${escapeHtml(String(value))}" autocomplete="new-password">`;
  }
  return `<input type="text" name="${key}" id="${key}" class="form-input" value="${escapeHtml(String(value))}">`;
}

/**
 * Render a list of setting keys into `{ inputs, toggles }` HTML fragments:
 * toggles are checkbox pills grouped together; everything else is a labelled
 * form group. Callers place each group where they want it.
 *
 * @param {string[]} keys
 * @param {Record<string,*>} settings
 * @param {{posts?: Array}} [ctx]
 * @returns {{inputs: string, toggles: string}}
 */
export function renderFields(keys, settings, ctx = {}) {
  const inputs = [];
  const toggles = [];

  for (const key of keys) {
    const value = settings[key] ?? "";
    const label = labelFor(key);

    if (isToggleKey(key)) {
      const checked =
        value === "true" || value === "1" || value === true || value === 1;
      toggles.push(`
        <label class="setting-pill">
          <input type="checkbox" name="${key}" id="${key}" class="setting-pill-input" ${checked ? "checked" : ""}>
          <span class="setting-pill-label">${label}</span>
        </label>`);
      continue;
    }

    inputs.push(`
      <div class="form-group">
        <label class="form-label" for="${key}">${label}</label>
        ${inputHtml(key, value, ctx)}
      </div>`);
  }

  return { inputs: inputs.join(""), toggles: toggles.join("") };
}

/**
 * Collect a settings-update object from a form, restricted to `keys`. Checkbox
 * keys are always emitted ("true"/"false") since unchecked boxes are absent from
 * FormData; other keys are emitted only when present in the form.
 *
 * @param {HTMLFormElement} form
 * @param {string[]} keys
 * @returns {Record<string,string>}
 */
export function collectUpdates(form, keys) {
  const fd = new FormData(form);
  const updates = {};
  for (const key of keys) {
    if (isToggleKey(key)) {
      updates[key] = fd.has(key) ? "true" : "false";
    } else if (fd.has(key)) {
      updates[key] = fd.get(key);
    }
  }
  return updates;
}
