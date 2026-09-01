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
import { getPost, createPost, updatePost, deletePost, generatePreviewLink, publishPostToInstagram, previewRender } from "../../api/posts.js";
import { getInstagramStatus } from "../../api/instagram.js";
import { uploadMedia } from "../../api/media.js";
import { ConfirmDialog } from "../../components/shared/ConfirmDialog.js";
import { getAllShareEntries, clearShareEntries } from "../../utils/idb.js";
import { store } from "../../store.js";
import { html, navigate, raw, debounce } from "../../utils/helpers.js";
import { pluginHost } from "../../core/pluginHost.js";
import { SPARKLE_SVG, STAR_SVG, STAR_OUTLINE_SVG, TRASH_SVG, LINK_SVG, CHEVRON_SVG, EXTERNAL_LINK_SVG, SETTINGS_SVG, GRIP_SVG } from "../../utils/icons.js";
import { VisualEditor } from "../../components/light/VisualEditor.js";
import { attachPointerReorder } from "../../utils/pointerReorder.js";
import { parseNodes, serializeNodes, firstImagePath } from "../../utils/postNodes.js";
import { attachWindowFileDrop } from "../../utils/windowFileDrop.js";
import { FIXED_TO_CANVAS, readFieldOrder, readPinnedFields, persistFieldOrder, persistPinnedFields, orderIndex, moveInOrder } from "../../components/light/editorFieldLayout.js";
import { buildFieldGroups, renderGroup, truncate, toTagNames } from "../../components/light/postEditorFields.js";
const AUTOSAVE_IDLE_MS = 5_000;
const AUTOSAVE_BUSY_MS = 30_000;
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
      arranging: false,
      hasPendingEdits: false
    };
    this._pinned = readPinnedFields();
    this._order = readFieldOrder();
    this._tags = [];
    this._nodes = [];
    this._unmounted = false;
    this._analyzing = false;
    this._idleTimer = null;
    this._maxWaitTimer = null;
  }

  /**
   * The header overflow menu, delegated from the container.
   *
   * The menu is rebuilt by every re-render (its labels track post status and
   * viewport width), so each item used to be re-bound by hand in afterRender;
   * the container these arrive at does not move.
   */
  actions = {
    "publish-now"() { this._save({ status: "published" }); },
    "mark-hidden"() { this._save({ status: "hidden" }); },
    unpublish() { this._save({ status: "draft" }); },
    analyze() { this._analyzeNow(); },
    arrange() { this._toggleArrange(true); },
    "toggle-preview"() { this._toggleLivePreview(); },
    "preview-link"() { this._generatePreviewLink(); },
    // Same tab, like every other public-site link in the admin. The editor is
    // the one place where leaving can cost something — edits typed inside the
    // autosave idle window are still only in the form — so flush them first
    // and let the navigation follow the save.
    "view-on-site"() { this._viewOnSite(); },
    schedule() {
      const sel = this.container.querySelector("#status-select");
      if (sel) {
        sel.value = "scheduled";
        sel.dispatchEvent(new Event("change"));
      }
      this._revealGroup("schedule");
      this.timer(() => this.container.querySelector("#schedule-input")?.focus(), 10);
    },
    delete() {
      const title = this.container.querySelector("#title-input")?.value
        || this.state.post?.title || "this post";
      this._showConfirm("Move to Trash", `Move "${title}" to Trash?`, "Move to Trash",
        "danger", () => this._deletePost(this.state.postId));
    },
  };

  render() {
    const {
      isNew,
      post,
      loading,
      menuOpen
    } = this.state;
    const titleText = isNew ? "New Post" : "Edit Post";
    if (loading) return adminLayoutTemplate({
      title: titleText,
      content: html`<div class="loading-spinner" aria-label="Loading…"></div>`
    });
    const p = post || {};
    const status = p.status || "draft";
    const isPublished = status === "published";
    const actions = html`
      <button id="save-btn" class="btn btn-secondary" type="button" style="margin-right: var(--spacing-sm);">Save</button>
      <div class="header-split-button ${menuOpen ? 'is-menu-open' : ''}">
        ${isPublished ? html`
          <button id="update-btn" class="btn btn-primary main-action" type="button">Update</button>
        ` : html`
          <button id="publish-btn" class="btn btn-primary main-action" type="button">Publish</button>
        `}
        <button id="header-menu-toggle" class="btn btn-primary menu-toggle" type="button" aria-label="More actions">
          ${raw(CHEVRON_SVG)}
        </button>
        <div class="header-menu">
          ${!isPublished ? html`
            <button class="menu-item" type="button" data-action="publish-now">Publish now</button>
            <button class="menu-item" type="button" data-action="schedule">Schedule…</button>
            <button class="menu-item" type="button" data-action="mark-hidden">Mark hidden</button>
          ` : html`
            <button class="menu-item" type="button" data-action="unpublish">Unpublish</button>
          `}
          <hr>
          ${pluginHost.isEnabled("ai-analysis") ? html`<button class="menu-item" type="button" data-action="analyze" id="analyze-btn">${raw(SPARKLE_SVG)} Analyze media</button>` : ''}
          <button class="menu-item" type="button" data-action="preview-link" id="preview-link-btn">${raw(LINK_SVG)} Preview link</button>
          <button class="menu-item" type="button" data-action="arrange">${raw(GRIP_SVG)} Arrange fields</button>
          ${this._isWide() ? html`<button class="menu-item" type="button" data-action="toggle-preview">${this.state.showLivePreview ? 'Hide preview' : 'Show preview'}</button>` : ''}
          ${!isNew ? html`<button class="menu-item" type="button" data-action="view-on-site">${raw(EXTERNAL_LINK_SVG)} View on site</button>` : ''}
          <hr>
          <button class="menu-item text-danger" type="button" data-action="delete" id="delete-btn">${raw(TRASH_SVG)} Delete</button>
        </div>
      </div>
    `;
    const detailsToggle = html`
      <button id="details-toggle" class="btn btn-secondary" type="button"
              aria-controls="details-panel" aria-expanded="${this.state.detailsOpen ? 'true' : 'false'}">
        ${raw(SETTINGS_SVG)}
        <span class="btn-label">Details</span>
      </button>`;
    let backUrl = "/light/posts";
    try {
      const stored = sessionStorage.getItem('point:admin:posts-list-url');
      if (stored) backUrl = stored;
    } catch {/* ignore */}
    return adminLayoutTemplate({
      title: html`<a href="${backUrl}" class="header-back-link" title="Back to Posts">←</a> ${titleText}`,
      actions: html`${detailsToggle}${actions}`,
      content: this._renderContent(),
      contentClass: "editor-full-width"
    });
  }
  _renderContent() {
    const {
      loading,
      error,
      post,
      isNew,
      saving,
      deleting,
      generatingPreview,
      publishingToInstagram,
      analyzingField,
      igStatus
    } = this.state;
    const analyzing = this._analyzing;
    const anyActionInProgress = saving || analyzing || deleting || generatingPreview || publishingToInstagram || !!analyzingField;
    if (loading) return html`<div class="loading-spinner"></div>`;
    if (error) return html`<p class="error-state">${error}</p>`;
    const groups = buildFieldGroups({
      post,
      isNew,
      editorMode: this.state.editorMode,
      maximizedField: this.state.maximizedField,
      igStatus,
      publishingToInstagram,
      anyActionInProgress
    });
    const keys = Object.keys(groups).sort((a, b) => this._orderIndex(a) - this._orderIndex(b));
    const renderWhere = pinned => keys.filter(k => this._pinned.has(k) === pinned).map(k => renderGroup(k, groups[k], pinned));
    const pinnedHtml = renderWhere(true);
    const detailsHtml = renderWhere(false);
    return html`
            <div class="editor-layout${this.state.detailsOpen ? " is-details-open" : ""}${this.state.showLivePreview ? " has-live-preview" : ""}">
              <div class="arrange-bar" id="arrange-bar" role="region" aria-label="Arrange fields" hidden>
                <span class="arrange-bar-hint">
                  <strong>Arranging fields</strong>
                  <span class="arrange-bar-hint-detail">Drag a field to reorder it, or across to the other list to move it there.</span>
                </span>
                <button id="arrange-done" class="btn btn-primary btn-sm" type="button">Done</button>
              </div>

              <div class="editor-main">
                <p class="arrange-list-label">Shown in the editor</p>
                <div class="pinned-fields" id="pinned-fields">${pinnedHtml}</div>
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
                <div class="details-panel-body${detailsHtml.length ? " has-groups" : ""}">
                  <!-- Kept first so a group unpinned back into an empty panel can
                       simply be appended and still land after this note. -->
                  <p class="details-panel-empty">Every field is shown in the editor. Move one back here from Arrange fields.</p>
                  ${detailsHtml}
                </div>
              </aside>
            </div>`;
  }

  /** Position of a group in the user's order; anything unknown sorts last. */
  _orderIndex(key) {
    return orderIndex(this._order, key);
  }

  /** Move `key` to sit directly after `afterKey` (or first, when null), and persist. */
  _moveInOrder(key, afterKey) {
    this._order = moveInOrder(this._order, key, afterKey);
    persistFieldOrder(this._order);
  }

  /**
   * Arrange mode: the fields collapse to labelled bars with a drag handle, so
   * the whole layout — order on both sides, and which side each field is on —
   * can be rearranged without the field bodies getting in the way of a drag.
   *
   * A mode rather than always-on handles because the editor is for writing:
   * handles next to every field would be permanent clutter around the one thing
   * the page is actually for.
   */
  _toggleArrange(on) {
    const arranging = typeof on === "boolean" ? on : !this.state.arranging;
    this.state.arranging = arranging;
    this.container.querySelector(".editor-layout")?.classList.toggle("is-arranging", arranging);
    const bar = this.container.querySelector("#arrange-bar");
    if (bar) bar.hidden = !arranging;
    // Both lists have to be on screen to move fields between them.
    if (arranging) this._toggleDetails(true);
    if (arranging) this.container.querySelector("#arrange-done")?.focus();
  }

  /** Wire dragging and keyboard reordering. Bound once; gated on arrange mode. */
  _setupArrange() {
    this._detachReorder?.();
    this._detachReorder = attachPointerReorder({
      handleSelector: ".details-group-handle",
      itemSelector: ".details-group",
      containers: () => [this.container.querySelector("#pinned-fields"), this.container.querySelector(".details-panel-body")],
      isEnabled: () => this.state.arranging,
      onDrop: ({
        item,
        to,
        afterEl
      }) => this._dropGroup(item, to, afterEl)
    });

    // Keyboard equivalent: the handle is a button, so arrows are free. Up/down
    // reorders within a list, left/right moves the block to the other one —
    // dragging is the only other way to cross lists, so without this half the
    // feature would be pointer-only.
    this.container.querySelector(".editor-layout")?.addEventListener("keydown", e => {
      if (!this.state.arranging) return;
      const handle = e.target.closest?.(".details-group-handle");
      if (!handle) return;
      const group = handle.closest(".details-group");
      const host = group.parentElement;
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const sibs = [...host.querySelectorAll(":scope > .details-group")];
        const i = sibs.indexOf(group);
        const j = e.key === "ArrowUp" ? i - 1 : i + 1;
        if (j < 0 || j >= sibs.length) return;
        this._dropGroup(group, host, e.key === "ArrowUp" ? sibs[j].previousElementSibling : sibs[j]);
        handle.focus();
        return;
      }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      // The canvas is the left-hand list on a wide screen and the upper one on a
      // narrow screen; either way left means "into the editor".
      const canvas = this.container.querySelector("#pinned-fields");
      const panel = this.container.querySelector(".details-panel-body");
      const to = e.key === "ArrowLeft" ? canvas : panel;
      if (!to || to === host) return;
      e.preventDefault();
      // Land at the position the shared order asks for, not at the end.
      const idx = this._orderIndex(group.dataset.group);
      const sibs = [...to.querySelectorAll(":scope > .details-group")];
      const after = sibs.filter(s => this._orderIndex(s.dataset.group) < idx).pop() || null;
      this._dropGroup(group, to, after);
      handle.focus();
    });
  }

  /**
   * Commit a move: `item` lands in `to`, directly after `afterEl`.
   *
   * Landing in the other list is what puts a block on the canvas or back in
   * Details, so the move updates the stored sides too — one gesture says both
   * where a block sits and which list it belongs to.
   */
  _dropGroup(item, to, afterEl) {
    const key = item.dataset.group;
    if (!key || !to) return;
    const pinnedHost = this.container.querySelector("#pinned-fields");
    const pinned = to === pinnedHost;
    // Content can be moved among the canvas blocks but never into Details.
    if (!pinned && key === FIXED_TO_CANVAS) return;
    if (this._pinned.has(key) !== pinned) {
      if (pinned) this._pinned.add(key);else this._pinned.delete(key);
      persistPinnedFields(this._pinned);
      item.classList.toggle("is-pinned", pinned);
      // A block on the canvas *is* the field, so it is never collapsed there;
      // back in Details it returns to being a summary row.
      item.open = pinned;
    }
    let after = afterEl;
    while (after && !after.classList?.contains("details-group")) after = after.previousElementSibling;
    to.insertBefore(item, after ? after.nextSibling : to.firstChild);
    this._moveInOrder(key, after?.dataset.group || null);
    this._updatePanelEmpty();
  }

  /** Show the "everything is on the canvas" note only when the panel has no groups left. */
  _updatePanelEmpty() {
    const body = this.container.querySelector(".details-panel-body");
    body?.classList.toggle("has-groups", !!body.querySelector(".details-group"));
  }

  /** The Schedule group is only meaningful for scheduled posts — hide it elsewhere. */
  _setScheduleVisible(on) {
    this.container.querySelector('.details-group[data-group="schedule"]')?.classList.toggle("is-hidden", !on);
  }

  /** Bring a group into view wherever it lives: expanded, and with the panel open if unpinned. */
  _revealGroup(key) {
    if (!this._pinned.has(key)) this._toggleDetails(true);
    this.container.querySelector(`.details-group[data-group="${key}"]`)?.setAttribute("open", "");
  }

  /** True on ultrawide viewports where the live-preview pane is available (≥112em, per admin-ux C5). */
  _isWide() {
    return typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(min-width: 112em)").matches : false;
  }

  /** Initial live-preview state: on by default on ultrawide unless the user turned it off. */
  _readLivePreviewPref() {
    if (!this._isWide()) return false;
    let pref = null;
    try {
      pref = localStorage.getItem("point:editor:live-preview");
    } catch {/* ignore */}
    return pref !== "0";
  }

  /** Toggle the live-preview pane without a full re-render; persists the choice. */
  _toggleLivePreview() {
    const on = !this.state.showLivePreview;
    this.state.showLivePreview = on;
    try {
      localStorage.setItem("point:editor:live-preview", on ? "1" : "0");
    } catch {/* ignore */}
    this.container.querySelector(".editor-layout")?.classList.toggle("has-live-preview", on);
    const btn = this.container.querySelector('[data-action="toggle-preview"]');
    if (btn) btn.textContent = on ? "Hide preview" : "Show preview";
    if (on) this._debouncedPreview?.();
  }

  /** Initial Details open state: persisted on wide viewports, always closed (sheet) on narrow. */
  _readDetailsPref() {
    const wide = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(min-width: 64em)").matches : true;
    if (!wide) return false;
    let pref = null;
    try {
      pref = localStorage.getItem("point:editor:details-open");
    } catch {/* ignore */}
    return pref !== "0";
  }

  /** Toggle (or force) the Details rail/sheet without a full re-render. */
  _toggleDetails(force) {
    const open = typeof force === "boolean" ? force : !this.state.detailsOpen;
    this.state.detailsOpen = open;
    this.container.querySelector(".editor-layout")?.classList.toggle("is-details-open", open);
    this.container.querySelector("#details-toggle")?.setAttribute("aria-expanded", String(open));
    this.container.querySelector("#details-panel")?.setAttribute("aria-hidden", String(!open));
    try {
      localStorage.setItem("point:editor:details-open", open ? "1" : "0");
    } catch {/* ignore */}
  }

  /** Refresh the one-line summary shown on each collapsed Details group. */
  _updateDetailsSummaries() {
    const q = sel => this.container.querySelector(sel);
    const set = (id, text) => {
      const el = this.container.querySelector(`#${id}`);
      if (el) el.textContent = text;
    };
    const title = (q("#title-input")?.value || "").trim();
    set("summary-title", title ? truncate(title) : "auto");
    const tags = this._tagsInputRef?.getTags?.() ?? this._tags ?? [];
    set("summary-tags", tags.length ? truncate(tags.join(", ")) : "none");
    const status = q("#status-select")?.value || "draft";
    const featured = q("#featured-check")?.checked;
    const scheduledAt = q("#schedule-input")?.value;
    let statusSummary = status.charAt(0).toUpperCase() + status.slice(1);
    if (status === "scheduled" && scheduledAt) {
      const d = new Date(scheduledAt);
      if (!isNaN(d)) statusSummary += ` · ${d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric"
      })}`;
    }
    if (featured) statusSummary += " · ★";
    set("summary-status", statusSummary);
    const scheduleDate = scheduledAt ? new Date(scheduledAt) : null;
    set("summary-schedule", scheduleDate && !isNaN(scheduleDate) ? scheduleDate.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }) : "not set");
    set("summary-slug", q("#slug-input")?.value.trim() || "auto");
    const excerpt = (q("#excerpt-editor")?.value || "").trim();
    set("summary-excerpt", excerpt ? truncate(excerpt) : "auto");
    const immersive = q("#immersive-mode-select")?.value || "auto";
    set("summary-immersive", {
      immersive: "Immersive",
      "non-immersive": "Non-immersive"
    }[immersive] || "Auto");
    const css = this._cssEditorRef?.getValue?.() ?? "";
    set("summary-css", css.trim() ? "custom" : "none");
    if (this.container.querySelector("#ig-share-input")) {
      set("summary-instagram", q("#ig-share-input")?.checked ? "on" : "off");
    }
  }
  afterRender() {
    const postSlug = this.state.post?.slug;
    setupAdminLayout(this, {
      currentPath: "/light/posts",
      publicUrl: postSlug ? `/posts/${postSlug}` : "/"
    });
    if (this.state.loading || this.state.error) return;

    // Details rail / bottom sheet toggle
    this.container.querySelector("#details-toggle")?.addEventListener("click", () => this._toggleDetails());
    this.container.querySelector("#details-close-btn")?.addEventListener("click", () => this._toggleDetails(false));
    this.container.querySelector("#details-backdrop")?.addEventListener("click", () => this._toggleDetails(false));

    // A block on the canvas is the field itself — its header row is a label, not
    // a disclosure control, so clicking it must not collapse it. While
    // arranging, every row is a bar to be dragged, not opened. Delegated on the
    // layout so a group added later (a plugin section rendered through
    // `renderGroup`) behaves the same with no extra wiring.
    this.container.querySelector(".editor-layout")?.addEventListener("click", e => {
      const summary = e.target.closest?.("summary.details-group-summary-row");
      if (!summary) return;
      if (this.state.arranging || summary.parentElement?.classList.contains("is-pinned")) e.preventDefault();
    });

    // Header overflow menu — toggle a class rather than setState. A full
    // re-render here would rebuild the editor from state.post and discard any
    // edits not yet flushed by autosave (title/slug/excerpt/tags/css), plus
    // lose focus and scroll position.
    const splitButton = this.container.querySelector(".header-split-button");
    const setMenuOpen = open => {
      this.state.menuOpen = open;
      splitButton?.classList.toggle("is-menu-open", open);
    };
    this.container.querySelector("#header-menu-toggle")?.addEventListener("click", e => {
      e.stopPropagation();
      setMenuOpen(!this.state.menuOpen);
    });

    // Close the menu on any outside click. Released at the render boundary, so
    // re-renders cannot accumulate stale document listeners.
    this.on(document, "click", () => {
      if (this.state.menuOpen) setMenuOpen(false);
    });

    // "Update" (for already-published posts) saves whatever status the user
    // picked in the Status dropdown, so a published post can be moved to
    // hidden/draft/page. "Publish" is an explicit action for unpublished posts.
    this.$("#save-btn")?.addEventListener("click", () => this._save());
    this.$("#update-btn")?.addEventListener("click", () => this._save());
    this.$("#publish-btn")?.addEventListener("click", () => this._save({
      status: 'published'
    }));
    if (!this._mediaPicker) {
      this._mediaPicker = new MediaPickerDialog({
        onConfirm: items => this._insertMediaPaths(items)
      });
      this._mediaPicker.mount();
    }
    this.container.querySelector("#mode-text-btn")?.addEventListener("click", () => this._switchMode("text"));
    this.container.querySelector("#mode-visual-btn")?.addEventListener("click", () => this._switchMode("visual"));
    this.container.querySelectorAll(".field-ai-btn").forEach(btn => {
      btn.addEventListener("click", () => this._analyzeField(btn.dataset.field));
    });
    this._tagsInputRef = this.mountChild(TagsInput, "#tags-input-mount", {
      tags: toTagNames(this.state.post?.tags),
      onChange: tags => {
        this._tags = tags;
        this._onInput();
      }
    });
    this._tags = toTagNames(this.state.post?.tags);

    // The Custom CSS field is only rendered when the custom-css plugin is on.
    if (pluginHost.isEnabled("custom-css")) {
      this._cssEditorRef = this.mountChild(CssEditor, "#css-editor-mount", {
        id: "css-editor",
        value: this.state.post?.css || "",
        isMaximized: this.state.maximizedField === "css",
        onChange: () => this._onInput()
      });
    }
    if (this.state.editorMode === "text") {
      this._markdownEditorRef = this.mountChild(MarkdownEditor, "#content-editor-mount", {
        id: "content-editor",
        value: this.state.post?.content || "",
        isMaximized: this.state.maximizedField === "content",
        onChange: () => this._onInput()
      });
    }
    this.container.addEventListener("textarea:save", () => this._save());
    this.container.addEventListener("textarea:maximize", e => {
      const {
        isMaximized
      } = e.detail;
      let field = null;
      if (isMaximized) {
        const target = e.target;
        if (target.id === "title-input") field = "title";else if (target.id === "excerpt-editor") field = "excerpt";else if (target.closest("#tags-input-mount")) field = "tags";else if (target.closest("#css-editor-mount")) field = "css";else if (target.closest("#content-editor-mount")) field = "content";
      }
      this.state.maximizedField = field;
    });
    if (this._onKeyDown) document.removeEventListener("keydown", this._onKeyDown);
    const onKeyDown = e => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        this._save();
      }
      // Escape leaves arrange mode — the drag itself cancels on Escape too, and
      // pointerReorder handles that first while one is in progress.
      if (e.key === "Escape" && this.state.arranging) this._toggleArrange(false);
    };
    document.addEventListener("keydown", onKeyDown);
    this._onKeyDown = onKeyDown;

    // Retry autosave listener
    if (this._onAutosaveRetry) window.removeEventListener("autosave:retry", this._onAutosaveRetry);
    this._onAutosaveRetry = () => this._save();
    window.addEventListener("autosave:retry", this._onAutosaveRetry);
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
    const scheduleInput = this.container.querySelector("#schedule-input");
    statusSelect?.addEventListener("change", () => {
      const newStatus = statusSelect.value;
      statusSelect.className = `status-select badge-${newStatus}`;
      this._setScheduleVisible(newStatus === "scheduled");
      if (newStatus !== "scheduled" && scheduleInput) scheduleInput.value = "";
      this._onInput();
    });
    if (this.props.query?.openSchedule && statusSelect && scheduleInput) {
      statusSelect.value = "scheduled";
      statusSelect.className = "status-select badge-scheduled";
      this._setScheduleVisible(true);
      this._revealGroup("schedule");
      setTimeout(() => scheduleInput.showPicker?.() || scheduleInput.focus(), 50);
    }
    const scheduleHint = this.container.querySelector("#schedule-hint");
    scheduleInput?.addEventListener("focus", () => {
      if (scheduleHint) scheduleHint.style.display = "none";
    });
    scheduleInput?.addEventListener("blur", () => {
      if (scheduleHint && !scheduleInput.value) scheduleHint.style.display = "";
    });
    scheduleInput?.addEventListener("change", () => {
      const val = scheduleInput.value;
      if (val) {
        if (scheduleHint) scheduleHint.style.display = "none";
      }
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
        // Not `html` — that name is the markup tag this module imports, and
        // shadowing it here turned every preview into a TypeError the catch
        // below swallowed. The body comes back rendered and sanitized by the
        // same server pipeline that stores it, so it goes in as raw().
        const { html: rendered } = await previewRender(data.content);
        const mount = this.$("#preview-content");
        if (mount) {
          const titleHtml = data.title ? html`<h1 class="post-title">${data.title}</h1>` : "";
          mount.innerHTML = html`${titleHtml}${raw(rendered)}`;
        }
      } catch (_err) {/* ignore */}
    }, 1000);

    // Re-render the preview when the viewport grows into ultrawide range.
    if (window.matchMedia) {
      this._previewMql?.removeEventListener?.("change", this._onPreviewMqlChange);
      this._previewMql = window.matchMedia("(min-width: 112em)");
      this._onPreviewMqlChange = e => {
        if (e.matches && this.state.showLivePreview) this._debouncedPreview?.();
      };
      this._previewMql.addEventListener?.("change", this._onPreviewMqlChange);
    }
    if (this.state.showLivePreview) this._debouncedPreview();
    this.container.querySelector("#arrange-done")?.addEventListener("click", () => this._toggleArrange(false));
    this._setupArrange();
    // A re-render rebuilds the layout with the bar hidden; restore the mode.
    if (this.state.arranging) this._toggleArrange(true);
    this._updateDetailsSummaries();
    this._updatePanelEmpty();
    this._detachFileDrop?.();
    this._detachFileDrop = attachWindowFileDrop({
      onFile: f => this._uploadAndInsert(f)
    });
  }

  /**
   * Open the post on the public site, in this tab.
   *
   * The slug can have changed under an unflushed edit, so the destination is
   * re-read from the saved post afterwards rather than from the props rendered
   * before the save.
   */
  async _viewOnSite() {
    if (this.state.hasPendingEdits) await this._autosave();
    const slug = this.state.post?.slug;
    navigate(slug ? `/posts/${slug}` : this.props.publicUrl || "/");
  }

  /**
   * Move the post to Trash and leave the editor.
   *
   * `deleting` is what parks the autosave — a queued idle save would otherwise
   * fire against the row we just trashed and resurrect it as a draft.
   */
  async _deletePost(id) {
    // Never saved: the post exists only in this form, so there is nothing to
    // trash — just leave.
    if (!id) {
      navigate("/light/posts");
      return;
    }
    this.setState({
      deleting: true
    });
    try {
      await deletePost(id);
      this.state.hasPendingEdits = false;
      store.set("toast", {
        message: "Post moved to Trash.",
        type: "success"
      });
      navigate("/light/posts");
    } catch (err) {
      this.setState({
        deleting: false
      });
      store.set("toast", {
        message: err.message || "Move to Trash failed.",
        type: "error"
      });
    }
  }
  _analyzeNow() {
    const path = this._extractImagePath();
    if (path) this._handleAnalyze({
      path
    });else this._mediaPicker.open(items => this._handleAnalyze(items[0]));
  }
  _onInput() {
    // Mutate state directly — a full re-render here would wipe input values and
    // focus on every keystroke. (Component.setState always re-renders.)
    this.state.hasPendingEdits = true;
    this._updateDetailsSummaries();
    store.set('autosave_status', {
      status: 'idle'
    });

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
    clearTimeout(this._idleTimer);
    this._idleTimer = null;
    clearTimeout(this._maxWaitTimer);
    this._maxWaitTimer = null;
    if (this._unmounted || this.state.saving || this.state.deleting || !this.state.hasPendingEdits) return;
    const data = this._applyPageType(this._collectFormData());
    // An untitled post is fine — the backend titles it after today. A brand new
    // one with nothing in it at all is not worth a draft row yet.
    if (this.state.isNew && !data.title && !data.content.trim()) return;
    store.set('autosave_status', {
      status: 'saving'
    });
    try {
      if (this.state.isNew) {
        const result = await createPost({
          ...data,
          status: 'draft'
        });
        this.state.isNew = false;
        this.state.postId = result.id;
        this.state.post = result;
        // Show the date title the backend assigned to an untitled post — a
        // re-render here would wipe the caret, so write the field directly.
        const titleEl = this.container.querySelector("#title-input");
        if (titleEl && !titleEl.value.trim() && result.title) titleEl.value = result.title;
        history.replaceState(null, "", `/light/posts/${result.id}/edit`);
      } else {
        const result = await updatePost(this.state.postId, data);
        this.state.post = result;
      }
      this.state.hasPendingEdits = false;
      store.set('autosave_status', {
        status: 'saved',
        lastSaved: Date.now()
      });
      if (this._chipInterval) clearInterval(this._chipInterval);
      this._chipInterval = setInterval(() => {
        if (store.get('autosave_status')?.status === 'saved') {
          store.set('offline_status', {
            ...store.get('offline_status')
          }); // trigger re-render of sync pill
        } else {
          clearInterval(this._chipInterval);
        }
      }, 5000);
    } catch (err) {
      console.error("Autosave failed:", err);
      store.set('autosave_status', {
        status: 'failed'
      });
    }
  }

  // The status dropdown offers "page", but a page is really type=page +
  // status=published. Map the chosen status onto the real (status, type) pair.
  // Done after overrides are merged so explicit status actions (publish/hidden/
  // draft) correctly turn a page back into a regular post.
  _applyPageType(data) {
    if (data.status === "page") return {
      ...data,
      status: "published",
      type: "page"
    };
    return {
      ...data,
      type: "post"
    };
  }
  async _save(overrides = {}) {
    const data = this._applyPageType({
      ...this._collectFormData(),
      ...overrides
    });
    this.setState({
      saving: true
    });
    store.set('autosave_status', {
      status: 'saving'
    });
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
      this.setState({
        saving: false,
        post: result
      });
      store.set('autosave_status', {
        status: 'saved',
        lastSaved: Date.now()
      });
      store.set("toast", {
        message: "Saved.",
        type: "success"
      });
    } catch (err) {
      this.setState({
        saving: false
      });
      store.set('autosave_status', {
        status: 'failed'
      });
      store.set("toast", {
        message: err.message || "Save failed.",
        type: "error"
      });
    }
  }
  beforeUnmount() {
    this._detachReorder?.();
    this._unmounted = true;
    if (this._onAutosaveRetry) window.removeEventListener("autosave:retry", this._onAutosaveRetry);
    clearTimeout(this._idleTimer);
    clearTimeout(this._maxWaitTimer);
    clearInterval(this._chipInterval);
    this._detachFileDrop?.();
    this._mediaPicker?.destroy();
    this._mediaPicker = null;
    this._visualEditorRef = null;
    if (this._onKeyDown) document.removeEventListener("keydown", this._onKeyDown);
    if (this._onDocClick) document.removeEventListener("click", this._onDocClick);
    this._previewMql?.removeEventListener?.("change", this._onPreviewMqlChange);
  }
  _insertMediaPaths(items) {
    if (!items.length) return;
    if (this.state.editorMode === "visual") {
      this._nodes = [...this._nodes, ...items.map(item => ({
        type: "image",
        path: item.path
      }))];
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
      onChange: nodes => {
        this._nodes = nodes;
        this._visualEditorRef.setProps({
          nodes: this._nodes
        });
        this._onInput();
      },
      onInput: () => this._onInput(),
      onAddMedia: index => {
        this._mediaPicker.open(items => {
          if (!items.length) return;
          this._nodes.splice(index, 0, ...items.map(item => ({
            type: "image",
            path: item.path
          })));
          this._mountVisualEditor();
          this._onInput();
        });
      },
      onRename: (oldPath, newFilename) => this._handleRename(oldPath, newFilename)
    });
  }
  async _handleRename(oldPath, newFilename) {
    const lastSlash = oldPath.lastIndexOf("/");
    const folder = oldPath.slice(1, lastSlash);
    try {
      const {
        listMedia,
        renameMedia
      } = await import('../../api/media.js');
      const result = await listMedia({
        folder,
        per_page: 200
      });
      const item = (result.media || []).find(m => m.path === oldPath);
      if (!item) throw new Error(`Media not found: ${oldPath}`);
      const updated = await renameMedia(item.id, newFilename);
      this._nodes = this._nodes.map(n => n.type === "image" && n.path === oldPath ? {
        ...n,
        path: updated.path
      } : n);
      this._mountVisualEditor();
      this._onInput();
      store.set("toast", {
        message: "File renamed.",
        type: "success"
      });
    } catch (err) {
      store.set("toast", {
        message: err.message || "Rename failed.",
        type: "error"
      });
      throw err;
    }
  }
  _switchMode(targetMode) {
    if (this.state.editorMode === targetMode) return;
    const data = this._collectFormData();
    const post = {
      ...(this.state.post || {}),
      ...data,
      tags: (data.tags || []).map(name => ({
        name,
        slug: name
      }))
    };
    if (targetMode === "visual") {
      this._nodes = parseNodes(data.content);
      this.setState({
        editorMode: "visual",
        post
      });
    } else {
      this.setState({
        editorMode: "text",
        post
      });
    }
  }
  mount() {
    super.mount();
    if (this.state.postId) {
      this._loadPost(this.state.postId);
    } else {
      const initialContent = sessionStorage.getItem("newPostInitialContent");
      if (initialContent) {
        this.state.post = {
          ...(this.state.post || {}),
          content: initialContent
        };
        if (this.state.editorMode === "visual") {
          this._nodes = parseNodes(initialContent);
        }
        sessionStorage.removeItem("newPostInitialContent");
      }
      getInstagramStatus().catch(() => null).then(igStatus => {
        if (!this._unmounted) this.setState({
          igStatus
        });
      });
    }
    if (this.props.query?.share === "pending") this._processShareQueue();
  }
  async _processShareQueue() {
    let entries;
    try {
      entries = await getAllShareEntries();
    } catch {
      return;
    }
    if (!entries.length) return;
    const [current, ...backlog] = entries;
    if (current.title) {
      const titleEl = this.container.querySelector("#title-input");
      if (titleEl && !titleEl.value.trim()) titleEl.value = current.title;
    }
    for (const fileEntry of current.files) {
      const blob = new Blob([fileEntry.data], {
        type: fileEntry.type
      });
      const file = new File([blob], fileEntry.name, {
        type: fileEntry.type
      });
      await this._uploadAndInsert(file);
    }
    for (const entry of backlog) {
      try {
        const title = entry.title || entry.files.map(f => f.name).join(", ") || "Shared photo";
        const post = await createPost({
          title,
          status: "draft",
          content: ""
        });
        let content = "";
        for (const fileEntry of entry.files) {
          const blob = new Blob([fileEntry.data], {
            type: fileEntry.type
          });
          const file = new File([blob], fileEntry.name, {
            type: fileEntry.type
          });
          const media = await uploadMedia(file, {
            post_id: post.id
          });
          content += `${media.path}\n`;
        }
        await updatePost(post.id, {
          content: content.trim()
        });
      } catch (err) {
        store.set("toast", {
          message: `Failed to save offline share: ${err.message}`,
          type: "error"
        });
      }
    }
    try {
      await clearShareEntries();
    } catch (_e) {/* ignore */}
    if (backlog.length > 0) store.set("toast", {
      message: `${backlog.length} offline shares saved as draft.`,
      type: "success"
    });
  }
  async _loadPost(id) {
    try {
      const [post, igStatus] = await Promise.all([getPost(id), getInstagramStatus().catch(() => null)]);
      if (post.status) post.status = post.status.toLowerCase();
      this._tags = toTagNames(post.tags);
      this._nodes = parseNodes(post.content);
      this._mediaByPath = {};
      try {
        const {
          listMedia
        } = await import('../../api/media.js');
        const result = await listMedia({
          post_id: post.id,
          per_page: 200
        });
        for (const m of result.media || []) if (m.path) this._mediaByPath[m.path] = m;
      } catch (_e) {/* ignore */}
      this.setState({
        loading: false,
        post,
        error: null,
        editorMode: "visual",
        igStatus
      });
    } catch (_err) {
      store.set("toast", {
        message: "Could not load post.",
        type: "error"
      });
      navigate("/light/posts", {
        replace: true
      });
    }
  }
  _collectFormData() {
    return {
      title: (this.container.querySelector("#title-input")?.value || "").trim(),
      slug: (this.container.querySelector("#slug-input")?.value || "").trim() || null,
      excerpt: (this.container.querySelector("#excerpt-editor")?.value || "").trim() || null,
      content: this.state.editorMode === "visual" ? this._visualEditorRef?.serializeNodes() ?? serializeNodes(this._nodes) : this._markdownEditorRef?.getValue() ?? "",
      status: this.container.querySelector("#status-select")?.value || this.state.post?.status || "draft",
      // These fields have no editor inputs; preserve existing values instead of
      // sending null (the backend would clear them on every save).
      formatter: this.state.post?.formatter || "markdown",
      is_featured: this.container.querySelector("#featured-check")?.checked || false,
      thumbnail_path: this.state.post?.thumbnail_path ?? null,
      meta_description: this.state.post?.meta_description ?? null,
      tags: this._tagsInputRef ? this._tagsInputRef.getTags() : this._tags,
      scheduled_at: this.container.querySelector("#schedule-input")?.value ? new Date(this.container.querySelector("#schedule-input").value).toISOString() : "",
      css: this._cssEditorRef ? this._cssEditorRef.getValue() : this.state.post?.css || "",
      immersive_mode: this.container.querySelector("#immersive-mode-select")?.value || "auto",
      instagram_share: this.container.querySelector("#ig-share-input")?.checked ?? (this.state.isNew ? this.state.igStatus?.default_share ?? false : this.state.post?.instagram_share ?? false)
    };
  }
  _showConfirm(title, message, confirmText, variant, onConfirm) {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const dialog = new ConfirmDialog(mount, {
      title,
      message,
      confirmText,
      variant,
      onConfirm: () => {
        dialog.unmount();
        mount.remove();
        onConfirm();
      },
      onCancel: () => {
        dialog.unmount();
        mount.remove();
      }
    });
    dialog.mount();
  }

  /** The image an AI analysis should run on: the first one in the post. */
  _extractImagePath() {
    if (this.state.editorMode === "visual") return this._nodes.find(n => n.type === "image")?.path ?? null;
    return firstImagePath(this._markdownEditorRef?.getValue() ?? "");
  }
  _analyzeField(field) {
    if (this._analyzing || this.state.analyzingField) return;
    const path = this._extractImagePath();
    if (path) this._doAnalyzeField(field, {
      path
    });else this._mediaPicker.open(items => {
      if (items?.[0]) this._doAnalyzeField(field, items[0]);
    });
  }
  async _doAnalyzeField(field, item) {
    if (!item) return;
    const snap = this._collectFormData();
    this.container.querySelectorAll(`.field-ai-btn`).forEach(b => {
      b.disabled = true;
    });
    const post = {
      ...(this.state.post || {}),
      title: snap.title,
      excerpt: snap.excerpt,
      content: snap.content,
      slug: snap.slug,
      status: snap.status,
      is_featured: snap.is_featured,
      formatter: snap.formatter,
      thumbnail_path: snap.thumbnail_path,
      meta_description: snap.meta_description,
      tags: snap.tags.map(name => ({
        name,
        slug: name
      }))
    };
    try {
      const {
        analyzeMedia,
        analyzeMediaByPath
      } = await import('../../api/media.js');
      const result = item.id ? await analyzeMedia(item.id) : await analyzeMediaByPath(item.path);
      const isEmpty = !result.title && !result.tags?.length && !result.excerpt;
      if (field === "title" && result.title) post.title = result.title;else if (field === "tags" && result.tags?.length) {
        const currentTags = this._tags || [];
        const mergedTags = [...currentTags, ...(result.tags || []).filter(t => !currentTags.includes(t))];
        this._tags = mergedTags;
        post.tags = mergedTags.map(name => ({
          name,
          slug: name
        }));
      } else if (field === "excerpt" && result.excerpt) post.excerpt = result.excerpt;
      if (isEmpty) store.set("toast", {
        message: "AI disabled or no suggestions.",
        type: "info"
      });else store.set("toast", {
        message: `${field.charAt(0).toUpperCase() + field.slice(1)} filled.`,
        type: "success"
      });
    } catch (err) {
      store.set("toast", {
        message: err.message || "Analysis failed.",
        type: "error"
      });
    }
    this.setState({
      analyzingField: null,
      post
    });
  }
  async _handleAnalyze(item) {
    if (!item || this._analyzing) return;
    const snap = this._collectFormData();
    this._analyzing = true;
    try {
      const {
        analyzeMedia,
        analyzeMediaByPath
      } = await import('../../api/media.js');
      const result = item.id ? await analyzeMedia(item.id) : await analyzeMediaByPath(item.path);
      const mergedTags = [...snap.tags, ...(result.tags || []).filter(t => !snap.tags.includes(t))];
      const post = {
        ...(this.state.post || {}),
        title: snap.title || result.title || "",
        excerpt: snap.excerpt || result.excerpt || null,
        content: snap.content,
        slug: snap.slug,
        status: snap.status,
        is_featured: snap.is_featured,
        formatter: snap.formatter,
        thumbnail_path: snap.thumbnail_path,
        meta_description: snap.meta_description,
        tags: mergedTags.map(name => ({
          name,
          slug: name
        }))
      };
      if (this.state.editorMode === "visual") this._nodes = parseNodes(post.content);
      store.set("toast", {
        message: "Analysis complete.",
        type: "success"
      });
      this._analyzing = false;
      this.setState({
        post
      });
    } catch (err) {
      const post = {
        ...(this.state.post || {}),
        title: snap.title,
        excerpt: snap.excerpt,
        content: snap.content,
        slug: snap.slug,
        status: snap.status,
        is_featured: snap.is_featured,
        formatter: snap.formatter,
        thumbnail_path: snap.thumbnail_path,
        meta_description: snap.meta_description,
        tags: snap.tags.map(name => ({
          name,
          slug: name
        }))
      };
      if (this.state.editorMode === "visual") this._nodes = parseNodes(post.content);
      store.set("toast", {
        message: err.message || "Analysis failed.",
        type: "error"
      });
      this._analyzing = false;
      this.setState({
        post
      });
    }
  }
  async _uploadAndInsert(file) {
    try {
      const result = await uploadMedia(file, {
        post_id: this.state.postId || undefined
      });
      if (this.state.editorMode === "visual") this._insertMediaPaths([{
        path: result.path
      }]);else if (this._markdownEditorRef) this._markdownEditorRef.insertAtEnd(result.path);
    } catch (err) {
      store.set("toast", {
        message: `Upload failed: ${err.message || file.name}`,
        type: "error"
      });
    }
  }
  async _publishToInstagram() {
    if (this.state.publishingToInstagram || this.state.isNew) return;
    this.setState({
      publishingToInstagram: true
    });
    try {
      const result = await publishPostToInstagram(this.state.postId);
      this.setState({
        publishingToInstagram: false,
        post: result
      });
      const st = result.instagram_status;
      // The backend writes "error"; "failed" is accepted too so older rows and
      // any future rename both still surface as a failure rather than as the
      // neutral "triggered" fallback.
      if (st === "published") store.set("toast", {
        message: "Published to Instagram.",
        type: "success"
      });else if (st === "error" || st === "failed") store.set("toast", {
        message: result.instagram_error || "Instagram publish failed.",
        type: "error"
      });else store.set("toast", {
        message: "Instagram publish triggered.",
        type: "info"
      });
    } catch (err) {
      this.setState({
        publishingToInstagram: false
      });
      store.set("toast", {
        message: err.message || "Instagram publish failed.",
        type: "error"
      });
    }
  }
  async _generatePreviewLink() {
    if (this.state.generatingPreview || this.state.isNew) return;
    this.setState({
      generatingPreview: true
    });
    try {
      const {
        preview_url
      } = await generatePreviewLink(this.state.postId);
      try {
        await navigator.clipboard.writeText(preview_url);
        store.set("toast", {
          message: "Preview link copied to clipboard.",
          type: "success"
        });
      } catch {
        this._showPreviewLinkDialog(preview_url);
      }
    } catch (err) {
      store.set("toast", {
        message: err.message || "Could not generate preview link.",
        type: "error"
      });
    } finally {
      this.setState({
        generatingPreview: false
      });
    }
  }
  _showPreviewLinkDialog(url) {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const close = () => {
      dialog.unmount();
      mount.remove();
    };
    const dialog = new ConfirmDialog(mount, {
      title: "Preview link",
      message: url,
      confirmText: "Close",
      variant: "primary",
      onConfirm: close,
      onCancel: close
    });
    dialog.mount();
    const msgEl = mount.querySelector(".confirm-dialog__message, p");
    if (msgEl) {
      const range = document.createRange();
      range.selectNodeContents(msgEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
}