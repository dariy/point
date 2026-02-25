/**
 * MediaPage — media library with folder tree, type filter, upload, copy and delete.
 *
 * Fetches: GET /api/media, GET /api/media/folders
 */

import { Component } from '../../components/Component.js';
import { LightSidebar } from '../../components/light/LightSidebar.js';
import { Pagination } from '../../components/shared/Pagination.js';
import { MediaLightbox } from '../../components/public/MediaLightbox.js';
import { listMedia, uploadMedia, deleteMedia, getMediaFolders } from '../../api/media.js';
import { logout } from '../../api/auth.js';
import { store } from '../../store.js';
import { escapeHtml, navigate } from '../../utils/helpers.js';
import { formatFileSize, formatDateShort } from '../../utils/formatters.js';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default class MediaPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      media: [],
      pagination: {},
      typeFilter: '',
      selectedFolder: null,  // "YYYY/MM" or null
      folders: [],           // [{ year, month, path }]
      expandedYears: {},     // { "YYYY": true/false }
      error: null,
      uploading: false,
      draggingOver: false,
    };
    this._dragCount = 0;
    this._dragListeners = [];
    this._lightbox = new MediaLightbox();
  }

  render() {
    const { loading, media, typeFilter, error, uploading, draggingOver,
            folders, selectedFolder, expandedYears } = this.state;

    const typeOptions = ['', 'image', 'video', 'audio', 'file'].map((t) => {
      const label = t ? t.charAt(0).toUpperCase() + t.slice(1) : 'All types';
      return `<option value="${t}"${typeFilter === t ? ' selected' : ''}>${label}</option>`;
    }).join('');

    const grid = loading
      ? `<div class="loading-spinner" aria-label="Loading media…"></div>`
      : error
        ? `<p class="error-state" role="alert">${escapeHtml(error)}</p>`
        : !media.length
          ? `<p class="empty-state">No media files. Drag &amp; drop anywhere to upload.</p>`
          : `<div class="media-grid">${media.map((m) => this._renderItem(m)).join('')}</div>`;

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

    return `
      <div class="light-layout">
        <div id="sidebar-mount"></div>
        <div class="light-main">
          <header class="light-header">
            <h1>Media</h1>
            <div class="header-actions">
              <button id="upload-btn" class="btn btn-primary" title="Upload files">⬆ Upload</button>
            </div>
          </header>
          <main class="light-content">
            <input type="file" id="file-input" multiple accept="image/*,video/*,audio/*" style="display:none">
            ${uploading ? `<div class="upload-progress-banner" aria-live="polite">Uploading…</div>` : ''}
            <div class="media-layout">
              ${folderTree}
              <div class="media-content">
                <div class="filters">
                  <select id="type-filter" class="filter-select">${typeOptions}</select>
                </div>
                <div id="media-area" style="margin-top: var(--spacing-md)">${grid}</div>
                <div id="pagination-mount"></div>
              </div>
            </div>
          </main>
        </div>
      </div>
      <div class="drop-overlay${draggingOver ? ' visible' : ''}" aria-hidden="true">
        <div class="drop-overlay-inner">
          <div class="drop-overlay-icon">⬆</div>
          <div>Drop files to upload</div>
        </div>
      </div>`;
  }

  _renderItem(m) {
    const fileType = (m.file_type || '').toLowerCase();
    const isImage = fileType === 'image';
    const thumb = m.thumbnail_path || (isImage ? m.original_path : null);
    const preview = isImage && thumb
      ? `<img src="${escapeHtml(thumb)}" alt="${escapeHtml(m.filename)}" loading="lazy">`
      : `<div class="file-icon" aria-label="${escapeHtml(fileType || 'file')}">${
          fileType === 'video' ? '▶' : fileType === 'audio' ? '♫' : '📄'
        }</div>`;

    // Derive /YYYY/MM/filename path from original_path if m.path is missing
    const copyPath = m.path || (m.original_path ? m.original_path.replace('/media/originals', '') : '');

    return `
      <div class="media-item" data-id="${escapeHtml(String(m.id))}"${
        isImage ? ` data-src="${escapeHtml(m.original_path || '')}" data-alt="${escapeHtml(m.filename)}"` : ''}>
        <div class="media-item-preview${isImage ? ' media-item-preview--clickable' : ''}">${preview}</div>
        <div class="media-item-info">
          <div class="media-item-name" title="${escapeHtml(m.filename)}">${escapeHtml(m.filename)}</div>
          <div class="media-item-meta">
            ${escapeHtml(formatFileSize(m.file_size))} · ${escapeHtml(formatDateShort(m.uploaded_at))}
          </div>
        </div>
        <div class="media-item-actions">
          <a href="${escapeHtml(m.original_path || '')}" class="btn btn-sm" target="_blank"
             rel="noopener" title="View original">↗</a>
          <button class="btn btn-sm copy-path-btn"
                  data-path="${escapeHtml(copyPath)}" title="Copy path to clipboard">⎘</button>
          <button class="btn btn-sm btn-danger delete-media-btn"
                  data-id="${escapeHtml(String(m.id))}"
                  data-name="${escapeHtml(m.filename)}" title="Delete">✕</button>
        </div>
      </div>`;
  }

  afterRender() {
    this.mountChild(LightSidebar, '#sidebar-mount', {
      currentPath: '/light/media',
      user: store.get('user') || {},
      onLogout: this._handleLogout.bind(this),
    });

    if (!this.state.loading && this.state.pagination.pages > 1) {
      this.mountChild(Pagination, '#pagination-mount', {
        page: this.state.pagination.page,
        pages: this.state.pagination.pages,
        total: this.state.pagination.total,
        onPage: (p) => this._load({ page: p }),
      });
    }

    const fileInput = this.$('#file-input');

    // Upload button
    this.$('#upload-btn')?.addEventListener('click', () => fileInput?.click());

    // File input
    fileInput?.addEventListener('change', () => {
      this._uploadFiles(Array.from(fileInput.files));
      fileInput.value = '';
    });

    // Window-wide drag-drop
    this._wireDragDrop(fileInput);

    // Type filter
    this.$('#type-filter')?.addEventListener('change', (e) => {
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

    // Delete buttons
    this.$$('.delete-media-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.id, 10);
        if (confirm(`Delete "${btn.dataset.name}"?`)) {
          this._deleteMedia(id);
        }
      });
    });

    // Image lightbox: click on image preview to open full-screen viewer
    const imageItems = Array.from(this.$$('.media-item[data-src]'));
    if (imageItems.length > 0) {
      const images = imageItems.map((el) => ({ src: el.dataset.src, alt: el.dataset.alt || '' }));
      imageItems.forEach((el, index) => {
        el.querySelector('.media-item-preview')?.addEventListener('click', () => {
          this._lightbox.open(images, index);
        });
      });
    }

    // Copy path buttons
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
  }

  _wireDragDrop(fileInput) {
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

    document.addEventListener('dragenter', onEnter);
    document.addEventListener('dragleave', onLeave);
    document.addEventListener('dragover', onOver);
    document.addEventListener('drop', onDrop);

    // Store for cleanup on unmount
    this._dragListeners = [
      ['dragenter', onEnter],
      ['dragleave', onLeave],
      ['dragover', onOver],
      ['drop', onDrop],
    ];
  }

  unmount() {
    for (const [event, fn] of this._dragListeners) {
      document.removeEventListener(event, fn);
    }
    this._dragListeners = [];
    this._lightbox?.destroy();
    super.unmount?.();
  }

  async _uploadFiles(files) {
    if (!files.length) return;
    this.setState({ uploading: true });
    let uploaded = 0;
    let failed = 0;
    for (const file of files) {
      try {
        await uploadMedia(file);
        uploaded++;
      } catch {
        failed++;
      }
    }
    this.setState({ uploading: false });
    store.set('toast', {
      message: `Uploaded ${uploaded}${failed ? `, ${failed} failed` : ''}.`,
      type: failed ? 'warning' : 'success',
    });
    this._load();
    this._loadFolders();
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

  mount() {
    super.mount();
    this._loadFolders();
    this._load();
  }

  async _loadFolders() {
    try {
      const data = await getMediaFolders();
      const folders = data.folders || [];
      // Auto-expand the most recent year if not yet set
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

  async _handleLogout() {
    try { await logout(); } catch { /* ignore */ }
    store.set('user', null);
    navigate('/light/login', { replace: true });
  }
}
