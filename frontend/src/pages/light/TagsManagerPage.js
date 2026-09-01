/**
 * TagsManagerPage — hierarchical tag management.
 *
 * Tree view: nav roots (by nav_order) → filed roots → Unfiled(N) group.
 * List view: tabular with search and parent filters.
 * Editor modal: Identity / Visibility / Display / Kind / Structure / Coordinates.
 * Markup is built with the html`` tag, which escapes every interpolation.
 */

import { Component } from '../../components/Component.js';
import { adminLayoutTemplate, setupAdminLayout } from '../../components/light/AdminLayout.js';
import { ConfirmDialog } from '../../components/shared/ConfirmDialog.js';
import { listTags, createTag, patchTag, setTagParents, setTagChildren, deleteTag, recalculateCounts, geocodeTag, moveTag } from '../../api/tags.js';
import { parseMapsCoords } from '../../api/util.js';
import { store } from '../../store.js';
import { html, setHTML, raw } from '../../utils/helpers.js';
import { X_SVG, REFRESH_SVG, LIST_SVG, TREE_SVG, PLUS_SVG, SELECT_SVG } from '../../utils/icons.js';
import { setupTextareaMaximizer } from '../../utils/textareaMaximizer.js';
import { buildTagTree, renderTagForest } from '../../components/light/tags/TagTreeView.js';
import { renderTagList, renderFilterChips, matchesListFilter } from '../../components/light/tags/TagListView.js';
import { getSiblingBefore } from '../../components/light/tags/tagOrdering.js';
import { renderTagEditorForm, slugifyTagName, tagEditorSelection } from '../../components/light/tags/TagEditorForm.js';
import { bindSwipeToReveal, bindDragAndDrop } from '../../components/light/tags/tagGestures.js';
import { setupTagToggleTrees } from '../../components/light/tags/tagToggleTree.js';
import { openMoveDialog, openMergeDialog, openDropOnConfirm } from '../../components/light/tags/tagFlows.js';
import { renderBulkToolbar, setupSelectMode } from '../../components/light/tags/tagSelection.js';
export default class TagsManagerPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      tags: [],
      error: null,
      expanded: new Set(),
      unfiledExpanded: false,
      sortField: 'sort_order',
      sortOrder: 'asc',
      selectMode: false,
      selectedIds: new Set(),
      view: store.get('tags_view') || 'tree'
    };
    this._modal = null;
    this._modalKeyHandler = null;
    this._listSearch = '';
    this._listFilterParents = [];
    // Track initial structure for change detection in modal
    this._initialParentIds = [];
    this._initialChildIds = [];
    this._swipeCleanup = null;
    this._select = null; // the tagSelection handle for the current render
  }
  render() {
    const {
      view,
      selectMode
    } = this.state;
    const actions = html`
      <div class="tm-view-toggle">
        <button id="view-tree-btn" class="btn btn-sm${view === 'tree' ? ' btn-primary' : ' btn-secondary'}" title="Tree view">${raw(TREE_SVG)}<span class="btn-label"> Tree</span></button>
        <button id="view-list-btn" class="btn btn-sm${view === 'list' ? ' btn-primary' : ' btn-secondary'}" title="List view">${raw(LIST_SVG)}<span class="btn-label"> List</span></button>
      </div>
      ${view === 'tree' && !selectMode ? html`
      <button id="expand-all-btn" class="btn btn-sm btn-secondary" title="Expand all">⇅<span class="btn-label"> Expand all</span></button>
      <button id="collapse-all-btn" class="btn btn-sm btn-secondary" title="Collapse all">‒<span class="btn-label"> Collapse all</span></button>` : ''}
      <button id="tm-select-btn" class="btn btn-sm btn-secondary" title="${selectMode ? 'Cancel selection' : 'Select tags'}">${raw(selectMode ? X_SVG : SELECT_SVG)}<span class="btn-label"> ${selectMode ? 'Cancel' : 'Select'}</span></button>
      <button id="add-root-tag-btn" class="btn btn-primary" title="New Tag">${raw(PLUS_SVG)}<span class="btn-label"> New Tag</span></button>
      <button id="recalc-counts-btn" class="btn btn-secondary" title="Recalculate post counts">${raw(REFRESH_SVG)}</button>
    `;
    return adminLayoutTemplate({
      title: 'Tags',
      actions,
      content: this._renderContent()
    });
  }
  _renderContent() {
    const {
      loading,
      error,
      tags,
      view
    } = this.state;
    let content;
    if (loading) {
      content = html`<div class="loading-spinner" aria-label="Loading tags…"></div>`;
    } else if (error) {
      content = html`<p class="error-state" role="alert">${error}</p>`;
    } else if (view === 'tree') {
      content = html`<div class="tags-tree-container">${renderTagForest(buildTagTree(tags), this._treeView())}</div>`;
    } else {
      content = renderTagList(tags, this._listView());
    }
    return html`
            ${this.state.selectMode && !loading && !error ? renderBulkToolbar() : ''}
            <div class="card tm-card">
              <div class="card-body">
                ${content}
              </div>
            </div>`;
  }

  // === List view ===

  /** View descriptor the TagListView renderers read instead of this.state. */
  _listView() {
    const {
      sortField,
      sortOrder,
      selectMode,
      selectedIds
    } = this.state;
    return {
      sortField,
      sortOrder,
      selectMode,
      selectedIds,
      search: this._listSearch,
      filterParents: this._listFilterParents
    };
  }
  _applyListFilter() {
    const byId = new Map(this.state.tags.map(t => [t.id, t]));
    this.container.querySelectorAll('.tm-tag-row').forEach(row => {
      const tag = byId.get(parseInt(row.dataset.id, 10));
      row.classList.toggle('hidden', !tag || !matchesListFilter(tag, this._listView()));
    });
  }
  _updateFilterChips() {
    const chips = this.container.querySelector('#tm-filter-chips');
    if (!chips) return;
    setHTML(chips, html`${renderFilterChips(this._listFilterParents)}`);
    chips.querySelectorAll('.tm-filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const id = parseInt(chip.dataset.removeId, 10);
        this._listFilterParents = this._listFilterParents.filter(p => p.id !== id);
        this._updateFilterChips();
        this._applyListFilter();
        this._syncClearBtn();
      });
    });
  }
  _syncClearBtn() {
    const btn = this.container.querySelector('.tm-clear-filters');
    const hasFilters = this._listSearch || '' || this._listFilterParents.length > 0;
    if (btn) {
      btn.classList.toggle('hidden', !hasFilters);
    } else if (hasFilters) {
      const listWrap = this.container.querySelector('.tm-list-filter-bar');
      if (listWrap) {
        const searchRow = listWrap.querySelector('.tm-list-search-row');
        if (searchRow && !searchRow.querySelector('.tm-clear-filters')) {
          const clearBtn = document.createElement('button');
          clearBtn.type = 'button';
          clearBtn.className = 'btn btn-sm btn-secondary tm-clear-filters';
          clearBtn.textContent = 'Clear';
          searchRow.appendChild(clearBtn);
          clearBtn.addEventListener('click', () => this._clearListFilters());
        }
      }
    }
  }
  _clearListFilters() {
    this._listSearch = '';
    this._listFilterParents = [];
    const searchInput = this.container.querySelector('.tm-list-search');
    if (searchInput) searchInput.value = '';
    this._updateFilterChips();
    this._applyListFilter();
    const btn = this.container.querySelector('.tm-clear-filters');
    if (btn) btn.classList.add('hidden');
  }

  // ── Tree view ────────────────────────────────────────────────────────────────

  /** View descriptor the TagTreeView renderers read instead of this.state. */
  _treeView() {
    const {
      expanded,
      unfiledExpanded,
      selectMode,
      selectedIds
    } = this.state;
    return {
      expanded,
      unfiledExpanded,
      selectMode,
      selectedIds
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────────

  mount() {
    super.mount();
    this._load();
  }
  afterRender() {
    const tagSlug = this.props?.params?.slug;
    setupAdminLayout(this, {
      currentPath: '/light/tags',
      publicUrl: tagSlug ? `/tags/${tagSlug}` : '/'
    });
    setupTextareaMaximizer(this.container);
    if (this.state.loading || this.state.error) return;
    this.container.querySelector('#view-tree-btn')?.addEventListener('click', () => this.setState({
      view: 'tree'
    }));
    this.container.querySelector('#view-list-btn')?.addEventListener('click', () => this.setState({
      view: 'list'
    }));
    this.container.querySelector('#add-root-tag-btn')?.addEventListener('click', () => this._openModal());
    this.container.querySelector('#recalc-counts-btn')?.addEventListener('click', () => this._handleRecalc());
    this._bindSelectMode();
    if (this.state.view === 'tree') {
      this.container.querySelector('#expand-all-btn')?.addEventListener('click', () => this._expandAll());
      this.container.querySelector('#collapse-all-btn')?.addEventListener('click', () => this._collapseAll());
      this.container.querySelectorAll('.tm-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = parseInt(btn.dataset.id, 10);
          const expanded = new Set(this.state.expanded);
          if (expanded.has(id)) expanded.delete(id);else expanded.add(id);
          this.setState({
            expanded
          });
        });
      });
      this.container.querySelector('#unfiled-toggle-btn')?.addEventListener('click', () => {
        this.setState({
          unfiledExpanded: !this.state.unfiledExpanded
        });
      });
      this.container.querySelectorAll('.add-child-btn').forEach(btn => {
        btn.addEventListener('click', () => this._openModal(null, parseInt(btn.dataset.id, 10)));
      });
      this.container.querySelectorAll('.move-tag-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          openMoveDialog({
            tags: this.state.tags,
            tagId: parseInt(btn.dataset.id, 10),
            contextParentId: btn.dataset.parentId !== '' ? parseInt(btn.dataset.parentId, 10) : null,
            onDone: () => this._afterFlow()
          });
        });
      });
      this.container.querySelectorAll('.merge-tag-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          openMergeDialog({
            tags: this.state.tags,
            loserId: parseInt(btn.dataset.id, 10),
            onDone: () => this._afterFlow()
          });
        });
      });

      // Open ancestor via inherited-hidden badge
      this.container.querySelectorAll('.tm-badge-via-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const tagId = parseInt(btn.dataset.openTagId, 10);
          const tag = this.state.tags.find(t => t.id === tagId);
          if (tag) this._openModal(tag);
        });
      });
      this._bindDragAndDrop();
    }
    this.container.querySelectorAll('.edit-tag-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.id, 10);
        this._openModal(this.state.tags.find(t => t.id === id));
      });
    });
    this.container.querySelectorAll('.delete-tag-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.id, 10);
        const tag = this.state.tags.find(t => t.id === id);
        this._showConfirm('Delete tag', `Delete tag "${tag?.name}"? Posts will NOT be deleted.`, 'Delete', 'danger', () => {
          this._handleDelete(id);
        });
      });
    });
    if (this.state.view === 'list') {
      this.container.querySelectorAll('.tm-sortable-header').forEach(th => {
        th.addEventListener('click', () => this._handleSort(th.dataset.field));
      });
      const searchInput = this.container.querySelector('.tm-list-search');
      if (searchInput) {
        searchInput.focus();
        const len = searchInput.value.length;
        searchInput.setSelectionRange(len, len);
        searchInput.addEventListener('input', e => {
          this._listSearch = e.target.value;
          this._applyListFilter();
          this._syncClearBtn();
        });
      }
      this.container.querySelectorAll('.tm-parent-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = parseInt(btn.dataset.parentId, 10);
          const name = btn.dataset.parentName;
          if (!this._listFilterParents.find(p => p.id === id)) {
            this._listFilterParents.push({
              id,
              name
            });
            this._updateFilterChips();
            this._applyListFilter();
            this._syncClearBtn();
          }
        });
      });
      this.container.querySelector('.tm-clear-filters')?.addEventListener('click', () => this._clearListFilters());
      this._updateFilterChips();
      this._applyListFilter();
    }
    this._bindSwipeToReveal();
  }
  beforeUnmount() {
    this._closeModal();
    this._swipeCleanup?.();
    this._swipeCleanup = null;
  }
  _expandAll() {
    const expanded = new Set();
    const collect = nodes => nodes.forEach(n => {
      if (n.childrenNodes.length > 0) {
        expanded.add(n.id);
        collect(n.childrenNodes);
      }
    });
    const {
      navRoots,
      otherRoots
    } = buildTagTree(this.state.tags);
    collect(navRoots);
    collect(otherRoots);
    this.setState({
      expanded
    });
  }
  _collapseAll() {
    this.setState({
      expanded: new Set()
    });
  }
  _handleSort(field) {
    const {
      sortField,
      sortOrder
    } = this.state;
    if (sortField === field) {
      this.setState({
        sortOrder: sortOrder === 'asc' ? 'desc' : 'asc'
      });
    } else {
      this.setState({
        sortField: field,
        sortOrder: 'asc'
      });
    }
  }

  // ── Select mode ───────────────────────────────────────────────────────────────

  /**
   * Hand select mode to tagSelection, keeping the handle: the swipe binder
   * below reaches back into it, and it is the only thing that may touch the
   * selection between renders.
   */
  _bindSelectMode() {
    this._select = setupSelectMode(this.container, {
      state: () => ({
        selectMode: this.state.selectMode,
        selectedIds: this.state.selectedIds,
        tags: this.state.tags,
        view: this.state.view,
        listView: this._listView()
      }),
      onModeChange: (selectMode, selectedIds) => this.setState({
        selectMode,
        selectedIds
      }),
      onBulkDone: () => this._afterBulk(),
      confirm: (...args) => this._showConfirm(...args)
    });
  }

  /**
   * What every flow does once its mutation lands: the list and the nav both
   * show hierarchy, and every one of these changes it.
   */
  _afterFlow() {
    this._load();
    this._refreshNavTags();
  }

  /** As above, and leave select mode — the selection it acted on is spent. */
  _afterBulk() {
    this.setState({
      selectMode: false,
      selectedIds: new Set()
    });
    this._load();
    this._refreshNavTags();
  }

  // ── Swipe-to-reveal actions (portrait mobile) ─────────────────────────────────

  /**
   * On narrow portrait viewports, hide .tm-actions off-screen and let users
   * swipe a row left to reveal them — the same drawer the post cards use in
   * /light/posts.  Applies to tree rows and list-view table rows alike.
   * Touch handling:
   *  • touchstart records origin
   *  • touchmove translates the row if the gesture is predominantly horizontal-left
   *  • touchend snaps open (if past threshold) or snaps shut
   *  • tapping anywhere else closes the currently-open row
   */
  _bindSwipeToReveal() {
    this._swipeCleanup?.(); // tear down listeners from the previous render
    this._swipeCleanup = null;
    this._swipeCleanup = bindSwipeToReveal(this.container, {
      onSelect: row => this._select?.selectBySwipe(row)
    });
  }

  // ── Drag and Drop ─────────────────────────────────────────────────────────────

  _bindDragAndDrop() {
    bindDragAndDrop(this.container, {
      siblingBefore: (targetId, parentId) => getSiblingBefore(this.state.tags, targetId, parentId),
      onReparent: (dragId, targetId) => openDropOnConfirm({
        tags: this.state.tags,
        dragId,
        targetId,
        onDone: () => this._afterFlow()
      }),
      onInvalidReorder: () => store.set('toast', {
        message: 'Drop ON a tag to reparent. Reordering only works within the same parent.',
        type: 'error'
      }),
      onReorder: async (dragId, parentId, afterId) => {
        try {
          await moveTag(dragId, {
            parent_id: parentId,
            after_id: afterId
          });
          this._load();
        } catch (err) {
          store.set('toast', {
            message: err.message || 'Reorder failed.',
            type: 'error'
          });
        }
      }
    });
  }

  // ── Modal ────────────────────────────────────────────────────────────────────

  _openModal(tag = null, parentId = null, {
    fromUrl = false
  } = {}) {
    this._closeModal();
    const isEdit = !!tag;
    const f = tag || {};
    const {
      selParents,
      selChildren
    } = tagEditorSelection(tag, parentId);

    // Track initial structure to detect changes on save
    this._initialParentIds = [...selParents];
    this._initialChildIds = [...selChildren];
    const modal = document.createElement('div');
    modal.className = 'modal-overlay active';
    const _html = renderTagEditorForm({
      tag,
      parentId,
      allTags: this.state.tags
    });
    modal['inner' + 'HTML'] = _html;
    document.body.appendChild(modal);
    this._modal = modal;
    setupTagToggleTrees(modal);

    // Reflect the open tag in the browser URL
    const urlSlug = isEdit ? f.slug : 'new';
    const targetPath = `/light/tags/${urlSlug}`;
    if (!fromUrl && location.pathname !== targetPath) {
      history.pushState(null, '', targetPath);
    }

    // Auto-slug from name
    const nameInput = modal.querySelector('[name="name"]');
    const slugInput = modal.querySelector('#modal-slug');
    if (isEdit) slugInput.dataset.manual = '1';
    nameInput.addEventListener('input', () => {
      if (!slugInput.dataset.manual) slugInput.value = slugifyTagName(nameInput.value);
    });
    slugInput.addEventListener('input', () => {
      slugInput.dataset.manual = '1';
    });

    // Toggle nav order field visibility
    const inNavCheck = modal.querySelector('#in-nav-check');
    const navOrderRow = modal.querySelector('#nav-order-row');
    inNavCheck?.addEventListener('change', () => {
      navOrderRow.classList.toggle('hidden', !inNavCheck.checked);
    });

    // Collapsible sections
    modal.querySelectorAll('.tm-section-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.target;
        const body = modal.querySelector(`#${targetId}`);
        const arrow = btn.querySelector('.tm-section-arrow');
        const isOpen = !body.classList.contains('hidden');
        body.classList.toggle('hidden', isOpen);
        arrow.textContent = isOpen ? '▶' : '▼';
      });
    });

    // Parse / Geocode
    modal.querySelector('#gmaps-parse-btn')?.addEventListener('click', async () => {
      const coordInput = modal.querySelector('#coordinates-input');
      const latInput = modal.querySelector('#coord-lat');
      const lngInput = modal.querySelector('#coord-lng');
      const parseBtn = modal.querySelector('#gmaps-parse-btn');
      const raw = coordInput.value.trim();
      const setLocked = locked => {
        coordInput.disabled = locked;
        latInput.disabled = locked;
        lngInput.disabled = locked;
        parseBtn.disabled = locked;
        parseBtn.textContent = locked ? '…' : isEdit ? 'Parse / Geocode' : 'Parse';
      };
      setLocked(true);
      try {
        if (raw) {
          const coords = await parseMapsCoords(raw);
          latInput.value = coords.lat;
          lngInput.value = coords.lng;
          coordInput.value = '';
        } else if (isEdit) {
          const result = await geocodeTag(f.id);
          latInput.value = result.latitude;
          lngInput.value = result.longitude;
          store.set('toast', {
            message: 'Coordinates fetched from Nominatim.',
            type: 'success'
          });
        }
      } catch (err) {
        store.set('toast', {
          message: err.message || 'Failed to get coordinates.',
          type: 'error'
        });
      } finally {
        setLocked(false);
      }
    });
    modal.querySelector('.modal-close').addEventListener('click', () => this._closeModal());
    modal.querySelector('#modal-cancel-btn').addEventListener('click', () => this._closeModal());
    modal.addEventListener('click', e => {
      if (e.target === modal) this._closeModal();
    });
    modal.querySelector('#tag-editor-form').addEventListener('submit', async e => {
      e.preventDefault();
      await this._handleSave(e.target, isEdit ? f.id : null);
    });
    modal.addEventListener('textarea:save', async () => {
      const form = modal.querySelector('#tag-editor-form');
      if (form) await this._handleSave(form, isEdit ? f.id : null, {
        closeAfter: false
      });
    });
    modal.addEventListener('keydown', async e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        const form = modal.querySelector('#tag-editor-form');
        if (form) {
          const isMaximized = !!modal.querySelector('.is-maximized');
          await this._handleSave(form, isEdit ? f.id : null, {
            closeAfter: !isMaximized
          });
        }
      }
    });
    this._modalKeyHandler = e => {
      if (e.key === 'Escape') this._closeModal();
    };
    document.addEventListener('keydown', this._modalKeyHandler);
    nameInput.focus();
    setupTextareaMaximizer(modal);
  }
  _closeModal() {
    const wasOpen = !!this._modal;
    if (this._modal) {
      this._modal.remove();
      this._modal = null;
    }
    if (this._modalKeyHandler) {
      document.removeEventListener('keydown', this._modalKeyHandler);
      this._modalKeyHandler = null;
    }
    if (wasOpen && location.pathname.startsWith('/light/tags/')) {
      history.replaceState(null, '', '/light/tags');
    }
  }

  // ── Data operations ──────────────────────────────────────────────────────────

  async _load() {
    this.setState({
      loading: true,
      error: null
    });
    try {
      const data = await listTags({
        include_empty: true
      });
      this.setState({
        loading: false,
        tags: data.tags || []
      });

      // Auto-open editor when navigated directly to /light/tags/:slug
      const slug = this.props?.params?.slug;
      if (slug) {
        const tags = data.tags || [];
        const tag = slug === 'new' ? null : tags.find(t => t.slug === slug);
        if (slug === 'new' || tag) {
          this._openModal(tag, null, {
            fromUrl: true
          });
        }
      }
    } catch (err) {
      console.error('[TagsManagerPage] load error:', err);
      store.set('toast', {
        message: 'Could not load tags.',
        type: 'error'
      });
      this.setState({
        loading: false,
        tags: [],
        error: err.message || 'Could not load tags.'
      });
    }
  }
  async _handleSave(form, tagId, {
    closeAfter = true
  } = {}) {
    const fd = new FormData(form);
    const name = (fd.get('name') || '').trim();
    const slug = (fd.get('slug') || '').trim();
    const description = (fd.get('description') || '').trim();
    const kind = fd.get('kind') || 'topic';
    const hidden = fd.has('hidden');
    const hides_posts = fd.has('hides_posts');
    const in_breadcrumbs = fd.has('in_breadcrumbs');
    const show_related = fd.has('show_related');
    const in_ancestor_flyout = fd.has('in_ancestor_flyout');
    const inNav = fd.has('in_nav');
    const navOrderRaw = fd.get('nav_order');
    // ponytail: checkbox on with empty position must still enable nav — default to 0.
    const nav_order = inNav ? navOrderRaw !== '' ? parseInt(navOrderRaw, 10) : 0 : null;
    const lat = parseFloat(fd.get('latitude') || '');
    const lon = parseFloat(fd.get('longitude') || '');
    const latitude = !isNaN(lat) ? lat : null;
    const longitude = !isNaN(lon) ? lon : null;
    const newParentIds = fd.getAll('parent_ids').map(v => parseInt(v, 10));
    const newChildIds = fd.getAll('child_ids').map(v => parseInt(v, 10));
    const submitBtn = form.querySelector('[type="submit"]');
    const origText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';
    try {
      if (tagId) {
        // PATCH for all non-structural fields
        await patchTag(tagId, {
          name,
          slug,
          description,
          kind,
          hidden,
          hides_posts,
          nav_order,
          in_breadcrumbs,
          show_related,
          in_ancestor_flyout,
          latitude,
          longitude
        });

        // Structure calls only when changed
        if (!_arraysEqual(newParentIds, this._initialParentIds)) {
          await setTagParents(tagId, newParentIds);
        }
        if (!_arraysEqual(newChildIds, this._initialChildIds)) {
          await setTagChildren(tagId, newChildIds);
        }
        store.set('toast', {
          message: 'Tag updated.',
          type: 'success'
        });
      } else {
        await createTag({
          name,
          slug,
          description,
          kind,
          hidden,
          hides_posts,
          nav_order,
          in_breadcrumbs,
          show_related,
          in_ancestor_flyout,
          latitude,
          longitude,
          parent_ids: newParentIds,
          child_ids: newChildIds
        });
        store.set('toast', {
          message: 'Tag created.',
          type: 'success'
        });
      }
      if (closeAfter) this._closeModal();
      this._load();
      this._refreshNavTags();
    } catch (err) {
      store.set('toast', {
        message: err.message || 'Save failed.',
        type: 'error'
      });
      submitBtn.disabled = false;
      submitBtn.textContent = origText;
    }
  }
  _showConfirm(title, message, confirmText, variant, onConfirm) {
    const mount = document.createElement('div');
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
  async _handleDelete(id) {
    try {
      await deleteTag(id);
      store.set('toast', {
        message: 'Tag deleted.',
        type: 'success'
      });
      this._load();
      this._refreshNavTags();
    } catch (err) {
      store.set('toast', {
        message: err.message || 'Delete failed.',
        type: 'error'
      });
    }
  }
  async _handleRecalc() {
    try {
      await recalculateCounts();
      store.set('toast', {
        message: 'Counts recalculated.',
        type: 'success'
      });
      this._load();
    } catch (err) {
      store.set('toast', {
        message: err.message || 'Recalculation failed.',
        type: 'error'
      });
    }
  }
  async _refreshNavTags() {
    document.dispatchEvent(new CustomEvent('nav-changed'));
  }
}
function _arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  return sa.every((v, i) => v === sb[i]);
}