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
import { getAdminNavMenu, updateAdminNavMenu } from './api.js';
import { store } from '../../store.js';
import { escapeHtml } from '../../utils/helpers.js';
import { setupTextareaMaximizer } from '../../utils/textareaMaximizer.js';
import { HeaderFold } from '../../utils/headerFold.js';
import { SEARCH_SVG, MENU_SVG } from '../../utils/icons.js';

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
      mode: 'tags', // 'tags' | 'custom' | 'none'
      editFormat: 'visual', // 'visual' | 'markdown'
      items: [], // [{label, url, depth}]
      inlineMax: 4, // links shown inline before More ▾
    };
    this._tagItems = []; // tags-mode menu (fetched once, for the preview)
    this._previewFolds = [];
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
              <label class="radio-card">
                <input type="radio" class="radio-input" name="menu-mode" value="none" ${mode === 'none' ? 'checked' : ''}>
                <div class="radio-content">
                  <span class="radio-indicator"></span>
                  <span class="radio-text">
                    <strong>None</strong>
                    <small>No menu — the header shows only the title, breadcrumbs and tools.</small>
                  </span>
                </div>
              </label>
            </div>
          </div>
        </section>

        ${mode !== 'none' ? `
        <section class="menu-inline-cap card">
          <div class="card-body menu-inline-cap-row">
            <label for="inline-max-input" class="menu-inline-cap-label">
              <strong>Links shown inline</strong>
              <small>Items beyond this number go under “More ▾”. Narrow screens may fold further.</small>
            </label>
            <input id="inline-max-input" type="number" min="1" max="10" step="1"
                   class="form-input menu-inline-max-input" value="${this.state.inlineMax}">
          </div>
        </section>` : ''}

        ${customEditor}

        ${this._renderPreviewSection()}

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

  /**
   * Live preview: three fixed-width headers laid out by the real HeaderFold
   * controller — what folds here is what folds on the site.
   */
  _renderPreviewSection() {
    const widths = [['Desktop', 900], ['Mobile landscape', 640], ['Mobile portrait', 360]];
    return `
      <section class="menu-preview card">
        <div class="card-header"><strong>Preview</strong></div>
        <div class="card-body">
          <div class="menu-preview-strip">
            ${widths.map(([label, w]) => `
              <figure class="menu-preview-fig">
                <figcaption class="menu-preview-caption">${label} · ${w}px</figcaption>
                <div class="menu-preview-vp" data-w="${w}" style="width:${w}px"></div>
              </figure>`).join('')}
          </div>
        </div>
      </section>`;
  }

  /** Menu items to preview, as {name, hasChildren} — depends on the mode. */
  _previewItems() {
    const { mode } = this.state;
    if (mode === 'none') return [];
    if (mode === 'custom') {
      const flat = this.state.editFormat === 'visual'
        ? this._collectVisualItems()
        : parseMarkdown(this.container.querySelector('#menu-markdown-input')?.value || '');
      return flat.filter((i) => i.depth === 0 && i.label)
        .map((i) => ({ name: i.label }));
    }
    return this._tagItems.map((t) => ({ name: t.name }));
  }

  _updatePreviews() {
    this._destroyPreviews();
    const items = this._previewItems();
    const settings = store.get('settings') || {};
    const title = settings.blog_title || 'My blog';
    const inlineMax = this.state.inlineMax;

    this.container.querySelectorAll('.menu-preview-vp').forEach((vp) => {
      const inline = items.slice(0, inlineMax);
      const overflow = items.length - inline.length;
      vp.innerHTML = `
        <div class="pvh">
          <span class="pvh-brand"><span class="pvh-logo"></span><span class="pvh-title">${escapeHtml(title)}</span></span>
          <span class="pvh-spacer"></span>
          <nav class="pvh-nav">
            ${inline.map((it) => `<span class="nav-menu-link">${escapeHtml(it.name)}</span>`).join('')}
            <span class="nav-more is-empty"><span class="nav-menu-link nav-more-btn">More<span class="nav-more-caret">▾</span></span></span>
          </nav>
          <span class="pvh-tools">
            <span class="pvh-iconbtn">${SEARCH_SVG}</span>
            <span class="pvh-iconbtn pvh-burger">${MENU_SVG}</span>
          </span>
        </div>`;

      const root = vp.querySelector('.pvh');
      const nav = root.querySelector('.pvh-nav');
      const more = root.querySelector('.nav-more');
      const moreBtn = root.querySelector('.nav-more-btn');
      const links = [...nav.querySelectorAll('.nav-menu-link')].filter((l) => !l.closest('.nav-more'));
      let foldedCount = 0;
      const syncMore = () => {
        const total = foldedCount + overflow;
        more.classList.toggle('is-empty', total === 0);
        moreBtn.innerHTML = `More (${total})<span class="nav-more-caret">▾</span>`;
      };
      syncMore();

      const fold = new HeaderFold({
        observe: vp,
        fits: () => {
          void root.offsetWidth;
          const tools = root.querySelector('.pvh-tools');
          return tools.getBoundingClientRect().right <= root.getBoundingClientRect().right - 7;
        },
      });
      fold.register(30, {
        reset: () => {
          links.forEach((l) => l.classList.remove('in-more'));
          foldedCount = 0;
          syncMore();
        },
        ops: () => links.slice().reverse().map((l) => () => {
          l.classList.add('in-more');
          foldedCount += 1;
          syncMore();
        }),
      });
      fold.register(40, {
        reset: () => root.classList.remove('pvh-folded'),
        ops: () => [() => root.classList.add('pvh-folded')],
      });
      this._previewFolds.push(fold);
    });
  }

  _destroyPreviews() {
    this._previewFolds.forEach((f) => f.destroy());
    this._previewFolds = [];
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

      row.addEventListener('dragleave', () => {
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

      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        this.container.querySelectorAll('.menu-row').forEach(r => r.classList.remove('drag-over'));
      });
    });

    this.container.querySelector('#save-menu-btn')?.addEventListener('click', () => this._handleSave());

    // Inline cap + item edits update the preview in place (no full re-render,
    // so inputs keep focus while typing).
    this.container.querySelector('#inline-max-input')?.addEventListener('change', (e) => {
      const n = parseInt(e.target.value, 10);
      if (n >= 1 && n <= 10) this.state.inlineMax = n;
      e.target.value = this.state.inlineMax;
      this._updatePreviews();
    });
    let previewTimer = null;
    const schedulePreview = () => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => this._updatePreviews(), 300);
    };
    this.container.querySelector('#menu-items-list')?.addEventListener('input', schedulePreview);
    this.container.querySelector('#menu-markdown-input')?.addEventListener('input', schedulePreview);

    this._updatePreviews();
  }

  beforeRender() {
    this._destroyPreviews();
  }

  beforeUnmount() {
    this._destroyPreviews();
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
      // Tags-mode tree (returned regardless of active mode) for the preview.
      this._tagItems = data.tag_items || [];
      this.setState({
        loading: false,
        mode: data.mode || 'tags',
        items: parseMarkdown(data.custom_markdown),
        inlineMax: data.inline_max || 4,
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
        inline_max: this.state.inlineMax,
      });

      // Sync the public settings store so the header reflects the change
      // without a reload, then let nav consumers refetch the menu.
      const settings = store.get('settings') || {};
      store.set('settings', {
        ...settings,
        nav_menu_mode: this.state.mode,
        nav_inline_max: String(this.state.inlineMax),
      });
      document.dispatchEvent(new CustomEvent('nav-changed'));

      store.set('toast', { message: 'Menu saved.', type: 'success' });
      this.setState({ saving: false });
    } catch (err) {
      store.set('toast', { message: err.message || 'Save failed.', type: 'error' });
      this.setState({ saving: false });
    }
  }
}
