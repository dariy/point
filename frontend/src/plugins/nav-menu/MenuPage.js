import { html, setHTML, raw } from "../../utils/helpers.js";
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
import { getSettings, mergeSettings, setToast } from '../../store.js';
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
      items.push({
        label: linkMatch[1],
        url: linkMatch[2],
        depth
      });
    } else if (content) {
      items.push({
        label: content,
        url: '',
        depth
      });
    }
  }
  return items;
}

/**
 * Serialise flat item list to markdown text.
 *
 * Label-less rows are dropped: they exist only as a half-filled row in the
 * visual editor (see _collectVisualItems) and have no markdown spelling — a
 * bare `- ` or `- [](url)` does not round-trip back through parseMarkdown.
 */
function serializeMarkdown(items) {
  return namedItems(items).map(({
    label,
    url,
    depth
  }) => {
    const prefix = '  '.repeat(depth) + '- ';
    return url ? `${prefix}[${label}](${url})` : `${prefix}${label}`;
  }).join('\n');
}

/** The items that are actually a menu entry — i.e. have a label. */
function namedItems(items) {
  return items.filter(i => i.label);
}
export default class MenuPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      saving: false,
      error: null,
      mode: 'tags',
      // 'tags' | 'custom' | 'none'
      editFormat: 'visual',
      // 'visual' | 'markdown'
      items: [],
      // [{label, url, depth}]
      inlineMax: 4,
      // links shown inline before More ▾
      moreTitle: 'More' // Title for the More link
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
    const {
      loading,
      error,
      mode,
      editFormat,
      items,
      saving
    } = this.state;
    if (loading) return html`<div class="loading-spinner" aria-label="Loading menu\u2026"></div>`;
    if (error) return html`<p class="error-state" role="alert">${error}</p>`;
    const customEditor = mode === 'custom' ? html`
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
    return html`
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

        ${mode !== 'none' ? html`
        <section class="menu-inline-cap card">
          <div class="card-body menu-inline-cap-row">
            <label for="inline-max-input" class="menu-inline-cap-label">
              <strong>Visible menu slots</strong>
              <small>The most nav slots shown at once. When items overflow, “More ▾”
              takes one slot — so with a cap of 3 and 4 links you get 2 links plus
              More (3 slots), not a lone link hidden behind More. Narrow screens may
              fold further.</small>
            </label>
            <input id="inline-max-input" type="number" min="1" max="10" step="1"
                   class="form-input menu-inline-max-input" value="${this.state.inlineMax}">
          </div>
          <div class="card-body menu-inline-cap-row" style="border-top: 1px solid var(--border)">
            <label for="more-title-input" class="menu-inline-cap-label">
              <strong>"More" link title</strong>
              <small>The text to display for the overflow menu link.</small>
            </label>
            <input id="more-title-input" type="text"
                   class="form-input menu-inline-max-input" value="${this.state.moreTitle}">
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

  // Rows are NOT draggable in the markup: a draggable ancestor swallows
  // mousedown on the inputs it contains, so drag-selecting the text of a label
  // starts a row drag instead of a selection and the field cannot be edited by
  // mouse at all. Dragging is armed on mousedown over the handle (afterRender)
  // and disarmed on dragend, mirroring VisualEditor's card list.
  _renderVisualEditor(items) {
    const rows = items.map((item, index) => html`
      <div class="menu-row" data-index="${index}" data-depth="${item.depth}" style="margin-left: ${item.depth * 24}px">
        <span class="drag-handle" style="cursor: grab;">\u22ee\u22ee</span>
        <div class="menu-row-inputs">
          <input type="text" class="form-input menu-label-input item-label" placeholder="Label" value="${item.label}">
          <input type="text" class="form-input menu-url-input item-url" placeholder="URL (optional)" value="${item.url}">
        </div>
        <div class="menu-row-actions">
          <button class="row-btn indent-btn" title="Indent">\u21e5</button>
          <button class="row-btn outdent-btn" title="Outdent">\u21e4</button>
          <button class="row-btn row-btn-delete delete-item-btn" title="Remove">&times;</button>
        </div>
      </div>
    `);
    return html`
      <div class="menu-visual-editor">
        <div class="menu-items" id="menu-items-list">${rows}</div>
        <div class="menu-add-bar">
          <button id="add-item-btn" class="btn btn-secondary">+ Add Item</button>
        </div>
      </div>`;
  }
  _renderMarkdownEditor(items) {
    const text = serializeMarkdown(items);
    return html`<textarea id="menu-markdown-input" class="form-input font-mono" rows="15" placeholder="- [Label](url)">${text}</textarea>`;
  }

  /**
   * Live preview: three fixed-width headers laid out by the real HeaderFold
   * controller — what folds here is what folds on the site.
   */
  _renderPreviewSection() {
    const widths = [['Desktop', 900], ['Mobile landscape', 640], ['Mobile portrait', 360]];
    return html`
      <section class="menu-preview card">
        <div class="card-header"><strong>Preview</strong></div>
        <div class="card-body">
          <div class="menu-preview-strip">
            ${widths.map(([label, w]) => html`
              <figure class="menu-preview-fig">
                <figcaption class="menu-preview-caption">${label} · ${w}px</figcaption>
                <div class="menu-preview-vp" data-w="${w}" style="width:${w}px"></div>
              </figure>`)}
          </div>
        </div>
      </section>`;
  }

  /**
   * The menu as it stands on screen right now, in whichever format is open.
   *
   * `state.items` is NOT that: typing deliberately never calls setState (a
   * re-render would take the focus out of the field being typed in), so state
   * holds the list as of the last structural change and the DOM holds the
   * truth. Anything that reads the current menu — the preview, a save, a
   * re-render that has to survive unsaved edits — has to come through here.
   */
  _currentItems() {
    if (this.state.mode !== 'custom') return this.state.items;
    return this.state.editFormat === 'visual' ? this._collectVisualItems() : parseMarkdown(/** @type {HTMLTextAreaElement|null} */ (this.$('#menu-markdown-input'))?.value || '');
  }

  /** Menu items to preview, as {name, hasChildren} — depends on the mode. */
  _previewItems() {
    const {
      mode
    } = this.state;
    if (mode === 'none') return [];
    if (mode === 'custom') {
      return namedItems(this._currentItems()).filter(i => i.depth === 0).map(i => ({
        name: i.label
      }));
    }
    return this._tagItems.map(t => ({
      name: t.name
    }));
  }
  _updatePreviews() {
    this._destroyPreviews();
    const items = this._previewItems();
    const settings = getSettings() || {};
    const title = settings.blog_title || 'My blog';
    const inlineMax = this.state.inlineMax;
    this.$$('.menu-preview-vp').forEach(vp => {
      // Mirror NavMenu: "More ▾" occupies one of the max visible slots, so
      // when items overflow we show max-1 inline and fold the rest under More.
      const cap = items.length <= inlineMax ? items.length : inlineMax - 1;
      const inline = items.slice(0, cap);
      const overflow = items.length - inline.length;
      setHTML(vp, html`
        <div class="pvh">
          <span class="pvh-brand"><span class="pvh-logo"></span><span class="pvh-title">${title}</span></span>
          <span class="pvh-spacer"></span>
          <nav class="pvh-nav">
            ${inline.map(it => html`<span class="nav-menu-link">${it.name}</span>`)}
            <span class="nav-more is-empty"><span class="nav-menu-link nav-more-btn">${this.state.moreTitle}<span class="nav-more-caret">▾</span></span></span>
          </nav>
          <span class="pvh-tools">
            <span class="pvh-iconbtn">${raw(SEARCH_SVG)}</span>
            <span class="pvh-iconbtn pvh-burger">${raw(MENU_SVG)}</span>
          </span>
        </div>`);
      const root = /** @type {HTMLElement} */ (vp.querySelector('.pvh'));
      const nav = /** @type {HTMLElement} */ (root.querySelector('.pvh-nav'));
      const more = /** @type {HTMLElement} */ (root.querySelector('.nav-more'));
      const moreBtn = /** @type {HTMLElement} */ (root.querySelector('.nav-more-btn'));
      const links = [...nav.querySelectorAll('.nav-menu-link')].filter(l => !l.closest('.nav-more'));
      let foldedCount = 0;
      const syncMore = () => {
        const total = foldedCount + overflow;
        more.classList.toggle('is-empty', total === 0);
        setHTML(moreBtn, html`${this.state.moreTitle} (${total})<span class="nav-more-caret">▾</span>`);
      };
      syncMore();
      const fold = new HeaderFold({
        observe: vp,
        fits: () => {
          void root.offsetWidth;
          const tools = root.querySelector('.pvh-tools');
          return tools.getBoundingClientRect().right <= root.getBoundingClientRect().right - 7;
        }
      });
      fold.register(30, {
        reset: () => {
          links.forEach(l => l.classList.remove('in-more'));
          foldedCount = 0;
          syncMore();
        },
        ops: () => links.slice().reverse().map(l => () => {
          l.classList.add('in-more');
          foldedCount += 1;
          syncMore();
        })
      });
      fold.register(40, {
        reset: () => root.classList.remove('pvh-folded'),
        ops: () => [() => root.classList.add('pvh-folded')]
      });
      this._previewFolds.push(fold);
    });
  }
  _destroyPreviews() {
    this._previewFolds.forEach(f => f.destroy());
    this._previewFolds = [];
  }
  afterRender() {
    setupAdminLayout(this, {
      currentPath: '/light/menu'
    });
    setupTextareaMaximizer(this.container);
    if (this.state.loading || this.state.error) return;
    this.container.querySelectorAll('input[name="menu-mode"]').forEach(radio => {
      radio.addEventListener('change', e => {
        // Carry the unsaved editor contents across, so flipping to None to see
        // the preview and back does not discard what has been typed.
        this.setState({
          mode: e.target.value,
          items: this._currentItems()
        });
      });
    });
    this.container.querySelector('#mode-visual-btn')?.addEventListener('click', () => {
      if (this.state.editFormat === 'markdown') {
        const text = /** @type {HTMLTextAreaElement} */ (this.$('#menu-markdown-input')).value;
        this.setState({
          editFormat: 'visual',
          items: parseMarkdown(text)
        });
      }
    });
    this.container.querySelector('#mode-markdown-btn')?.addEventListener('click', () => {
      if (this.state.editFormat === 'visual') {
        this.setState({
          editFormat: 'markdown',
          items: this._collectVisualItems()
        });
      }
    });
    this.container.querySelector('#add-item-btn')?.addEventListener('click', () => {
      const items = this._collectVisualItems();
      items.push({
        label: '',
        url: '',
        depth: 0
      });
      this.setState({
        items
      });
    });
    let dragSrcIndex = -1;
    this.$$('.menu-row').forEach(row => {
      const index = parseInt(row.dataset.index, 10);
      row.querySelector('.delete-item-btn').addEventListener('click', () => {
        const items = this._collectVisualItems();
        items.splice(index, 1);
        this.setState({
          items
        });
      });
      row.querySelector('.indent-btn').addEventListener('click', () => {
        const items = this._collectVisualItems();
        items[index].depth = Math.min(3, items[index].depth + 1);
        this.setState({
          items
        });
      });
      row.querySelector('.outdent-btn').addEventListener('click', () => {
        const items = this._collectVisualItems();
        items[index].depth = Math.max(0, items[index].depth - 1);
        this.setState({
          items
        });
      });

      // Arm the row for dragging only while the pointer went down on the
      // handle; anywhere else (the label and URL inputs, above all) must stay
      // an ordinary mousedown so text selection works.
      row.querySelector('.drag-handle').addEventListener('mousedown', () => {
        row.setAttribute('draggable', 'true');
        // A press that never becomes a drag ends in mouseup and no dragend, so
        // without this a plain click on the handle would leave the row armed
        // for good — and an armed row is one whose inputs cannot be edited.
        document.addEventListener('mouseup', () => row.removeAttribute('draggable'), {
          once: true
        });
      });
      row.addEventListener('dragstart', e => {
        if (row.getAttribute('draggable') !== 'true') return;
        dragSrcIndex = index;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', index.toString());
        row.classList.add('dragging');
      });
      row.addEventListener('dragover', e => {
        if (dragSrcIndex === -1) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      });
      row.addEventListener('dragenter', e => {
        if (dragSrcIndex === -1) return;
        e.preventDefault();
        row.classList.add('drag-over');
      });
      row.addEventListener('dragleave', () => {
        row.classList.remove('drag-over');
      });
      row.addEventListener('drop', e => {
        if (dragSrcIndex === -1) return;
        // preventDefault, not `return false`: a listener's return value does
        // not cancel the default action, and the default drop handler would
        // paste the dragged payload into whatever it landed on.
        e.preventDefault();
        e.stopPropagation();
        row.classList.remove('drag-over');
        if (dragSrcIndex !== index) {
          const items = this._collectVisualItems();
          const [movedItem] = items.splice(dragSrcIndex, 1);
          items.splice(index, 0, movedItem);
          this.setState({
            items
          });
        }
      });
      row.addEventListener('dragend', () => {
        dragSrcIndex = -1;
        row.classList.remove('dragging');
        this.container.querySelectorAll('.menu-row').forEach(r => {
          r.classList.remove('drag-over');
          r.removeAttribute('draggable');
        });
      });
    });
    this.container.querySelector('#save-menu-btn')?.addEventListener('click', () => this._handleSave());

    // Inline cap + item edits update the preview in place (no full re-render,
    // so inputs keep focus while typing).
    this.container.querySelector('#inline-max-input')?.addEventListener('change', e => {
      const n = parseInt(e.target.value, 10);
      if (n >= 1 && n <= 10) this.state.inlineMax = n;
      e.target.value = this.state.inlineMax;
      this._updatePreviews();
    });
    this.container.querySelector('#more-title-input')?.addEventListener('input', e => {
      this.state.moreTitle = e.target.value || 'More';
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
  }

  /**
   * Read the visual editor back out of the DOM, one entry per row.
   *
   * Every row is returned, including ones whose label is still empty. That is
   * load-bearing: the row handlers index this array with the row's own
   * data-index, so dropping a row here shifts every index after it — clearing
   * a label (step one of retyping it) used to make the NEXT edit delete or
   * indent the wrong row, or throw on an index past the end. Rows without a
   * label are filtered where they actually mean something instead: the
   * preview, the markdown serialiser and the save payload.
   */
  _collectVisualItems() {
    const rows = this.$$('.menu-row');
    const items = [];
    rows.forEach(row => {
      items.push({
        label: /** @type {HTMLInputElement} */ (row.querySelector('.item-label')).value.trim(),
        url: /** @type {HTMLInputElement} */ (row.querySelector('.item-url')).value.trim(),
        depth: parseInt(row.dataset.depth, 10) || 0
      });
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
        moreTitle: data.more_title || 'More',
        error: null
      });
    } catch (err) {
      console.error('[MenuPage] load error:', err);
      this.setState({
        loading: false,
        error: 'Could not load menu configuration.'
      });
    }
  }

  /**
   * Reflect the in-flight save on the button, in place.
   *
   * Deliberately not setState: re-rendering would rebuild the editor from
   * `state.items`, which is stale by exactly the edits being saved — the owner
   * would watch a row they just typed into come back empty (and the markdown
   * they authored come back as the last-parsed text), even though the request
   * that left carried the right thing.
   */
  _setSaving(saving) {
    this.state.saving = saving;
    const btn = /** @type {HTMLButtonElement|null} */ (this.$('#save-menu-btn'));
    if (!btn) return;
    btn.disabled = saving;
    btn.textContent = saving ? 'Saving…' : 'Save Menu Configuration';
  }
  async _handleSave() {
    let markdown = '';
    let apiItems = [];
    if (this.state.mode === 'custom') {
      // A row the owner never named is not a menu entry — it is an empty row
      // they left behind. It must not reach the API, nor the markdown.
      const items = namedItems(this._currentItems());
      markdown = serializeMarkdown(items);

      // Flat list → tree, by the depth each row carries. The open-ancestor
      // stack is popped down to the item's own level first, so a branch that
      // has been closed cannot adopt a later item: in A > B, then C, then a
      // deeper row, the deeper row belongs to C — indexing the stack by depth
      // alone would hand it to B, which is no longer on the path.
      const stack = [];
      for (const item of items) {
        const node = {
          name: item.label,
          url: item.url,
          children: []
        };
        while (stack.length && stack[stack.length - 1].depth >= item.depth) stack.pop();
        const parent = stack[stack.length - 1];
        if (parent) parent.node.children.push(node);else apiItems.push(node);
        stack.push({
          depth: item.depth,
          node
        });
      }
    }
    this._setSaving(true);
    try {
      await updateAdminNavMenu({
        mode: this.state.mode,
        custom_markdown: markdown,
        items: apiItems,
        inline_max: this.state.inlineMax,
        more_title: this.state.moreTitle
      });

      // Sync the public settings store so the header reflects the change
      // without a reload, then let nav consumers refetch the menu.
      mergeSettings({
        nav_menu_mode: this.state.mode,
        nav_inline_max: String(this.state.inlineMax),
        nav_more_title: this.state.moreTitle
      });
      document.dispatchEvent(new CustomEvent('nav-changed'));
      setToast({
        message: 'Menu saved.',
        type: 'success'
      });
    } catch (err) {
      setToast({
        message: err.message || 'Save failed.',
        type: 'error'
      });
    } finally {
      this._setSaving(false);
    }
  }
}