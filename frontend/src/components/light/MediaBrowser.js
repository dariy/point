/**
 * MediaBrowser — reusable media library component.
 *
 * Renders the folder tree, type filter, media grid, upload, and pagination.
 * Used by MediaPage (standalone) and MediaPickerDialog (picker mode).
 *
 * Props:
 *   pickerMode  {boolean}  When true: shows checkboxes on items, hides
 *                          delete/copy actions, and scopes drag-drop to the
 *                          component container. Defaults to false.
 *
 * Public methods (picker mode):
 *   getSelectedItems()  Returns array of selected media objects.
 */

import { Component } from '../Component.js';
import { Pagination } from '../shared/Pagination.js';
import { MediaLightbox } from '../public/MediaLightbox.js';
import { listMedia, uploadMedia, deleteMedia, getMediaFolders } from '../../api/media.js';
import { store } from '../../store.js';
import { escapeHtml } from '../../utils/helpers.js';
import { formatFileSize, formatDateShort } from '../../utils/formatters.js';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export class MediaBrowser extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      media: [],
      pagination: {},
      typeFilter: '',
      selectedFolder: null,
      folders: [],
      expandedYears: {},
      error: null,
      uploading: false,
      draggingOver: false,
      selectedIds: new Set(),
    };
    this._dragCount = 0;
    this._dragListeners = [];
    this._lightbox = this.props.pickerMode ? null : new MediaLightbox();
    // Picker mode: persists selected media objects across page/folder changes
    this._selectedItemsById = {};
  }

  render() {
    const { loading, media, typeFilter, error, uploading, draggingOver,
            folders, selectedFolder, expandedYears, selectedIds } = this.state;
    const pickerMode = this.props.pickerMode;

    const typeOptions = ['', 'image', 'video', 'audio', 'file'].map((t) => {
      const label = t ? t.charAt(0).toUpperCase() + t.slice(1) : 'All types';
      return `<option value="${t}"${typeFilter === t ? ' selected' : ''}>${label}</option>`;
    }).join('');

    const grid = loading
      ? `<div class="loading-spinner" aria-label="Loading media…"></div>`
      : error
        ? `<p class="error-state" role="alert">${escapeHtml(error)}</p>`
        : !media.length
          ? `<p class="empty-state">No media files. Drag &amp; drop to upload.</p>`
          : `<div class="media-grid">${media.map((m) => this._renderItem(m, selectedIds)).join('')}</div>`;

    // Group folders by year for the tree
    const yearGroups = {};
    for (const f of folders) {
      if (!yearGroups[f.year]) yearGroups[f.year] = [];
      yearGroups[f.year].push(f);
    }
    const sortedYears = Object.keys(yearGroups).sort((a, b) => b - a);

    const folderTree = `
      <nav class="media-folder-tree" aria-label="Media folders">
        <button class="folder-tree-all${!selectedFolder ? ' active' : ''}" data-folder="">
          All media
        </button>
        ${sortedYears.map((year) => {
          const expanded = expandedYears[year] !== false;
          const months = yearGroups[year];
          const hasActive = months.some((f) => selectedFolder === f.path);
          return `
            <div class="folder-year-group">
              <button class="folder-year-btn${hasActive ? ' has-active' : ''}" data-year="${escapeHtml(year)}">
                <span class="folder-year-arrow">${expanded ? '▾' : '▸'}</span>
                ${escapeHtml(year)}
              </button>
              <div class="folder-year-months${expanded ? '' : ' hidden'}">
                ${months.map((f) => {
                  const monthName = MONTH_NAMES[parseInt(f.month, 10) - 1] || f.month;
                  return `<button class="folder-month-btn${selectedFolder === f.path ? ' active' : ''}"
                                  data-folder="${escapeHtml(f.path)}">
                    ${escapeHtml(monthName)}
                  </button>`;
                }).join('')}
              </div>
            </div>`;
        }).join('')}
      </nav>`;

    const dropOverlay = pickerMode
      ? `<div class="media-browser-drop-overlay${draggingOver ? ' visible' : ''}" aria-hidden="true">
           <div class="drop-overlay-inner">
             <div class="drop-overlay-icon">⬆</div>
             <div>Drop files to upload</div>
           </div>
         </div>`
      : `<div class="drop-overlay${draggingOver ? ' visible' : ''}" aria-hidden="true">
           <div class="drop-overlay-inner">
             <div class="drop-overlay-icon">⬆</div>
             <div>Drop files to upload</div>
           </div>
         </div>`;

    return `
      <div class="media-browser${pickerMode ? ' media-browser--picker' : ''}">
        <input type="file" id="mb-file-input" multiple accept="image/*,video/*,audio/*" style="display:none">
        <div class="media-browser-toolbar">
          <button id="mb-upload-btn" class="btn btn-sm btn-secondary" title="Upload files">⬆ Upload</button>
          <select id="mb-type-filter" class="filter-select">${typeOptions}</select>
        </div>
        ${uploading ? `<div class="upload-progress-banner" aria-live="polite">Uploading…</div>` : ''}
        <div class="media-layout">
          ${folderTree}
          <div class="media-content">
            <div id="mb-media-area">${grid}</div>
            <div id="mb-pagination-mount"></div>
          </div>
        </div>
        ${dropOverlay}
      </div>`;
  }

  _renderItem(m, selectedIds) {
    const pickerMode = this.props.pickerMode;
    const fileType = (m.file_type || '').toLowerCase();
    const isImage = fileType === 'image';
    const thumb = m.thumbnail_path || (isImage ? m.original_path : null);
    const isSelected = selectedIds.has(m.id);

    const preview = isImage && thumb
      ? `<img src="${escapeHtml(thumb)}" alt="${escapeHtml(m.filename)}" loading="lazy">`
      : `<div class="file-icon" aria-label="${escapeHtml(fileType || 'file')}">${
          fileType === 'video' ? '▶' : fileType === 'audio' ? '♫' : '📄'
        }</div>`;

    const copyPath = m.path || (m.original_path ? m.original_path.replace('/media/originals', '') : '');

    const pickerCheckbox = pickerMode ? `
      <label class="media-item-checkbox" title="${isSelected ? 'Deselect' : 'Select'}">
        <input type="checkbox" class="media-item-check" data-id="${escapeHtml(String(m.id))}"
               ${isSelected ? 'checked' : ''} aria-label="Select ${escapeHtml(m.filename)}">
      </label>` : '';

    const actions = pickerMode ? '' : `
      <div class="media-item-actions">
        <a href="${escapeHtml(m.original_path || '')}" class="btn btn-sm" target="_blank"
           rel="noopener" title="View original">↗</a>
        <button class="btn btn-sm copy-path-btn"
                data-path="${escapeHtml(copyPath)}" title="Copy path to clipboard">⎘</button>
        <button class="btn btn-sm btn-danger delete-media-btn"
                data-id="${escapeHtml(String(m.id))}"
                data-name="${escapeHtml(m.filename)}" title="Delete">✕</button>
      </div>`;

    return `
      <div class="media-item${isSelected ? ' media-item--selected' : ''}"
           data-id="${escapeHtml(String(m.id))}"${
        isImage ? ` data-src="${escapeHtml(m.original_path || '')}" data-alt="${escapeHtml(m.filename)}"` : ''}>
        ${pickerCheckbox}
        <div class="media-item-preview${isImage && !pickerMode ? ' media-item-preview--clickable' : ''}">${preview}</div>
        <div class="media-item-info">
          <div class="media-item-name" title="${escapeHtml(m.filename)}">${escapeHtml(m.filename)}</div>
          <div class="media-item-meta">
            ${escapeHtml(formatFileSize(m.file_size))} · ${escapeHtml(formatDateShort(m.uploaded_at))}
          </div>
        </div>
        ${actions}
      </div>`;
  }

  afterRender() {
    const { pickerMode } = this.props;

    if (!this.state.loading && this.state.pagination.pages > 1) {
      this.mountChild(Pagination, '#mb-pagination-mount', {
        page: this.state.pagination.page,
        pages: this.state.pagination.pages,
        total: this.state.pagination.total,
        onPage: (p) => this._load({ page: p }),
      });
    }

    const fileInput = this.$('#mb-file-input');

    this.$('#mb-upload-btn')?.addEventListener('click', () => fileInput?.click());

    fileInput?.addEventListener('change', () => {
      this._uploadFiles(Array.from(fileInput.files));
      fileInput.value = '';
    });

    this._wireDragDrop(fileInput, pickerMode);

    this.$('#mb-type-filter')?.addEventListener('change', (e) => {
      this.setState({ typeFilter: e.target.value });
      this._load({ page: 1 });
    });

    // Folder year toggle
    this.$$('.folder-year-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const year = btn.dataset.year;
        const expanded = this.state.expandedYears[year] !== false;
        this.setState({ expandedYears: { ...this.state.expandedYears, [year]: !expanded } });
      });
    });

    // Folder / "all" selection
    this.$$('.folder-month-btn, .folder-tree-all').forEach((btn) => {
      btn.addEventListener('click', () => {
        const folder = btn.dataset.folder || null;
        this.setState({ selectedFolder: folder });
        this._load({ page: 1 });
      });
    });

    if (pickerMode) {
      // Picker: toggle selection via checkbox or clicking the item
      this.$$('.media-item').forEach((item) => {
        item.addEventListener('click', (e) => {
          // Don't trigger if clicking directly on checkbox label (it handles its own state)
          if (e.target.closest('.media-item-checkbox')) return;
          const id = parseInt(item.dataset.id, 10);
          this._toggleSelection(id);
        });
      });
      this.$$('.media-item-check').forEach((checkbox) => {
        checkbox.addEventListener('change', () => {
          const id = parseInt(checkbox.dataset.id, 10);
          this._toggleSelection(id);
        });
      });
    } else {
      // Standalone: delete, copy, lightbox
      this.$$('.delete-media-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = parseInt(btn.dataset.id, 10);
          if (confirm(`Delete "${btn.dataset.name}"?`)) {
            this._deleteMedia(id);
          }
        });
      });

      this.$$('.copy-path-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const path = btn.dataset.path;
          navigator.clipboard.writeText(path).then(() => {
            store.set('toast', { message: `Copied: ${path}`, type: 'success' });
          }).catch(() => {
            store.set('toast', { message: 'Copy failed', type: 'error' });
          });
        });
      });

      const imageItems = Array.from(this.$$('.media-item[data-src]'));
      if (imageItems.length > 0) {
        const images = imageItems.map((el) => ({ src: el.dataset.src, alt: el.dataset.alt || '' }));
        imageItems.forEach((el, index) => {
          el.querySelector('.media-item-preview')?.addEventListener('click', () => {
            this._lightbox.open(images, index);
          });
        });
      }
    }
  }

  _toggleSelection(id) {
    const selectedIds = new Set(this.state.selectedIds);
    if (selectedIds.has(id)) {
      selectedIds.delete(id);
      delete this._selectedItemsById[id];
    } else {
      selectedIds.add(id);
      const item = this.state.media.find((m) => m.id === id);
      if (item) this._selectedItemsById[id] = item;
    }
    this.setState({ selectedIds });
  }

  /**
   * Returns the currently selected media objects (picker mode only).
   * Persists across page and folder changes.
   * @returns {object[]}
   */
  getSelectedItems() {
    return Object.values(this._selectedItemsById);
  }

  _wireDragDrop(fileInput, pickerMode) {
    // In picker mode, scope drag-drop to the component container to avoid
    // conflicting with PostEditPage's document-level drag handler.
    const target = pickerMode ? this.container : document;

    const onEnter = (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      this._dragCount++;
      if (this._dragCount === 1) this.setState({ draggingOver: true });
    };
    const onLeave = () => {
      this._dragCount = Math.max(0, this._dragCount - 1);
      if (this._dragCount === 0) this.setState({ draggingOver: false });
    };
    const onOver = (e) => e.preventDefault();
    const onDrop = (e) => {
      e.preventDefault();
      this._dragCount = 0;
      this.setState({ draggingOver: false });
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) this._uploadFiles(files);
    };

    target.addEventListener('dragenter', onEnter);
    target.addEventListener('dragleave', onLeave);
    target.addEventListener('dragover', onOver);
    target.addEventListener('drop', onDrop);

    this._dragListeners = [
      [target, 'dragenter', onEnter],
      [target, 'dragleave', onLeave],
      [target, 'dragover', onOver],
      [target, 'drop', onDrop],
    ];
  }

  beforeUnmount() {
    for (const [target, event, fn] of this._dragListeners) {
      target.removeEventListener(event, fn);
    }
    this._dragListeners = [];
    this._lightbox?.destroy();
    this._dragCount = 0;
  }

  mount() {
    super.mount();
    this._loadFolders();
    this._load();
  }

  async _loadFolders() {
    try {
      const data = await getMediaFolders();
      const folders = data.folders || [];
      const expandedYears = { ...this.state.expandedYears };
      if (folders.length && expandedYears[folders[0].year] === undefined) {
        expandedYears[folders[0].year] = true;
      }
      this.setState({ folders, expandedYears });
    } catch {
      // Silently ignore
    }
  }

  async _load(overrides = {}) {
    this.setState({ loading: true, error: null });
    const params = {
      page: overrides.page ?? 1,
      per_page: 24,
    };
    if (this.state.typeFilter) params.file_type = this.state.typeFilter;
    if (this.state.selectedFolder) params.folder = this.state.selectedFolder;

    try {
      const data = await listMedia(params);
      this.setState({
        loading: false,
        media: data.media || [],
        pagination: { page: data.page, pages: data.pages, total: data.total },
      });
    } catch (err) {
      this.setState({ loading: false, error: err.message || 'Failed to load media.' });
    }
  }

  async _uploadFiles(files) {
    if (!files.length) return;
    this.setState({ uploading: true });
    const uploadedItems = [];
    let failed = 0;

    for (const file of files) {
      try {
        const result = await uploadMedia(file);
        uploadedItems.push(result);
      } catch {
        failed++;
      }
    }

    this.setState({ uploading: false });
    store.set('toast', {
      message: `Uploaded ${uploadedItems.length}${failed ? `, ${failed} failed` : ''}.`,
      type: failed ? 'warning' : 'success',
    });

    await this._load();
    await this._loadFolders();

    // In picker mode, auto-select the newly uploaded items
    if (this.props.pickerMode && uploadedItems.length > 0) {
      for (const item of uploadedItems) {
        this._selectedItemsById[item.id] = item;
      }
      const newIds = uploadedItems.map((item) => item.id);
      const selectedIds = new Set([...this.state.selectedIds, ...newIds]);
      this.setState({ selectedIds });
    }
  }

  async _deleteMedia(id) {
    try {
      await deleteMedia(id);
      store.set('toast', { message: 'File deleted.', type: 'success' });
      this._load();
      this._loadFolders();
    } catch (err) {
      store.set('toast', { message: err.message || 'Delete failed.', type: 'error' });
    }
  }
}
