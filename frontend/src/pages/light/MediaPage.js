/**
 * MediaPage — media library with upload, filter, and delete.
 *
 * Fetches: GET /api/media
 */

import { Component } from '../../components/Component.js';
import { LightSidebar } from '../../components/light/LightSidebar.js';
import { Pagination } from '../../components/shared/Pagination.js';
import { listMedia, uploadMedia, deleteMedia } from '../../api/media.js';
import { logout } from '../../api/auth.js';
import { store } from '../../store.js';
import { escapeHtml, navigate } from '../../utils/helpers.js';
import { formatFileSize, formatDateShort } from '../../utils/formatters.js';

export default class MediaPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      media: [],
      pagination: {},
      typeFilter: '',
      error: null,
      uploading: false,
    };
  }

  render() {
    const { loading, media, typeFilter, error, uploading } = this.state;

    const typeOptions = ['', 'image', 'video', 'audio'].map((t) => {
      const label = t ? t.charAt(0).toUpperCase() + t.slice(1) : 'All types';
      return `<option value="${t}"${typeFilter === t ? ' selected' : ''}>${label}</option>`;
    }).join('');

    const grid = loading
      ? `<div class="loading-spinner" aria-label="Loading media…"></div>`
      : error
        ? `<p class="error-state" role="alert">${escapeHtml(error)}</p>`
        : !media.length
          ? `<p class="empty-state">No media files yet. Upload something!</p>`
          : `<div class="media-grid">${media.map((m) => this._renderItem(m)).join('')}</div>`;

    return `
      <div class="light-layout">
        <div id="sidebar-mount"></div>
        <div class="light-main">
          <header class="light-header">
            <h1>Media</h1>
          </header>
          <main class="light-content">

            <div class="card" id="upload-card">
              <div class="card-header"><h2>Upload</h2></div>
              <div class="card-body">
                <div class="upload-area" id="upload-area" tabindex="0" role="button"
                     aria-label="Click or drag files here to upload">
                  <div class="upload-area-icon" aria-hidden="true">⬆</div>
                  <div class="upload-area-text">
                    <strong>Click to select</strong> or drag &amp; drop files here
                    <br><small>Images, video, audio</small>
                  </div>
                  <input type="file" id="file-input" multiple accept="image/*,video/*,audio/*"
                         style="display:none">
                </div>
                ${uploading ? `<p class="upload-progress" aria-live="polite">Uploading…</p>` : ''}
              </div>
            </div>

            <div class="filters" style="margin-top: var(--spacing-lg)">
              <select id="type-filter" class="filter-select">${typeOptions}</select>
            </div>

            <div id="media-area" style="margin-top: var(--spacing-md)">${grid}</div>
            <div id="pagination-mount"></div>
          </main>
        </div>
      </div>`;
  }

  _renderItem(m) {
    const thumb = m.thumbnail_url || m.url || '';
    const isImage = m.file_type === 'image';
    const preview = isImage && thumb
      ? `<img src="${escapeHtml(thumb)}" alt="${escapeHtml(m.filename)}" loading="lazy">`
      : `<div class="file-icon" aria-label="${escapeHtml(m.file_type || 'file')}">${m.file_type === 'video' ? '▶' : m.file_type === 'audio' ? '♫' : '📄'}</div>`;

    return `
      <div class="media-item" data-id="${escapeHtml(String(m.id))}">
        <div class="media-item-preview">${preview}</div>
        <div class="media-item-info">
          <div class="media-item-name" title="${escapeHtml(m.filename)}">${escapeHtml(m.filename)}</div>
          <div class="media-item-meta">
            ${escapeHtml(formatFileSize(m.file_size))} · ${escapeHtml(formatDateShort(m.uploaded_at))}
          </div>
        </div>
        <div class="media-item-actions">
          <a href="${escapeHtml(m.url || '')}" class="btn btn-sm" target="_blank"
             data-external title="View">↗</a>
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

    this._wireUpload();

    // Type filter
    this.$('#type-filter')?.addEventListener('change', (e) => {
      this.setState({ typeFilter: e.target.value });
      this._load({ page: 1 });
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
  }

  _wireUpload() {
    const uploadArea = this.$('#upload-area');
    const fileInput  = this.$('#file-input');
    if (!uploadArea || !fileInput) return;

    uploadArea.addEventListener('click', () => fileInput.click());
    uploadArea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') fileInput.click();
    });

    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.classList.add('dragover');
    });
    uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.classList.remove('dragover');
      this._uploadFiles(Array.from(e.dataTransfer.files));
    });

    fileInput.addEventListener('change', () => {
      this._uploadFiles(Array.from(fileInput.files));
      fileInput.value = '';
    });
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
    const msg = `Uploaded ${uploaded}${failed ? `, ${failed} failed` : ''}.`;
    store.set('toast', { message: msg, type: failed ? 'warning' : 'success' });
    this._load();
  }

  async _deleteMedia(id) {
    try {
      await deleteMedia(id);
      store.set('toast', { message: 'File deleted.', type: 'success' });
      this._load();
    } catch (err) {
      store.set('toast', { message: err.message || 'Delete failed.', type: 'error' });
    }
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load(overrides = {}) {
    this.setState({ loading: true, error: null });
    const params = {
      page: overrides.page ?? 1,
      per_page: 24,
    };
    if (this.state.typeFilter) params.file_type = this.state.typeFilter;

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
