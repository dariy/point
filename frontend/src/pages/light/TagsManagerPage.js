/**
 * TagsManagerPage — hierarchical tag management.
 *
 * Fetches all tags and renders them in a tree structure.
 * Supports CRUD and reordering.
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
      expanded: new Set(), // IDs of expanded tags
      editingTag: null,    // Tag being edited (ID)
    };
  }

  render() {
    const { loading, error, tags } = this.state;

    const content = loading
      ? `<div class="loading-spinner" aria-label="Loading tags…"></div>`
      : error
        ? `<p class="error-state" role="alert">${escapeHtml(error)}</p>`
        : `<div class="tags-tree-container">
            ${this._renderTree(this._buildTree(tags))}
          </div>`;

    return `
      <div class="light-layout">
        <div id="sidebar-mount"></div>
        <div class="light-main">
          <header class="light-header">
            <h1>Tags</h1>
            <div class="header-actions">
              <button id="add-root-tag-btn" class="btn btn-primary">+ New Root Tag</button>
              <button id="recalc-counts-btn" class="btn btn-secondary" title="Recalculate post counts">⟳</button>
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
      </div>

      <div id="tag-modal-mount"></div>`;
  }

  /** Build a forest (list of root nodes) from flat tag list. */
  _buildTree(tags) {
    const map = new Map();
    tags.forEach(t => map.set(t.id, { ...t, childrenNodes: [] }));
    const roots = [];
    tags.forEach(t => {
      const node = map.get(t.id);
      if (t.parents && t.parents.length > 0) {
        // Just use first parent for tree view
        const parentId = t.parents[0].id;
        const parentNode = map.get(parentId);
        if (parentNode) {
          parentNode.childrenNodes.push(node);
        } else {
          roots.push(node);
        }
      } else {
        roots.push(node);
      }
    });

    // Sort by sort_order
    const sortNodes = (nodes) => {
      nodes.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.name.localeCompare(b.name));
      nodes.forEach(n => sortNodes(n.childrenNodes));
    };
    sortNodes(roots);
    return roots;
  }

  _renderTree(nodes, level = 0) {
    if (!nodes.length) return level === 0 ? '<p class="empty-state">No tags found.</p>' : '';

    return `<ul class="tree-list level-${level}">
      ${nodes.map(node => this._renderNode(node, level)).join('')}
    </ul>`;
  }

  _renderNode(node, level) {
    const isExpanded = this.state.expanded.has(node.id);
    const hasChildren = node.childrenNodes.length > 0;
    const toggle = hasChildren
      ? `<button class="tree-toggle" data-id="${node.id}">${isExpanded ? '▼' : '▶'}</button>`
      : `<span class="tree-toggle-spacer"></span>`;

    const badgeCls = node.is_important ? ' badge-primary' : node.is_hidden ? ' badge-hidden' : '';

    return `
      <li class="tree-node" data-id="${node.id}">
        <div class="tree-node-content">
          ${toggle}
          <span class="tree-node-name">${escapeHtml(node.name)}</span>
          <span class="tree-node-meta">
            <span class="badge${badgeCls}">${node.post_count || 0} posts</span>
            ${node.is_hidden ? '<span class="icon-hidden" title="Hidden from public">👁✕</span>' : ''}
          </span>
          <div class="tree-node-actions">
            <button class="btn btn-sm edit-tag-btn" data-id="${node.id}" title="Edit">✎</button>
            <button class="btn btn-sm add-child-btn" data-id="${node.id}" title="Add child">+</button>
            <button class="btn btn-sm btn-danger delete-tag-btn" data-id="${node.id}" title="Delete">✕</button>
          </div>
        </div>
        ${isExpanded && hasChildren ? this._renderTree(node.childrenNodes, level + 1) : ''}
      </li>`;
  }

  afterRender() {
    this.mountChild(LightSidebar, '#sidebar-mount', {
      currentPath: '/light/tags',
      user: store.get('user') || {},
      onLogout: this._handleLogout.bind(this),
    });

    if (this.state.loading || this.state.error) return;

    // Toggle expansion
    this.$$('.tree-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.id, 10);
        const expanded = new Set(this.state.expanded);
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);
        this.setState({ expanded });
      });
    });

    // Add root tag
    this.$('#add-root-tag-btn')?.addEventListener('click', () => this._showTagModal());

    // Recalculate counts
    this.$('#recalc-counts-btn')?.addEventListener('click', () => this._handleRecalc());

    // Node actions
    this.$$('.edit-tag-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.id, 10);
        const tag = this.state.tags.find(t => t.id === id);
        this._showTagModal(tag);
      });
    });

    this.$$('.add-child-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const parentId = parseInt(btn.dataset.id, 10);
        this._showTagModal(null, parentId);
      });
    });

    this.$$('.delete-tag-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.id, 10);
        const tag = this.state.tags.find(t => t.id === id);
        if (confirm(`Delete tag "${tag.name}"? This will NOT delete posts, but may affect hierarchy.`)) {
          this._handleDelete(id);
        }
      });
    });
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    this.setState({ loading: true, error: null });
    try {
      const data = await listTags({ include_empty: true });
      this.setState({ loading: false, tags: data.tags || [] });
    } catch (err) {
      this.setState({ loading: false, error: err.message || 'Failed to load tags.' });
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

  _showTagModal(tag = null, parentId = null) {
    // Simple prompt-based creation for now, can be replaced with a real Modal component later
    if (!tag) {
      const name = prompt(parentId ? 'New child tag name:' : 'New root tag name:');
      if (name && name.trim()) {
        this._handleCreate(name.trim(), parentId);
      }
    } else {
      const name = prompt('Rename tag:', tag.name);
      if (name && name.trim() && name.trim() !== tag.name) {
        this._handleUpdate(tag.id, { name: name.trim() });
      }
    }
  }

  async _handleCreate(name, parentId) {
    try {
      const payload = { name };
      if (parentId) payload.parent_ids = [parentId];
      await createTag(payload);
      store.set('toast', { message: 'Tag created.', type: 'success' });
      if (parentId) {
        const expanded = new Set(this.state.expanded);
        expanded.add(parentId);
        this.setState({ expanded });
      }
      this._load();
    } catch (err) {
      store.set('toast', { message: err.message || 'Create failed.', type: 'error' });
    }
  }

  async _handleUpdate(id, data) {
    try {
      await updateTag(id, data);
      store.set('toast', { message: 'Tag updated.', type: 'success' });
      this._load();
    } catch (err) {
      store.set('toast', { message: err.message || 'Update failed.', type: 'error' });
    }
  }

  async _handleLogout() {
    try { await logout(); } catch { /* ignore */ }
    store.set('user', null);
    navigate('/light/login', { replace: true });
  }
}
