/**
 * MenuPage — custom navigation menu editor.
 *
 * Allows the owner to choose between the built-in tags-based navigation
 * or a manually authored custom menu. The custom menu editor has two modes:
 *   - visual: drag-reorder list of items with label/URL inputs
 *   - markdown: plain-text format with `- [Label](url)` syntax
 */

import { Component } from '../../components/Component.js';
import { adminLayoutTemplate, setupAdminLayout } from '../../components/light/AdminLayout.js';
import { getAdminNavMenu, updateAdminNavMenu, getNavMenu } from '../../api/pages.js';
import { store } from '../../store.js';
import { escapeHtml } from '../../utils/helpers.js';
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
    const prefix = '  '.repeat(depth) + '- ';
    return url ? `${prefix}[${label}](${url})` : `${prefix}${label}`;
  }).join('\n');
}

export default class MenuPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      saving: false,
      error: null,
      mode: 'tags', // 'tags' | 'custom'
      editFormat: 'visual', // 'visual' | 'markdown'
      items: [], // [{label, url, depth}]
    };
  }

  render() {
    return adminLayoutTemplate({
      title: 'Menu',
      content: this._renderContent()
    });
  }

  _renderContent() {
    const { loading, error, mode, editFormat, items, saving } = this.state;

    if (loading) return '<div class="loading-spinner" aria-label="Loading menu\u2026"></div>';
    if (error) return `<p class="error-state" role="alert">${escapeHtml(error)}</p>`;

    const customEditor = mode === 'custom' ? `
      <div class="menu-editor-card card">
        <div class="card-header">
          <div class="menu-editor-tabs">
            <button id="mode-visual-btn" class="btn btn-sm ${editFormat === 'visual' ? 'btn-primary' : 'btn-secondary'}">Visual</button>
            <button id="mode-markdown-btn" class="btn btn-sm ${editFormat === 'markdown' ? 'btn-primary' : 'btn-secondary'}">Markdown</button>
          </div>
        </div>
        <div class="card-body">
          ${editFormat === 'visual' ? this._renderVisualEditor(items) : this._renderMarkdownEditor(items)}
        </div>
      </div>
    ` : '';

    return `
      <div class="menu-page-container">
        <section class="menu-mode-selector card">
          <div class="card-body">
            <p>Choose how the site navigation menu is generated:</p>
            <div class="radio-group">
              <label class="radio-card">
                <input type="radio" class="radio-input" name="menu-mode" value="tags" ${mode === 'tags' ? 'checked' : ''}>
                <div class="radio-content">
                  <span class="radio-indicator"></span>
                  <span class="radio-text">
                    <strong>Automatic (Tags-based)</strong>
                    <small>Hierarchical tags from the Tag Manager are automatically used.</small>
                  </span>
                </div>
              </label>
              <label class="radio-card">
                <input type="radio" class="radio-input" name="menu-mode" value="custom" ${mode === 'custom' ? 'checked' : ''}>
                <div class="radio-content">
                  <span class="radio-indicator"></span>
                  <span class="radio-text">
                    <strong>Custom (Manual)</strong>
                    <small>Manually define links and labels for the navigation menu.</small>
                  </span>
                </div>
              </label>
            </div>
          </div>
        </section>

        ${customEditor}

        <div class="form-actions-sticky">
           <button id="save-menu-btn" class="btn btn-primary" ${saving ? 'disabled' : ''}>
             ${saving ? 'Saving\u2026' : 'Save Menu Configuration'}
           </button>
        </div>
      </div>`;
  }

  _renderVisualEditor(items) {
    const rows = items.map((item, index) => `
      <div class="menu-row" data-index="${index}" draggable="true" style="margin-left: ${item.depth * 24}px">
        <span class="drag-handle" style="cursor: grab;">\u22ee\u22ee</span>
        <div class="menu-row-inputs">
          <input type="text" class="form-input menu-label-input item-label" placeholder="Label" value="${escapeHtml(item.label)}">
          <input type="text" class="form-input menu-url-input item-url" placeholder="URL (optional)" value="${escapeHtml(item.url)}">
        </div>
        <div class="menu-row-actions">
          <button class="row-btn indent-btn" title="Indent">\u21e5</button>
          <button class="row-btn outdent-btn" title="Outdent">\u21e4</button>
          <button class="row-btn row-btn-delete delete-item-btn" title="Remove">&times;</button>
        </div>
      </div>
    `).join('');

    return `
      <div class="menu-visual-editor">
        <div class="menu-items" id="menu-items-list">${rows}</div>
        <div class="menu-add-bar">
          <button id="add-item-btn" class="btn btn-secondary">+ Add Item</button>
        </div>
      </div>`;
  }

  _renderMarkdownEditor(items) {
    const text = serializeMarkdown(items);
    return `<textarea id="menu-markdown-input" class="form-input font-mono" rows="15" placeholder="- [Label](url)">${escapeHtml(text)}</textarea>`;
  }

  afterRender() {
    this._cleanupAdminLayout = setupAdminLayout(this, {
      currentPath: '/light/menu',
    });

    setupTextareaMaximizer(this.container);

    if (this.state.loading || this.state.error) return;

    this.container.querySelectorAll('input[name="menu-mode"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.setState({ mode: e.target.value });
      });
    });

    this.container.querySelector('#mode-visual-btn')?.addEventListener('click', () => {
      if (this.state.editFormat === 'markdown') {
        const text = this.container.querySelector('#menu-markdown-input').value;
        this.setState({ editFormat: 'visual', items: parseMarkdown(text) });
      }
    });

    this.container.querySelector('#mode-markdown-btn')?.addEventListener('click', () => {
      if (this.state.editFormat === 'visual') {
        this.setState({ editFormat: 'markdown', items: this._collectVisualItems() });
      }
    });

    this.container.querySelector('#add-item-btn')?.addEventListener('click', () => {
      const items = this._collectVisualItems();
      items.push({ label: '', url: '', depth: 0 });
      this.setState({ items });
    });

    let dragSrcIndex = -1;

    this.container.querySelectorAll('.menu-row').forEach(row => {
      const index = parseInt(row.dataset.index, 10);
      row.querySelector('.delete-item-btn').addEventListener('click', () => {
        const items = this._collectVisualItems();
        items.splice(index, 1);
        this.setState({ items });
      });
      row.querySelector('.indent-btn').addEventListener('click', () => {
        const items = this._collectVisualItems();
        items[index].depth = Math.min(3, items[index].depth + 1);
        this.setState({ items });
      });
      row.querySelector('.outdent-btn').addEventListener('click', () => {
        const items = this._collectVisualItems();
        items[index].depth = Math.max(0, items[index].depth - 1);
        this.setState({ items });
      });

      row.addEventListener('dragstart', (e) => {
        dragSrcIndex = index;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', index.toString());
        row.classList.add('dragging');
      });

      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        return false;
      });

      row.addEventListener('dragenter', (e) => {
        e.preventDefault();
        row.classList.add('drag-over');
      });

      row.addEventListener('dragleave', (e) => {
        row.classList.remove('drag-over');
      });

      row.addEventListener('drop', (e) => {
        e.stopPropagation();
        row.classList.remove('drag-over');
        if (dragSrcIndex !== -1 && dragSrcIndex !== index) {
          const items = this._collectVisualItems();
          const [movedItem] = items.splice(dragSrcIndex, 1);
          items.splice(index, 0, movedItem);
          this.setState({ items });
        }
        return false;
      });

      row.addEventListener('dragend', (e) => {
        row.classList.remove('dragging');
        this.container.querySelectorAll('.menu-row').forEach(r => r.classList.remove('drag-over'));
      });
    });

    this.container.querySelector('#save-menu-btn')?.addEventListener('click', () => this._handleSave());
  }

  beforeUnmount() {
    this._cleanupAdminLayout?.();
  }

  _collectVisualItems() {
    const rows = this.container.querySelectorAll('.menu-row');
    const items = [];
    rows.forEach(row => {
      const label = row.querySelector('.item-label').value.trim();
      const url = row.querySelector('.item-url').value.trim();
      const depth = Math.floor(parseInt(row.style.marginLeft || '0', 10) / 24);
      if (label) items.push({ label, url, depth });
    });
    return items;
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    try {
      const data = await getAdminNavMenu();
      this.setState({
        loading: false,
        mode: data.mode || 'tags',
        items: parseMarkdown(data.custom_markdown),
        error: null
      });
    } catch (err) {
      console.error('[MenuPage] load error:', err);
      this.setState({ loading: false, error: 'Could not load menu configuration.' });
    }
  }

  async _handleSave() {
    let markdown = '';
    let apiItems = [];
    if (this.state.mode === 'custom') {
      const items = this.state.editFormat === 'visual' ? this._collectVisualItems() : parseMarkdown(this.container.querySelector('#menu-markdown-input').value);
      markdown = serializeMarkdown(items);

      const stack = [];
      for (const item of items) {
        const node = { name: item.label, url: item.url, children: [] };
        if (item.depth === 0) {
          apiItems.push(node);
          stack[0] = node;
        } else {
          const parent = stack[item.depth - 1] || stack[stack.length - 1] || apiItems[apiItems.length - 1];
          if (parent) {
            parent.children.push(node);
            stack[item.depth] = node;
          } else {
            apiItems.push(node);
            stack[0] = node;
          }
        }
      }
    }

    this.setState({ saving: true });
    try {
      await updateAdminNavMenu({
        mode: this.state.mode,
        custom_markdown: markdown,
        items: apiItems,
      });
      
      // Refresh global nav tags
      const fresh = await getNavMenu();
      store.set('navTags', fresh.menu || []);

      store.set('toast', { message: 'Menu saved.', type: 'success' });
      this.setState({ saving: false });
    } catch (err) {
      store.set('toast', { message: err.message || 'Save failed.', type: 'error' });
      this.setState({ saving: false });
    }
  }
}
