/**
 * MenuPage — custom navigation menu editor.
 *
 * Allows the owner to choose between the built-in tags-based navigation
 * or a manually authored custom menu. The custom menu editor has two modes:
 *   - visual: drag-reorder list of items with label/URL inputs
 *   - markdown: plain-text format with `- [Label](url)` syntax
 */

import { Component } from '../../components/Component.js';
import { LightSidebar } from '../../components/light/LightSidebar.js';
import { getAdminNavMenu, updateAdminNavMenu, getNavMenu } from '../../api/pages.js';
import { logout } from '../../api/auth.js';
import { store } from '../../store.js';
import { escapeHtml, navigate } from '../../utils/helpers.js';
import { setupTextareaMaximizer } from '../../utils/textareaMaximizer.js';

// ── Markdown parser/serialiser ────────────────────────────────────────────────

/**
 * Parse markdown menu format into a flat list of {label, url, depth} items.
 *
 * Supported formats per line:
 *   - [Label](url)        → linked item
 *   - Label               → group header (no url)
 *   (leading spaces × 2 per level determine depth)
 */
function parseMarkdown(text) {
  const lines = (text || '').split('\n');
  const items = [];
  for (const raw of lines) {
    const trimmed = raw.trimEnd();
    if (!trimmed.trim() || !trimmed.trim().startsWith('-')) continue;
    const depth = Math.floor((trimmed.length - trimmed.trimStart().length) / 2);
    const content = trimmed.trim().slice(1).trim(); // strip leading -
    const linkMatch = content.match(/^\[([^\]]+)\]\(([^)]*)\)$/);
    if (linkMatch) {
      items.push({ label: linkMatch[1], url: linkMatch[2], depth });
    } else if (content) {
      items.push({ label: content, url: '', depth });
    }
  }
  return items;
}

/**
 * Serialise flat item list to markdown text.
 */
function serializeMarkdown(items) {
  return items.map(({ label, url, depth }) => {
    const indent = '  '.repeat(depth);
    if (url) return `${indent}- [${label}](${url})`;
    return `${indent}- ${label}`;
  }).join('\n');
}

/**
 * Convert flat list (with depth) to nested tree for the API.
 */
function flatToTree(items) {
  const roots = [];
  const stack = []; // { node, depth }

  for (const item of items) {
    const node = {
      id: 0, name: item.label, slug: '', url: item.url || undefined,
      post_count: 0, is_related: false, show_in_ancestors: false, children: [],
    };
    if (!node.url) delete node.url;

    // Pop stack until we find a parent with lower depth
    while (stack.length && stack[stack.length - 1].depth >= item.depth) {
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].node.children.push(node);
    }
    stack.push({ node, depth: item.depth });
  }
  return roots;
}

/**
 * Convert nested tree from the API to flat list with depth.
 */
function treeToFlat(nodes, depth = 0) {
  const flat = [];
  for (const node of (nodes || [])) {
    flat.push({ label: node.name, url: node.url || '', depth });
    flat.push(...treeToFlat(node.children, depth + 1));
  }
  return flat;
}

// ── Page component ────────────────────────────────────────────────────────────

export default class MenuPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      saving: false,
      error: null,
      mode: 'tags',        // 'tags' | 'custom'
      editorMode: 'visual', // 'visual' | 'markdown'
      items: [],           // flat [{label, url, depth}]
    };
  }

  render() {
    const { loading, saving, error, mode, editorMode, items } = this.state;

    const sidebarHtml = `<div id="sidebar-mount"></div>`;

    let content;
    if (loading) {
      content = `<div class="loading-state"><div class="spinner"></div><p>Loading menu…</p></div>`;
    } else if (error) {
      content = `<div class="error-banner">${escapeHtml(error)}</div>`;
    } else {
      content = this._renderEditor(mode, editorMode, items, saving);
    }

    return `
      <div class="light-layout">
        ${sidebarHtml}
        <div class="light-main">
          <header class="light-header">
            <h1>Navigation Menu</h1>
          </header>
          <main class="light-content">
            ${content}
          </main>
        </div>
      </div>`;
  }

  _renderEditor(mode, editorMode, items, saving) {
    const isCustom = mode === 'custom';
    const savingAttr = saving ? ' disabled' : '';

    return `
      <div class="menu-editor">
        <div class="menu-mode-bar">
          <div class="menu-mode-toggle" role="group" aria-label="Menu source">
            <button type="button" class="mode-btn${!isCustom ? ' active' : ''}" data-mode="tags">
              Built-in Tags
            </button>
            <button type="button" class="mode-btn${isCustom ? ' active' : ''}" data-mode="custom">
              Custom Menu
            </button>
          </div>
          <button type="button" class="btn btn-primary save-btn"${savingAttr} id="save-btn">
            ${saving ? 'Saving…' : 'Save'}
          </button>
        </div>

        ${!isCustom ? `
          <div class="menu-tags-info">
            <p>The navigation bar is generated automatically from your tag hierarchy. Switch to <strong>Custom Menu</strong> to define your own navigation structure.</p>
          </div>
        ` : `
          <div class="menu-editor-tabs" role="group" aria-label="Editor mode">
            <button type="button" class="editor-tab${editorMode === 'visual' ? ' active' : ''}" data-editor="visual">Visual</button>
            <button type="button" class="editor-tab${editorMode === 'markdown' ? ' active' : ''}" data-editor="markdown">Markdown</button>
          </div>

          ${editorMode === 'visual' ? this._renderVisual(items) : this._renderMarkdown(items)}
        `}
      </div>`;
  }

  _renderVisual(items) {
    const rows = items.map((item, i) => this._renderRow(item, i, items)).join('');
    return `
      <div class="menu-visual-editor">
        <div class="menu-items" id="menu-items">
          ${rows || '<p class="menu-empty">No items yet. Add one below.</p>'}
        </div>
        <div class="menu-add-bar">
          <button type="button" class="btn btn-secondary add-item-btn" id="add-item-btn">+ Add item</button>
        </div>
      </div>`;
  }

  _renderRow(item, index, items) {
    const indent = item.depth * 24;
    const canIndent = index > 0 && item.depth < 3;
    const canOutdent = item.depth > 0;
    const canMoveUp = index > 0;
    const canMoveDown = index < items.length - 1;

    return `
      <div class="menu-row" data-index="${index}" style="margin-left:${indent}px">
        <div class="menu-row-inputs">
          <input type="text" class="menu-label-input" placeholder="Label"
            value="${escapeHtml(item.label)}" data-index="${index}" data-field="label">
          <input type="text" class="menu-url-input" placeholder="URL (e.g. /tags/travel)"
            value="${escapeHtml(item.url)}" data-index="${index}" data-field="url">
        </div>
        <div class="menu-row-actions">
          ${canOutdent ? `<button type="button" class="row-btn" data-action="outdent" data-index="${index}" title="Outdent">←</button>` : '<span class="row-btn-placeholder"></span>'}
          ${canIndent  ? `<button type="button" class="row-btn" data-action="indent"  data-index="${index}" title="Indent">→</button>`  : '<span class="row-btn-placeholder"></span>'}
          ${canMoveUp  ? `<button type="button" class="row-btn" data-action="up"      data-index="${index}" title="Move up">↑</button>`  : '<span class="row-btn-placeholder"></span>'}
          ${canMoveDown? `<button type="button" class="row-btn" data-action="down"    data-index="${index}" title="Move down">↓</button>`: '<span class="row-btn-placeholder"></span>'}
          <button type="button" class="row-btn row-btn-delete" data-action="delete" data-index="${index}" title="Delete">×</button>
        </div>
      </div>`;
  }

  _renderMarkdown(items) {
    const text = serializeMarkdown(items);
    return `
      <div class="menu-markdown-editor">
        <p class="menu-markdown-hint">
          Use <code>- [Label](url)</code> for linked items, <code>- Label</code> for group headers.
          Indent with 2 spaces per level.
        </p>
        <textarea class="menu-markdown-textarea" id="menu-markdown-textarea" spellcheck="false"
          rows="20">${escapeHtml(text)}</textarea>
      </div>`;
  }

  afterRender() {
    setupTextareaMaximizer(this.container);
    const user = store.get('user');

    const publicUrl = store.get('settings')?.public_url || '/';

    this.mountChild(LightSidebar, '#sidebar-mount', {
      currentPath: '/light/menu',
      publicUrl,
      user,
      onLogout: async () => {
        await logout();
        store.set('user', null);
        navigate('/');
      },
    });

    if (this.state.loading) return;

    // Mode toggle
    this.$$('.mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this._syncFromEditor();
        this.setState({ mode: btn.dataset.mode });
      });
    });

    // Editor tab toggle
    this.$$('.editor-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        this._syncFromEditor();
        this.setState({ editorMode: btn.dataset.editor });
      });
    });

    // Save button
    this.$('#save-btn')?.addEventListener('click', () => this._save());

    // Visual editor: field changes
    this.$$('.menu-label-input, .menu-url-input').forEach((input) => {
      input.addEventListener('input', () => {
        const index = parseInt(input.dataset.index, 10);
        const field = input.dataset.field;
        const items = [...this.state.items];
        items[index] = { ...items[index], [field]: input.value };
        this.state.items = items; // update without re-render
      });
    });

    // Visual editor: action buttons
    this.$$('.row-btn[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this._syncFromEditor();
        const index = parseInt(btn.dataset.index, 10);
        this._handleRowAction(btn.dataset.action, index);
      });
    });

    // Add item button
    this.$('#add-item-btn')?.addEventListener('click', () => {
      this._syncFromEditor();
      const items = [...this.state.items, { label: '', url: '', depth: 0 }];
      this.setState({ items });
    });
  }

  _syncFromEditor() {
    if (this.state.editorMode === 'markdown') {
      const ta = this.$('#menu-markdown-textarea');
      if (ta) {
        this.state.items = parseMarkdown(ta.value);
      }
    } else {
      // Visual: read current input values from DOM before re-render
      const inputs = this.$$('.menu-label-input, .menu-url-input');
      const items = [...this.state.items];
      inputs.forEach((input) => {
        const index = parseInt(input.dataset.index, 10);
        const field = input.dataset.field;
        if (items[index]) {
          items[index] = { ...items[index], [field]: input.value };
        }
      });
      this.state.items = items;
    }
  }

  _handleRowAction(action, index) {
    const items = [...this.state.items];
    switch (action) {
      case 'indent':
        if (index > 0 && items[index].depth < 3) {
          items[index] = { ...items[index], depth: items[index].depth + 1 };
        }
        break;
      case 'outdent':
        if (items[index].depth > 0) {
          items[index] = { ...items[index], depth: items[index].depth - 1 };
          // Also outdent any following deeper children
          for (let i = index + 1; i < items.length && items[i].depth > items[index].depth; i++) {
            items[i] = { ...items[i], depth: items[i].depth - 1 };
          }
        }
        break;
      case 'up':
        if (index > 0) {
          [items[index - 1], items[index]] = [items[index], items[index - 1]];
        }
        break;
      case 'down':
        if (index < items.length - 1) {
          [items[index], items[index + 1]] = [items[index + 1], items[index]];
        }
        break;
      case 'delete':
        items.splice(index, 1);
        break;
    }
    this.setState({ items });
  }

  async _save() {
    this._syncFromEditor();
    this.setState({ saving: true, error: null });

    try {
      const tree = flatToTree(this.state.items);
      await updateAdminNavMenu({ mode: this.state.mode, items: tree });

      // Refresh store nav tags so the public header updates without reload.
      try {
        const navData = await getNavMenu();
        store.set('navTags', navData.menu || []);
      } catch { /* ignore */ }

      store.set('toast', { message: 'Menu saved.', type: 'success' });
    } catch (err) {
      this.setState({ saving: false, error: err.message || 'Failed to save.' });
      return;
    }
    this.setState({ saving: false });
  }

  async mount() {
    super.mount();
    await this._load();
  }

  async _load() {
    try {
      const data = await getAdminNavMenu();
      const items = treeToFlat(data.items || []);
      this.setState({ loading: false, mode: data.mode || 'tags', items });
    } catch (err) {
      this.setState({ loading: false, error: err.message || 'Failed to load menu.' });
    }
  }
}
