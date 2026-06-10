/**
 * PostsListPage — paginated, filterable list of all posts.
 *
 * Fetches: GET /api/posts
 */

import { Component } from "../../components/Component.js";
import { adminLayoutTemplate, setupAdminLayout } from "../../components/light/AdminLayout.js";
import { TagsInput } from "../../components/light/TagsInput.js";
import { Pagination } from "../../components/shared/Pagination.js";
import { ConfirmDialog } from "../../components/shared/ConfirmDialog.js";
import {
  listPosts,
  deletePost,
  restorePost,
  permanentlyDeletePost,
  updatePostTags,
  updatePost,
  setPostStatus,
} from "../../api/posts.js";
import { store } from "../../store.js";
import { escapeHtml, navigate, debounce } from "../../utils/helpers.js";
import { formatDateShort } from "../../utils/formatters.js";
import {
  EDIT_SVG,
  X_SVG,
  EXTERNAL_LINK_SVG,
  PLAY_SVG,
  MUSIC_SVG,
  RESTORE_SVG,
  SELECT_SVG,
  PLUS_SVG,
} from "../../utils/icons.js";

const STATUS_LABELS = {
  published: "Published",
  draft: "Draft",
  hidden: "Hidden",
  page: "Page",
  scheduled: "Scheduled",
  trash: "Trash",
};

export default class PostsListPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      posts: [],
      pagination: {},
      error: null,
      statusFilter: props.query?.status || "",
      search: props.query?.search || "",
      page: parseInt(props.query?.page || "1", 10),
      selectMode: false,
      selectedIds: new Set(),
    };
  }

  render() {
    const { selectMode, statusFilter } = this.state;
    const isTrash = statusFilter === "trash";

    const actions = `
      ${!isTrash ? `<button id="select-mode-btn" class="btn" title="${selectMode ? "Cancel selection" : "Select posts"}">${selectMode ? X_SVG : SELECT_SVG}<span class="btn-label">${selectMode ? "Cancel" : "Select"}</span></button>` : ""}
      <a href="/light/posts/new" class="btn btn-primary" title="New Post">${PLUS_SVG}<span class="btn-label">New Post</span></a>
    `;

    return adminLayoutTemplate({
      title: "Posts",
      actions,
      content: this._renderContent()
    });
  }

  _renderCardRow(p) {
    const { selectMode, selectedIds, statusFilter } = this.state;
    const isTrash = statusFilter === "trash";
    const isChecked = selectedIds.has(p.id);

    const mediaUrl = p.media_url || "";
    const isImage = /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(mediaUrl);
    const isVideo = /\.(mp4|webm|mov|ogv|m4v|avi|mkv)$/i.test(mediaUrl);
    const isAudio = /\.(mp3|m4a|ogg|wav|flac|aac|opus)$/i.test(mediaUrl);

    let thumbInner = "";
    if (isImage && p.media_url) {
      thumbInner = `<img src="${escapeHtml(p.media_url + "?thumb")}" class="post-preview-img" loading="lazy">`;
    } else if (isVideo) {
      thumbInner = PLAY_SVG;
    } else if (isAudio) {
      thumbInner = MUSIC_SVG;
    }

    if (isTrash) {
      const deletedAt = p.deleted_at?.value
        ? formatDateShort(p.deleted_at.value)
        : p.deleted_at
          ? formatDateShort(p.deleted_at)
          : "";
      return `
        <div class="post-card post-card--trash" data-post-id="${escapeHtml(String(p.id))}">
          <div class="post-card-thumb post-card-thumb--muted"></div>
          <div class="post-card-body">
            <div class="post-card-title muted">${escapeHtml(p.title)}</div>
            <div class="post-card-meta">
              <span class="trash-status-label">Was: ${escapeHtml(STATUS_LABELS[p.status] || p.status)}</span>
              ${deletedAt ? `· ${escapeHtml(deletedAt)}` : ""}
            </div>
            <div class="post-card-actions">
              <button class="btn btn-sm restore-btn"
                      data-id="${escapeHtml(String(p.id))}"
                      data-title="${escapeHtml(p.title)}"
                      title="Restore">${RESTORE_SVG} Restore</button>
              <button class="btn btn-sm btn-danger perm-delete-btn"
                      data-id="${escapeHtml(String(p.id))}"
                      data-title="${escapeHtml(p.title)}"
                      title="Delete permanently">${X_SVG} Delete</button>
            </div>
          </div>
        </div>`;
    }

    const cardStatusOptions = ["draft", "published", "scheduled", "hidden", "page"]
      .map((s) => `<option value="${s}"${p.status === s ? " selected" : ""}>${escapeHtml(STATUS_LABELS[s] || s)}</option>`)
      .join("");

    const tags = (p.tags || []).map((t) => (typeof t === "string" ? t : t.name));
    const chipsHtml = tags
      .map((name) => `<span class="tag">${escapeHtml(name)}</span>`)
      .join("");

    return `
      <div class="post-card" data-post-id="${escapeHtml(String(p.id))}">
        <div class="post-card-check-wrap">
          <input type="checkbox" class="select-row-cb post-card-check" data-id="${escapeHtml(String(p.id))}" ${isChecked ? "checked" : ""}>
        </div>
        <div class="post-card-thumb">${thumbInner}</div>
        <div class="post-card-body">
          <div class="post-card-top">
            <span class="post-card-title">${escapeHtml(p.title)}</span>
            <select class="status-select badge-${escapeHtml(p.status)} status-change-btn" name="status" data-id="${escapeHtml(String(p.id))}">${cardStatusOptions}</select>
          </div>
          ${chipsHtml ? `<div class="post-card-chips">${chipsHtml}</div>` : ""}
          <div class="post-card-meta">${escapeHtml(formatDateShort(p.updated_at || p.created_at))}</div>
        </div>
      </div>`;
  }

  _renderCardList() {
    const { loading, posts, error, statusFilter, selectMode } = this.state;
    const isTrash = statusFilter === "trash";

    let inner;
    if (loading) {
      inner = `<p class="post-card-placeholder">Loading…</p>`;
    } else if (error) {
      inner = `<p class="post-card-placeholder error-state">${escapeHtml(error)}</p>`;
    } else if (!posts.length) {
      inner = `<p class="post-card-placeholder">${isTrash ? "Trash is empty." : "No posts found."}</p>`;
    } else {
      inner = posts.map((p) => this._renderCardRow(p)).join("");
    }

    const selectClass = selectMode && !isTrash ? " select-mode" : "";
    return `<div class="posts-card-list${selectClass}" id="posts-card-list">${inner}</div>`;
  }

  _renderContent() {
    const {
      loading,
      posts,
      error,
      statusFilter,
      search,
      selectMode,
      selectedIds,
    } = this.state;
    const isTrash = statusFilter === "trash";

    const statusOptions = [
      "",
      "draft",
      "published",
      "scheduled",
      "hidden",
      "page",
      "trash",
    ]
      .map((s) => {
        const label = s ? STATUS_LABELS[s] : "All statuses";
        const sel = statusFilter === s ? " selected" : "";
        return `<option value="${escapeHtml(s)}"${sel}>${escapeHtml(label)}</option>`;
      })
      .join("");

    const colspan = selectMode && !isTrash ? 6 : 5;

    const rows = loading
      ? `<tr><td colspan="${colspan}" class="loading">Loading…</td></tr>`
      : error
        ? `<tr><td colspan="${colspan}" class="error-state">${escapeHtml(error)}</td></tr>`
        : !posts.length
          ? `<tr><td colspan="${colspan}" class="empty-state">${isTrash ? "Trash is empty." : "No posts found."}</td></tr>`
          : posts
              .map((p) => {
                const mediaUrl = p.media_url || "";
                const isImage = /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(
                  mediaUrl,
                );
                const isVideo = /\.(mp4|webm|mov|ogv|m4v|avi|mkv)$/i.test(
                  mediaUrl,
                );
                const isAudio = /\.(mp3|m4a|ogg|wav|flac|aac|opus)$/i.test(
                  mediaUrl,
                );

                let previewHtml = "";
                if (isImage && p.media_url) {
                  previewHtml = `<img src="${escapeHtml(p.media_url + "?thumb")}" class="post-preview-img" loading="lazy">`;
                } else if (isVideo) {
                  previewHtml = `<div class="post-preview-placeholder" title="Video">${PLAY_SVG}</div>`;
                } else if (isAudio) {
                  previewHtml = `<div class="post-preview-placeholder" title="Audio">${MUSIC_SVG}</div>`;
                } else {
                  previewHtml = `<div class="post-preview-placeholder"></div>`;
                }
                const isChecked = selectedIds.has(p.id);

                if (isTrash) {
                  const deletedAt = p.deleted_at?.value
                    ? formatDateShort(p.deleted_at.value)
                    : p.deleted_at
                      ? formatDateShort(p.deleted_at)
                      : "";
                  return `
                <tr data-post-id="${escapeHtml(String(p.id))}" class="post-row-main">
                  <td class="preview-col" rowspan="2">
                    <div class="post-preview-placeholder" title="Trashed"></div>
                  </td>
                  <td class="status-col">
                    <span class="badge badge-trash">Trash</span>
                  </td>
                  <td class="title-col">
                    <span class="table-link muted">${escapeHtml(p.title)}</span>
                  </td>
                  <td class="updated-col">${escapeHtml(deletedAt)}</td>
                  <td class="actions-col">
                    <div class="actions">
                      <button class="btn btn-sm restore-btn"
                              data-id="${escapeHtml(String(p.id))}"
                              data-title="${escapeHtml(p.title)}"
                              title="Restore">${RESTORE_SVG}</button>
                      <button class="btn btn-sm btn-danger perm-delete-btn"
                              data-id="${escapeHtml(String(p.id))}"
                              data-title="${escapeHtml(p.title)}"
                              title="Delete permanently">${X_SVG}</button>
                    </div>
                  </td>
                </tr>
                <tr data-post-id="${escapeHtml(String(p.id))}" class="post-row-tags">
                  <td colspan="4" class="tags-col muted-tags">
                    <span class="trash-status-label">Was: ${escapeHtml(STATUS_LABELS[p.status] || p.status)}</span>
                  </td>
                </tr>`;
                }

                return `
              <tr data-post-id="${escapeHtml(String(p.id))}" class="post-row-main">
                ${selectMode ? `<td class="check-col" rowspan="2"><input type="checkbox" class="select-row-cb" data-id="${p.id}" ${isChecked ? "checked" : ""}></td>` : ""}
                <td class="preview-col" rowspan="2">
                  <a href="/light/posts/${escapeHtml(String(p.id))}/edit" title="Edit post">
                    ${previewHtml}
                  </a>
                </td>
                <td class="status-col">
                  <select class="status-select badge-${escapeHtml(p.status)} status-change-btn"
                          name="status" data-id="${escapeHtml(String(p.id))}">
                    ${["draft", "published", "scheduled", "hidden", "page"]
                      .map(
                        (s) => `
                      <option value="${s}"${p.status === s ? " selected" : ""}>
                        ${escapeHtml(STATUS_LABELS[s] || s)}
                      </option>
                    `,
                      )
                      .join("")}
                  </select>
                  ${
                    p.status === "scheduled" && p.scheduled_at
                      ? `<span class="scheduled-date">${escapeHtml(
                          new Date(p.scheduled_at).toLocaleString([], {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          }),
                        )}</span>`
                      : ""
                  }
                </td>
                <td class="title-col">
                  <a href="/light/posts/${escapeHtml(String(p.id))}/edit" class="table-link">
                    ${escapeHtml(p.title)}
                  </a>
                </td>
                <td class="updated-col">${escapeHtml(formatDateShort(p.updated_at || p.created_at))}</td>
                <td class="actions-col">
                  <div class="actions">
                    <a href="/light/posts/${escapeHtml(String(p.id))}/edit"
                       class="btn btn-sm" title="Edit">${EDIT_SVG}</a>
                    <a href="/posts/${escapeHtml(p.slug)}" class="btn btn-sm"
                       title="View" target="_blank" data-external>${EXTERNAL_LINK_SVG}</a>
                    <button class="btn btn-sm btn-danger delete-btn"
                            data-id="${escapeHtml(String(p.id))}"
                            data-title="${escapeHtml(p.title)}"
                            title="Move to Trash">${X_SVG}</button>
                  </div>
                </td>
              </tr>
              <tr data-post-id="${escapeHtml(String(p.id))}" class="post-row-tags">
                <td colspan="4" class="tags-col">
                  <div id="tags-cell-${escapeHtml(String(p.id))}"></div>
                </td>
              </tr>`;
              })
              .join("");

    return `
            <div class="filters">
              <select id="status-filter" class="status-select badge-${escapeHtml(statusFilter || "draft")} filter-select">
                ${statusOptions}
              </select>
              ${
                !isTrash
                  ? `<input type="search" id="search-input" class="form-input filter-search"
                     placeholder="Search posts…" value="${escapeHtml(search)}">`
                  : ""
              }
            </div>
            ${
              selectMode && !isTrash
                ? `
            <div class="bulk-toolbar" id="bulk-toolbar">
              <span id="bulk-count">0 selected</span>
              <select id="bulk-status-select">
                <option value="draft">Draft</option>
                <option value="published">Published</option>
                <option value="hidden">Hidden</option>
              </select>
              <button id="bulk-apply-btn" class="btn btn-sm" disabled>Apply</button>
              <button id="bulk-delete-btn" class="btn btn-sm btn-danger" disabled>Move to Trash</button>
            </div>
            `
                : ""
            }
            <div class="table-container">
              <table class="table">
                <thead>
                  <tr>
                    ${selectMode && !isTrash ? '<th class="check-col"><input type="checkbox" id="select-all-cb"></th>' : ""}
                    <th class="preview-col" colspan="2">Post</th>
                    <th class="title-col"></th>
                    <th class="updated-col">${isTrash ? "Deleted" : "Last updated"}</th>
                    <th class="actions-col"></th>
                  </tr>
                </thead>
                <tbody id="posts-tbody">${rows}</tbody>
              </table>
            </div>
            ${this._renderCardList()}
            <div id="pagination-mount"></div>`;
  }

  afterRender() {
    this._cleanupAdminLayout = setupAdminLayout(this, {
      currentPath: "/light/posts",
    });

    const { statusFilter } = this.state;
    const isTrash = statusFilter === "trash";

    if (!this.state.loading && this.state.pagination.pages > 1) {
      this.mountChild(Pagination, "#pagination-mount", {
        page: this.state.pagination.page,
        pages: this.state.pagination.pages,
        total: this.state.pagination.total,
        onPage: (p) => this._load({ page: p }),
      });
    }

    // Restore focus to search input after a re-render triggered by _load
    const searchInput = this.container.querySelector("#search-input");
    if (searchInput) {
      if (this._restoreSearchFocus) {
        this._restoreSearchFocus = false;
        const len = searchInput.value.length;
        searchInput.focus();
        searchInput.setSelectionRange(len, len);
      }

      searchInput.addEventListener(
        "input",
        debounce((e) => {
          // Update state without re-rendering — the input already shows the new value
          this.state.search = e.target.value;
          this.state.page = 1;
          this._load({ page: 1, search: e.target.value });
        }, 350),
      );
    }

    // Status filter
    const statusFilterEl = this.container.querySelector("#status-filter");
    if (statusFilterEl) {
      statusFilterEl.addEventListener("change", (e) => {
        const val = e.target.value;
        statusFilterEl.className = `status-select badge-${val || "draft"} filter-select`;
        this.setState({ statusFilter: val, page: 1 });
        this._load({ page: 1, status: val });
      });
    }

    // Mount a TagsInput in every tags cell (skip for trash view)
    if (!isTrash && !this.state.loading && !this.state.error) {
      for (const post of this.state.posts) {
        this._mountTagEditor(post);
      }
    }

    // Status change buttons (skip for trash view)
    if (!isTrash) {
      this.container.querySelectorAll(".status-change-btn").forEach((select) => {
        select.addEventListener("change", async (e) => {
          const id = parseInt(select.dataset.id, 10);
          const newStatus = e.target.value;
          await this._updatePostStatus(id, newStatus, select);
        });
      });
    }

    // Delete buttons (move to trash)
    this.container.querySelectorAll(".delete-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = parseInt(btn.dataset.id, 10);
        const title = btn.dataset.title;
        this._showConfirm(
          "Move to Trash",
          `Move "${title}" to Trash? You can restore it later.`,
          "Move to Trash",
          "danger",
          () => {
            this._deletePost(id);
          },
        );
      });
    });

    // Restore buttons (trash view)
    this.container.querySelectorAll(".restore-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = parseInt(btn.dataset.id, 10);
        const title = btn.dataset.title;
        this._restorePost(id, title);
      });
    });

    // Permanently delete buttons (trash view)
    this.container.querySelectorAll(".perm-delete-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = parseInt(btn.dataset.id, 10);
        const title = btn.dataset.title;
        this._showConfirm(
          "Delete permanently",
          `Permanently delete "${title}"? This cannot be undone.`,
          "Delete",
          "danger",
          () => {
            this._permanentlyDeletePost(id);
          },
        );
      });
    });

    // Select mode (skip for trash view)
    this.$("#select-mode-btn")?.addEventListener("click", () => {
        this.setState({
          selectMode: !this.state.selectMode,
          selectedIds: new Set(),
        });
    });

    if (this.state.selectMode && !isTrash) {
      this.container.querySelector("#select-all-cb")?.addEventListener(
        "change",
        this._handleSelectAll.bind(this),
      );
      this.container.querySelectorAll(".select-row-cb").forEach((cb) => {
        cb.addEventListener("change", this._handleSelectRow.bind(this));
      });
      this.container.querySelector("#bulk-apply-btn")?.addEventListener(
        "click",
        this._handleBulkApply.bind(this),
      );
      this.container.querySelector("#bulk-delete-btn")?.addEventListener(
        "click",
        this._handleBulkDelete.bind(this),
      );
      this._updateBulkToolbar();
    }

    // Card view: tap to edit or toggle selection; long-press to enter select mode
    this.container.querySelectorAll(".post-card").forEach((card) => {
      const postId = parseInt(card.dataset.postId, 10);

      if (!isTrash) {
        let longPressTimer = null;
        card.addEventListener("pointerdown", (e) => {
          if (e.target.closest("select, button, a, input")) return;
          longPressTimer = setTimeout(() => {
            longPressTimer = null;
            if (!this.state.selectMode) {
              this.setState({ selectMode: true, selectedIds: new Set([postId]) });
            }
          }, 500);
        });
        const cancelTimer = () => {
          if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        };
        card.addEventListener("pointerup", cancelTimer);
        card.addEventListener("pointermove", cancelTimer);
        card.addEventListener("pointercancel", cancelTimer);
      }

      card.addEventListener("click", (e) => {
        if (e.target.closest("select, button, a, input")) return;
        if (isTrash) return;
        if (this.state.selectMode) {
          const cb = card.querySelector(".select-row-cb");
          if (cb) {
            cb.checked = !cb.checked;
            cb.dispatchEvent(new Event("change", { bubbles: true }));
          }
          return;
        }
        navigate(`/light/posts/${postId}/edit`);
      });
    });
  }

  _handleSelectAll(e) {
    const isChecked = e.target.checked;
    const { posts, selectedIds } = this.state;
    this.container.querySelectorAll(".select-row-cb").forEach((cb) => {
      cb.checked = isChecked;
    });
    if (isChecked) {
      posts.forEach((p) => selectedIds.add(p.id));
    } else {
      selectedIds.clear();
    }
    this._updateBulkToolbar();
  }

  _handleSelectRow(e) {
    const id = parseInt(e.target.dataset.id, 10);
    if (e.target.checked) {
      this.state.selectedIds.add(id);
    } else {
      this.state.selectedIds.delete(id);
    }
    this._updateBulkToolbar();
  }

  _updateBulkToolbar() {
    const n = this.state.selectedIds.size;
    const bulkCount = this.container.querySelector("#bulk-count");
    const applyBtn = this.container.querySelector("#bulk-apply-btn");
    const deleteBtn = this.container.querySelector("#bulk-delete-btn");
    const selectAllCb = this.container.querySelector("#select-all-cb");

    if (bulkCount) bulkCount.textContent = `${n} selected`;
    if (applyBtn) applyBtn.disabled = n === 0;
    if (deleteBtn) deleteBtn.disabled = n === 0;

    if (selectAllCb) {
      const totalVisible = this.state.posts.length;
      if (n === 0) {
        selectAllCb.checked = false;
        selectAllCb.indeterminate = false;
      } else if (n === totalVisible) {
        selectAllCb.checked = true;
        selectAllCb.indeterminate = false;
      } else {
        selectAllCb.checked = false;
        selectAllCb.indeterminate = true;
      }
    }
  }

  async _handleBulkApply() {
    const status = this.container.querySelector("#bulk-status-select").value;
    const ids = Array.from(this.state.selectedIds);
    let successCount = 0;
    let failCount = 0;

    for (const id of ids) {
      try {
        await setPostStatus(id, status);
        successCount++;
      } catch (err) {
        console.error(`Failed to update post ${id}:`, err);
        failCount++;
      }
    }

    let message = "";
    if (failCount === 0) {
      message = `All ${successCount} posts updated.`;
    } else {
      message = `${successCount} of ${ids.length} posts updated. ${failCount} failed.`;
    }
    store.set("toast", { message, type: failCount > 0 ? "error" : "success" });

    this.setState({ selectMode: false, selectedIds: new Set() });
    this._load();
  }

  _handleBulkDelete() {
    const n = this.state.selectedIds.size;
    this._showConfirm(
      "Move to Trash",
      `Move ${n} posts to Trash? You can restore them later.`,
      "Move to Trash",
      "danger",
      async () => {
        const ids = Array.from(this.state.selectedIds);
        let successCount = 0;
        let failCount = 0;

        for (const id of ids) {
          try {
            await deletePost(id);
            successCount++;
          } catch (err) {
            console.error(`Failed to move post ${id} to trash:`, err);
            failCount++;
          }
        }

        let message = "";
        if (failCount === 0) {
          message = `${successCount} posts moved to Trash.`;
        } else {
          message = `${successCount} of ${ids.length} posts moved to Trash. ${failCount} failed.`;
        }
        store.set("toast", {
          message,
          type: failCount > 0 ? "error" : "success",
        });

        this.setState({ selectMode: false, selectedIds: new Set() });
        this._load();
      },
    );
  }

  mount() {
    super.mount();
    this._perPage = this._calcPerPage();
    this._load();

    this._onResize = debounce(() => {
      const next = this._calcPerPage();
      if (next !== this._perPage) {
        this._perPage = next;
        this._load({ page: 1 });
      }
    }, 200);
    window.addEventListener("resize", this._onResize);
  }

  beforeUnmount() {
    this._cleanupAdminLayout?.();
    if (this._onResize) window.removeEventListener("resize", this._onResize);
  }

  /** Measure how many table rows fit in the available container height. */
  _calcPerPage() {
    const container = this.container.querySelector(".table-container");
    const thead = this.container.querySelector("thead");
    const probeRow = this.container.querySelector("tbody tr");
    if (!container || !thead || !probeRow) return 20;
    const bodyHeight = container.clientHeight - thead.offsetHeight;
    // Each post item now takes two <tr> rows.
    const rowHeight = (probeRow.offsetHeight || 44) * 2;
    return Math.max(5, Math.floor(bodyHeight / rowHeight));
  }

  /** Update the browser URL to reflect current filters without triggering a full navigation. */
  _syncUrl(overrides = {}) {
    const status = overrides.status ?? this.state.statusFilter;
    const search = overrides.search ?? this.state.search;
    const page = overrides.page ?? this.state.page;

    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (search) params.set("search", search);
    if (page > 1) params.set("page", String(page));

    const qs = params.toString();
    const url = "/light/posts" + (qs ? "?" + qs : "");
    history.replaceState(null, "", url);
  }

  async _load(overrides = {}) {
    // Check focus before any DOM mutation so we can restore it after re-render
    const searchEl = this.container.querySelector("#search-input");
    const searchHadFocus = searchEl && document.activeElement === searchEl;

    // Show loading indicator in-place — no full re-render, no focus loss.
    // The strings are fully static (no user data), so innerHTML is safe here.
    const tbody = this.container.querySelector("#posts-tbody");
    const colspan = this.state.selectMode ? 6 : 5;
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="${colspan}" class="loading">Loading…</td></tr>`; // static, safe
    }
    const cardList = this.container.querySelector("#posts-card-list");
    if (cardList) {
      cardList.innerHTML = `<p class="post-card-placeholder">Loading…</p>`; // static, safe
    }
    this.state.loading = true;
    this.state.error = null;

    const params = {
      page: overrides.page ?? this.state.page,
      per_page: this._perPage ?? 20,
    };
    const status = overrides.status ?? this.state.statusFilter;
    const search = overrides.search ?? this.state.search;
    if (status) params.status = status;
    if (search) params.q = search;

    // Sync URL whenever filters change
    this._syncUrl(overrides);

    try {
      const data = await listPosts(params);
      this._restoreSearchFocus = searchHadFocus;
      this.setState({
        loading: false,
        posts: (data.posts || data.items || []).map((p) => ({
          ...p,
          status: (p.status || "").toLowerCase(),
        })),
        pagination: {
          page: data.page,
          pages: data.pages,
          total: data.total,
          per_page: data.per_page,
        },
      });
    } catch (err) {
      this._restoreSearchFocus = searchHadFocus;
      console.error("[PostsListPage] load error:", err);
      store.set("toast", { message: "Could not load posts.", type: "error" });
      this.setState({ loading: false });
    }
  }

  /** Mount a TagsInput directly in the tags cell for a post row. Saves on change. */
  _mountTagEditor(post) {
    const mount = this.container.querySelector(`#tags-cell-${post.id}`);
    if (!mount) return;

    const initialTags = (post.tags || []).map((t) =>
      typeof t === "string" ? t : t.name,
    );

    this.mountChild(TagsInput, `#tags-cell-${post.id}`, {
      tags: initialTags,
      onChange: async (tags) => {
        try {
          const updated = await updatePostTags(post.id, tags);
          // Update local state silently so re-render preserves the new tags
          post.tags = updated.tags || tags.map((n) => ({ name: n, slug: n }));
          store.set("toast", { message: "Tags saved.", type: "success" });
        } catch (err) {
          store.set("toast", {
            message: err.message || "Failed to save tags.",
            type: "error",
          });
        }
      },
    });
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
      },
    });
    dialog.mount();
  }

  async _deletePost(id) {
    try {
      await deletePost(id);
      store.set("toast", { message: "Post moved to Trash.", type: "success" });
      this._load();
    } catch (err) {
      store.set("toast", {
        message: err.message || "Move to Trash failed.",
        type: "error",
      });
    }
  }

  async _restorePost(id, title) {
    try {
      await restorePost(id);
      store.set("toast", { message: `"${title}" restored.`, type: "success" });
      this._load();
    } catch (err) {
      store.set("toast", {
        message: err.message || "Restore failed.",
        type: "error",
      });
    }
  }

  async _permanentlyDeletePost(id) {
    try {
      await permanentlyDeletePost(id);
      store.set("toast", {
        message: "Post permanently deleted.",
        type: "success",
      });
      this._load();
    } catch (err) {
      store.set("toast", {
        message: err.message || "Delete failed.",
        type: "error",
      });
    }
  }

  async _updatePostStatus(id, status, select) {
    if (status === "scheduled") {
      navigate(`/light/posts/${id}/edit?openSchedule=1`);
      return;
    }
    const originalStatus =
      this.state.posts.find((p) => p.id === id)?.status || "draft";
    select.classList.add("badge-loading");
    try {
      const updated = await updatePost(id, { status });
      // Update local state silently to prevent full re-render
      const post = this.state.posts.find((p) => p.id === id);
      if (post) post.status = updated.status.toLowerCase();

      // Update UI
      select.className = `status-select badge-${updated.status.toLowerCase()} status-change-btn`;
      store.set("toast", { message: "Status updated.", type: "success" });
    } catch (err) {
      // Revert select value on failure
      select.value = originalStatus;
      store.set("toast", {
        message: err.message || "Update failed.",
        type: "error",
      });
    } finally {
      select.classList.remove("badge-loading");
    }
  }
}
