// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.11.
/**
 * The editor's field markup.
 *
 * Every post property is one group: a `<details>` block with a summary row and
 * a body. `buildFieldGroups` produces them all from the post and the editor's
 * state, and `renderGroup` turns one into markup — which side of the layout it
 * lands on is decided by the caller (see editorFieldLayout.js), so the markup
 * for a field exists once regardless of placement.
 */

import { store } from "../../store.js";
import { html, raw } from "../../utils/helpers.js";
import { defaultPostTitle } from "../../utils/formatters.js";
import { pluginHost } from "../../core/pluginHost.js";
import { SPARKLE_SVG, STAR_SVG, STAR_OUTLINE_SVG, GRIP_SVG } from "../../utils/icons.js";

/** Trim a value to a one-line summary length. */
export function truncate(str, max = 24) {
  return str.length > max ? str.slice(0, max).trimEnd() + "…" : str;
}

/** Convert a UTC ISO string to a datetime-local input value (local time). */
export function toDatetimeLocal(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function scheduleSummary(scheduledAt) {
  if (!scheduledAt) return "not set";
  const d = new Date(scheduledAt);
  return isNaN(d) ? "not set" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export const toTagNames = (tags) =>
  (tags || []).map((t) => (typeof t === "string" ? t : t.name));

function instagramGroup(post, igStatus, publishingToInstagram, anyActionInProgress, isNew = false) {
  const igShare = isNew ? (igStatus.default_share ?? false) : (post.instagram_share ?? false);
  const igSt = post.instagram_status || "none";
  const igError = post.instagram_error || "";
  const igStatusBadgeClass = { published: "badge-success", error: "badge-danger", failed: "badge-danger", publishing: "badge-primary" }[igSt] ?? "badge-draft";
  const canPublishNow = !isNew && igStatus.connected && igShare && igSt !== "published";

  return {
    label: "Instagram",
    summary: igShare ? "on" : "off",
    body: html`
        <div class="form-group ig-post-section">
          <div class="ig-controls">
            <label class="setting-pill">
              <input type="checkbox" id="ig-share-input" class="setting-pill-input" ${igShare ? "checked" : ""}>
              <span class="setting-pill-label">Share to Instagram</span>
            </label>
            ${igSt !== "none" ? html`<span class="badge ${igStatusBadgeClass}" title="${igError}">${igSt}</span>` : ""}
            ${canPublishNow ? html`<button id="ig-publish-now-btn" class="btn btn-secondary btn-sm" type="button" ${anyActionInProgress ? "disabled" : ""}>${publishingToInstagram ? "Publishing…" : "Publish to Instagram now"}</button>` : ""}
          </div>
          ${igError ? html`<p class="ig-error-msg">${igError}</p>` : ""}
          <span class="ig-connection-note">${igStatus.connected ? html`Connected as @${igStatus.username}` : html`Not connected — <a href="/light/settings#instagram">connect in Settings</a>`}</span>
        </div>`,
  };
}

/**
 * Every editor field, keyed by group name. The css and instagram groups exist
 * only when their plugin is on, so a disabled plugin leaves no empty block
 * behind — and no entry in the layout for arrange mode to move.
 */
export function buildFieldGroups({ post, isNew, editorMode, maximizedField, igStatus, publishingToInstagram, anyActionInProgress }) {
  const p = post || {};
  const title = p.title || "";
  const slug = p.slug || "";
  // "Page" is surfaced as a status in the UI but is really type=page (always
  // published). Show "Page" selected whenever the post is a page.
  const status = p.type === "page" ? "page" : (p.status || "draft");
  const featured = p.is_featured || false;
  const excerpt = p.excerpt || "";

  const statusOpts = ["draft", "published", "scheduled", "hidden", "page"]
    .map(s => html`<option value="${s}"${status === s ? " selected" : ""}>${s.charAt(0).toUpperCase() + s.slice(1)}</option>`);

  const aiBtn = (field) => pluginHost.isEnabled("ai-analysis") ? html`<button class="field-ai-btn" data-field="${field}" type="button" title="Fill with AI" ${anyActionInProgress ? "disabled" : ""} aria-label="AI fill ${field}">${raw(SPARKLE_SVG)}</button>` : '';

  const modeToggle = html`
      <div class="editor-mode-toggle">
        <button id="mode-text-btn" type="button" class="${editorMode === "text" ? "active" : ""}">Text</button>
        <button id="mode-visual-btn" type="button" class="${editorMode === "visual" ? "active" : ""}">Visual</button>
      </div>`;

  const contentArea = editorMode === "visual"
      ? html`<div id="visual-editor-mount"></div>`
      : html`<label class="form-label" for="content-editor">Content</label><div id="content-editor-mount"></div>`;

  // Summaries are plain text — renderGroup escapes them on the way into markup.
  const featuredSummary = featured ? " · ★" : "";
  const statusSummary = status.charAt(0).toUpperCase() + status.slice(1) + featuredSummary;
  const slugSummary = slug || "auto";
  const excerptSummary = excerpt.trim() ? truncate(excerpt.trim()) : "auto";
  const immersiveSummary = { immersive: "Immersive", "non-immersive": "Non-immersive" }[p.immersive_mode] || "Auto";
  const cssSummary = (p.css || "").trim() ? "custom" : "none";
  const tagNames = toTagNames(p.tags);

  const groups = {
    title: {
      label: "Post title",
      summary: title ? truncate(p.title) : "auto",
      body: html`
          <div class="title-row">
            <div class="title-input-wrapper">
              <input type="text" id="title-input" class="form-input editor-title" placeholder="${defaultPostTitle(store.get("settings"))}" title="Leave blank to title this post with today's date" value="${title}">
              ${aiBtn("title")}
            </div>
          </div>`,
    },
    tags: {
      label: "Tags",
      summary: tagNames.length ? truncate(tagNames.join(", ")) : "none",
      body: html`
          <div class="tags-row">
            <div class="tags-input-wrapper">
              <div id="tags-input-mount" class="tags-row-input"></div>
              ${aiBtn("tags")}
            </div>
          </div>`,
    },
    status: {
      label: "Status &amp; visibility",
      summary: statusSummary,
      body: html`
          <div class="details-split-row">
            <div class="form-group">
              <label class="form-label" for="status-select">Status</label>
              <select id="status-select" class="status-select badge-${status}" ${anyActionInProgress ? "disabled" : ""}>
                ${statusOpts}
              </select>
            </div>
            <div class="form-group featured-toggle-group">
              <label class="form-label">Featured</label>
              <button id="featured-toggle" type="button" class="featured-btn${featured ? " is-featured" : ""}" title="${featured ? "Unmark as featured" : "Mark as featured"}" ${anyActionInProgress ? "disabled" : ""}>
                ${raw(featured ? STAR_SVG : STAR_OUTLINE_SVG)}
              </button>
              <input type="checkbox" id="featured-check" style="display:none" ${featured ? "checked" : ""}>
            </div>
          </div>`,
    },
    // Only relevant while the post is scheduled; the group hides itself
    // otherwise, wherever it currently sits (see `_setScheduleVisible`).
    schedule: {
      label: "Schedule",
      summary: scheduleSummary(p.scheduled_at),
      hidden: status !== "scheduled",
      body: html`
          <div class="schedule-row" id="schedule-row">
            <div class="schedule-input-wrapper">
              <input type="datetime-local" id="schedule-input" class="form-input schedule-at-input" value="${toDatetimeLocal(p.scheduled_at || "")}" ${anyActionInProgress ? "disabled" : ""}>
              <span class="schedule-input-hint" id="schedule-hint" style="${p.scheduled_at ? "display:none" : ""}">Publish at…</span>
            </div>
          </div>`,
    },
    slug: {
      label: "Slug",
      summary: slugSummary,
      body: html`
          <div class="slug-row">
            <div class="slug-input-wrapper">
              <span class="slug-prefix">/posts/</span>
              <input type="text" id="slug-input" class="form-input editor-slug" placeholder="post-slug" value="${slug}" spellcheck="false">
            </div>
          </div>`,
    },
    excerpt: {
      label: "Excerpt",
      summary: excerptSummary,
      body: html`
          <div class="form-group excerpt-row">
            <textarea id="excerpt-editor" class="form-input editor-excerpt ${maximizedField === "excerpt" ? "is-maximized" : ""}" rows="3" placeholder="Post excerpt…">${excerpt}</textarea>
            ${aiBtn("excerpt")}
          </div>`,
    },
    content: {
      label: "Content",
      summary: "",
      fixed: true,
      body: html`${modeToggle}${contentArea}`,
    },
    immersive: {
      label: "Immersive mode",
      summary: immersiveSummary,
      body: html`
          <div class="form-group">
            <select id="immersive-mode-select" class="form-input immersive-mode-select">
              <option value="auto"${(p.immersive_mode || "auto") === "auto" ? " selected" : ""}>Auto (detect from content)</option>
              <option value="immersive"${p.immersive_mode === "immersive" ? " selected" : ""}>Immersive</option>
              <option value="non-immersive"${p.immersive_mode === "non-immersive" ? " selected" : ""}>Non-immersive</option>
            </select>
          </div>`,
    },
  };

  if (pluginHost.isEnabled("custom-css")) {
    groups.css = {
      label: "Custom CSS",
      summary: cssSummary,
      body: html`<div class="form-group"><div id="css-editor-mount"></div></div>`,
    };
  }
  if (pluginHost.isEnabled("instagram") && igStatus?.enabled) {
    groups.instagram = instagramGroup(p, igStatus, publishingToInstagram, anyActionInProgress, isNew);
  }

  return groups;
}

/**
 * One editor block as a collapsible group. On the canvas it renders with
 * `is-pinned` and forced open — the body is the field itself, so which side a
 * block is on is purely a question of which parent the element hangs off.
 *
 * That is what lets arrange mode *move* the live element instead of
 * re-rendering, keeping unsaved input values, focus and listeners.
 */
export function renderGroup(key, group, pinned) {
  const plain = group.label.replace(/&amp;/g, "&");
  // The labels are literals in this module and one of them carries an entity
  // ("Status &amp; visibility"), so the title span takes it raw; `plain` is the
  // decoded copy the tag re-escapes for the aria-label.
  return html`
      <details class="details-group${pinned ? " is-pinned" : ""}${group.fixed ? " is-fixed" : ""}${group.hidden ? " is-hidden" : ""}" data-group="${key}"${pinned ? " open" : ""}>
        <summary class="details-group-summary-row">
          <button type="button" class="details-group-handle" data-handle="${key}"
                  aria-label="Move ${plain}" title="Drag to reorder, or across the lists to move it — arrow keys do both">${raw(GRIP_SVG)}</button>
          <span class="details-group-title">${raw(group.label)}</span>
          <span class="details-group-summary" id="summary-${key}">${group.summary}</span>
        </summary>
        <div class="details-group-body">${group.body}</div>
      </details>`;
}
