/**
 * TagsManagerPage — hierarchical tag management.
 *
 * Two views: "tree" (multi-parent DAG, expand/collapse) and "list" (tabular).
 * Tag editor: full modal with all fields, flag checkboxes, and tag-badge
 * toggles for selecting parents and children (many-to-many).
 * Tree view supports drag-and-drop reordering of siblings via sort_order.
 * All user-supplied strings are escaped with escapeHtml() before interpolation.
 */

import { Component } from '../../components/Component.js';
import { LightSidebar } from '../../components/light/LightSidebar.js';
import { ConfirmDialog } from '../../components/shared/ConfirmDialog.js';
import { listTags, createTag, updateTag, deleteTag, recalculateCounts, reorderTag, geocodeTag } from '../../api/tags.js';
import { parseMapsCoords } from '../../api/util.js';
import { logout } from '../../api/auth.js';
import { store } from '../../store.js';
import { escapeHtml, navigate } from '../../utils/helpers.js';

export default class TagsManagerPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      tags: [],
      error: null,
      view: 'tree',        // 'tree' | 'list'
      expanded: new Set(), // IDs of expanded nodes in tree view
      sortField: 'sort_order',
      sortOrder: 'asc',    // 'asc' | 'desc'
    };
    this._modal = null;
    this._modalKeyHandler = null;
    this._didPushUrl = false;
    this._dragState = null; // { tagId, parentId }
    // List-view filter state (persists across tree↔list switches)
    this._listSearch = '';
    this._listFilterParents = []; // [{id, name}]
  }

  render() {
    const { loading, error, tags, view } = this.state;

    let content;
    if (loading) {
      content = `<div class="loading-spinner" aria-label="Loading tags\u2026"></div>`;
    } else if (error) {
      content = `<p class="error-state" role="alert">${escapeHtml(error)}</p>`;
    } else if (view === 'tree') {
      content = `<div class="tags-tree-container">${this._renderTree(this._buildTree(tags))}</div>`;
    } else {
      content = this._renderList(tags);
    }

    return `
      <div class="light-layout">
        <div id="sidebar-mount"></div>
        <div class="light-main">
          <header class="light-header">
            <h1>Tags</h1>
            <div class="header-actions">
              <div class="tm-view-toggle">
                <button id="view-tree-btn" class="btn btn-sm${view === 'tree' ? ' btn-primary' : ' btn-secondary'}" title="Tree view">\u29ad Tree</button>
                <button id="view-list-btn" class="btn btn-sm${view === 'list' ? ' btn-primary' : ' btn-secondary'}" title="List view">\u2261 List</button>
              </div>
              <button id="add-root-tag-btn" class="btn btn-primary">+ New Tag</button>
              <button id="recalc-counts-btn" class="btn btn-secondary" title="Recalculate post counts">\u27f3</button>
            </div>
          </header>
          <main class="light-content">
            <div class="card">
              <div class="card-body">
                ${content}
              </div>
            </div>
          </main>
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
          valA = a.sort_order ?? Infinity; valB = b.sort_order ?? Infinity;
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
      const isSystem = !!tag.is_system;
      const systemBadge = isSystem ? ' <span class="tm-system-badge" title="System tag">\ud83d\udd12</span>' : '';

      return `
        <tr class="tm-tag-row" data-name="${escapeHtml(tag.name.toLowerCase())}" data-slug="${escapeHtml(tag.slug.toLowerCase())}" data-parent-ids="${parentIds}" data-parent-names="${escapeHtml(parentNamesLower)}">
          <td><span class="tm-tag-name">${escapeHtml(tag.name)}${systemBadge}</span></td>
          <td><code class="tm-slug">${escapeHtml(tag.slug)}</code></td>
          <td class="text-center"><span class="tm-count-badge">${tag.post_count || 0}</span></td>
          <td class="text-center">
            <span class="tm-flag-static ${hasLocation ? 'active' : ''} tm-flag-location"
                  title="${hasLocation ? 'Has coordinates' : 'No coordinates'}">\ud83d\udccd</span>
          </td>
          <td><div class="tm-parents-cell">${parentBadges || '<span class="text-muted">\u2014</span>'}</div></td>
          <td class="tm-actions">
            <button class="btn btn-sm edit-tag-btn"   data-id="${tag.id}" title="Edit"${isSystem ? ' disabled' : ''}>\u270e</button>
            <button class="btn btn-sm btn-danger delete-tag-btn" data-id="${tag.id}" title="Delete"${isSystem ? ' disabled' : ''}>\u2715</button>
          </td>
        </tr>`;
    }).join('');

    const chips = this._listFilterParents.map(p =>
      `<button type="button" class="tm-filter-chip" data-remove-id="${p.id}">${escapeHtml(p.name)} <span class="tm-chip-remove">\u00d7</span></button>`
    ).join('');
    const hasFilters = this._listSearch || this._listFilterParents.length > 0;

    return `
      <div class="tm-list-filter-bar">
        <div class="tm-list-search-row">
          <input type="text" class="form-input tm-list-search" placeholder="Search name, slug, parents\u2026" value="${escapeHtml(this._listSearch || '')}">
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
              ${this._renderSortHeader('locations', '\ud83d\udccd', 'text-center', 'Coordinates')}
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
    this.$$('.tm-tag-row').forEach(row => {
      const textMatch = !q ||
        row.dataset.name.includes(q) ||
        row.dataset.slug.includes(q) ||
        row.dataset.parentNames.includes(q);
      const rowParentIds = row.dataset.parentIds ? row.dataset.parentIds.split(',').map(Number) : [];
      const parentMatch = filterIds.length === 0 || filterIds.every(id => rowParentIds.includes(id));
      row.style.display = (textMatch && parentMatch) ? '' : 'none';
    });
  }

  _updateFilterChips() {
    const chips = this.$('#tm-filter-chips');
    if (!chips) return;
    chips.innerHTML = this._listFilterParents.map(p =>
      `<button type="button" class="tm-filter-chip" data-remove-id="${p.id}">${escapeHtml(p.name)} <span class="tm-chip-remove">\u00d7</span></button>`
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
    const btn = this.$('.tm-clear-filters');
    const hasFilters = (this._listSearch || '') || this._listFilterParents.length > 0;
    if (btn) {
      btn.style.display = hasFilters ? '' : 'none';
    } else if (hasFilters) {
      // Re-render list to show the clear button
      const listWrap = this.$('.tm-list-filter-bar');
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
    const searchInput = this.$('.tm-list-search');
    if (searchInput) searchInput.value = '';
    this._updateFilterChips();
    this._applyListFilter();
    const btn = this.$('.tm-clear-filters');
    if (btn) btn.style.display = 'none';
  }

  _renderSortHeader(field, label, className = '', title = '') {
    const { sortField, sortOrder } = this.state;
    const isActive = sortField === field;
    const icon = isActive ? (sortOrder === 'asc' ? ' \u25b4' : ' \u25be') : '';

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

  // ── Tree view (multi-parent DAG) ─────────────────────────────────────────────

  /**
   * Build a forest from the flat tag list.
   * Tags with multiple parents appear under each parent (multi-parent DAG).
   * ancestorIds prevents infinite cycles.
   */
  _buildTree(tags) {
    // Only _root and _pending are shown as top-level nodes.
    // All other system tags (_system, _hidden, _hide_posts, etc.) are excluded.
    const VISIBLE_SYSTEM = new Set(['_root', '_pending']);
    const HIDDEN_SYSTEM  = new Set(['_system', '_hidden', '_hide_posts', '_is_in_breadcrumbs', '_with_related']);

    // Build adjacency map across all tags so user-tag subtrees work correctly.
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
      if (a.sort_order != null && b.sort_order != null) return a.sort_order - b.sort_order;
      if (a.sort_order != null) return -1;
      if (b.sort_order != null) return 1;
      return a.name.localeCompare(b.name);
    };

    // Recursive builder — only include non-hidden-system tags as children.
    const makeNode = (tag, ancestorIds) => {
      const kids = (childrenOf.get(tag.id) || [])
        .filter(c => !HIDDEN_SYSTEM.has(c.slug) && !ancestorIds.has(c.id));
      kids.sort(sortFn);
      return {
        ...tag,
        childrenNodes: kids.map(c => makeNode(c, new Set([...ancestorIds, c.id]))),
      };
    };

    // Top level: _root first, _pending second (if they exist).
    return ['_root', '_pending']
      .map(slug => tags.find(t => t.slug === slug))
      .filter(Boolean)
      .map(t => makeNode(t, new Set([t.id])));
  }

  _renderTree(nodes, level = 0, parentId = null) {
    if (!nodes.length) return level === 0 ? '<p class="empty-state">No tags found.</p>' : '';
    return `<ul class="tm-tree level-${level}" data-parent-id="${parentId ?? ''}">${nodes.map(n => this._renderNode(n, level, parentId)).join('')}</ul>`;
  }

  _renderNode(node, level, parentId) {
    const isExpanded = this.state.expanded.has(node.id);
    const hasChildren = node.childrenNodes.length > 0;

    const toggle = hasChildren
      ? `<button class="tm-toggle" data-id="${node.id}">${isExpanded ? '\u25bc' : '\u25b6'}</button>`
      : `<span class="tm-toggle-spacer"></span>`;

    const hasLocation = node.locations?.length > 0;
    const locationFlag = `<button type="button" disabled class="btn btn-sm tm-flag-static ${hasLocation ? 'active' : ''} tm-flag-location"
                                title="${hasLocation ? 'Has coordinates' : 'No coordinates'}">\ud83d\udccd</button>`;

    const isSystem = !!node.is_system;
    const systemBadge = isSystem ? ' <span class="tm-system-badge" title="System tag">\ud83d\udd12</span>' : '';

    // Multi-parent indicator: show other parents (not the one rendering this node)
    const otherParents = (node.parents || []).slice(1);
    const multiParentHint = otherParents.length > 0
      ? `<span class="tm-multi-parent" title="Also child of: ${otherParents.map(p => escapeHtml(p.name)).join(', ')}">\u2387</span>`
      : '';

    const parentAttr = parentId != null ? parentId : '';

    return `
      <li class="tm-node${isSystem ? ' tm-system-node' : ''}" data-id="${node.id}">
        <div class="tm-row" draggable="true" data-id="${node.id}" data-parent-id="${parentAttr}">
          <span class="tm-drag-handle" title="Drag to reorder">\u22ee\u22ee</span>
          ${toggle}
          <div class="tm-node-body">
            <span class="tm-tag-name">${escapeHtml(node.name)}${systemBadge}</span>
          </div>
          <div class="tm-flags-row">${locationFlag}</div>
          <span class="tm-row-meta">
            <span class="tm-count-badge">${node.post_count || 0}</span>
            ${multiParentHint}
          </span>
          <div class="tm-actions">
            <button class="btn btn-sm edit-tag-btn"    data-id="${node.id}" title="Edit"${isSystem ? ' disabled' : ''}>\u270e</button>
            <button class="btn btn-sm add-child-btn"   data-id="${node.id}" title="Add child">+</button>
            <button class="btn btn-sm btn-danger delete-tag-btn" data-id="${node.id}" title="Delete"${isSystem ? ' disabled' : ''}>\u2715</button>
          </div>
        </div>
        ${isExpanded && hasChildren ? this._renderTree(node.childrenNodes, level + 1, node.id) : ''}
      </li>`;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────────

  mount() { super.mount(); this._load(); }

  beforeUnmount() { this._closeModal(); }

  afterRender() {
    const tagSlug = this.props?.params?.slug;
    this.mountChild(LightSidebar, '#sidebar-mount', {
      currentPath: '/light/tags',
      publicUrl: tagSlug ? `/tag/${tagSlug}` : '/',
      user: store.get('user') || {},
      onLogout: this._handleLogout.bind(this),
    });

    if (this.state.loading || this.state.error) return;

    this.$('#view-tree-btn')?.addEventListener('click', () => this.setState({ view: 'tree' }));
    this.$('#view-list-btn')?.addEventListener('click', () => this.setState({ view: 'list' }));
    this.$('#add-root-tag-btn')?.addEventListener('click', () => this._openModal());
    this.$('#recalc-counts-btn')?.addEventListener('click', () => this._handleRecalc());

    if (this.state.view === 'tree') {
      this.$$('.tm-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = parseInt(btn.dataset.id, 10);
          const expanded = new Set(this.state.expanded);
          if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
          this.setState({ expanded });
        });
      });
      this.$$('.add-child-btn').forEach(btn => {
        btn.addEventListener('click', () => this._openModal(null, parseInt(btn.dataset.id, 10)));
      });

      this._bindDragAndDrop();
    }

    this.$$('.edit-tag-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.id, 10);
        this._openModal(this.state.tags.find(t => t.id === id));
      });
    });

    this.$$('.delete-tag-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.id, 10);
        const tag = this.state.tags.find(t => t.id === id);
        this._showConfirm('Delete tag', `Delete tag "${tag?.name}"? Posts will NOT be deleted.`, 'Delete', 'danger', () => {
          this._handleDelete(id);
        });
      });
    });

    if (this.state.view === 'list') {
      this.$$('.tm-sortable-header').forEach(th => {
        th.addEventListener('click', () => this._handleSort(th.dataset.field));
      });

      // Search input
      const searchInput = this.$('.tm-list-search');
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

      // Parent filter buttons (click a parent badge to add it as a filter chip)
      this.$$('.tm-parent-filter-btn').forEach(btn => {
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

      // Clear button
      this.$('.tm-clear-filters')?.addEventListener('click', () => this._clearListFilters());

      // Wire existing chips (rendered from state on initial load)
      this._updateFilterChips();
      // Re-apply filter immediately (restores after sort/view-switch)
      this._applyListFilter();
    }
  }

  _handleSort(field) {
    const { sortField, sortOrder } = this.state;
    if (sortField === field) {
      this.setState({ sortOrder: sortOrder === 'asc' ? 'desc' : 'asc' });
    } else {
      this.setState({ sortField: field, sortOrder: 'asc' });
    }
  }

  // ── Drag and Drop ────────────────────────────────────────────────────────────

  _bindDragAndDrop() {
    const rows = this.$$('.tm-row[draggable="true"]');

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
        this.$$('.tm-row').forEach(r => r.classList.remove('tm-drop-before', 'tm-drop-after'));
        this._dragState = null;
      });

      row.addEventListener('dragover', e => {
        if (!this._dragState) return;
        const dragId = this._dragState.tagId;
        const targetId = parseInt(row.dataset.id, 10);
        if (dragId === targetId) return;

        // Only allow reorder within the same parent context.
        const rowParentId = row.dataset.parentId !== '' ? parseInt(row.dataset.parentId, 10) : null;
        if (rowParentId !== this._dragState.parentId) return;

        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        // Show before/after indicator based on vertical position.
        const rect = row.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        this.$$('.tm-row').forEach(r => r.classList.remove('tm-drop-before', 'tm-drop-after'));
        if (e.clientY < midY) {
          row.classList.add('tm-drop-before');
        } else {
          row.classList.add('tm-drop-after');
        }
      });

      row.addEventListener('dragleave', () => {
        row.classList.remove('tm-drop-before', 'tm-drop-after');
      });

      row.addEventListener('drop', async e => {
        e.preventDefault();
        if (!this._dragState) return;

        const dragId   = this._dragState.tagId;
        const parentId = this._dragState.parentId;
        const targetId = parseInt(row.dataset.id, 10);
        if (dragId === targetId) return;

        const position = row.classList.contains('tm-drop-before') ? 'before' : 'after';
        row.classList.remove('tm-drop-before', 'tm-drop-after');
        this._dragState = null;

        try {
          await reorderTag(dragId, {
            target_id: targetId,
            position,
            parent_id: parentId,
          });
          this._load();
        } catch (err) {
          store.set('toast', { message: err.message || 'Reorder failed.', type: 'error' });
        }
      });
    });
  }

  // ── Modal ────────────────────────────────────────────────────────────────────

  _openModal(tag = null, parentId = null, { fromUrl = false } = {}) {
    this._closeModal();

    const isEdit      = !!tag;
    const f           = tag || {};
    const isSystem    = isEdit && !!f.is_system;
    const existingLoc = f.locations?.[0] ?? null;
    const selfId      = isEdit ? f.id : null;
    const selParents  = isEdit ? (f.parents  || []).map(p => p.id) : (parentId ? [parentId] : []);
    const selChildren = isEdit ? (f.children || []).map(c => c.id) : [];

    const modal = document.createElement('div');
    modal.className = 'modal-overlay active';

    // All user content is wrapped in escapeHtml(). HTML structure is static.
    const html = [
      '<div class="modal tag-editor-modal" role="dialog" aria-modal="true">',
      '  <button class="modal-close" aria-label="Close">\u00d7</button>',
      '  <div class="modal-header">',
      `    <h3>${isEdit ? 'Edit: ' + escapeHtml(f.name) : 'New Tag'}${isEdit ? ` <span class="tm-count-badge" title="Posts with this tag">${f.post_count || 0}</span>` : ''}</h3>`,
      '  </div>',
      '  <form id="tag-editor-form">',
      '    <div class="modal-body">',

      // Name (title-style, like post editor)
      '      <div class="title-row">',
      `        <input type="text" name="name" class="form-input editor-title" placeholder="Tag name" value="${escapeHtml(f.name || '')}"${isSystem ? ' readonly' : ' required'}>`,
      '      </div>',

      // Slug (slug-row with /tag/ prefix, like post editor)
      '      <div class="slug-row">',
      '        <span class="slug-prefix">/tag/</span>',
      `        <input type="text" name="slug" id="modal-slug" class="form-input editor-slug" placeholder="tag-slug" value="${escapeHtml(f.slug || '')}" spellcheck="false"${isSystem ? ' readonly' : ''}>`,
      '      </div>',

      // Description (excerpt-style, like post editor)
      '      <div class="form-group">',
      `        <textarea name="description" class="form-input editor-excerpt" rows="2" placeholder="Tag description\u2026">${escapeHtml(f.description || '')}</textarea>`,
      '      </div>',

      // System flag tags — always inline, right below description
      this._renderSystemFlags(selParents),

      // Parents (collapsible) — hidden for system tags (parents are fixed)
      ...(isSystem ? [] : [
        '      <div class="tm-collapsible-section">',
        '        <button type="button" class="tm-section-toggle" data-target="parents-body">',
        `          <span class="tm-section-arrow">\u25b6</span> Parents`,
        `          <span class="tm-section-count">${selParents.length > 0 ? selParents.length : ''}</span>`,
        '        </button>',
        '        <div class="tm-section-body" id="parents-body" style="display:none">',
        '          <input type="text" class="form-input tm-toggle-search" placeholder="Search tags\u2026" autocomplete="off">',
        '          <div class="tag-toggles-container">',
        this._renderTagToggles('parent_ids', this.state.tags, selfId, selParents),
        '          </div>',
        '        </div>',
        '      </div>',
      ]),

      // Children (collapsible) — only user tags are selectable as children
      '      <div class="tm-collapsible-section">',
      '        <button type="button" class="tm-section-toggle" data-target="children-body">',
      `          <span class="tm-section-arrow">\u25b6</span> Children`,
      `          <span class="tm-section-count">${selChildren.length > 0 ? selChildren.length : ''}</span>`,
      '        </button>',
      '        <div class="tm-section-body" id="children-body" style="display:none">',
      '          <input type="text" class="form-input tm-toggle-search" placeholder="Search tags\u2026" autocomplete="off">',
      '          <div class="tag-toggles-container">',
      this._renderTagToggles('child_ids', this.state.tags.filter(t => !t.is_system), selfId, selChildren),
      '          </div>',
      '        </div>',
      '      </div>',

      // Map coordinates (collapsible) — hidden for system tags
      ...(isSystem ? [] : [
        '      <div class="tm-collapsible-section">',
        '        <button type="button" class="tm-section-toggle" data-target="coords-body">',
        '          <span class="tm-section-arrow">\u25b6</span> Map Coordinates',
        `          <span class="tm-section-count">${existingLoc ? '\ud83d\udccd' : ''}</span>`,
        '        </button>',
        '        <div class="tm-section-body" id="coords-body" style="display:none">',
        '          <div class="input-with-btn">',
        `            <input type="text" id="coordinates-input" class="form-input" placeholder="Paste a Maps link, \u201c45.507\u00b0 N, 73.554\u00b0 W\u201d, or leave blank to geocode by name">`,
        `            <button type="button" id="gmaps-parse-btn" class="btn btn-secondary">${isEdit ? 'Parse / Geocode' : 'Parse'}</button>`,
        '          </div>',
        '          <div class="slug-row">',
        '            <span class="slug-prefix">Lat</span>',
        `            <input type="number" name="latitude" id="coord-lat" class="form-input editor-slug" step="any" value="${existingLoc ? existingLoc.latitude : ''}" placeholder="e.g. 48.8566">`,
        '          </div>',
        '          <div class="slug-row">',
        '            <span class="slug-prefix">Lng</span>',
        `            <input type="number" name="longitude" id="coord-lng" class="form-input editor-slug" step="any" value="${existingLoc ? existingLoc.longitude : ''}" placeholder="e.g. 2.3522">`,
        '          </div>',
        '          <p class="form-hint">Leave blank to remove coordinates. Used to place this tag on the map page.</p>',
        '        </div>',
        '      </div>',
      ]),

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

    // Reflect the open tag in the browser URL.
    const urlSlug = isEdit ? f.slug : 'new';
    const targetPath = `/light/tags/${urlSlug}`;
    if (!fromUrl && location.pathname !== targetPath) {
      history.pushState(null, '', targetPath);
      this._didPushUrl = true;
    }

    // Auto-generate slug from name (disabled for system tags — both fields are readonly).
    const nameInput = modal.querySelector('[name="name"]');
    const slugInput = modal.querySelector('#modal-slug');
    if (!isSystem) {
      if (isEdit) slugInput.dataset.manual = '1';
      nameInput.addEventListener('input', () => {
        if (!slugInput.dataset.manual) slugInput.value = this._slugify(nameInput.value);
      });
      slugInput.addEventListener('input', () => { slugInput.dataset.manual = '1'; });
    }

    modal.querySelectorAll('.tm-section-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.target;
        const body = modal.querySelector(`#${targetId}`);
        const arrow = btn.querySelector('.tm-section-arrow');
        const isOpen = body.style.display !== 'none';
        body.style.display = isOpen ? 'none' : 'block';
        arrow.textContent = isOpen ? '\u25b6' : '\u25bc';
      });
    });

    // Parse / Geocode button (not rendered for system tags).
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
        parseBtn.textContent = locked ? '\u2026' : (isEdit ? 'Parse / Geocode' : 'Parse');
      };

      setLocked(true);
      try {
        if (raw) {
          // Parse coordinates from URL or string.
          const coords = await parseMapsCoords(raw);
          latInput.value = coords.lat;
          lngInput.value = coords.lng;
          coordInput.value = '';
        } else if (isEdit) {
          // Geocode by tag name via Nominatim.
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

    this._modalKeyHandler = e => { if (e.key === 'Escape') this._closeModal(); };
    document.addEventListener('keydown', this._modalKeyHandler);
    nameInput.focus();
  }

  /**
   * Render the four flag system tags (_hidden, _hide_posts, _is_in_breadcrumbs, _with_related)
   * as an inline pill strip, positioned below Description in the modal.
   * The checkboxes use name="parent_ids" so they're included in the save payload.
   */
  _renderSystemFlags(selectedIds) {
    const FLAG_SLUGS = ['_hidden', '_hide_posts', '_is_in_breadcrumbs', '_with_related'];
    const selectedSet = new Set(selectedIds);
    const flagTags = FLAG_SLUGS.map(s => this.state.tags.find(t => t.slug === s)).filter(Boolean);
    if (!flagTags.length) return '';
    const pills = flagTags.map(t =>
      `<span class="tag-toggle-system-item tm-system-node">
        <label class="tag-toggle">
          <input type="checkbox" name="parent_ids" value="${t.id}"${selectedSet.has(t.id) ? ' checked' : ''}>
          <span>${escapeHtml(t.name)}</span>
        </label>
      </span>`
    ).join('');
    return `<div class="tag-toggle-system-strip tm-flags-inline-strip">${pills}</div>`;
  }

  /** Render tag-badge toggle checkboxes for parent/children selection (tree only).
   *
   * Excluded: _system, _pending, and the four flag tags (shown inline above).
   */
  _renderTagToggles(inputName, allTags, selfId, selectedIds) {
    const EXCLUDE = new Set(['_system', '_pending', '_hidden', '_hide_posts', '_is_in_breadcrumbs', '_with_related']);

    const available = allTags.filter(t => t.id !== selfId && !EXCLUDE.has(t.slug));
    if (!available.length) return '<span class="tag-toggles-empty">No other tags available.</span>';

    const selectedSet = new Set(selectedIds);

    // ── Tree section (_root + user tags) ─────────────────────────────────────
    const treeItems = available; // _root + user tags
    const treeById  = new Map(treeItems.map(t => [t.id, t]));

    const childrenOf = new Map();
    treeItems.forEach(t => {
      (t.parents || []).forEach(p => {
        if (treeById.has(p.id)) {
          if (!childrenOf.has(p.id)) childrenOf.set(p.id, []);
          childrenOf.get(p.id).push(t);
        }
      });
    });

    // Roots = no parent in the tree set. _root sorts first.
    const roots = treeItems
      .filter(t => !(t.parents || []).some(p => treeById.has(p.id)))
      .sort((a, b) => {
        if (a.slug === '_root') return -1;
        if (b.slug === '_root') return 1;
        return (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity) || a.name.localeCompare(b.name);
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
        .sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity) || a.name.localeCompare(b.name));
      const hasKids = kids.length > 0;
      const expanded = hasCheckedDesc.has(t.id);
      const nodeId = `tt-${inputName}-${t.id}`;
      const toggleBtn = hasKids
        ? `<button type="button" class="tag-toggle-btn" data-tt-toggle="${nodeId}" aria-expanded="${expanded}">${expanded ? '\u25bc' : '\u25b6'}</button>`
        : `<span class="tag-toggle-btn-spacer"></span>`;
      const childList = hasKids
        ? `<ul class="tag-toggle-tree level-${level + 1}" id="${nodeId}"${expanded ? '' : ' style="display:none"'}>${kids.map(k => renderNode(k, level + 1)).join('')}</ul>`
        : '';
      return `<li class="tag-toggle-node${t.is_system ? ' tm-system-node' : ''}">
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

  /**
   * Wire expand/collapse buttons and indeterminate checkbox state for the
   * tag-toggle trees rendered inside a modal.  Must be called after the modal
   * HTML has been inserted into the DOM.
   */
  _initTagToggleTrees(modal) {
    // Recompute indeterminate state for every node in a tree, bottom-up.
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

    // Wire expand/collapse buttons.
    modal.querySelectorAll('[data-tt-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const list = modal.querySelector(`#${btn.dataset.ttToggle}`);
        if (!list) return;
        const open = list.style.display !== 'none';
        list.style.display = open ? 'none' : '';
        btn.setAttribute('aria-expanded', String(!open));
        btn.textContent = open ? '\u25b6' : '\u25bc';
      });
    });

    // Set initial indeterminate state.
    modal.querySelectorAll('.tag-toggle-tree.level-0').forEach(tree => updateIndeterminate(tree));

    // Keep indeterminate live: attach directly to each checkbox to avoid
    // relying on change-event bubbling through ul/li ancestors.
    modal.querySelectorAll('.tag-toggle-tree input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => {
        const tree = cb.closest('.tag-toggle-tree.level-0');
        if (tree) updateIndeterminate(tree);
      });
    });

    // Wire search inputs — each filters only its own tag-toggles-container.
    modal.querySelectorAll('.tm-toggle-search').forEach(input => {
      const container = input.nextElementSibling; // .tag-toggles-container
      if (!container) return;
      input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        const allNodes = Array.from(container.querySelectorAll('.tag-toggle-node'));
        const allLists = Array.from(container.querySelectorAll('.tag-toggle-tree'));
        if (!q) {
          allNodes.forEach(n => (n.style.display = ''));
          allLists.forEach(l => (l.style.display = ''));
          return;
        }
        allNodes.forEach(n => (n.style.display = 'none'));
        allLists.forEach(l => (l.style.display = 'none'));
        // Show matching nodes and all their ancestors.
        allNodes.forEach(n => {
          const label = n.querySelector(':scope > .tag-toggle-row .tag-toggle span');
          if (label && label.textContent.toLowerCase().includes(q)) {
            let el = n;
            while (el && el !== container) {
              if (el.classList.contains('tag-toggle-node') || el.classList.contains('tag-toggle-tree')) {
                el.style.display = '';
              }
              el = el.parentElement;
            }
          }
        });
      });
    });
  }

  _renderFlagCheckbox(name, icon, label, description, checked) {
    return [
      '<label class="flag-item">',
      `  <input type="checkbox" name="${name}"${checked ? ' checked' : ''}>`,
      '  <span class="flag-item-body">',
      `    <span class="flag-item-icon">${icon}</span>`,
      '    <span class="flag-item-text">',
      `      <strong>${label}</strong><small>${description}</small>`,
      '    </span>',
      '  </span>',
      '</label>',
    ].join('\n');
  }

  _closeModal() {
    if (this._modal) { this._modal.remove(); this._modal = null; }
    if (this._modalKeyHandler) {
      document.removeEventListener('keydown', this._modalKeyHandler);
      this._modalKeyHandler = null;
    }
    // Restore URL to the tags list — only if we're still on a tag-detail URL.
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
      const tags = data.tags || [];
      this.setState({ loading: false, tags });

      // Auto-open editor when navigated directly to /light/tags/:slug
      const slug = this.props?.params?.slug;
      if (slug) {
        const tag = slug === 'new' ? null : tags.find(t => t.slug === slug);
        if (slug === 'new' || tag) {
          this._openModal(tag, null, { fromUrl: true });
        }
      }
    } catch (err) {
      this.setState({ loading: false, error: err.message || 'Failed to load tags.' });
    }
  }

  async _handleSave(form, tagId) {
    const fd = new FormData(form);

    const payload = {
      name:        (fd.get('name') || '').trim(),
      slug:        (fd.get('slug') || '').trim(),
      description: (fd.get('description') || '').trim(),
      custom_url:  '',
      sort_order:  null,
      parent_ids:  fd.getAll('parent_ids').map(v => parseInt(v, 10)),
      child_ids:   fd.getAll('child_ids').map(v => parseInt(v, 10)),
      locations:   (() => {
        const lat = parseFloat(fd.get('latitude') || '');
        const lon = parseFloat(fd.get('longitude') || '');
        return (!isNaN(lat) && !isNaN(lon)) ? [{ latitude: lat, longitude: lon }] : [];
      })(),
    };

    const submitBtn = form.querySelector('[type="submit"]');
    const origText  = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving\u2026';

    try {
      if (tagId) {
        await updateTag(tagId, payload);
        store.set('toast', { message: 'Tag updated.', type: 'success' });
      } else {
        await createTag(payload);
        store.set('toast', { message: 'Tag created.', type: 'success' });
      }
      this._closeModal();
      this._load();
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

  async _handleLogout() {
    try { await logout(); } catch { /* ignore */ }
    store.set('user', null);
    navigate('/light/login', { replace: true });
  }
}
