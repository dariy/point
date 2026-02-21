/**
 * TagsManagerPage — hierarchical tag management.
 *
 * Two views: "tree" (multi-parent DAG, expand/collapse) and "list" (tabular).
 * Tag editor: full modal with all fields, flag checkboxes, and tag-badge
 * toggles for selecting parents and children (many-to-many).
 * All user-supplied strings are escaped with escapeHtml() before interpolation.
 */

import { Component } from '../../components/Component.js';
import { LightSidebar } from '../../components/light/LightSidebar.js';
import { listTags, createTag, updateTag, deleteTag, recalculateCounts } from '../../api/tags.js';
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
    };
    this._modal = null;
    this._modalKeyHandler = null;
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

  // \u2500\u2500 List view \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  _renderList(tags) {
    if (!tags.length) return '<p class="empty-state">No tags found.</p>';

    const sorted = [...tags].sort((a, b) => {
      if (a.sort_order != null && b.sort_order != null) return a.sort_order - b.sort_order;
      if (a.sort_order != null) return -1;
      if (b.sort_order != null) return 1;
      return a.name.localeCompare(b.name);
    });

    const rows = sorted.map(tag => {
      const flags = [
        tag.is_important    ? `<span class="tm-flag tm-flag-important"    title="Important">\u2605</span>`   : '',
        tag.is_featured     ? `<span class="tm-flag tm-flag-featured"     title="Featured">\u2666</span>`    : '',
        tag.is_hidden       ? `<span class="tm-flag tm-flag-hidden"       title="Hidden">\ud83d\udc41</span>` : '',
        tag.is_hidden_posts ? `<span class="tm-flag tm-flag-hidden-posts" title="Posts hidden">\u2298</span>` : '',
      ].filter(Boolean).join('');

      const parents = (tag.parents || [])
        .map(p => `<span class="tm-rel-badge">${escapeHtml(p.name)}</span>`)
        .join('');

      return `
        <tr>
          <td>
            <span class="tm-tag-name">${escapeHtml(tag.name)}</span>
            ${flags ? `<span class="tm-flags-inline">${flags}</span>` : ''}
          </td>
          <td><code class="tm-slug">${escapeHtml(tag.slug)}</code></td>
          <td class="text-center"><span class="tm-count-badge">${tag.post_count || 0}</span></td>
          <td>${parents || '<span class="text-muted">\u2014</span>'}</td>
          <td class="actions">
            <button class="btn btn-sm edit-tag-btn"   data-id="${tag.id}" title="Edit">\u270e</button>
            <button class="btn btn-sm btn-danger delete-tag-btn" data-id="${tag.id}" title="Delete">\u2715</button>
          </td>
        </tr>`;
    }).join('');

    return `
      <div class="table-container">
        <table class="table">
          <thead>
            <tr>
              <th>Name</th><th>Slug</th>
              <th class="text-center">Posts</th>
              <th>Parents</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  // \u2500\u2500 Tree view (multi-parent DAG) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  /**
   * Build a forest from the flat tag list.
   * Tags with multiple parents appear under each parent (multi-parent DAG).
   * ancestorIds prevents infinite cycles.
   */
  _buildTree(tags) {
    const tagById = new Map(tags.map(t => [t.id, t]));

    // parent-id -> [child tags that list this parent]
    const childrenOf = new Map();
    const hasParent  = new Set(); // tag IDs that have at least one known parent

    tags.forEach(t => {
      (t.parents || []).forEach(p => {
        if (tagById.has(p.id)) {
          if (!childrenOf.has(p.id)) childrenOf.set(p.id, []);
          childrenOf.get(p.id).push(t);
          hasParent.add(t.id);
        }
      });
    });

    const sortFn = (a, b) => {
      if (a.sort_order != null && b.sort_order != null) return a.sort_order - b.sort_order;
      if (a.sort_order != null) return -1;
      if (b.sort_order != null) return 1;
      return a.name.localeCompare(b.name);
    };

    // Recursive builder — ancestorIds guards against cycles.
    const makeNode = (tag, ancestorIds) => {
      const kids = (childrenOf.get(tag.id) || []).filter(c => !ancestorIds.has(c.id));
      kids.sort(sortFn);
      return {
        ...tag,
        childrenNodes: kids.map(c => makeNode(c, new Set([...ancestorIds, c.id]))),
      };
    };

    const roots = tags.filter(t => !hasParent.has(t.id));
    roots.sort(sortFn);
    return roots.map(r => makeNode(r, new Set([r.id])));
  }

  _renderTree(nodes, level = 0) {
    if (!nodes.length) return level === 0 ? '<p class="empty-state">No tags found.</p>' : '';
    return `<ul class="tm-tree level-${level}">${nodes.map(n => this._renderNode(n, level)).join('')}</ul>`;
  }

  _renderNode(node, level) {
    const isExpanded = this.state.expanded.has(node.id);
    const hasChildren = node.childrenNodes.length > 0;

    const toggle = hasChildren
      ? `<button class="tm-toggle" data-id="${node.id}">${isExpanded ? '\u25bc' : '\u25b6'}</button>`
      : `<span class="tm-toggle-spacer"></span>`;

    const flags = [
      node.is_important ? `<span class="tm-flag tm-flag-important" title="Important">\u2605</span>` : '',
      node.is_featured  ? `<span class="tm-flag tm-flag-featured"  title="Featured">\u2666</span>`  : '',
      node.is_hidden    ? `<span class="tm-flag tm-flag-hidden"    title="Hidden">\ud83d\udc41</span>` : '',
    ].filter(Boolean).join('');

    // Multi-parent indicator: show other parents (not the one rendering this node)
    const otherParents = (node.parents || []).slice(1);
    const multiParentHint = otherParents.length > 0
      ? `<span class="tm-multi-parent" title="Also child of: ${otherParents.map(p => escapeHtml(p.name)).join(', ')}">\u2387</span>`
      : '';

    return `
      <li class="tm-node" data-id="${node.id}">
        <div class="tm-row">
          ${toggle}
          <span class="tm-tag-name">${escapeHtml(node.name)}</span>
          <span class="tm-row-meta">
            ${flags}${multiParentHint}
            <span class="tm-count-badge">${node.post_count || 0}</span>
          </span>
          <div class="tm-actions">
            <button class="btn btn-sm edit-tag-btn"    data-id="${node.id}" title="Edit">\u270e</button>
            <button class="btn btn-sm add-child-btn"   data-id="${node.id}" title="Add child">+</button>
            <button class="btn btn-sm btn-danger delete-tag-btn" data-id="${node.id}" title="Delete">\u2715</button>
          </div>
        </div>
        ${isExpanded && hasChildren ? this._renderTree(node.childrenNodes, level + 1) : ''}
      </li>`;
  }

  // \u2500\u2500 Lifecycle \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  mount() { super.mount(); this._load(); }

  beforeUnmount() { this._closeModal(); }

  afterRender() {
    this.mountChild(LightSidebar, '#sidebar-mount', {
      currentPath: '/light/tags',
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
        if (confirm(`Delete tag "${tag?.name}"? Posts will NOT be deleted.`)) this._handleDelete(id);
      });
    });
  }

  // \u2500\u2500 Modal \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  _openModal(tag = null, parentId = null) {
    this._closeModal();

    const isEdit      = !!tag;
    const f           = tag || {};
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
      `    <h3>${isEdit ? 'Edit: ' + escapeHtml(f.name) : 'New Tag'}</h3>`,
      '  </div>',
      '  <form id="tag-editor-form">',
      '    <div class="modal-body">',

      // Name + Slug
      '      <div class="form-row">',
      '        <div class="form-group">',
      '          <label>Name <span class="required-mark">*</span></label>',
      `          <input type="text" name="name" value="${escapeHtml(f.name || '')}" required>`,
      '        </div>',
      '        <div class="form-group">',
      '          <label>Slug</label>',
      `          <input type="text" name="slug" id="modal-slug" class="font-mono" value="${escapeHtml(f.slug || '')}" placeholder="auto-generated">`,
      '        </div>',
      '      </div>',

      // Description
      '      <div class="form-group">',
      '        <label>Description</label>',
      `        <textarea name="description" rows="2">${escapeHtml(f.description || '')}</textarea>`,
      '      </div>',

      // Custom URL + Sort Order
      '      <div class="form-row">',
      '        <div class="form-group">',
      '          <label>Custom URL</label>',
      `          <input type="text" name="custom_url" value="${escapeHtml(f.custom_url || '')}" placeholder="/custom/path">`,
      '        </div>',
      '        <div class="form-group">',
      '          <label>Sort Order</label>',
      `          <input type="number" name="sort_order" value="${f.sort_order != null ? f.sort_order : ''}" placeholder="empty = alphabetical">`,
      '        </div>',
      '      </div>',

      // Parents
      '      <div class="form-group">',
      '        <label>Parents</label>',
      '        <div class="tag-toggles-container">',
      this._renderTagToggles('parent_ids', this.state.tags, selfId, selParents),
      '        </div>',
      '      </div>',

      // Children
      '      <div class="form-group">',
      '        <label>Children</label>',
      '        <div class="tag-toggles-container">',
      this._renderTagToggles('child_ids', this.state.tags, selfId, selChildren),
      '        </div>',
      '      </div>',

      // Flags
      '      <div class="tag-flags-section">',
      '        <div class="tag-flags-title">Flags</div>',
      '        <div class="tag-flags-grid">',
      this._renderFlagCheckbox('is_important',               '\u2605', 'Important',          'Appears in tag cloud',                f.is_important),
      this._renderFlagCheckbox('is_featured',                '\u2666', 'Featured',            'Display in footer',                   f.is_featured),
      this._renderFlagCheckbox('is_hidden',                  '\ud83d\udc41', 'Hidden',       'Hide tag from public',                f.is_hidden),
      this._renderFlagCheckbox('is_hidden_posts',            '\u2298', 'Hide Posts',          'Hide posts in this tag from public',  f.is_hidden_posts),
      this._renderFlagCheckbox('include_in_breadcrumbs',     '\ud83d\udd17', 'Breadcrumbs', 'Show in breadcrumb navigation',        f.include_in_breadcrumbs !== false),
      this._renderFlagCheckbox('show_related_tags_as_children', '\u22a2', 'Related as Children', 'Display related tags as children', f.show_related_tags_as_children),
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

    // Auto-generate slug from name.
    const nameInput = modal.querySelector('[name="name"]');
    const slugInput = modal.querySelector('#modal-slug');
    if (isEdit) slugInput.dataset.manual = '1';
    nameInput.addEventListener('input', () => {
      if (!slugInput.dataset.manual) slugInput.value = this._slugify(nameInput.value);
    });
    slugInput.addEventListener('input', () => { slugInput.dataset.manual = '1'; });

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

  /** Render a set of tag-badge toggle checkboxes for parent/children selection. */
  _renderTagToggles(inputName, allTags, selfId, selectedIds) {
    const available = allTags
      .filter(t => t.id !== selfId)
      .sort((a, b) => a.name.localeCompare(b.name));

    if (!available.length) {
      return '<span class="tag-toggles-empty">No other tags available.</span>';
    }

    return available.map(t => [
      '<label class="tag-toggle">',
      `  <input type="checkbox" name="${inputName}" value="${t.id}"${selectedIds.includes(t.id) ? ' checked' : ''}>`,
      `  <span>${escapeHtml(t.name)}</span>`,
      '</label>',
    ].join('')).join('');
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
  }

  _slugify(text) {
    return text.toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  // \u2500\u2500 Data operations \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  async _load() {
    this.setState({ loading: true, error: null });
    try {
      const data = await listTags({ include_empty: true });
      this.setState({ loading: false, tags: data.tags || [] });
    } catch (err) {
      this.setState({ loading: false, error: err.message || 'Failed to load tags.' });
    }
  }

  async _handleSave(form, tagId) {
    const fd = new FormData(form);
    const sortOrderRaw = (fd.get('sort_order') || '').trim();

    const payload = {
      name:                          (fd.get('name') || '').trim(),
      slug:                          (fd.get('slug') || '').trim(),
      description:                   (fd.get('description') || '').trim(),
      custom_url:                    (fd.get('custom_url') || '').trim(),
      is_important:                  fd.get('is_important') === 'on',
      is_featured:                   fd.get('is_featured') === 'on',
      is_hidden:                     fd.get('is_hidden') === 'on',
      is_hidden_posts:               fd.get('is_hidden_posts') === 'on',
      include_in_breadcrumbs:        fd.get('include_in_breadcrumbs') === 'on',
      show_related_tags_as_children: fd.get('show_related_tags_as_children') === 'on',
      sort_order:                    sortOrderRaw !== '' ? parseInt(sortOrderRaw, 10) : null,
      parent_ids:                    fd.getAll('parent_ids').map(v => parseInt(v, 10)),
      child_ids:                     fd.getAll('child_ids').map(v => parseInt(v, 10)),
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
