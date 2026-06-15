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
import { getNavMenu } from '../../api/pages.js';
import { store } from '../../store.js';
import { escapeHtml } from '../../utils/helpers.js';
import { EDIT_SVG, X_SVG, REFRESH_SVG, MAP_SVG, LIST_SVG, TREE_SVG, CHEVRON_SVG, CHEVRON_RIGHT_SVG, PLUS_SVG } from '../../utils/icons.js';
import { setupTextareaMaximizer } from '../../utils/textareaMaximizer.js';

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
    const { view } = this.state;

    const actions = `
      <div class="tm-view-toggle">
        <button id="view-tree-btn" class="btn btn-sm${view === 'tree' ? ' btn-primary' : ' btn-secondary'}" title="Tree view">${TREE_SVG}<span class="btn-label"> Tree</span></button>
        <button id="view-list-btn" class="btn btn-sm${view === 'list' ? ' btn-primary' : ' btn-secondary'}" title="List view">${LIST_SVG}<span class="btn-label"> List</span></button>
      </div>
      ${view === 'tree' ? `
      <button id="expand-all-btn" class="btn btn-sm btn-secondary" title="Expand all">⇅<span class="btn-label"> Expand all</span></button>
      <button id="collapse-all-btn" class="btn btn-sm btn-secondary" title="Collapse all">‒<span class="btn-label"> Collapse all</span></button>` : ''}
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
            <div class="card">
              <div class="card-body">
                ${content}
              </div>
            </div>`;
  }

  // === List view ===

  _renderList(tags) {
    if (!tags.length) return '<p class="empty-state">No tags found.</p>';

    const { sortField, sortOrder } = this.state;
    const dir = sortOrder === 'asc' ? 1 : -1;

    const sorted = [...tags].sort((a, b) => {
      let valA, valB;
      switch (sortField) {
        case 'name':        valA = a.name.toLowerCase();      valB = b.name.toLowerCase();      break;
        case 'slug':        valA = a.slug.toLowerCase();      valB = b.slug.toLowerCase();      break;
        case 'post_count':  valA = a.post_count || 0;         valB = b.post_count || 0;         break;
        case 'locations':   valA = (a.locations?.length > 0) ? 1 : 0; valB = (b.locations?.length > 0) ? 1 : 0; break;
        case 'parents':     valA = a.parents?.length || 0;    valB = b.parents?.length || 0;    break;
        default:
          valA = a.nav_order ?? Infinity; valB = b.nav_order ?? Infinity;
          if (valA === valB) { valA = a.name.toLowerCase(); valB = b.name.toLowerCase(); }
      }
      if (valA < valB) return -1 * dir;
      if (valA > valB) return 1 * dir;
      return 0;
    });

    const rows = sorted.map(tag => {
      const parentIds  = (tag.parents || []).map(p => p.id).join(',');
      const parentNamesLower = (tag.parents || []).map(p => p.name.toLowerCase()).join(' ');
      const parentBadges = (tag.parents || [])
        .map(p => `<button type="button" class="tm-parent-filter-btn tm-rel-badge" data-parent-id="${p.id}" data-parent-name="${escapeHtml(p.name)}" title="Filter by ${escapeHtml(p.name)}">${escapeHtml(p.name)}</button>`)
        .join('');

      const hasLocation = tag.locations?.length > 0;

      return `
        <tr class="tm-tag-row" data-name="${escapeHtml(tag.name.toLowerCase())}" data-slug="${escapeHtml(tag.slug.toLowerCase())}" data-parent-ids="${parentIds}" data-parent-names="${escapeHtml(parentNamesLower)}">
          <td><span class="tm-tag-name">${escapeHtml(tag.name)}</span></td>
          <td><code class="tm-slug">${escapeHtml(tag.slug)}</code></td>
          <td class="text-center"><a class="tm-count-badge" href="/light/posts?search=${encodeURIComponent(tag.slug)}" title="View posts tagged ${escapeHtml(tag.slug)}">${tag.post_count || 0}</a></td>
          <td class="text-center">
            ${hasLocation ? `
              <a href="/map?tag=${encodeURIComponent(tag.slug)}" class="btn btn-sm tm-flag-link active tm-flag-location" title="View on map">
                ${MAP_SVG}<span class="btn-label"> Map</span>
              </a>` : `
              <span class="tm-flag-static tm-flag-location" title="No coordinates">${MAP_SVG}</span>
            `}
          </td>
          <td><div class="tm-parents-cell">${parentBadges || '<span class="text-muted">—</span>'}</div></td>
          <td class="tm-actions">
            <button class="btn btn-sm edit-tag-btn"   data-id="${tag.id}" title="Edit">${EDIT_SVG}</button>
            <button class="btn btn-sm merge-tag-btn"  data-id="${tag.id}" title="Merge into…">Merge…</button>
            <button class="btn btn-sm btn-danger delete-tag-btn" data-id="${tag.id}" title="Delete">${X_SVG}</button>
          </td>
        </tr>`;
    }).join('');

    const chips = this._listFilterParents.map(p =>
      `<button type="button" class="tm-filter-chip" data-remove-id="${p.id}">${escapeHtml(p.name)} <span class="tm-chip-remove">${X_SVG}</span></button>`
    ).join('');
    const hasFilters = this._listSearch || this._listFilterParents.length > 0;

    return `
      <div class="tm-list-filter-bar">
        <div class="tm-list-search-row">
          <input type="text" class="form-input tm-list-search" placeholder="Search name, slug, parents…" value="${escapeHtml(this._listSearch || '')}">
          ${hasFilters ? '<button type="button" class="btn btn-sm btn-secondary tm-clear-filters">Clear</button>' : ''}
        </div>
        ${chips ? `<div class="tm-filter-chips" id="tm-filter-chips">${chips}</div>` : '<div class="tm-filter-chips" id="tm-filter-chips"></div>'}
      </div>
      <div class="table-container">
        <table class="table tm-tags-table">
          <thead>
            <tr>
              ${this._renderSortHeader('name', 'Name')}
              ${this._renderSortHeader('slug', 'Slug')}
              ${this._renderSortHeader('post_count', 'Posts', 'text-center')}
              ${this._renderSortHeader('locations', '📍', 'text-center', 'Coordinates')}
              ${this._renderSortHeader('parents', 'Parents')}
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  _applyListFilter() {
    const q = (this._listSearch || '').trim().toLowerCase();
    const filterIds = this._listFilterParents.map(p => p.id);
    this.container.querySelectorAll('.tm-tag-row').forEach(row => {
      const textMatch = !q ||
        row.dataset.name.includes(q) ||
        row.dataset.slug.includes(q) ||
        row.dataset.parentNames.includes(q);
      const rowParentIds = row.dataset.parentIds ? row.dataset.parentIds.split(',').map(Number) : [];
      const parentMatch = filterIds.length === 0 || filterIds.every(id => rowParentIds.includes(id));
      row.classList.toggle('hidden', !(textMatch && parentMatch));
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
    const { sortField, sortOrder } = this.state;
    const isActive = sortField === field;
    const icon = isActive ? (sortOrder === 'asc' ? ' ▴' : ' ▾') : '';

    return `
      <th class="tm-sortable-header ${className} ${isActive ? 'active' : ''}"
          data-field="${field}"
          title="${title || 'Sort by ' + label}">
        <div class="tm-header-content">
          <span>${label}</span>
          <span class="tm-sort-icon">${icon}</span>
        </div>
      </th>`;
  }

  // ── Tree view ────────────────────────────────────────────────────────────────

  /**
   * Build tree structure from flat tag list.
   * Returns { navRoots, otherRoots, unfiled } for the forest renderer.
   * Multi-parent tags appear under each parent (DAG).
   */
  _buildTree(tags) {
    const tagById = new Map(tags.map(t => [t.id, t]));
    const childrenOf = new Map();
    tags.forEach(t => {
      (t.parents || []).forEach(p => {
        if (tagById.has(p.id)) {
          if (!childrenOf.has(p.id)) childrenOf.set(p.id, []);
          childrenOf.get(p.id).push(t);
        }
      });
    });

    const sortFn = (a, b) => {
      const ao = a.sort_order ?? Infinity;
      const bo = b.sort_order ?? Infinity;
      if (ao !== bo) return ao - bo;
      return a.name.localeCompare(b.name);
    };

    const makeNode = (tag, ancestorIds) => {
      const kids = (childrenOf.get(tag.id) || []).filter(c => !ancestorIds.has(c.id));
      kids.sort(sortFn);
      return {
        ...tag,
        childrenNodes: kids.map(c => makeNode(c, new Set([...ancestorIds, c.id]))),
      };
    };

    // Parentless tags are top-level
    const parentless = tags.filter(t => (t.parents || []).length === 0);

    // Nav roots: explicitly placed in navigation
    const navRoots = parentless
      .filter(t => t.nav_order != null)
      .sort((a, b) => a.nav_order - b.nav_order)
      .map(t => makeNode(t, new Set([t.id])));

    // Other filed roots: no nav_order but have children (intentional hierarchy roots)
    const otherRoots = parentless
      .filter(t => t.nav_order == null && (childrenOf.get(t.id) || []).length > 0)
      .sort(sortFn)
      .map(t => makeNode(t, new Set([t.id])));

    // Unfiled: no parents, no children, not in nav
    const unfiled = parentless
      .filter(t => t.nav_order == null && (childrenOf.get(t.id) || []).length === 0)
      .sort((a, b) => a.name.localeCompare(b.name));

    return { navRoots, otherRoots, unfiled };
  }

  _renderForest({ navRoots, otherRoots, unfiled }) {
    const total = navRoots.length + otherRoots.length + unfiled.length;
    if (!total) return '<p class="empty-state">No tags found.</p>';

    let html = '<div class="tm-tree-root">';

    if (navRoots.length) {
      html += `<ul class="tm-tree level-0">${navRoots.map(n => this._renderNode(n, 0, null)).join('')}</ul>`;
    }

    if (otherRoots.length) {
      html += `<ul class="tm-tree level-0">${otherRoots.map(n => this._renderNode(n, 0, null)).join('')}</ul>`;
    }

    if (unfiled.length) {
      html += this._renderUnfiledGroup(unfiled);
    }

    html += '</div>';
    return html;
  }

  _renderTree(nodes, level = 0, parentId = null) {
    if (!nodes.length) return level === 0 ? '<p class="empty-state">No tags found.</p>' : '';
    return `<ul class="tm-tree level-${level}" data-parent-id="${parentId ?? ''}">${nodes.map(n => this._renderNode(n, level, parentId)).join('')}</ul>`;
  }

  _renderNode(node, level, parentId) {
    const isExpanded = this.state.expanded.has(node.id);
    const hasChildren = node.childrenNodes.length > 0;

    const toggle = hasChildren
      ? `<button class="tm-toggle" data-id="${node.id}">${isExpanded ? CHEVRON_SVG : CHEVRON_RIGHT_SVG}</button>`
      : `<span class="tm-toggle-spacer"></span>`;

    const badges = this._renderRowBadges(node);
    const parentAttr = parentId != null ? parentId : '';

    return `
      <li class="tm-node" data-id="${node.id}">
        <div class="tm-row" draggable="true" data-id="${node.id}" data-parent-id="${parentAttr}">
          <span class="tm-drag-handle" title="Drag to reorder">⋮⋮</span>
          ${toggle}
          <div class="tm-node-body">
            <span class="tm-tag-name">${escapeHtml(node.name)}</span>
            ${badges ? `<span class="tm-badges-row">${badges}</span>` : ''}
          </div>
          <span class="tm-row-meta">
            <a class="tm-count-badge" href="/light/posts?search=${encodeURIComponent(node.slug)}" title="View posts tagged ${escapeHtml(node.slug)}">${node.post_count || 0}</a>
          </span>
          <div class="tm-actions">
            <button class="btn btn-sm edit-tag-btn"    data-id="${node.id}" title="Edit" aria-label="Edit tag">${EDIT_SVG}</button>
            <button class="btn btn-sm merge-tag-btn"   data-id="${node.id}" title="Merge into…" aria-label="Merge into another tag">Merge…</button>
            <button class="btn btn-sm move-tag-btn"    data-id="${node.id}" data-parent-id="${parentAttr}" title="Move to parent…" aria-label="Move to new parent">Move…</button>
            <button class="btn btn-sm add-child-btn"   data-id="${node.id}" title="Add child" aria-label="Add child tag">+</button>
            <button class="btn btn-sm btn-danger delete-tag-btn" data-id="${node.id}" title="Delete" aria-label="Delete tag">${X_SVG}</button>
          </div>
        </div>
        ${isExpanded && hasChildren ? this._renderTree(node.childrenNodes, level + 1, node.id) : ''}
      </li>`;
  }

  _renderRowBadges(node) {
    const parts = [];

    if (node.nav_order != null) {
      parts.push(`<span class="tm-badge tm-badge-nav" title="In public navigation (position ${node.nav_order})">⌂ nav</span>`);
    }

    if (node.hidden) {
      parts.push(`<span class="tm-badge tm-badge-hidden" title="Hidden from public">🚫 hidden</span>`);
    } else if (node.effective_hidden) {
      const via = node.hidden_via
        ? ` <button type="button" class="tm-badge-via-btn" data-open-tag-id="${node.hidden_via}" title="Open ancestor tag">inh.</button>`
        : ' inh.';
      parts.push(`<span class="tm-badge tm-badge-inherited" title="Hidden via ancestor">🚫${via}</span>`);
    }

    if (node.kind === 'year') {
      parts.push(`<span class="tm-badge tm-badge-year" title="Year tag">📅 year</span>`);
    }

    if (node.locations?.length > 0) {
      parts.push(`<a href="/map?tag=${encodeURIComponent(node.slug)}" class="tm-badge tm-badge-coords" title="View on map">📍</a>`);
    }

    const allParents = node.parents || [];
    if (allParents.length > 1) {
      const extras = allParents.slice(1).map(p => escapeHtml(p.name)).join(', ');
      parts.push(`<span class="tm-badge tm-badge-multi" title="Also under: ${extras}">⎇ ${allParents.length} parents</span>`);
    }

    return parts.join('');
  }

  _renderUnfiledGroup(unfiledTags) {
    const { unfiledExpanded } = this.state;
    const n = unfiledTags.length;
    const rows = unfiledTags.map(tag => `
      <li class="tm-node tm-unfiled-node" data-id="${tag.id}">
        <div class="tm-row" data-id="${tag.id}" data-parent-id="">
          <span class="tm-toggle-spacer"></span>
          <span class="tm-toggle-spacer"></span>
          <div class="tm-node-body">
            <span class="tm-tag-name">${escapeHtml(tag.name)}</span>
            <code class="tm-slug-inline">${escapeHtml(tag.slug)}</code>
          </div>
          <span class="tm-row-meta">
            <a class="tm-count-badge" href="/light/posts?search=${encodeURIComponent(tag.slug)}" title="View posts tagged ${escapeHtml(tag.slug)}">${tag.post_count || 0}</a>
          </span>
          <div class="tm-actions">
            <button class="btn btn-sm edit-tag-btn" data-id="${tag.id}" title="Edit">${EDIT_SVG}</button>
            <button class="btn btn-sm merge-tag-btn" data-id="${tag.id}" title="Merge into…">Merge…</button>
            <button class="btn btn-sm move-tag-btn" data-id="${tag.id}" data-parent-id="" title="Move to parent…">Move…</button>
            <button class="btn btn-sm btn-danger delete-tag-btn" data-id="${tag.id}" title="Delete">${X_SVG}</button>
          </div>
        </div>
      </li>`).join('');

    return `
      <div class="tm-unfiled-group">
        <button type="button" class="tm-unfiled-toggle" id="unfiled-toggle-btn">
          ${unfiledExpanded ? CHEVRON_SVG : CHEVRON_RIGHT_SVG}
          <span class="tm-unfiled-label">Unfiled <span class="tm-unfiled-count">(${n})</span></span>
        </button>
        ${unfiledExpanded ? `<ul class="tm-tree level-0 tm-unfiled-list">${rows}</ul>` : ''}
      </div>`;
  }

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

  // ── Swipe-to-reveal actions (portrait mobile) ─────────────────────────────────

  /**
   * On narrow portrait viewports, hide .tm-actions off-screen and let users
   * swipe a row left to reveal them.  Touch handling:
   *  • touchstart records origin
   *  • touchmove translates the row if the gesture is predominantly horizontal-left
   *  • touchend snaps open (if past threshold) or snaps shut
   *  • tapping anywhere else closes the currently-open row
   */
  _bindSwipeToReveal() {
    if (!window.matchMedia) return;     // SSR / test env guard
    const mql = window.matchMedia('(max-width: 40em)');
    if (!mql.matches) return;           // desktop / tablet — nothing to do

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

    const rows = this.container.querySelectorAll('.tm-row');

    rows.forEach(row => {
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
        } else {
          // Swiping on a closed row: open if swiped left past threshold
          if (dx < -THRESHOLD_PX && actionsWidth > 0) {
            closeOpen();
            row.style.transform = `translateX(${-actionsWidth}px)`;
            row.classList.add('tm-row--revealed');
            openRow = row;
          } else {
            row.style.transform = '';
          }
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

  // Returns the ID of the sibling just before targetId in parentId's children list,
  // or null if targetId is first (meaning move dragId to the front).
  _getSiblingBefore(targetId, parentId) {
    const siblings = this._getChildrenOf(parentId);
    const idx = siblings.findIndex(t => t.id === targetId);
    if (idx <= 0) return null;
    return siblings[idx - 1].id;
  }

  // Returns children of parentId in sort_order (uses the parent's ordered children list).
  _getChildrenOf(parentId) {
    if (!parentId) return [];
    const parent = this.state.tags.find(t => t.id === parentId);
    if (!parent) return [];
    const childIds = (parent.children || []).map(c => c.id);
    return childIds.map(id => this.state.tags.find(t => t.id === id)).filter(Boolean);
  }

  // Confirm dialog shown when dragging one tag onto another.
  _openDropOnConfirm(dragId, targetId) {
    const drag   = this.state.tags.find(t => t.id === dragId);
    const target = this.state.tags.find(t => t.id === targetId);
    if (!drag || !target) return;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay active';
    overlay['inner' + 'HTML'] = `
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
      </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('#drop-cancel-btn').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

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

    const winnerItems = available.map(t => `
      <label class="tm-merge-winner-item">
        <input type="radio" name="tm-merge-winner" value="${t.id}">
        <div class="tm-merge-winner-info">
          <span class="tm-merge-winner-name">${escapeHtml(t.name)}</span>
          ${t.name_path ? `<span class="tm-merge-winner-path">${escapeHtml(t.name_path)}</span>` : ''}
        </div>
      </label>`).join('');

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay active';
    overlay.innerHTML = `
      <div class="modal tm-merge-modal" role="dialog" aria-modal="true">
        <button class="modal-close" aria-label="Close">×</button>
        <div class="modal-header">
          <h3>Merge "${escapeHtml(loser.name)}" into…</h3>
        </div>
        <div class="modal-body">
          <p class="tm-section-label">Select destination tag</p>
          <input type="text" class="form-input tm-merge-search" placeholder="Search tags…" autocomplete="off">
          <div class="tm-merge-winner-list">${winnerItems}</div>
          <p class="form-hint" style="margin-top:var(--spacing-md)">
            Posts tagged <strong>${escapeHtml(loser.name)}</strong> will be re-tagged.
            Hierarchy will be moved. <strong>${escapeHtml(loser.name)}</strong> will be deleted.
          </p>
          <label class="tm-flag-row" style="margin-top:var(--spacing-sm)">
            <input type="checkbox" id="tm-merge-redirect" checked> Keep redirect (not yet implemented)
          </label>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" id="tm-merge-cancel-btn">Cancel</button>
          <button type="button" class="btn btn-primary" id="tm-merge-confirm-btn">Merge Tags</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.querySelector('#tm-merge-cancel-btn').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    overlay.querySelector('.tm-merge-search').addEventListener('input', e => {
      const q = e.target.value.trim().toLowerCase();
      overlay.querySelectorAll('.tm-merge-winner-item').forEach(item => {
        const name = item.querySelector('.tm-merge-winner-name')?.textContent.toLowerCase() || '';
        item.classList.toggle('hidden', q !== '' && !name.includes(q));
      });
    });

    overlay.querySelector('#tm-merge-confirm-btn').addEventListener('click', async () => {
      const radio = overlay.querySelector('input[name="tm-merge-winner"]:checked');
      if (!radio) {
        store.set('toast', { message: 'Select a destination tag first.', type: 'error' });
        return;
      }
      const winnerId = parseInt(radio.value, 10);
      const keepRedirect = overlay.querySelector('#tm-merge-redirect').checked;

      close();
      try {
        await mergeTags(loserId, { winner_id: winnerId, keep_redirect: keepRedirect });
        this._load();
        this._refreshNavTags();
        store.set('toast', { message: 'Tags merged successfully.', type: 'success' });
      } catch (err) {
        store.set('toast', { message: err.message || 'Merge failed.', type: 'error' });
      }
    });
  }

  // Move… dialog: touch parity for drag — pick parent + position, then call MoveTag.
  _openMoveDialog(tagId, contextParentId) {
    const tag = this.state.tags.find(t => t.id === tagId);
    if (!tag) return;

    const available = this.state.tags
      .filter(t => t.id !== tagId)
      .sort((a, b) => a.name.localeCompare(b.name));

    const parentItems = available.map(t => `
      <label class="tm-move-parent-item">
        <input type="radio" name="tm-move-parent" value="${t.id}"${t.id === contextParentId ? ' checked' : ''}>
        <span class="tm-move-parent-name">${escapeHtml(t.name)}</span>
      </label>`).join('');

    const initialSiblings = contextParentId
      ? this._getChildrenOf(contextParentId).filter(t => t.id !== tagId)
      : [];

    const posOpts = [
      `<option value="">At beginning</option>`,
      ...initialSiblings.map(s => `<option value="${s.id}">After "${escapeHtml(s.name)}"</option>`),
    ].join('');

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay active';
    overlay['inner' + 'HTML'] = `
      <div class="modal tm-move-modal" role="dialog" aria-modal="true">
        <button class="modal-close" aria-label="Close">×</button>
        <div class="modal-header">
          <h3>Move "${escapeHtml(tag.name)}"</h3>
        </div>
        <div class="modal-body">
          <p class="tm-section-label">Under parent</p>
          <input type="text" class="form-input tm-move-search" placeholder="Search tags…" autocomplete="off">
          <div class="tm-move-parent-list">${parentItems}</div>
          <p class="tm-section-label" style="margin-top:var(--spacing-md)">Position</p>
          <select class="form-input tm-move-position-select">${posOpts}</select>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" id="tm-move-cancel-btn">Cancel</button>
          <button type="button" class="btn btn-primary" id="tm-move-confirm-btn">Move</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const updatePosition = (parentId) => {
      const siblings = parentId
        ? this._getChildrenOf(parentId).filter(t => t.id !== tagId)
        : [];
      overlay.querySelector('.tm-move-position-select').innerHTML = [
        `<option value="">At beginning</option>`,
        ...siblings.map(s => `<option value="${s.id}">After "${escapeHtml(s.name)}"</option>`),
      ].join('');
    };

    const close = () => overlay.remove();

    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.querySelector('#tm-move-cancel-btn').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    overlay.querySelector('.tm-move-search').addEventListener('input', e => {
      const q = e.target.value.trim().toLowerCase();
      overlay.querySelectorAll('.tm-move-parent-item').forEach(item => {
        const name = item.querySelector('.tm-move-parent-name')?.textContent.toLowerCase() || '';
        item.classList.toggle('hidden', q !== '' && !name.includes(q));
      });
    });

    overlay.querySelector('.tm-move-parent-list').addEventListener('change', e => {
      if (e.target.name === 'tm-move-parent') {
        updatePosition(parseInt(e.target.value, 10));
      }
    });

    overlay.querySelector('#tm-move-confirm-btn').addEventListener('click', async () => {
      const radio = overlay.querySelector('input[name="tm-move-parent"]:checked');
      if (!radio) {
        store.set('toast', { message: 'Select a parent first.', type: 'error' });
        return;
      }
      const parentId = parseInt(radio.value, 10);
      const afterRaw = overlay.querySelector('.tm-move-position-select').value;
      const afterId  = afterRaw ? parseInt(afterRaw, 10) : null;

      close();
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
    });
  }

  // ── Modal ────────────────────────────────────────────────────────────────────

  _openModal(tag = null, parentId = null, { fromUrl = false } = {}) {
    this._closeModal();

    const isEdit = !!tag;
    const f = tag || {};
    const selfId = isEdit ? f.id : null;
    const selParents = isEdit ? (f.parents || []).map(p => p.id) : (parentId ? [parentId] : []);
    const selChildren = isEdit ? (f.children || []).map(c => c.id) : [];

    // Track initial structure to detect changes on save
    this._initialParentIds = [...selParents];
    this._initialChildIds  = [...selChildren];

    const existingLat = f.latitude ?? (f.locations?.[0]?.latitude ?? null);
    const existingLng = f.longitude ?? (f.locations?.[0]?.longitude ?? null);

    const modal = document.createElement('div');
    modal.className = 'modal-overlay active';

    const inNav     = f.nav_order != null;
    const navOrder  = f.nav_order ?? '';
    const kind      = f.kind || 'topic';

    const html = [
      '<div class="modal tag-editor-modal" role="dialog" aria-modal="true">',
      '  <button class="modal-close" aria-label="Close">×</button>',
      '  <div class="modal-header">',
      `    <h3>${isEdit ? 'Edit: ' + escapeHtml(f.name) : 'New Tag'}${isEdit ? ` <a class="tm-count-badge" href="/light/posts?search=${encodeURIComponent(f.slug || '')}" title="View posts tagged ${escapeHtml(f.slug || '')}">${f.post_count || 0}</a>` : ''}</h3>`,
      '  </div>',
      '  <form id="tag-editor-form">',
      '    <div class="modal-body">',

      // — Identity —
      '      <div class="title-row">',
      `        <input type="text" name="name" class="form-input editor-title" placeholder="Tag name" value="${escapeHtml(f.name || '')}" required>`,
      '      </div>',
      '      <div class="slug-row">',
      '        <span class="slug-prefix">/tags/</span>',
      `        <input type="text" name="slug" id="modal-slug" class="form-input editor-slug" placeholder="tag-slug" value="${escapeHtml(f.slug || '')}" spellcheck="false">`,
      '      </div>',
      '      <div class="form-group">',
      `        <textarea name="description" class="form-input editor-excerpt" rows="2" placeholder="Tag description…">${escapeHtml(f.description || '')}</textarea>`,
      '      </div>',

      // — Visibility —
      '      <div class="tm-collapsible-section">',
      '        <button type="button" class="tm-section-toggle" data-target="visibility-body">',
      '          <span class="tm-section-arrow">▶</span> Visibility',
      `          <span class="tm-section-count">${(f.hidden || f.effective_hidden) ? '🚫' : ''}</span>`,
      '        </button>',
      '        <div class="tm-section-body hidden" id="visibility-body">',
      this._renderVisibilitySection(f),
      '        </div>',
      '      </div>',

      // — Display —
      '      <div class="tm-collapsible-section">',
      '        <button type="button" class="tm-section-toggle" data-target="display-body">',
      '          <span class="tm-section-arrow">▶</span> Display',
      `          <span class="tm-section-count">${inNav ? '⌂' : ''}</span>`,
      '        </button>',
      '        <div class="tm-section-body hidden" id="display-body">',
      `          <label class="tm-flag-row">`,
      `            <input type="checkbox" name="in_nav" id="in-nav-check"${inNav ? ' checked' : ''}>`,
      `            In public navigation`,
      `          </label>`,
      `          <div class="tm-nav-order-row${inNav ? '' : ' hidden'}" id="nav-order-row">`,
      `            <span class="slug-prefix">Position</span>`,
      `            <input type="number" name="nav_order" class="form-input editor-slug" min="0" step="1" value="${escapeHtml(String(navOrder))}" placeholder="1, 2, 3…">`,
      `          </div>`,
      `          <label class="tm-flag-row">`,
      `            <input type="checkbox" name="in_breadcrumbs"${f.in_breadcrumbs ? ' checked' : ''}>`,
      `            In breadcrumbs`,
      `          </label>`,
      `          <label class="tm-flag-row">`,
      `            <input type="checkbox" name="show_related"${f.show_related ? ' checked' : ''}>`,
      `            Show related tags`,
      `          </label>`,
      `          <label class="tm-flag-row">`,
      `            <input type="checkbox" name="in_ancestor_flyout"${(isEdit ? f.in_ancestor_flyout : true) ? ' checked' : ''}>`,
      `            Show in ancestor flyout`,
      `          </label>`,
      '        </div>',
      '      </div>',

      // — Kind —
      '      <div class="tm-collapsible-section">',
      '        <button type="button" class="tm-section-toggle" data-target="kind-body">',
      '          <span class="tm-section-arrow">▶</span> Kind',
      `          <span class="tm-section-count">${kind !== 'topic' ? kind : ''}</span>`,
      '        </button>',
      '        <div class="tm-section-body hidden" id="kind-body">',
      `          <label class="tm-flag-row"><input type="radio" name="kind" value="topic"${kind === 'topic' ? ' checked' : ''}> Topic</label>`,
      `          <label class="tm-flag-row"><input type="radio" name="kind" value="year"${kind === 'year' ? ' checked' : ''}> Year <span class="form-hint">(slug must be a 4-digit year)</span></label>`,
      '        </div>',
      '      </div>',

      // — Structure —
      '      <div class="tm-collapsible-section">',
      '        <button type="button" class="tm-section-toggle" data-target="structure-body">',
      `          <span class="tm-section-arrow">▶</span> Structure`,
      `          <span class="tm-section-count">${selParents.length > 0 ? selParents.length + ' parents' : ''}</span>`,
      '        </button>',
      '        <div class="tm-section-body hidden" id="structure-body">',
      '          <p class="tm-section-label">Parents</p>',
      '          <input type="text" class="form-input tm-toggle-search" placeholder="Search tags…" autocomplete="off">',
      '          <div class="tag-toggles-container">',
      this._renderTagToggles('parent_ids', this.state.tags, selfId, selParents),
      '          </div>',
      '          <p class="tm-section-label">Children</p>',
      '          <input type="text" class="form-input tm-toggle-search" placeholder="Search tags…" autocomplete="off">',
      '          <div class="tag-toggles-container">',
      this._renderTagToggles('child_ids', this.state.tags, selfId, selChildren),
      '          </div>',
      '        </div>',
      '      </div>',

      // — Coordinates —
      '      <div class="tm-collapsible-section">',
      '        <button type="button" class="tm-section-toggle" data-target="coords-body">',
      `          <span class="tm-section-arrow">▶</span> Coordinates`,
      `          <span class="tm-section-count">${existingLat != null ? '📍' : ''}</span>`,
      '        </button>',
      '        <div class="tm-section-body hidden" id="coords-body">',
      '          <div class="input-with-btn">',
      `            <input type="text" id="coordinates-input" class="form-input" placeholder="Paste a Maps link, “45.507° N, 73.554° W”, or leave blank to geocode by name">`,
      `            <button type="button" id="gmaps-parse-btn" class="btn btn-secondary">${isEdit ? 'Parse / Geocode' : 'Parse'}</button>`,
      '          </div>',
      '          <div class="slug-row">',
      '            <span class="slug-prefix">Lat</span>',
      `            <input type="number" name="latitude" id="coord-lat" class="form-input editor-slug" step="any" value="${existingLat != null ? existingLat : ''}" placeholder="e.g. 48.8566">`,
      '          </div>',
      '          <div class="slug-row">',
      '            <span class="slug-prefix">Lng</span>',
      `            <input type="number" name="longitude" id="coord-lng" class="form-input editor-slug" step="any" value="${existingLng != null ? existingLng : ''}" placeholder="e.g. 2.3522">`,
      '          </div>',
      '          <p class="form-hint">Leave blank to remove coordinates.</p>',
      '        </div>',
      '      </div>',

      '    </div>',
      '    <div class="modal-footer">',
      '      <button type="button" class="btn btn-secondary" id="modal-cancel-btn">Cancel</button>',
      `      <button type="submit" class="btn btn-primary">${isEdit ? 'Save Changes' : 'Create Tag'}</button>`,
      '    </div>',
      '  </form>',
      '</div>',
    ].join('\n');

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

  _renderVisibilitySection(f) {
    const isEffectivelyHidden = f.effective_hidden && !f.hidden;
    const hiddenViaAncestor = isEffectivelyHidden && f.hidden_via
      ? `<span class="tm-inherited-chip">inherited — <button type="button" class="tm-badge-via-btn" data-open-tag-id="${f.hidden_via}">change at ancestor</button></span>`
      : (isEffectivelyHidden ? `<span class="tm-inherited-chip">inherited from ancestor</span>` : '');

    return [
      `<label class="tm-flag-row">`,
      `  <input type="checkbox" name="hidden"${f.hidden ? ' checked' : ''}>`,
      `  Hidden (from public tag cloud and tag pages)`,
      `</label>`,
      hiddenViaAncestor,
      `<label class="tm-flag-row">`,
      `  <input type="checkbox" name="hides_posts"${f.hides_posts ? ' checked' : ''}>`,
      `  Hide posts (all posts with this tag are hidden from public)`,
      `</label>`,
    ].join('\n');
  }

  /** Render tag-badge toggle checkboxes for parent/children selection. */
  _renderTagToggles(inputName, allTags, selfId, selectedIds) {
    const available = allTags.filter(t => t.id !== selfId);
    if (!available.length) return '<span class="tag-toggles-empty">No other tags available.</span>';

    const selectedSet = new Set(selectedIds);
    const treeById = new Map(available.map(t => [t.id, t]));

    const childrenOf = new Map();
    available.forEach(t => {
      (t.parents || []).forEach(p => {
        if (treeById.has(p.id)) {
          if (!childrenOf.has(p.id)) childrenOf.set(p.id, []);
          childrenOf.get(p.id).push(t);
        }
      });
    });

    const roots = available
      .filter(t => !(t.parents || []).some(p => treeById.has(p.id)))
      .sort((a, b) => {
        const ao = a.nav_order ?? Infinity;
        const bo = b.nav_order ?? Infinity;
        if (ao !== bo) return ao - bo;
        return a.name.localeCompare(b.name);
      });

    const hasCheckedDesc = new Set();
    const visiting = new Set();
    const markDesc = (id) => {
      if (visiting.has(id)) return selectedSet.has(id);
      visiting.add(id);
      let anyChecked = selectedSet.has(id);
      for (const kid of (childrenOf.get(id) || [])) { if (markDesc(kid.id)) anyChecked = true; }
      if (anyChecked && !selectedSet.has(id)) hasCheckedDesc.add(id);
      return anyChecked;
    };
    roots.forEach(r => markDesc(r.id));

    const rendered = new Set();
    const renderNode = (t, level) => {
      if (rendered.has(t.id)) return '';
      rendered.add(t.id);
      const kids = (childrenOf.get(t.id) || [])
        .sort((a, b) => {
          const ao = a.sort_order ?? Infinity;
          const bo = b.sort_order ?? Infinity;
          if (ao !== bo) return ao - bo;
          return a.name.localeCompare(b.name);
        });
      const hasKids = kids.length > 0;
      const expanded = hasCheckedDesc.has(t.id);
      const nodeId = `tt-${inputName}-${t.id}`;
      const toggleBtn = hasKids
        ? `<button type="button" class="tag-toggle-btn" data-tt-toggle="${nodeId}" aria-expanded="${expanded}">${expanded ? '▼' : '▶'}</button>`
        : `<span class="tag-toggle-btn-spacer"></span>`;
      const childList = hasKids
        ? `<ul class="tag-toggle-tree level-${level + 1}${expanded ? '' : ' hidden'}" id="${nodeId}">${kids.map(k => renderNode(k, level + 1)).join('')}</ul>`
        : '';
      return `<li class="tag-toggle-node">
        <div class="tag-toggle-row">
          ${toggleBtn}
          <label class="tag-toggle">
            <input type="checkbox" name="${inputName}" value="${t.id}"${selectedSet.has(t.id) ? ' checked' : ''}>
            <span>${escapeHtml(t.name)}</span>
          </label>
        </div>
        ${childList}
      </li>`;
    };

    const treeInner = roots.map(r => renderNode(r, 0)).join('');
    return treeInner
      ? `<ul class="tag-toggle-tree level-0">${treeInner}</ul>`
      : '<span class="tag-toggles-empty">No other tags available.</span>';
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

  _slugify(text) {
    return text.toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

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
    const nav_order   = inNav && navOrderRaw !== '' ? parseInt(navOrderRaw, 10) : null;

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
    try {
      const fresh = await getNavMenu();
      store.set('navTags', fresh.menu || []);
    } catch { /* ignore */ }
  }
}

function _arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  return sa.every((v, i) => v === sb[i]);
}
