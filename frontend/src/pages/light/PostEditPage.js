/**
 * PostEditPage — create or edit a blog post.
 *
 * Routes:
 *   /light/posts/new          → create
 *   /light/posts/:id/edit     → edit existing
 */

import { Component } from "../../components/Component.js";
import { adminLayoutTemplate, setupAdminLayout } from "../../components/light/AdminLayout.js";
import { TagsInput } from "../../components/light/TagsInput.js";
import { MediaPickerDialog } from "../../components/light/MediaPickerDialog.js";
import { CssEditor } from "../../components/light/CssEditor.js";
import { MarkdownEditor } from "../../components/light/MarkdownEditor.js";
import {
  getPost,
  createPost,
  updatePost,
  generatePreviewLink,
  publishPostToInstagram,
  previewRender,
} from "../../api/posts.js";
import { getInstagramStatus } from "../../api/instagram.js";
import {
  uploadMedia,
} from "../../api/media.js";
import { ConfirmDialog } from "../../components/shared/ConfirmDialog.js";
import { getAllShareEntries, clearShareEntries } from "../../utils/idb.js";
import { store } from "../../store.js";
import { escapeHtml, navigate, debounce } from "../../utils/helpers.js";
import { SPARKLE_SVG, STAR_SVG, STAR_OUTLINE_SVG, TRASH_SVG, LINK_SVG, CHEVRON_SVG, EXTERNAL_LINK_SVG, SETTINGS_SVG } from "../../utils/icons.js";
import { VisualEditor } from "../../components/light/VisualEditor.js";

const AUTOSAVE_IDLE_MS = 5_000;
const AUTOSAVE_BUSY_MS = 30_000;

const IMAGE_PATH_RE = /^\/\d{4}\/\d{2}\/.+$/;

/** Convert a UTC ISO string to a datetime-local input value (local time). */
function toDatetimeLocal(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function parseNodes(content) {
  const lines = (content || "").split("\n");
  const nodes = [];
  let textBuf = [];

  const flushText = () => {
    const text = textBuf.join("\n").trim();
    if (text) {
      const fenceMatch = text.match(/^:::\{\.([^}]+)\}\n([\s\S]*)\n:::$/);
      if (fenceMatch) {
        nodes.push({ type: "text", text: fenceMatch[2], blockClass: fenceMatch[1] });
      } else {
        nodes.push({ type: "text", text });
      }
    }
    textBuf = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (IMAGE_PATH_RE.test(trimmed)) {
      flushText();
      nodes.push({ type: "image", path: trimmed });
    } else if (trimmed === "---") {
      flushText();
    } else {
      textBuf.push(line);
    }
  }
  flushText();
  return nodes;
}

export function serializeNodes(nodes) {
  return nodes
    .map((n) => {
      if (n.type === "image") return n.path;
      if (n.blockClass) return `:::{.${n.blockClass}}\n${n.text}\n:::\n---`;
      return n.text + "\n---";
    })
    .join("\n");
}

const toTagNames = (tags) =>
  (tags || []).map((t) => (typeof t === "string" ? t : t.name));

export default class PostEditPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    const id = props.params?.id ? parseInt(props.params.id, 10) : null;
    this.state = {
      loading: !!id,
      saving: false,
      deleting: false,
      generatingPreview: false,
      publishingToInstagram: false,
      analyzingField: null,
      post: null,
      error: null,
      isNew: !id,
      postId: id,
      editorMode: "visual",
      igStatus: null,
      maximizedField: null,
      detailsOpen: this._readDetailsPref(),
      showLivePreview: this._readLivePreviewPref(),
      menuOpen: false,
      hasPendingEdits: false,
    };
    this._tags = [];
    this._nodes = [];
    this._unmounted = false;
    this._analyzing = false;
    this._idleTimer = null;
    this._maxWaitTimer = null;
  }

  render() {
    const { isNew, post, loading, menuOpen } = this.state;
    const titleText = isNew ? "New Post" : "Edit Post";
    
    if (loading) return adminLayoutTemplate({ title: titleText, content: `<div class="loading-spinner" aria-label="Loading…"></div>` });

    const p = post || {};
    const status = p.status || "draft";
    const isPublished = status === "published";
    
    const actions = `
      <div class="header-split-button ${menuOpen ? 'is-menu-open' : ''}">
        ${isPublished ? `
          <button id="update-btn" class="btn btn-primary main-action" type="button">Update</button>
        ` : `
          <button id="publish-btn" class="btn btn-primary main-action" type="button">Publish</button>
        `}
        <button id="header-menu-toggle" class="btn btn-primary menu-toggle" type="button" aria-label="More actions">
          ${CHEVRON_SVG}
        </button>
        <div class="header-menu">
          ${!isPublished ? `
            <button class="menu-item" type="button" data-action="publish-now">Publish now</button>
            <button class="menu-item" type="button" data-action="schedule">Schedule…</button>
            <button class="menu-item" type="button" data-action="mark-hidden">Mark hidden</button>
          ` : `
            <button class="menu-item" type="button" data-action="unpublish">Unpublish</button>
          `}
          <hr>
          <button class="menu-item" type="button" data-action="analyze" id="analyze-btn">${SPARKLE_SVG} Analyze media</button>
          <button class="menu-item" type="button" data-action="preview-link" id="preview-link-btn">${LINK_SVG} Preview link</button>
          ${this._isWide() ? `<button class="menu-item" type="button" data-action="toggle-preview">${this.state.showLivePreview ? 'Hide preview' : 'Show preview'}</button>` : ''}
          ${!isNew ? `<button class="menu-item" type="button" data-action="view-on-site">${EXTERNAL_LINK_SVG} View on site</button>` : ''}
          <hr>
          <button class="menu-item text-danger" type="button" data-action="delete" id="delete-btn">${TRASH_SVG} Delete</button>
        </div>
      </div>
    `;

    const detailsToggle = `
      <button id="details-toggle" class="btn btn-secondary" type="button"
              aria-controls="details-panel" aria-expanded="${this.state.detailsOpen ? 'true' : 'false'}">
        ${SETTINGS_SVG}
        <span class="btn-label">Details</span>
      </button>`;

    return adminLayoutTemplate({
      title: `<a href="/light/posts" class="header-back-link" title="Back to Posts">←</a> ${titleText}`,
      actions: detailsToggle + actions,
      content: this._renderContent()
    });
  }

  _renderContent() {
    const { loading, error, post, isNew, saving, deleting, generatingPreview, publishingToInstagram, analyzingField, igStatus } = this.state;
    const analyzing = this._analyzing;
    const anyActionInProgress = saving || analyzing || deleting || generatingPreview || publishingToInstagram || !!analyzingField;

    if (loading) return `<div class="loading-spinner"></div>`;
    if (error) return `<p class="error-state">${escapeHtml(error)}</p>`;

    const p = post || {};
    const title = escapeHtml(p.title || "");
    const slug = escapeHtml(p.slug || "");
    const status = p.status || "draft";
    const featured = p.is_featured || false;
    const excerpt = p.excerpt || "";

    const statusOpts = ["draft", "published", "scheduled", "hidden", "page"]
      .map(s => `<option value="${s}"${status === s ? " selected" : ""}>${escapeHtml(s.charAt(0).toUpperCase() + s.slice(1))}</option>`)
      .join("");

    const aiBtn = (field) => `<button class="field-ai-btn" data-field="${field}" type="button" title="Fill with AI" ${anyActionInProgress ? "disabled" : ""} aria-label="AI fill ${field}">${SPARKLE_SVG}</button>`;

    const modeToggle = `
      <div class="editor-mode-toggle">
        <button id="mode-text-btn" type="button" class="${this.state.editorMode === "text" ? "active" : ""}">Text</button>
        <button id="mode-visual-btn" type="button" class="${this.state.editorMode === "visual" ? "active" : ""}">Visual</button>
      </div>`;

    const contentArea = this.state.editorMode === "visual"
        ? `<div id="visual-editor-mount"></div>`
        : `<label class="form-label" for="content-editor">Content</label><div id="content-editor-mount"></div>`;

    const featuredSummary = featured ? " · ★" : "";
    const statusSummary = escapeHtml(status.charAt(0).toUpperCase() + status.slice(1)) + featuredSummary;
    const slugSummary = slug || "auto";
    const excerptSummary = excerpt.trim() ? escapeHtml(this._truncate(excerpt.trim())) : "auto";
    const immersiveSummary = { immersive: "Immersive", "non-immersive": "Non-immersive" }[p.immersive_mode] || "Auto";
    const cssSummary = (p.css || "").trim() ? "custom" : "none";

    return `
            <div class="editor-layout${this.state.detailsOpen ? " is-details-open" : ""}${this.state.showLivePreview ? " has-live-preview" : ""}">
              <div class="editor-main">
                <div class="title-row">
                  <div class="title-input-wrapper">
                    <input type="text" id="title-input" class="form-input editor-title" placeholder="Post title" value="${title}" required>
                    ${aiBtn("title")}
                  </div>
                </div>


                <div class="tags-row">
                  <div class="tags-input-wrapper">
                    <div id="tags-input-mount" class="tags-row-input"></div>
                    ${aiBtn("tags")}
                  </div>
                </div>

                <div class="form-group">
                  ${modeToggle}
                  ${contentArea}
                </div>
              </div>

              <div class="editor-live-preview" id="live-preview-mount">
                <div class="preview-header">Live Preview</div>
                <div id="preview-content" class="preview-content post-content"></div>
              </div>

              <div class="details-backdrop" id="details-backdrop"></div>

              <aside class="editor-details-panel" id="details-panel" aria-label="Post details" aria-hidden="${this.state.detailsOpen ? "false" : "true"}">
                <div class="details-panel-header">
                  <span class="details-panel-title">Details</span>
                  <button id="details-close-btn" class="details-panel-close" type="button" aria-label="Close details">&times;</button>
                </div>
                <div class="details-panel-body">
                  <details class="details-group" data-group="status">
                    <summary class="details-group-summary-row">
                      <span class="details-group-title">Status &amp; visibility</span>
                      <span class="details-group-summary" id="summary-status">${statusSummary}</span>
                    </summary>
                    <div class="details-group-body">
                      <div class="details-split-row">
                        <div class="form-group">
                          <label class="form-label" for="status-select">Status</label>
                          <select id="status-select" class="status-select badge-${escapeHtml(status)}" ${anyActionInProgress ? "disabled" : ""}>
                            ${statusOpts}
                          </select>
                        </div>
                        <div class="form-group featured-toggle-group">
                          <label class="form-label">Featured</label>
                          <button id="featured-toggle" type="button" class="featured-btn${featured ? " is-featured" : ""}" title="${featured ? "Unmark as featured" : "Mark as featured"}" ${anyActionInProgress ? "disabled" : ""}>
                            ${featured ? STAR_SVG : STAR_OUTLINE_SVG}
                          </button>
                          <input type="checkbox" id="featured-check" style="display:none" ${featured ? "checked" : ""}>
                        </div>
                      </div>

                      <div class="schedule-row" id="schedule-row" style="display:${status === "scheduled" ? "flex" : "none"}">
                        <div class="schedule-input-wrapper">
                          <label class="form-label" for="schedule-input">Schedule</label>
                          <input type="datetime-local" id="schedule-input" class="form-input schedule-at-input" value="${toDatetimeLocal(p.scheduled_at || "")}" ${anyActionInProgress ? "disabled" : ""}>
                          <span class="schedule-input-hint" id="schedule-hint" style="${p.scheduled_at ? "display:none" : ""}">Publish at…</span>
                        </div>
                      </div>
                    </div>
                  </details>

                  <details class="details-group" data-group="slug">
                    <summary class="details-group-summary-row">
                      <span class="details-group-title">Slug</span>
                      <span class="details-group-summary" id="summary-slug">${escapeHtml(slugSummary)}</span>
                    </summary>
                    <div class="details-group-body">
                      <div class="slug-row">
                        <div class="slug-input-wrapper">
                          <span class="slug-prefix">/posts/</span>
                          <input type="text" id="slug-input" class="form-input editor-slug" placeholder="post-slug" value="${slug}" spellcheck="false">
                        </div>
                      </div>
                    </div>
                  </details>

                  <details class="details-group" data-group="excerpt">
                    <summary class="details-group-summary-row">
                      <span class="details-group-title">Excerpt</span>
                      <span class="details-group-summary" id="summary-excerpt">${excerptSummary}</span>
                    </summary>
                    <div class="details-group-body">
                      <div class="form-group excerpt-row">
                        <textarea id="excerpt-editor" class="form-input editor-excerpt ${this.state.maximizedField === "excerpt" ? "is-maximized" : ""}" rows="3" placeholder="Post excerpt…">${escapeHtml(excerpt)}</textarea>
                        ${aiBtn("excerpt")}
                      </div>
                    </div>
                  </details>

                  <details class="details-group" data-group="immersive">
                    <summary class="details-group-summary-row">
                      <span class="details-group-title">Immersive mode</span>
                      <span class="details-group-summary" id="summary-immersive">${immersiveSummary}</span>
                    </summary>
                    <div class="details-group-body">
                      <div class="form-group">
                        <select id="immersive-mode-select" class="form-input immersive-mode-select">
                          <option value="auto"${(p.immersive_mode || "auto") === "auto" ? " selected" : ""}>Auto (detect from content)</option>
                          <option value="immersive"${p.immersive_mode === "immersive" ? " selected" : ""}>Immersive</option>
                          <option value="non-immersive"${p.immersive_mode === "non-immersive" ? " selected" : ""}>Non-immersive</option>
                        </select>
                      </div>
                    </div>
                  </details>

                  <details class="details-group" data-group="css">
                    <summary class="details-group-summary-row">
                      <span class="details-group-title">Custom CSS</span>
                      <span class="details-group-summary" id="summary-css">${cssSummary}</span>
                    </summary>
                    <div class="details-group-body">
                      <div class="form-group">
                        <div id="css-editor-mount"></div>
                      </div>
                    </div>
                  </details>

                  ${igStatus?.enabled ? this._renderInstagramSection(p, igStatus, publishingToInstagram, anyActionInProgress, isNew) : ""}
                </div>
              </aside>
            </div>`;
  }

  /** Trim a value to a one-line summary length. */
  _truncate(str, max = 24) {
    return str.length > max ? str.slice(0, max).trimEnd() + "…" : str;
  }

  _renderInstagramSection(post, igStatus, publishingToInstagram, anyActionInProgress, isNew = false) {
    const igShare = isNew ? (igStatus.default_share ?? false) : (post.instagram_share ?? false);
    const igSt = post.instagram_status || "none";
    const igError = post.instagram_error || "";
    const igStatusBadgeClass = { published: "badge-success", failed: "badge-danger", publishing: "badge-primary" }[igSt] ?? "badge-draft";
    const canPublishNow = !isNew && igStatus.connected && igShare && igSt !== "published";
    const igSummary = igShare ? "on" : "off";

    return `
      <details class="details-group" data-group="instagram">
        <summary class="details-group-summary-row">
          <span class="details-group-title">Instagram</span>
          <span class="details-group-summary" id="summary-instagram">${igSummary}</span>
        </summary>
        <div class="details-group-body">
          <div class="form-group ig-post-section">
            <div class="ig-controls">
              <label class="setting-pill">
                <input type="checkbox" id="ig-share-input" class="setting-pill-input" ${igShare ? "checked" : ""}>
                <span class="setting-pill-label">Share to Instagram</span>
              </label>
              ${igSt !== "none" ? `<span class="badge ${igStatusBadgeClass}" title="${escapeHtml(igError)}">${escapeHtml(igSt)}</span>` : ""}
              ${canPublishNow ? `<button id="ig-publish-now-btn" class="btn btn-secondary btn-sm" type="button" ${anyActionInProgress ? "disabled" : ""}>${publishingToInstagram ? "Publishing…" : "Publish to Instagram now"}</button>` : ""}
            </div>
            ${igError ? `<p class="ig-error-msg">${escapeHtml(igError)}</p>` : ""}
            <span class="ig-connection-note">${igStatus.connected ? `Connected as @${escapeHtml(igStatus.username)}` : `Not connected — <a href="/light/settings#instagram">connect in Settings</a>`}</span>
          </div>
        </div>
      </details>`;
  }

  /** True on ultrawide viewports where the live-preview pane is available (≥112em, per admin-ux C5). */
  _isWide() {
    return typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(min-width: 112em)").matches : false;
  }

  /** Initial live-preview state: on by default on ultrawide unless the user turned it off. */
  _readLivePreviewPref() {
    if (!this._isWide()) return false;
    let pref = null;
    try { pref = localStorage.getItem("point:editor:live-preview"); } catch { /* ignore */ }
    return pref !== "0";
  }

  /** Toggle the live-preview pane without a full re-render; persists the choice. */
  _toggleLivePreview() {
    const on = !this.state.showLivePreview;
    this.state.showLivePreview = on;
    try { localStorage.setItem("point:editor:live-preview", on ? "1" : "0"); } catch { /* ignore */ }
    this.container.querySelector(".editor-layout")?.classList.toggle("has-live-preview", on);
    const btn = this.container.querySelector('[data-action="toggle-preview"]');
    if (btn) btn.textContent = on ? "Hide preview" : "Show preview";
    if (on) this._debouncedPreview?.();
  }

  /** Initial Details open state: persisted on wide viewports, always closed (sheet) on narrow. */
  _readDetailsPref() {
    const wide = typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(min-width: 64em)").matches : true;
    if (!wide) return false;
    let pref = null;
    try { pref = localStorage.getItem("point:editor:details-open"); } catch { /* ignore */ }
    return pref !== "0";
  }

  /** Toggle (or force) the Details rail/sheet without a full re-render. */
  _toggleDetails(force) {
    const open = typeof force === "boolean" ? force : !this.state.detailsOpen;
    this.state.detailsOpen = open;
    this.container.querySelector(".editor-layout")?.classList.toggle("is-details-open", open);
    this.container.querySelector("#details-toggle")?.setAttribute("aria-expanded", String(open));
    this.container.querySelector("#details-panel")?.setAttribute("aria-hidden", String(!open));
    try { localStorage.setItem("point:editor:details-open", open ? "1" : "0"); } catch { /* ignore */ }
  }

  /** Refresh the one-line summary shown on each collapsed Details group. */
  _updateDetailsSummaries() {
    const q = (sel) => this.container.querySelector(sel);
    const set = (id, text) => { const el = this.container.querySelector(`#${id}`); if (el) el.textContent = text; };

    const status = q("#status-select")?.value || "draft";
    const featured = q("#featured-check")?.checked;
    const scheduledAt = q("#schedule-input")?.value;
    let statusSummary = status.charAt(0).toUpperCase() + status.slice(1);
    if (status === "scheduled" && scheduledAt) {
      const d = new Date(scheduledAt);
      if (!isNaN(d)) statusSummary += ` · ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
    }
    if (featured) statusSummary += " · ★";
    set("summary-status", statusSummary);

    set("summary-slug", q("#slug-input")?.value.trim() || "auto");

    const excerpt = (q("#excerpt-editor")?.value || "").trim();
    set("summary-excerpt", excerpt ? this._truncate(excerpt) : "auto");

    const immersive = q("#immersive-mode-select")?.value || "auto";
    set("summary-immersive", { immersive: "Immersive", "non-immersive": "Non-immersive" }[immersive] || "Auto");

    const css = this._cssEditorRef?.getValue?.() ?? "";
    set("summary-css", css.trim() ? "custom" : "none");

    if (this.container.querySelector("#ig-share-input")) {
      set("summary-instagram", q("#ig-share-input")?.checked ? "on" : "off");
    }
  }

  afterRender() {
    const postSlug = this.state.post?.slug;
    this._cleanupAdminLayout = setupAdminLayout(this, {
      currentPath: "/light/posts",
      publicUrl: postSlug ? `/posts/${postSlug}` : "/",
    });

    if (this.state.loading || this.state.error) return;

    // Details rail / bottom sheet toggle
    this.container.querySelector("#details-toggle")?.addEventListener("click", () => this._toggleDetails());
    this.container.querySelector("#details-close-btn")?.addEventListener("click", () => this._toggleDetails(false));
    this.container.querySelector("#details-backdrop")?.addEventListener("click", () => this._toggleDetails(false));

    // Header overflow menu — toggle a class rather than setState. A full
    // re-render here would rebuild the editor from state.post and discard any
    // edits not yet flushed by autosave (title/slug/excerpt/tags/css), plus
    // lose focus and scroll position.
    const splitButton = this.container.querySelector(".header-split-button");
    const setMenuOpen = (open) => {
      this.state.menuOpen = open;
      splitButton?.classList.toggle("is-menu-open", open);
    };
    this.container.querySelector("#header-menu-toggle")?.addEventListener("click", (e) => {
      e.stopPropagation();
      setMenuOpen(!this.state.menuOpen);
    });

    // Close the menu on any outside click. Stored + removed below so re-renders
    // don't accumulate stale document listeners.
    if (this._onDocClick) document.removeEventListener("click", this._onDocClick);
    this._onDocClick = () => { if (this.state.menuOpen) setMenuOpen(false); };
    document.addEventListener("click", this._onDocClick);

    this.container.querySelectorAll(".menu-item").forEach(btn => {
      btn.addEventListener("click", () => {
        const action = btn.dataset.action;
        this._handleMenuAction(action);
      });
    });

    this.$("#update-btn")?.addEventListener("click", () => this._save({ status: 'published' }));
    this.$("#publish-btn")?.addEventListener("click", () => this._save({ status: 'published' }));

    if (!this._mediaPicker) {
      this._mediaPicker = new MediaPickerDialog({ onConfirm: (items) => this._insertMediaPaths(items) });
      this._mediaPicker.mount();
    }

    this.container.querySelector("#mode-text-btn")?.addEventListener("click", () => this._switchMode("text"));
    this.container.querySelector("#mode-visual-btn")?.addEventListener("click", () => this._switchMode("visual"));

    this.container.querySelectorAll(".field-ai-btn").forEach((btn) => {
      btn.addEventListener("click", () => this._analyzeField(btn.dataset.field));
    });

    this._tagsInputRef = this.mountChild(TagsInput, "#tags-input-mount", {
      tags: toTagNames(this.state.post?.tags),
      onChange: (tags) => { this._tags = tags; this._onInput(); },
    });
    this._tags = toTagNames(this.state.post?.tags);

    this._cssEditorRef = this.mountChild(CssEditor, "#css-editor-mount", {
      id: "css-editor",
      value: this.state.post?.css || "",
      isMaximized: this.state.maximizedField === "css",
      onChange: () => this._onInput(),
    });

    if (this.state.editorMode === "text") {
      this._markdownEditorRef = this.mountChild(MarkdownEditor, "#content-editor-mount", {
        id: "content-editor",
        value: this.state.post?.content || "",
        isMaximized: this.state.maximizedField === "content",
        onChange: () => this._onInput(),
      });
    }

    this.container.addEventListener("textarea:save", () => this._save());
    this.container.addEventListener("textarea:maximize", (e) => {
      const { isMaximized } = e.detail;
      let field = null;
      if (isMaximized) {
        const target = e.target;
        if (target.id === "title-input") field = "title";
        else if (target.id === "excerpt-editor") field = "excerpt";
        else if (target.closest("#tags-input-mount")) field = "tags";
        else if (target.closest("#css-editor-mount")) field = "css";
        else if (target.closest("#content-editor-mount")) field = "content";
      }
      this.state.maximizedField = field;
    });

    if (this._onKeyDown) document.removeEventListener("keydown", this._onKeyDown);
    const onKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); this._save(); }
    };
    document.addEventListener("keydown", onKeyDown);
    this._onKeyDown = onKeyDown;

    // Retry autosave listener
    if (window.Point) {
      this._unsubscribeRetry = window.Point.on('autosave:retry', () => this._save());
    }

    const featuredToggle = this.container.querySelector("#featured-toggle");
    const featuredCheck = this.container.querySelector("#featured-check");
    featuredToggle?.addEventListener("click", () => {
      const newVal = !featuredCheck.checked;
      featuredCheck.checked = newVal;
      featuredToggle.replaceChildren(new DOMParser().parseFromString(newVal ? STAR_SVG : STAR_OUTLINE_SVG, "image/svg+xml").documentElement);
      featuredToggle.classList.toggle("is-featured", newVal);
      featuredToggle.title = newVal ? "Unmark as featured" : "Mark as featured";
      this._onInput();
    });

    const statusSelect = this.container.querySelector("#status-select");
    const scheduleRow = this.container.querySelector("#schedule-row");
    const scheduleInput = this.container.querySelector("#schedule-input");
    statusSelect?.addEventListener("change", () => {
      const newStatus = statusSelect.value;
      statusSelect.className = `status-select badge-${newStatus}`;
      if (newStatus === "scheduled") {
        if (scheduleRow) scheduleRow.style.display = "flex";
      } else {
        if (scheduleRow) scheduleRow.style.display = "none";
        if (scheduleInput) scheduleInput.value = "";
      }
      this._onInput();
    });

    if (this.props.query?.openSchedule && scheduleRow && scheduleInput) {
      this._toggleDetails(true);
      this.container.querySelector('.details-group[data-group="status"]')?.setAttribute("open", "");
      scheduleRow.style.display = "flex";
      statusSelect.value = "scheduled";
      statusSelect.className = "status-select badge-scheduled";
      setTimeout(() => scheduleInput.showPicker?.() || scheduleInput.focus(), 50);
    }

    const scheduleHint = this.container.querySelector("#schedule-hint");
    scheduleInput?.addEventListener("focus", () => { if (scheduleHint) scheduleHint.style.display = "none"; });
    scheduleInput?.addEventListener("blur", () => { if (scheduleHint && !scheduleInput.value) scheduleHint.style.display = ""; });
    scheduleInput?.addEventListener("change", () => {
      const val = scheduleInput.value;
      if (val) { if (scheduleHint) scheduleHint.style.display = "none"; }
      this._onInput();
    });

    [this.container.querySelector("#title-input"), this.container.querySelector("#slug-input"), this.container.querySelector("#excerpt-editor")].forEach(el => {
      el?.addEventListener("input", () => this._onInput());
    });
    this.container.querySelector("#immersive-mode-select")?.addEventListener("change", () => this._onInput());

    if (this.state.editorMode === "visual") this._mountVisualEditor();

    this.container.querySelector("#ig-share-input")?.addEventListener("change", () => this._onInput());
    this.container.querySelector("#ig-publish-now-btn")?.addEventListener("click", () => this._publishToInstagram());

    this._debouncedPreview = debounce(async () => {
      if (!this.state.showLivePreview || this._unmounted) return;
      const data = this._collectFormData();
      try {
        const { html } = await previewRender(data.content);
        const mount = this.$("#preview-content");
        if (mount) {
          const titleHtml = data.title ? `<h1 class="post-title">${escapeHtml(data.title)}</h1>` : "";
          mount.innerHTML = titleHtml + html;
        }
      } catch (err) { /* ignore */ }
    }, 1000);

    // Re-render the preview when the viewport grows into ultrawide range.
    if (window.matchMedia) {
      this._previewMql?.removeEventListener?.("change", this._onPreviewMqlChange);
      this._previewMql = window.matchMedia("(min-width: 112em)");
      this._onPreviewMqlChange = (e) => { if (e.matches && this.state.showLivePreview) this._debouncedPreview?.(); };
      this._previewMql.addEventListener?.("change", this._onPreviewMqlChange);
    }

    if (this.state.showLivePreview) this._debouncedPreview();

    this._updateDetailsSummaries();
    this._setupWindowDragAndDrop();
  }

  _handleMenuAction(action) {
    switch (action) {
      case "publish-now": this._save({ status: "published" }); break;
      case "schedule": {
        this._toggleDetails(true);
        this.container.querySelector('.details-group[data-group="status"]')?.setAttribute("open", "");
        const sel = this.container.querySelector("#status-select");
        if (sel) { sel.value = "scheduled"; sel.dispatchEvent(new Event("change")); }
        setTimeout(() => this.container.querySelector("#schedule-input")?.focus(), 10);
        break;
      }
      case "mark-hidden": this._save({ status: "hidden" }); break;
      case "unpublish": this._save({ status: "draft" }); break;
      case "analyze": this._analyzeNow(); break;
      case "toggle-preview": this._toggleLivePreview(); break;
      case "preview-link": this._generatePreviewLink(); break;
      case "view-on-site": window.open(this.props.publicUrl, "_blank"); break;
      case "delete": {
        const title = this.container.querySelector("#title-input")?.value || this.state.post?.title || "this post";
        this._showConfirm("Move to Trash", `Move "${title}" to Trash?`, "Move to Trash", "danger", () => this._deletePost(this.state.postId));
        break;
      }
    }
  }

  _analyzeNow() {
    const path = this._extractImagePath();
    if (path) this._handleAnalyze({ path });
    else this._mediaPicker.open((items) => this._handleAnalyze(items[0]));
  }

  _onInput() {
    // Mutate state directly — a full re-render here would wipe input values and
    // focus on every keystroke. (Component.setState always re-renders.)
    this.state.hasPendingEdits = true;
    this._updateDetailsSummaries();
    store.set('autosave_status', { status: 'idle' });
    
    // Save ~5s after the user stops typing. The idle timer resets on every
    // keystroke, so a separate max-wait timer (not reset on input) guarantees
    // a save during long continuous typing.
    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => this._autosave(), AUTOSAVE_IDLE_MS);
    if (!this._maxWaitTimer) {
      this._maxWaitTimer = setTimeout(() => this._autosave(), AUTOSAVE_BUSY_MS);
    }

    this._debouncedPreview?.();
  }

  async _autosave() {
    clearTimeout(this._idleTimer); this._idleTimer = null;
    clearTimeout(this._maxWaitTimer); this._maxWaitTimer = null;
    if (this._unmounted || this.state.saving || this.state.deleting || !this.state.hasPendingEdits) return;

    const data = this._collectFormData();
    if (!data.title) return;

    store.set('autosave_status', { status: 'saving' });
    
    try {
      if (this.state.isNew) {
         const result = await createPost({ ...data, status: 'draft' });
         this.state.isNew = false;
         this.state.postId = result.id;
         this.state.post = result;
         history.replaceState(null, "", `/light/posts/${result.id}/edit`);
      } else {
         const result = await updatePost(this.state.postId, data);
         this.state.post = result;
      }
      
      this.state.hasPendingEdits = false;
      store.set('autosave_status', { status: 'saved', lastSaved: Date.now() });
      
      if (this._chipInterval) clearInterval(this._chipInterval);
      this._chipInterval = setInterval(() => {
        if (store.get('autosave_status')?.status === 'saved') {
            store.set('offline_status', { ...store.get('offline_status') }); // trigger re-render of sync pill
        } else {
            clearInterval(this._chipInterval);
        }
      }, 5000);

    } catch (err) {
      console.error("Autosave failed:", err);
      store.set('autosave_status', { status: 'failed' });
    }
  }

  async _save(overrides = {}) {
    const data = { ...this._collectFormData(), ...overrides };
    if (!data.title) { store.set("toast", { message: "Title is required.", type: "error" }); return; }

    this.setState({ saving: true });
    store.set('autosave_status', { status: 'saving' });

    try {
      let result;
      if (this.state.isNew) {
        result = await createPost(data);
        this.state.isNew = false;
        this.state.postId = result.id;
        history.replaceState(null, "", `/light/posts/${result.id}/edit`);
      } else {
        result = await updatePost(this.state.postId, data);
      }
      this.state.hasPendingEdits = false;
      this.setState({ saving: false, post: result });
      store.set('autosave_status', { status: 'saved', lastSaved: Date.now() });
      store.set("toast", { message: "Saved.", type: "success" });
    } catch (err) {
      this.setState({ saving: false });
      store.set('autosave_status', { status: 'failed' });
      store.set("toast", { message: err.message || "Save failed.", type: "error" });
    }
  }

  beforeUnmount() {
    this._cleanupAdminLayout?.();
    this._unmounted = true;
    if (this._unsubscribeRetry && window.Point) window.Point.off('autosave:retry', this._unsubscribeRetry);
    clearTimeout(this._idleTimer);
    clearTimeout(this._maxWaitTimer);
    clearInterval(this._chipInterval);
    document.removeEventListener("dragenter", this._onDragEnter);
    document.removeEventListener("dragleave", this._onDragLeave);
    document.removeEventListener("dragover", this._onDragOver);
    document.removeEventListener("drop", this._onDrop);
    document.body.classList.remove("drag-active");
    this._mediaPicker?.destroy();
    this._mediaPicker = null;
    this._visualEditorRef = null;
    if (this._onKeyDown) document.removeEventListener("keydown", this._onKeyDown);
    if (this._onDocClick) document.removeEventListener("click", this._onDocClick);
    this._previewMql?.removeEventListener?.("change", this._onPreviewMqlChange);
  }

  _setupWindowDragAndDrop() {
    document.removeEventListener("dragenter", this._onDragEnter);
    document.removeEventListener("dragleave", this._onDragLeave);
    document.removeEventListener("dragover", this._onDragOver);
    document.removeEventListener("drop", this._onDrop);
    this._dragCount = 0;
    this._onDragEnter = () => { this._dragCount++; document.body.classList.add("drag-active"); };
    this._onDragLeave = () => { this._dragCount--; if (this._dragCount === 0) document.body.classList.remove("drag-active"); };
    this._onDragOver = (e) => { e.preventDefault(); };
    this._onDrop = (e) => {
      e.preventDefault(); this._dragCount = 0; document.body.classList.remove("drag-active");
      const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/") || f.type.startsWith("video/"));
      files.forEach(f => this._uploadAndInsert(f));
    };
    document.addEventListener("dragenter", this._onDragEnter);
    document.addEventListener("dragleave", this._onDragLeave);
    document.addEventListener("dragover", this._onDragOver);
    document.addEventListener("drop", this._onDrop);
  }

  _insertMediaPaths(items) {
    if (!items.length) return;
    if (this.state.editorMode === "visual") {
      this._nodes = [...this._nodes, ...items.map(item => ({ type: "image", path: item.path }))];
      this._mountVisualEditor();
      return;
    }
    const paths = items.map(item => item.path).join("\n");
    if (this._markdownEditorRef) this._markdownEditorRef.insertAtEnd(paths);
  }

  _mountVisualEditor() {
    if (this._visualEditorRef) {
      this._visualEditorRef.unmount();
      const idx = this._children.indexOf(this._visualEditorRef);
      if (idx !== -1) this._children.splice(idx, 1);
    }
    this._visualEditorRef = this.mountChild(VisualEditor, "#visual-editor-mount", {
      nodes: this._nodes,
      mediaByPath: this._mediaByPath || {},
      onChange: (nodes) => { this._nodes = nodes; this._onInput(); },
      onInput: () => this._onInput(),
      onAddMedia: (index) => {
        this._mediaPicker.open((items) => {
          if (!items.length) return;
          this._nodes.splice(index, 0, ...items.map(item => ({ type: "image", path: item.path })));
          this._mountVisualEditor();
          this._onInput();
        });
      },
      onRename: (oldPath, newFilename) => this._handleRename(oldPath, newFilename),
    });
  }

  async _handleRename(oldPath, newFilename) {
    const lastSlash = oldPath.lastIndexOf("/");
    const folder = oldPath.slice(1, lastSlash);
    try {
      const { listMedia, renameMedia } = await import('../../api/media.js');
      const result = await listMedia({ folder, per_page: 200 });
      const item = (result.media || []).find(m => m.path === oldPath);
      if (!item) throw new Error(`Media not found: ${oldPath}`);
      const updated = await renameMedia(item.id, newFilename);
      this._nodes = this._nodes.map(n => n.type === "image" && n.path === oldPath ? { ...n, path: updated.path } : n);
      this._mountVisualEditor();
      this._onInput();
      store.set("toast", { message: "File renamed.", type: "success" });
    } catch (err) {
      store.set("toast", { message: err.message || "Rename failed.", type: "error" });
      throw err;
    }
  }

  _switchMode(targetMode) {
    if (this.state.editorMode === targetMode) return;
    const data = this._collectFormData();
    const post = { ...(this.state.post || {}), ...data, tags: (data.tags || []).map(name => ({ name, slug: name })) };
    if (targetMode === "visual") { this._nodes = parseNodes(data.content); this.setState({ editorMode: "visual", post }); }
    else { this.setState({ editorMode: "text", post }); }
  }

  mount() {
    super.mount();
    if (this.state.postId) this._loadPost(this.state.postId);
    else getInstagramStatus().catch(() => null).then(igStatus => { if (!this._unmounted) this.setState({ igStatus }); });
    if (this.props.query?.share === "pending") this._processShareQueue();
  }

  async _processShareQueue() {
    let entries; try { entries = await getAllShareEntries(); } catch { return; }
    if (!entries.length) return;
    const [current, ...backlog] = entries;
    if (current.title) { const titleEl = this.container.querySelector("#title-input"); if (titleEl && !titleEl.value.trim()) titleEl.value = current.title; }
    for (const fileEntry of current.files) {
      const blob = new Blob([fileEntry.data], { type: fileEntry.type });
      const file = new File([blob], fileEntry.name, { type: fileEntry.type });
      await this._uploadAndInsert(file);
    }
    for (const entry of backlog) {
      try {
        const title = entry.title || entry.files.map(f => f.name).join(", ") || "Shared photo";
        const post = await createPost({ title, status: "draft", content: "" });
        let content = "";
        for (const fileEntry of entry.files) {
          const blob = new Blob([fileEntry.data], { type: fileEntry.type });
          const file = new File([blob], fileEntry.name, { type: fileEntry.type });
          const media = await uploadMedia(file, { post_id: post.id });
          content += `${media.path}\n`;
        }
        await updatePost(post.id, { content: content.trim() });
      } catch (err) { store.set("toast", { message: `Failed to save offline share: ${err.message}`, type: "error" }); }
    }
    try { await clearShareEntries(); } catch (e) { /* ignore */ }
    if (backlog.length > 0) store.set("toast", { message: `${backlog.length} offline shares saved as draft.`, type: "success" });
  }

  async _loadPost(id) {
    try {
      const [post, igStatus] = await Promise.all([getPost(id), getInstagramStatus().catch(() => null)]);
      if (post.status) post.status = post.status.toLowerCase();
      this._tags = toTagNames(post.tags);
      this._nodes = parseNodes(post.content);
      this._mediaByPath = {};
      try {
        const { listMedia } = await import('../../api/media.js');
        const result = await listMedia({ post_id: post.id, per_page: 200 });
        for (const m of result.media || []) if (m.path) this._mediaByPath[m.path] = m;
      } catch (e) { /* ignore */ }
      this.setState({ loading: false, post, error: null, editorMode: "visual", igStatus });
    } catch (err) { store.set("toast", { message: "Could not load post.", type: "error" }); navigate("/light/posts", { replace: true }); }
  }

  _collectFormData() {
    return {
      title: (this.container.querySelector("#title-input")?.value || "").trim(),
      slug: (this.container.querySelector("#slug-input")?.value || "").trim() || null,
      excerpt: (this.container.querySelector("#excerpt-editor")?.value || "").trim() || null,
      content: this.state.editorMode === "visual" ? (this._visualEditorRef?.serializeNodes() ?? serializeNodes(this._nodes)) : this._markdownEditorRef?.getValue() ?? "",
      status: this.container.querySelector("#status-select")?.value || this.state.post?.status || "draft",
      // These fields have no editor inputs; preserve existing values instead of
      // sending null (the backend would clear them on every save).
      formatter: this.state.post?.formatter || "markdown",
      is_featured: this.container.querySelector("#featured-check")?.checked || false,
      thumbnail_path: this.state.post?.thumbnail_path ?? null,
      meta_description: this.state.post?.meta_description ?? null,
      tags: this._tagsInputRef ? this._tagsInputRef.getTags() : this._tags,
      scheduled_at: this.container.querySelector("#schedule-input")?.value ? new Date(this.container.querySelector("#schedule-input").value).toISOString() : "",
      css: this._cssEditorRef ? this._cssEditorRef.getValue() : (this.state.post?.css || ""),
      immersive_mode: this.container.querySelector("#immersive-mode-select")?.value || "auto",
      instagram_share: this.container.querySelector("#ig-share-input")?.checked ?? (this.state.isNew ? (this.state.igStatus?.default_share ?? false) : (this.state.post?.instagram_share ?? false)),
    };
  }

  _showConfirm(title, message, confirmText, variant, onConfirm) {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const dialog = new ConfirmDialog(mount, {
      title, message, confirmText, variant,
      onConfirm: () => { dialog.unmount(); mount.remove(); onConfirm(); },
      onCancel: () => { dialog.unmount(); mount.remove(); },
    });
    dialog.mount();
  }

  _extractImagePath() {
    if (this.state.editorMode === "visual") return this._nodes.find((n) => n.type === "image")?.path ?? null;
    const content = this._markdownEditorRef?.getValue() ?? "";
    const match = content.match(/(?:^|["'\s(])(\/\d{4}\/\d{2}\/.+?\.(?:jpe?g|png|webp|gif|avif|heic|tiff|bmp))(?:["'\s)]|$)/i);
    return match ? match[1] : null;
  }

  _analyzeField(field) {
    if (this._analyzing || this.state.analyzingField) return;
    const path = this._extractImagePath();
    if (path) this._doAnalyzeField(field, { path });
    else this._mediaPicker.open((items) => { if (items?.[0]) this._doAnalyzeField(field, items[0]); });
  }

  async _doAnalyzeField(field, item) {
    if (!item) return;
    const snap = this._collectFormData();
    this.container.querySelectorAll(`.field-ai-btn`).forEach((b) => { b.disabled = true; });
    const post = { ...(this.state.post || {}), title: snap.title, excerpt: snap.excerpt, content: snap.content, slug: snap.slug, status: snap.status, is_featured: snap.is_featured, formatter: snap.formatter, thumbnail_path: snap.thumbnail_path, meta_description: snap.meta_description, tags: snap.tags.map((name) => ({ name, slug: name })), };
    try {
      const { analyzeMedia, analyzeMediaByPath } = await import('../../api/media.js');
      const result = item.id ? await analyzeMedia(item.id) : await analyzeMediaByPath(item.path);
      const isEmpty = !result.title && !result.tags?.length && !result.excerpt;
      if (field === "title" && result.title) post.title = result.title;
      else if (field === "tags" && result.tags?.length) {
        const currentTags = this._tags || [];
        const mergedTags = [...currentTags, ...(result.tags || []).filter((t) => !currentTags.includes(t))];
        this._tags = mergedTags; post.tags = mergedTags.map((name) => ({ name, slug: name }));
      } else if (field === "excerpt" && result.excerpt) post.excerpt = result.excerpt;
      if (isEmpty) store.set("toast", { message: "AI disabled or no suggestions.", type: "info" });
      else store.set("toast", { message: `${field.charAt(0).toUpperCase() + field.slice(1)} filled.`, type: "success" });
    } catch (err) { store.set("toast", { message: err.message || "Analysis failed.", type: "error" }); }
    this.setState({ analyzingField: null, post });
  }

  async _handleAnalyze(item) {
    if (!item || this._analyzing) return;
    const snap = this._collectFormData();
    this._analyzing = true;
    try {
      const { analyzeMedia, analyzeMediaByPath } = await import('../../api/media.js');
      const result = item.id ? await analyzeMedia(item.id) : await analyzeMediaByPath(item.path);
      const mergedTags = [...snap.tags, ...(result.tags || []).filter((t) => !snap.tags.includes(t))];
      const post = { ...(this.state.post || {}), title: snap.title || result.title || "", excerpt: snap.excerpt || result.excerpt || null, content: snap.content, slug: snap.slug, status: snap.status, is_featured: snap.is_featured, formatter: snap.formatter, thumbnail_path: snap.thumbnail_path, meta_description: snap.meta_description, tags: mergedTags.map((name) => ({ name, slug: name })), };
      if (this.state.editorMode === "visual") this._nodes = parseNodes(post.content);
      store.set("toast", { message: "Analysis complete.", type: "success" });
      this._analyzing = false; this.setState({ post });
    } catch (err) {
      const post = { ...(this.state.post || {}), title: snap.title, excerpt: snap.excerpt, content: snap.content, slug: snap.slug, status: snap.status, is_featured: snap.is_featured, formatter: snap.formatter, thumbnail_path: snap.thumbnail_path, meta_description: snap.meta_description, tags: snap.tags.map((name) => ({ name, slug: name })), };
      if (this.state.editorMode === "visual") this._nodes = parseNodes(post.content);
      store.set("toast", { message: err.message || "Analysis failed.", type: "error" });
      this._analyzing = false; this.setState({ post });
    }
  }

  async _uploadAndInsert(file) {
    try {
      const result = await uploadMedia(file, { post_id: this.state.postId || undefined, });
      if (this.state.editorMode === "visual") this._insertMediaPaths([{ path: result.path }]);
      else if (this._markdownEditorRef) this._markdownEditorRef.insertAtEnd(result.path);
    } catch (err) { store.set("toast", { message: `Upload failed: ${err.message || file.name}`, type: "error" }); }
  }

  async _publishToInstagram() {
    if (this.state.publishingToInstagram || this.state.isNew) return;
    this.setState({ publishingToInstagram: true });
    try {
      const result = await publishPostToInstagram(this.state.postId);
      this.setState({ publishingToInstagram: false, post: result });
      const st = result.instagram_status;
      if (st === "published") store.set("toast", { message: "Published to Instagram.", type: "success" });
      else if (st === "failed") store.set("toast", { message: result.instagram_error || "Instagram publish failed.", type: "error" });
      else store.set("toast", { message: "Instagram publish triggered.", type: "info" });
    } catch (err) { this.setState({ publishingToInstagram: false }); store.set("toast", { message: err.message || "Instagram publish failed.", type: "error" }); }
  }

  async _generatePreviewLink() {
    if (this.state.generatingPreview || this.state.isNew) return;
    this.setState({ generatingPreview: true });
    try {
      const { preview_url } = await generatePreviewLink(this.state.postId);
      try { await navigator.clipboard.writeText(preview_url); store.set("toast", { message: "Preview link copied to clipboard.", type: "success" }); }
      catch { this._showPreviewLinkDialog(preview_url); }
    } catch (err) { store.set("toast", { message: err.message || "Could not generate preview link.", type: "error" }); }
    finally { this.setState({ generatingPreview: false }); }
  }

  _showPreviewLinkDialog(url) {
    const mount = document.createElement("div"); document.body.appendChild(mount);
    const close = () => { dialog.unmount(); mount.remove(); };
    const dialog = new ConfirmDialog(mount, { title: "Preview link", message: url, confirmText: "Close", variant: "primary", onConfirm: close, onCancel: close, });
    dialog.mount();
    const msgEl = mount.querySelector(".confirm-dialog__message, p");
    if (msgEl) { const range = document.createRange(); range.selectNodeContents(msgEl); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); }
  }
}
