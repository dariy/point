/**
 * TagsManagerPage — hierarchical tag management.
 *
 * Tree view: nav roots (by nav_order) → filed roots → Unfiled(N) group.
 * List view: tabular with search and parent filters.
 * Editor modal: Identity / Visibility / Display / Kind / Structure / Coordinates.
 * All user-supplied strings are escaped with escapeHtml() before interpolation.
 */

import { Component } from '../../components/Component.js';
import { adminLayoutTemplate, setupAdminLayout } from '../../components/light/AdminLayout.js';
import { ConfirmDialog } from '../../components/shared/ConfirmDialog.js';
import { listTags, createTag, patchTag, setTagParents, setTagChildren, deleteTag, recalculateCounts, geocodeTag, moveTag, mergeTags } from '../../api/tags.js';
import { parseMapsCoords } from '../../api/util.js';

import { store } from '../../store.js';
import { escapeHtml } from '../../utils/helpers.js';
import { X_SVG, REFRESH_SVG, LIST_SVG, TREE_SVG, PLUS_SVG, SELECT_SVG, CHECK_SVG, TRASH_SVG } from '../../utils/icons.js';
import { setupTextareaMaximizer } from '../../utils/textareaMaximizer.js';
import { buildTagTree, renderTagForest, renderTagTree, renderTagNode, renderSelectCheckbox, renderRowBadges, renderUnfiledGroup } from '../../components/light/tags/TagTreeView.js';
import { renderTagList, matchesListFilter, renderSortHeader } from '../../components/light/tags/TagListView.js';
import { getChildrenOf, getSiblingBefore } from '../../components/light/tags/tagOrdering.js';
import { openTagPickerDialog, openOverlay } from '../../components/light/tags/TagPickerDialog.js';
import { renderTagEditorForm, slugifyTagName, tagEditorSelection } from '../../components/light/tags/TagEditorForm.js';

export default class TagsManagerPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      tags: [],
      error: null,
      view: 'tree',
      expanded: new Set(),
      unfiledExpanded: false,
      sortField: 'sort_order',
      sortOrder: 'asc',
      selectMode: false,
      selectedIds: new Set(),
    };
    this._modal = null;
    this._modalKeyHandler = null;
    this._didPushUrl = false;
    this._dragState = null;
    this._listSearch = '';
    this._listFilterParents = [];
    // Track initial structure for change detection in modal
    this._initialParentIds = [];
    this._initialChildIds = [];
    this._swipeCleanup = null;
  }

  render() {
    const { view, selectMode } = this.state;

    const actions = `
      <div class="tm-view-toggle">
        <button id="view-tree-btn" class="btn btn-sm${view === 'tree' ? ' btn-primary' : ' btn-secondary'}" title="Tree view">${TREE_SVG}<span class="btn-label"> Tree</span></button>
        <button id="view-list-btn" class="btn btn-sm${view === 'list' ? ' btn-primary' : ' btn-secondary'}" title="List view">${LIST_SVG}<span class="btn-label"> List</span></button>
      </div>
      ${view === 'tree' && !selectMode ? `
      <button id="expand-all-btn" class="btn btn-sm btn-secondary" title="Expand all">⇅<span class="btn-label"> Expand all</span></button>
      <button id="collapse-all-btn" class="btn btn-sm btn-secondary" title="Collapse all">‒<span class="btn-label"> Collapse all</span></button>` : ''}
      <button id="tm-select-btn" class="btn btn-sm btn-secondary" title="${selectMode ? 'Cancel selection' : 'Select tags'}">${selectMode ? X_SVG : SELECT_SVG}<span class="btn-label"> ${selectMode ? 'Cancel' : 'Select'}</span></button>
      <button id="add-root-tag-btn" class="btn btn-primary" title="New Tag">${PLUS_SVG}<span class="btn-label"> New Tag</span></button>
      <button id="recalc-counts-btn" class="btn btn-secondary" title="Recalculate post counts">${REFRESH_SVG}</button>
    `;

    return adminLayoutTemplate({
      title: 'Tags',
      actions,
      content: this._renderContent()
    });
  }

  _renderContent() {
    const { loading, error, tags, view } = this.state;

    let content;
    if (loading) {
      content = `<div class="loading-spinner" aria-label="Loading tags…"></div>`;
    } else if (error) {
      content = `<p class="error-state" role="alert">${escapeHtml(error)}</p>`;
    } else if (view === 'tree') {
      content = `<div class="tags-tree-container">${this._renderForest(this._buildTree(tags))}</div>`;
    } else {
      content = this._renderList(tags);
    }

    return `
            ${this._renderBulkToolbar()}
            <div class="card tm-card">
              <div class="card-body">
                ${content}
              </div>
            </div>`;
  }

  // ── Bulk selection ───────────────────────────────────────────────────────────

  /**
   * Toolbar shown while select mode is on. Unlike the posts list this sits in
   * the flow rather than overlaying a filter block — the tags tree has none.
   */
  _renderBulkToolbar() {
    if (!this.state.selectMode || this.state.loading || this.state.error) return '';
    return `
      <div class="tm-bulk-toolbar" id="tm-bulk-toolbar">
        <label class="select-all-label"><input type="checkbox" id="tm-select-all-cb"> Select all</label>
        <div class="tm-bulk-actions">
          <span id="tm-bulk-count">0 selected</span>
          <select id="tm-bulk-visibility-select" aria-label="Visibility to apply">
            <option value="hidden">Hidden</option>
            <option value="visible">Visible</option>
          </select>
          <button id="tm-bulk-apply-btn" class="btn btn-sm" disabled title="Apply visibility">${CHECK_SVG}<span class="btn-label"> Apply</span></button>
          <button id="tm-bulk-move-btn" class="btn btn-sm" disabled title="Move under a parent…">Move…</button>
          <button id="tm-bulk-delete-btn" class="btn btn-sm btn-danger" disabled title="Delete tags">${TRASH_SVG}<span class="btn-label"> Delete</span></button>
          <!-- Deliberately not a .btn-label: this is the way out of select
               mode, so its text has to survive the icon-only collapse. -->
          <button id="tm-bulk-done-btn" class="btn btn-sm btn-secondary" title="Leave selection mode">Done</button>
        </div>
      </div>`;
  }

  /** Tags "Select all" applies to — the list view honours its own filters. */
  _selectableTags() {
    if (this.state.view === 'list') {
      return this.state.tags.filter(t => this._matchesListFilter(t));
    }
    return this.state.tags;
  }

  // === List view ===

  /** View descriptor the TagListView renderers read instead of this.state. */
  _listView() {
    const { sortField, sortOrder, selectMode, selectedIds } = this.state;
    return {
      sortField, sortOrder, selectMode, selectedIds,
      search: this._listSearch,
      filterParents: this._listFilterParents,
    };
  }

  _renderList(tags) { return renderTagList(tags, this._listView()); }

  _matchesListFilter(tag) { return matchesListFilter(tag, this._listView()); }

  _applyListFilter() {
    const byId = new Map(this.state.tags.map(t => [t.id, t]));
    this.container.querySelectorAll('.tm-tag-row').forEach(row => {
      const tag = byId.get(parseInt(row.dataset.id, 10));
      row.classList.toggle('hidden', !tag || !this._matchesListFilter(tag));
    });
  }

  _updateFilterChips() {
    const chips = this.container.querySelector('#tm-filter-chips');
    if (!chips) return;
    chips.innerHTML = this._listFilterParents.map(p =>
      `<button type="button" class="tm-filter-chip" data-remove-id="${p.id}">${escapeHtml(p.name)} <span class="tm-chip-remove">×</span></button>`
    ).join('');
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
    const hasFilters = (this._listSearch || '') || this._listFilterParents.length > 0;
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

  _renderSortHeader(field, label, className = '', title = '') {
    return renderSortHeader(field, label, className, title, this._listView());
  }

  // ── Tree view ────────────────────────────────────────────────────────────────
  // Rendering lives in components/light/tags/TagTreeView.js as pure functions.
  // These delegators keep the page's call sites (and its tests) unchanged.

  /** View descriptor the TagTreeView renderers read instead of this.state. */
  _treeView() {
    const { expanded, unfiledExpanded, selectMode, selectedIds } = this.state;
    return { expanded, unfiledExpanded, selectMode, selectedIds };
  }

  _buildTree(tags) { return buildTagTree(tags); }

  _renderForest(forest) { return renderTagForest(forest, this._treeView()); }

  _renderTree(nodes, level = 0, parentId = null) {
    return renderTagTree(nodes, level, parentId, this._treeView());
  }

  _renderNode(node, level, parentId) {
    return renderTagNode(node, level, parentId, this._treeView());
  }

  _renderSelectCheckbox(tag, selectMode, isSelected) {
    return renderSelectCheckbox(tag, selectMode, isSelected);
  }

  _renderRowBadges(node) { return renderRowBadges(node); }

  _renderUnfiledGroup(unfiledTags) { return renderUnfiledGroup(unfiledTags, this._treeView()); }


  // ── Lifecycle ──────────────────────────────────────────────────────────────────

  mount() { super.mount(); this._load(); }

  afterRender() {
    const tagSlug = this.props?.params?.slug;
    this._cleanupAdminLayout = setupAdminLayout(this, {
      currentPath: '/light/tags',
      publicUrl: tagSlug ? `/tags/${tagSlug}` : '/',
    });

    setupTextareaMaximizer(this.container);

    if (this.state.loading || this.state.error) return;

    this.container.querySelector('#view-tree-btn')?.addEventListener('click', () => this.setState({ view: 'tree' }));
    this.container.querySelector('#view-list-btn')?.addEventListener('click', () => this.setState({ view: 'list' }));
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
          if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
          this.setState({ expanded });
        });
      });

      this.container.querySelector('#unfiled-toggle-btn')?.addEventListener('click', () => {
        this.setState({ unfiledExpanded: !this.state.unfiledExpanded });
      });

      this.container.querySelectorAll('.add-child-btn').forEach(btn => {
        btn.addEventListener('click', () => this._openModal(null, parseInt(btn.dataset.id, 10)));
      });

      this.container.querySelectorAll('.move-tag-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = parseInt(btn.dataset.id, 10);
          const parentId = btn.dataset.parentId !== '' ? parseInt(btn.dataset.parentId, 10) : null;
          this._openMoveDialog(id, parentId);
        });
      });

      this.container.querySelectorAll('.merge-tag-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          this._openMergeDialog(parseInt(btn.dataset.id, 10));
        });
      });

      // Open ancestor via inherited-hidden badge
      this.container.querySelectorAll('.tm-badge-via-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
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
        searchInput.addEventListener('input', (e) => {
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
            this._listFilterParents.push({ id, name });
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
    this._cleanupAdminLayout?.();
    this._closeModal();
    this._swipeCleanup?.();
    this._swipeCleanup = null;
  }

  _expandAll() {
    const expanded = new Set();
    const collect = (nodes) => nodes.forEach(n => {
      if (n.childrenNodes.length > 0) {
        expanded.add(n.id);
        collect(n.childrenNodes);
      }
    });
    const { navRoots, otherRoots } = this._buildTree(this.state.tags);
    collect(navRoots);
    collect(otherRoots);
    this.setState({ expanded });
  }

  _collapseAll() {
    this.setState({ expanded: new Set() });
  }

  _handleSort(field) {
    const { sortField, sortOrder } = this.state;
    if (sortField === field) {
      this.setState({ sortOrder: sortOrder === 'asc' ? 'desc' : 'asc' });
    } else {
      this.setState({ sortField: field, sortOrder: 'asc' });
    }
  }

  // ── Select mode ───────────────────────────────────────────────────────────────

  _bindSelectMode() {
    this.container.querySelector('#tm-select-btn')?.addEventListener('click', () => {
      this.setState({ selectMode: !this.state.selectMode, selectedIds: new Set() });
    });

    this._bindRowSelectGestures();

    if (!this.state.selectMode) return;

    this.container.querySelectorAll('.tm-select-cb').forEach(cb => {
      cb.addEventListener('change', e => {
        e.stopPropagation();
        this._setSelected(parseInt(cb.dataset.id, 10), cb.checked);
      });
    });

    this.container.querySelector('#tm-select-all-cb')?.addEventListener('change', e => {
      const selectedIds = new Set();
      if (e.target.checked) this._selectableTags().forEach(t => selectedIds.add(t.id));
      this.setState({ selectedIds });
    });

    this.container.querySelector('#tm-bulk-apply-btn')
      ?.addEventListener('click', () => this._handleBulkVisibility());
    this.container.querySelector('#tm-bulk-move-btn')
      ?.addEventListener('click', () => this._openBulkMoveDialog());
    this.container.querySelector('#tm-bulk-delete-btn')
      ?.addEventListener('click', () => this._handleBulkDelete());
    this.container.querySelector('#tm-bulk-done-btn')
      ?.addEventListener('click', () => this.setState({ selectMode: false, selectedIds: new Set() }));

    this._updateBulkToolbar();
  }

  /**
   * Touch shortcuts into select mode, mirroring the post cards: long-press a
   * row to start selecting, then tap rows to add and remove them. Bound only
   * where the touch layout is active, since a row is not a tap target on
   * desktop — there the header's Select button is the way in.
   */
  _bindRowSelectGestures() {
    if (!window.matchMedia?.('(max-width: 48em)').matches) return;

    const LONG_PRESS_MS = 500;
    // Controls that act on their own; a press on one is never a row press.
    const interactive = 'input, button, a, select, label';

    this.container.querySelectorAll('.tm-row, .tm-tag-row').forEach(row => {
      const id = parseInt(row.dataset.id, 10);
      if (!Number.isInteger(id)) return;

      let timer = null;
      const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };

      row.addEventListener('pointerdown', e => {
        if (e.target.closest(interactive)) return;
        if (this.state.selectMode) return;
        timer = setTimeout(() => {
          timer = null;
          this.setState({ selectMode: true, selectedIds: new Set([id]) });
        }, LONG_PRESS_MS);
      });
      row.addEventListener('pointerup', cancel);
      row.addEventListener('pointermove', cancel);
      row.addEventListener('pointercancel', cancel);

      row.addEventListener('click', e => {
        if (!this.state.selectMode) return;
        if (e.target.closest(interactive)) return;
        this._toggleSelected(id);
      });
    });
  }

  /** Swipe-right on a row: start selecting, or add/remove it if already on. */
  _selectBySwipe(row) {
    const id = parseInt(row.dataset.id, 10);
    if (!Number.isInteger(id)) return;
    if (!this.state.selectMode) {
      this.setState({ selectMode: true, selectedIds: new Set([id]) });
      return;
    }
    this._toggleSelected(id);
  }

  /**
   * Select or deselect a tag without re-rendering — a re-render would steal
   * focus back to the list-view search box. A tag can appear under several
   * parents in the tree, so every instance of its row is updated.
   */
  _setSelected(id, on) {
    const selectedIds = this.state.selectedIds;
    if (on) selectedIds.add(id); else selectedIds.delete(id);

    this.container.querySelectorAll(`.tm-select-cb[data-id="${id}"]`).forEach(cb => {
      cb.checked = on;
    });
    this.container.querySelectorAll(`.tm-row[data-id="${id}"], .tm-tag-row[data-id="${id}"]`)
      .forEach(row => row.classList.toggle('is-selected', on));

    this._updateBulkToolbar();
  }

  _toggleSelected(id) {
    this._setSelected(id, !this.state.selectedIds.has(id));
  }

  _updateBulkToolbar() {
    const n = this.state.selectedIds.size;
    const count = this.container.querySelector('#tm-bulk-count');
    if (count) count.textContent = `${n} selected`;

    ['#tm-bulk-apply-btn', '#tm-bulk-move-btn', '#tm-bulk-delete-btn'].forEach(sel => {
      const btn = this.container.querySelector(sel);
      if (btn) btn.disabled = n === 0;
    });

    const selectAll = this.container.querySelector('#tm-select-all-cb');
    if (selectAll) {
      const total = this._selectableTags().length;
      selectAll.checked = n > 0 && n === total;
      selectAll.indeterminate = n > 0 && n < total;
    }
  }

  async _handleBulkVisibility() {
    const hidden = this.container.querySelector('#tm-bulk-visibility-select').value === 'hidden';
    const ids = Array.from(this.state.selectedIds);
    await this._runBulk(
      ids,
      id => patchTag(id, { hidden }),
      n => `${n} tag${n === 1 ? '' : 's'} marked ${hidden ? 'hidden' : 'visible'}.`,
    );
  }

  _handleBulkDelete() {
    const n = this.state.selectedIds.size;
    this._showConfirm(
      'Delete tags',
      `Delete ${n} tag${n === 1 ? '' : 's'}? Posts will NOT be deleted.`,
      'Delete',
      'danger',
      async () => {
        const ids = Array.from(this.state.selectedIds);
        await this._runBulk(ids, id => deleteTag(id), c => `${c} tag${c === 1 ? '' : 's'} deleted.`);
      },
    );
  }

  /**
   * Apply an operation to every selected tag, reporting partial failure rather
   * than stopping at the first one, then reload and leave select mode.
   */
  async _runBulk(ids, op, successMessage) {
    let done = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await op(id);
        done++;
      } catch (err) {
        console.error(`[TagsManagerPage] bulk operation failed for tag ${id}:`, err);
        failed++;
      }
    }

    store.set('toast', {
      message: failed === 0
        ? successMessage(done)
        : `${done} of ${ids.length} done. ${failed} failed.`,
      type: failed > 0 ? 'error' : 'success',
    });

    this.setState({ selectMode: false, selectedIds: new Set() });
    this._load();
    this._refreshNavTags();
  }

  // Bulk Move…: pick one parent, then re-file every selected tag under it.
  _openBulkMoveDialog() {
    const ids = Array.from(this.state.selectedIds);
    if (!ids.length) return;

    const selected = new Set(ids);
    const available = this.state.tags
      .filter(t => !selected.has(t.id))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (!available.length) {
      store.set('toast', { message: 'No tag left to move these under.', type: 'error' });
      return;
    }

    openTagPickerDialog({
      title: `Move ${ids.length} tag${ids.length === 1 ? '' : 's'} under…`,
      modalClass: 'tm-move-modal',
      tags: available,
      radioName: 'tm-bulk-parent',
      renderItem: t => `
      <label class="tm-move-parent-item">
        <input type="radio" name="tm-bulk-parent" value="${t.id}">
        <span class="tm-move-parent-name">${escapeHtml(t.name)}</span>
      </label>`,
      itemClass: 'tm-move-parent-item',
      nameClass: 'tm-move-parent-name',
      listClass: 'tm-move-parent-list',
      searchClass: 'tm-move-search',
      afterList: '<p class="form-hint">Replaces any parents these tags already have.</p>',
      cancelId: 'tm-bulk-move-cancel-btn',
      confirmId: 'tm-bulk-move-confirm-btn',
      confirmLabel: 'Move',
      onEmpty: () => store.set('toast', { message: 'Select a parent first.', type: 'error' }),
      onConfirm: parentId => this._runBulk(
        ids,
        id => setTagParents(id, [parentId]),
        n => `${n} tag${n === 1 ? '' : 's'} moved.`,
      ),
    });
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
    this._swipeCleanup?.();             // tear down listeners from the previous render
    this._swipeCleanup = null;
    if (!window.matchMedia) return;     // SSR / test env guard
    // Same breakpoint as the post card list — see responsive.css.
    const mql = window.matchMedia('(max-width: 48em)');
    if (!mql.matches) return;           // desktop — nothing to do

    const THRESHOLD_PX = 40;            // minimum drag to snap open
    const DAMPING = 0.55;               // rubber-band resistance past full-open
    let openRow = null;                 // currently revealed row (or null)
    let actionsWidth = 0;               // measured width of the actions panel
    let startX = 0, startY = 0;
    let dragging = false;               // true once we've committed to horizontal
    let decided = false;                // true once direction is locked
    let dx = 0;
    const abortControllers = [];        // for easy cleanup

    const closeOpen = () => {
      if (!openRow) return;
      openRow.style.transform = '';
      openRow.classList.remove('tm-row--revealed');
      openRow = null;
    };

    // Tree rows carry .tm-row; list-view rows are the <tr class="tm-tag-row">.
    const rows = this.container.querySelectorAll('.tm-row, .tm-tag-row');

    rows.forEach(row => {
      if (!row.querySelector('.tm-actions')) return;
      const ac = new AbortController();
      abortControllers.push(ac);
      const sig = { signal: ac.signal };

      row.addEventListener('touchstart', e => {
        if (e.touches.length !== 1) return;
        // If tapping inside the already-open row's actions, let buttons handle it
        if (row === openRow && e.target.closest('.tm-actions')) return;

        const t = e.touches[0];
        startX = t.clientX;
        startY = t.clientY;
        dragging = false;
        decided = false;
        dx = 0;

        // Measure actions width (varies per row due to button count)
        const actions = row.querySelector('.tm-actions');
        actionsWidth = actions ? actions.offsetWidth : 0;

        // Disable transition during drag for responsive feel
        row.style.transition = 'none';
      }, { ...sig, passive: true });

      row.addEventListener('touchmove', e => {
        if (e.touches.length !== 1) return;
        const t = e.touches[0];
        const rawDx = t.clientX - startX;
        const rawDy = t.clientY - startY;

        if (!decided) {
          const absDx = Math.abs(rawDx);
          const absDy = Math.abs(rawDy);
          if (Math.max(absDx, absDy) < 8) return; // not enough movement
          decided = true;
          dragging = absDx > absDy;                // horizontal wins?
          if (!dragging) return;                    // vertical — bail, let scroll work

          // Close any other open row when starting a new swipe
          if (openRow && openRow !== row) closeOpen();
        }

        if (!dragging) return;
        e.preventDefault();

        // Clamp: allow leftward (negative) but resist rightward past 0
        dx = rawDx;
        const isAlreadyOpen = row === openRow;
        const baseOffset = isAlreadyOpen ? -actionsWidth : 0;
        let translate = baseOffset + dx;

        // Rubber-band on both edges
        if (translate > 0) {
          translate = translate * (1 - DAMPING);
        } else if (translate < -actionsWidth) {
          const over = -actionsWidth - translate;
          translate = -actionsWidth - over * (1 - DAMPING);
        }

        row.style.transform = `translateX(${translate}px)`;
      }, { ...sig, passive: false });

      row.addEventListener('touchend', () => {
        row.style.transition = ''; // restore CSS transition for snap

        if (!dragging) {
          // A tap (not a drag) — close any open row if tapping outside it
          if (openRow && openRow !== row) closeOpen();
          return;
        }

        const isAlreadyOpen = row === openRow;

        if (isAlreadyOpen) {
          // Swiping on an already-open row: close if swiped right past threshold
          if (dx > THRESHOLD_PX) {
            closeOpen();
          } else {
            // Snap back to open position
            row.style.transform = `translateX(${-actionsWidth}px)`;
          }
        } else if (dx < -THRESHOLD_PX && actionsWidth > 0) {
          // Swiping left on a closed row reveals the action drawer
          closeOpen();
          row.style.transform = `translateX(${-actionsWidth}px)`;
          row.classList.add('tm-row--revealed');
          openRow = row;
        } else if (dx > THRESHOLD_PX) {
          // Swipe right toggles selection, as on the post cards
          row.style.transform = '';
          this._selectBySwipe(row);
        } else {
          row.style.transform = '';
        }
      }, { ...sig, passive: true });

      row.addEventListener('touchcancel', () => {
        row.style.transition = '';
        if (row === openRow) {
          row.style.transform = `translateX(${-actionsWidth}px)`;
        } else {
          row.style.transform = '';
        }
      }, { ...sig, passive: true });
    });

    // Tap-elsewhere-to-close: listen on container
    const containerAc = new AbortController();
    abortControllers.push(containerAc);
    this.container.addEventListener('click', e => {
      if (!openRow) return;
      // If click is inside the open row, let it propagate normally
      if (openRow.contains(e.target)) return;
      closeOpen();
    }, { signal: containerAc.signal });

    this._swipeCleanup = () => {
      abortControllers.forEach(ac => ac.abort());
      closeOpen();
    };
  }

  // ── Drag and Drop ─────────────────────────────────────────────────────────────

  _bindDragAndDrop() {
    const rows = this.container.querySelectorAll('.tm-row[draggable="true"]');

    const clearIndicators = () => {
      this.container.querySelectorAll('.tm-row').forEach(r => r.classList.remove('tm-drop-before', 'tm-drop-after', 'tm-drop-on'));
    };

    const dropZone = (e, rect) => {
      const rel = (e.clientY - rect.top) / rect.height;
      if (rel < 0.25) return 'before';
      if (rel > 0.75) return 'after';
      return 'on';
    };

    rows.forEach(row => {
      row.addEventListener('dragstart', e => {
        const id = parseInt(row.dataset.id, 10);
        const parentId = row.dataset.parentId !== '' ? parseInt(row.dataset.parentId, 10) : null;
        this._dragState = { tagId: id, parentId };
        row.classList.add('tm-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(id));
      });

      row.addEventListener('dragend', () => {
        row.classList.remove('tm-dragging');
        clearIndicators();
        this._dragState = null;
      });

      row.addEventListener('dragover', e => {
        if (!this._dragState) return;
        const dragId   = this._dragState.tagId;
        const targetId = parseInt(row.dataset.id, 10);
        if (dragId === targetId) return;

        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        clearIndicators();
        const zone = dropZone(e, row.getBoundingClientRect());
        if (zone === 'before') row.classList.add('tm-drop-before');
        else if (zone === 'after') row.classList.add('tm-drop-after');
        else row.classList.add('tm-drop-on');
      });

      row.addEventListener('dragleave', e => {
        if (!row.contains(e.relatedTarget)) {
          row.classList.remove('tm-drop-before', 'tm-drop-after', 'tm-drop-on');
        }
      });

      row.addEventListener('drop', async e => {
        e.preventDefault();
        if (!this._dragState) return;

        const dragId      = this._dragState.tagId;
        const dragParent  = this._dragState.parentId;
        const targetId    = parseInt(row.dataset.id, 10);
        const targetParent = row.dataset.parentId !== '' ? parseInt(row.dataset.parentId, 10) : null;
        if (dragId === targetId) { clearIndicators(); this._dragState = null; return; }

        const zone = row.classList.contains('tm-drop-before') ? 'before'
                   : row.classList.contains('tm-drop-after')  ? 'after'
                   : 'on';
        clearIndicators();
        this._dragState = null;

        if (zone === 'on') {
          // Drop onto: show confirm (Move under / Also file under)
          this._openDropOnConfirm(dragId, targetId);
        } else if (zone === 'before' || zone === 'after') {
          // Reorder within same parent via per-edge sort_order
          if (dragParent === null || dragParent !== targetParent) {
            store.set('toast', { message: 'Drop ON a tag to reparent. Reordering only works within the same parent.', type: 'error' });
            return;
          }
          const afterId = zone === 'after'
            ? targetId
            : this._getSiblingBefore(targetId, dragParent);
          try {
            await moveTag(dragId, { parent_id: dragParent, after_id: afterId });
            this._load();
          } catch (err) {
            store.set('toast', { message: err.message || 'Reorder failed.', type: 'error' });
          }
        }
      });
    });
  }

  _getSiblingBefore(targetId, parentId) {
    return getSiblingBefore(this.state.tags, targetId, parentId);
  }

  _getChildrenOf(parentId) { return getChildrenOf(this.state.tags, parentId); }

  // Confirm dialog shown when dragging one tag onto another.
  _openDropOnConfirm(dragId, targetId) {
    const drag   = this.state.tags.find(t => t.id === dragId);
    const target = this.state.tags.find(t => t.id === targetId);
    if (!drag || !target) return;

    const { overlay, close } = openOverlay(`
      <div class="modal" role="dialog" aria-modal="true" style="max-width:28rem">
        <div class="modal-header">
          <h3>Move "${escapeHtml(drag.name)}" under "${escapeHtml(target.name)}"?</h3>
        </div>
        <div class="modal-body">
          <p style="font-size:var(--font-size-sm);color:var(--text-secondary);margin:0">
            Choose how to place <strong>${escapeHtml(drag.name)}</strong>:
          </p>
        </div>
        <div class="modal-footer tm-drop-confirm-footer">
          <button class="btn btn-primary" id="drop-move-btn">
            Move under "${escapeHtml(target.name)}" — replaces other parents
          </button>
          <button class="btn btn-secondary" id="drop-also-btn">
            Also file under "${escapeHtml(target.name)}" — keeps other parents
          </button>
          <button class="btn btn-secondary" id="drop-cancel-btn">Cancel</button>
        </div>
      </div>`);

    overlay.querySelector('#drop-cancel-btn').addEventListener('click', close);

    overlay.querySelector('#drop-move-btn').addEventListener('click', async () => {
      close();
      try {
        await setTagParents(dragId, [targetId]);
        this._load();
        this._refreshNavTags();
      } catch (err) {
        store.set('toast', { message: err.message || 'Move failed.', type: 'error' });
      }
    });

    overlay.querySelector('#drop-also-btn').addEventListener('click', async () => {
      close();
      try {
        const currentParents = (drag.parents || []).map(p => p.id);
        if (!currentParents.includes(targetId)) {
          await setTagParents(dragId, [...currentParents, targetId]);
        }
        this._load();
        this._refreshNavTags();
      } catch (err) {
        store.set('toast', { message: err.message || 'Move failed.', type: 'error' });
      }
    });
  }

  // Merge… dialog: pick destination tag to merge into.
  _openMergeDialog(loserId) {
    const loser = this.state.tags.find(t => t.id === loserId);
    if (!loser) return;

    const available = this.state.tags
      .filter(t => t.id !== loserId)
      .sort((a, b) => a.name.localeCompare(b.name));

    openTagPickerDialog({
      title: `Merge "${escapeHtml(loser.name)}" into…`,
      modalClass: 'tm-merge-modal',
      tags: available,
      radioName: 'tm-merge-winner',
      renderItem: t => `
      <label class="tm-merge-winner-item">
        <input type="radio" name="tm-merge-winner" value="${t.id}">
        <div class="tm-merge-winner-info">
          <span class="tm-merge-winner-name">${escapeHtml(t.name)}</span>
          ${t.name_path ? `<span class="tm-merge-winner-path">${escapeHtml(t.name_path)}</span>` : ''}
        </div>
      </label>`,
      itemClass: 'tm-merge-winner-item',
      nameClass: 'tm-merge-winner-name',
      listClass: 'tm-merge-winner-list',
      searchClass: 'tm-merge-search',
      beforeList: '<p class="tm-section-label">Select destination tag</p>',
      afterList: `
          <p class="form-hint" style="margin-top:var(--spacing-md)">
            Posts tagged <strong>${escapeHtml(loser.name)}</strong> will be re-tagged.
            Hierarchy will be moved. <strong>${escapeHtml(loser.name)}</strong> will be deleted.
          </p>
          <label class="tm-flag-row" style="margin-top:var(--spacing-sm)">
            <input type="checkbox" id="tm-merge-redirect" checked> Keep redirect (not yet implemented)
          </label>`,
      cancelId: 'tm-merge-cancel-btn',
      confirmId: 'tm-merge-confirm-btn',
      confirmLabel: 'Merge Tags',
      onEmpty: () => store.set('toast', { message: 'Select a destination tag first.', type: 'error' }),
      collect: overlay => overlay.querySelector('#tm-merge-redirect').checked,
      onConfirm: async (winnerId, keepRedirect) => {
        try {
          await mergeTags(loserId, { winner_id: winnerId, keep_redirect: keepRedirect });
          this._load();
          this._refreshNavTags();
          store.set('toast', { message: 'Tags merged successfully.', type: 'success' });
        } catch (err) {
          store.set('toast', { message: err.message || 'Merge failed.', type: 'error' });
        }
      },
    });
  }

  // Move… dialog: touch parity for drag — pick parent + position, then call MoveTag.
  _openMoveDialog(tagId, contextParentId) {
    const tag = this.state.tags.find(t => t.id === tagId);
    if (!tag) return;

    const available = this.state.tags
      .filter(t => t.id !== tagId)
      .sort((a, b) => a.name.localeCompare(b.name));

    const positionOptions = parentId => [
      `<option value="">At beginning</option>`,
      ...this._getChildrenOf(parentId)
        .filter(t => t.id !== tagId)
        .map(s => `<option value="${s.id}">After "${escapeHtml(s.name)}"</option>`),
    ].join('');

    openTagPickerDialog({
      title: `Move "${escapeHtml(tag.name)}"`,
      modalClass: 'tm-move-modal',
      tags: available,
      radioName: 'tm-move-parent',
      renderItem: t => `
      <label class="tm-move-parent-item">
        <input type="radio" name="tm-move-parent" value="${t.id}"${t.id === contextParentId ? ' checked' : ''}>
        <span class="tm-move-parent-name">${escapeHtml(t.name)}</span>
      </label>`,
      itemClass: 'tm-move-parent-item',
      nameClass: 'tm-move-parent-name',
      listClass: 'tm-move-parent-list',
      searchClass: 'tm-move-search',
      beforeList: '<p class="tm-section-label">Under parent</p>',
      afterList: `
          <p class="tm-section-label" style="margin-top:var(--spacing-md)">Position</p>
          <select class="form-input tm-move-position-select">${positionOptions(contextParentId)}</select>`,
      cancelId: 'tm-move-cancel-btn',
      confirmId: 'tm-move-confirm-btn',
      confirmLabel: 'Move',
      onEmpty: () => store.set('toast', { message: 'Select a parent first.', type: 'error' }),
      onMount: overlay => {
        // Re-offer positions whenever the chosen parent changes.
        overlay.querySelector('.tm-move-parent-list').addEventListener('change', e => {
          if (e.target.name === 'tm-move-parent') {
            overlay.querySelector('.tm-move-position-select').innerHTML =
              positionOptions(parseInt(e.target.value, 10));
          }
        });
      },
      collect: overlay => {
        const raw = overlay.querySelector('.tm-move-position-select').value;
        return raw ? parseInt(raw, 10) : null;
      },
      onConfirm: async (parentId, afterId) => {
        try {
          const currentParents = (tag.parents || []).map(p => p.id);
          if (!currentParents.includes(parentId)) {
            await setTagParents(tagId, [...currentParents, parentId]);
          }
          await moveTag(tagId, { parent_id: parentId, after_id: afterId });
          this._load();
          this._refreshNavTags();
          store.set('toast', { message: 'Tag moved.', type: 'success' });
        } catch (err) {
          store.set('toast', { message: err.message || 'Move failed.', type: 'error' });
        }
      },
    });
  }

  // ── Modal ────────────────────────────────────────────────────────────────────

  _openModal(tag = null, parentId = null, { fromUrl = false } = {}) {
    this._closeModal();

    const isEdit = !!tag;
    const f = tag || {};
    const { selParents, selChildren } = tagEditorSelection(tag, parentId);

    // Track initial structure to detect changes on save
    this._initialParentIds = [...selParents];
    this._initialChildIds  = [...selChildren];

    const modal = document.createElement('div');
    modal.className = 'modal-overlay active';

    const html = renderTagEditorForm({ tag, parentId, allTags: this.state.tags });

    modal['inner' + 'HTML'] = html;
    document.body.appendChild(modal);
    this._modal = modal;
    this._initTagToggleTrees(modal);

    // Reflect the open tag in the browser URL
    const urlSlug = isEdit ? f.slug : 'new';
    const targetPath = `/light/tags/${urlSlug}`;
    if (!fromUrl && location.pathname !== targetPath) {
      history.pushState(null, '', targetPath);
      this._didPushUrl = true;
    }

    // Auto-slug from name
    const nameInput = modal.querySelector('[name="name"]');
    const slugInput = modal.querySelector('#modal-slug');
    if (isEdit) slugInput.dataset.manual = '1';
    nameInput.addEventListener('input', () => {
      if (!slugInput.dataset.manual) slugInput.value = this._slugify(nameInput.value);
    });
    slugInput.addEventListener('input', () => { slugInput.dataset.manual = '1'; });

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
      const latInput   = modal.querySelector('#coord-lat');
      const lngInput   = modal.querySelector('#coord-lng');
      const parseBtn   = modal.querySelector('#gmaps-parse-btn');
      const raw = coordInput.value.trim();
      const setLocked = locked => {
        coordInput.disabled = locked;
        latInput.disabled   = locked;
        lngInput.disabled   = locked;
        parseBtn.disabled   = locked;
        parseBtn.textContent = locked ? '…' : (isEdit ? 'Parse / Geocode' : 'Parse');
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
          store.set('toast', { message: 'Coordinates fetched from Nominatim.', type: 'success' });
        }
      } catch (err) {
        store.set('toast', { message: err.message || 'Failed to get coordinates.', type: 'error' });
      } finally {
        setLocked(false);
      }
    });

    modal.querySelector('.modal-close').addEventListener('click',    () => this._closeModal());
    modal.querySelector('#modal-cancel-btn').addEventListener('click', () => this._closeModal());
    modal.addEventListener('click', e => { if (e.target === modal) this._closeModal(); });
    modal.querySelector('#tag-editor-form').addEventListener('submit', async e => {
      e.preventDefault();
      await this._handleSave(e.target, isEdit ? f.id : null);
    });
    modal.addEventListener('textarea:save', async () => {
      const form = modal.querySelector('#tag-editor-form');
      if (form) await this._handleSave(form, isEdit ? f.id : null, { closeAfter: false });
    });
    modal.addEventListener('keydown', async (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        const form = modal.querySelector('#tag-editor-form');
        if (form) {
          const isMaximized = !!modal.querySelector('.is-maximized');
          await this._handleSave(form, isEdit ? f.id : null, { closeAfter: !isMaximized });
        }
      }
    });

    this._modalKeyHandler = e => { if (e.key === 'Escape') this._closeModal(); };
    document.addEventListener('keydown', this._modalKeyHandler);
    nameInput.focus();
    setupTextareaMaximizer(modal);
  }



  _initTagToggleTrees(modal) {
    const updateIndeterminate = (tree) => {
      const nodes = Array.from(tree.querySelectorAll('.tag-toggle-node')).reverse();
      nodes.forEach(node => {
        const ownCb = node.querySelector(':scope > .tag-toggle-row .tag-toggle input[type="checkbox"]');
        if (!ownCb) return;
        const descCbs = node.querySelectorAll('.tag-toggle-node input[type="checkbox"]');
        if (!descCbs.length) return;
        const anyActive = Array.from(descCbs).some(cb => cb.checked || cb.indeterminate);
        ownCb.indeterminate = !ownCb.checked && anyActive;
      });
    };

    modal.querySelectorAll('[data-tt-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const list = modal.querySelector(`#${btn.dataset.ttToggle}`);
        if (!list) return;
        const open = !list.classList.contains('hidden');
        list.classList.toggle('hidden', open);
        btn.setAttribute('aria-expanded', String(!open));
        btn.textContent = open ? '▶' : '▼';
      });
    });

    modal.querySelectorAll('.tag-toggle-tree.level-0').forEach(tree => updateIndeterminate(tree));

    modal.querySelectorAll('.tag-toggle-tree input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => {
        const tree = cb.closest('.tag-toggle-tree.level-0');
        if (tree) updateIndeterminate(tree);
      });
    });

    modal.querySelectorAll('.tm-toggle-search').forEach(input => {
      const container = input.nextElementSibling;
      if (!container) return;
      input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        const allNodes = Array.from(container.querySelectorAll('.tag-toggle-node'));
        const allLists = Array.from(container.querySelectorAll('.tag-toggle-tree'));
        if (!q) {
          allNodes.forEach(n => n.classList.remove('hidden'));
          allLists.forEach(l => l.classList.remove('hidden'));
          return;
        }
        allNodes.forEach(n => n.classList.add('hidden'));
        allLists.forEach(l => l.classList.add('hidden'));
        allNodes.forEach(n => {
          const label = n.querySelector(':scope > .tag-toggle-row .tag-toggle span');
          if (label && label.textContent.toLowerCase().includes(q)) {
            let el = n;
            while (el && el !== container) {
              if (el.classList.contains('tag-toggle-node') || el.classList.contains('tag-toggle-tree')) {
                el.classList.remove('hidden');
              }
              el = el.parentElement;
            }
          }
        });
      });
    });
  }

  _closeModal() {
    if (this._modal) { this._modal.remove(); this._modal = null; }
    if (this._modalKeyHandler) {
      document.removeEventListener('keydown', this._modalKeyHandler);
      this._modalKeyHandler = null;
    }
    if (location.pathname.startsWith('/light/tags/')) {
      history.replaceState(null, '', '/light/tags');
    }
    this._didPushUrl = false;
  }

  _slugify(text) { return slugifyTagName(text); }

  // ── Data operations ──────────────────────────────────────────────────────────

  async _load() {
    this.setState({ loading: true, error: null });
    try {
      const data = await listTags({ include_empty: true });
      this.setState({ loading: false, tags: data.tags || [] });

      // Auto-open editor when navigated directly to /light/tags/:slug
      const slug = this.props?.params?.slug;
      if (slug) {
        const tags = data.tags || [];
        const tag = slug === 'new' ? null : tags.find(t => t.slug === slug);
        if (slug === 'new' || tag) {
          this._openModal(tag, null, { fromUrl: true });
        }
      }
    } catch (err) {
      console.error('[TagsManagerPage] load error:', err);
      store.set('toast', { message: 'Could not load tags.', type: 'error' });
      this.setState({ loading: false, tags: [] });
    }
  }

  async _handleSave(form, tagId, { closeAfter = true } = {}) {
    const fd = new FormData(form);

    const name        = (fd.get('name') || '').trim();
    const slug        = (fd.get('slug') || '').trim();
    const description = (fd.get('description') || '').trim();
    const kind        = fd.get('kind') || 'topic';
    const hidden      = fd.has('hidden');
    const hides_posts = fd.has('hides_posts');
    const in_breadcrumbs    = fd.has('in_breadcrumbs');
    const show_related      = fd.has('show_related');
    const in_ancestor_flyout = fd.has('in_ancestor_flyout');
    const inNav       = fd.has('in_nav');
    const navOrderRaw = fd.get('nav_order');
    // ponytail: checkbox on with empty position must still enable nav — default to 0.
    const nav_order   = inNav ? (navOrderRaw !== '' ? parseInt(navOrderRaw, 10) : 0) : null;

    const lat = parseFloat(fd.get('latitude') || '');
    const lon = parseFloat(fd.get('longitude') || '');
    const latitude  = !isNaN(lat) ? lat : null;
    const longitude = !isNaN(lon) ? lon : null;

    const newParentIds = fd.getAll('parent_ids').map(v => parseInt(v, 10));
    const newChildIds  = fd.getAll('child_ids').map(v => parseInt(v, 10));

    const submitBtn = form.querySelector('[type="submit"]');
    const origText  = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';

    try {
      if (tagId) {
        // PATCH for all non-structural fields
        await patchTag(tagId, {
          name, slug, description, kind,
          hidden, hides_posts, nav_order,
          in_breadcrumbs, show_related, in_ancestor_flyout,
          latitude, longitude,
        });

        // Structure calls only when changed
        if (!_arraysEqual(newParentIds, this._initialParentIds)) {
          await setTagParents(tagId, newParentIds);
        }
        if (!_arraysEqual(newChildIds, this._initialChildIds)) {
          await setTagChildren(tagId, newChildIds);
        }

        store.set('toast', { message: 'Tag updated.', type: 'success' });
      } else {
        await createTag({
          name, slug, description, kind,
          hidden, hides_posts, nav_order,
          in_breadcrumbs, show_related, in_ancestor_flyout,
          latitude, longitude,
          parent_ids: newParentIds,
          child_ids:  newChildIds,
        });
        store.set('toast', { message: 'Tag created.', type: 'success' });
      }

      if (closeAfter) this._closeModal();
      this._load();
      this._refreshNavTags();
    } catch (err) {
      store.set('toast', { message: err.message || 'Save failed.', type: 'error' });
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
      onConfirm: () => { dialog.unmount(); mount.remove(); onConfirm(); },
      onCancel:  () => { dialog.unmount(); mount.remove(); },
    });
    dialog.mount();
  }

  async _handleDelete(id) {
    try {
      await deleteTag(id);
      store.set('toast', { message: 'Tag deleted.', type: 'success' });
      this._load();
      this._refreshNavTags();
    } catch (err) {
      store.set('toast', { message: err.message || 'Delete failed.', type: 'error' });
    }
  }

  async _handleRecalc() {
    try {
      await recalculateCounts();
      store.set('toast', { message: 'Counts recalculated.', type: 'success' });
      this._load();
    } catch (err) {
      store.set('toast', { message: err.message || 'Recalculation failed.', type: 'error' });
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
