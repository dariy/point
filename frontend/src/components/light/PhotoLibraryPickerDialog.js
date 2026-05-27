/**
 * PhotoLibraryPickerDialog — browse the external photo library and selectively
 * import photos into site media.
 *
 * Appended to document.body once and reused across open/close cycles.
 *
 * Usage:
 *   const picker = new PhotoLibraryPickerDialog({ onImport: (result) => { ... } });
 *   picker.open();
 *   // later:
 *   picker.destroy();
 */

import { Component } from '../Component.js';
import { store } from '../../store.js';
import { escapeHtml } from '../../utils/helpers.js';
import {
  getPhotoLibraryContents,
  importSelectedPhotos,
  getPhotoLibraryFileUrl,
} from '../../api/system.js';

export class PhotoLibraryPickerDialog extends Component {
  constructor({ onImport }) {
    const container = document.createElement('div');
    container.className = 'modal-overlay photo-library-overlay';
    container.setAttribute('aria-modal', 'true');
    container.setAttribute('role', 'dialog');
    container.setAttribute('aria-label', 'Browse Photo Library');
    document.body.appendChild(container);

    super(container, { onImport });
    this._keyHandler = null;

    this.state = {
      currentPath: '',
      contents: null,
      selected: new Set(),
      loading: false,
      importing: false,
    };
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  render() {
    const { currentPath, contents, selected, loading, importing } = this.state;
    const selectedCount = selected.size;

    return `
      <div class="modal photo-library-modal">
        <header class="modal-header photo-library-header">
          <div class="photo-library-title">
            <h3>Browse Photo Library</h3>
            ${this._renderBreadcrumb(currentPath)}
          </div>
          <button class="modal-close" id="plpd-close-btn" aria-label="Close">&times;</button>
        </header>
        <div class="modal-body photo-library-body" id="plpd-body">
          ${loading ? '<div class="photo-library-loading">Loading&hellip;</div>' : ''}
          ${!loading && contents ? this._renderContents(contents, selected) : ''}
          ${!loading && !contents ? '' : ''}
        </div>
        <footer class="modal-footer">
          <button class="btn btn-secondary" id="plpd-cancel-btn">Cancel</button>
          <button class="btn btn-primary" id="plpd-import-btn"
            ${selectedCount === 0 || importing ? 'disabled' : ''}>
            ${importing
              ? 'Importing&hellip;'
              : selectedCount === 0
                ? 'Import selected'
                : `Import ${selectedCount} photo${selectedCount !== 1 ? 's' : ''}`}
          </button>
        </footer>
      </div>`;
  }

  _renderBreadcrumb(currentPath) {
    const parts = currentPath ? currentPath.split('/').filter(Boolean) : [];
    const crumbs = [{ label: '/', index: -1 }];
    parts.forEach((part, i) => crumbs.push({ label: part, index: i }));

    return `
      <nav class="photo-library-breadcrumb" aria-label="Path">
        ${crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          return isLast
            ? `<span class="breadcrumb-current">${escapeHtml(crumb.label)}</span>`
            : `<button class="breadcrumb-btn" data-index="${crumb.index}">${escapeHtml(crumb.label)}</button>
               <span class="breadcrumb-sep">/</span>`;
        }).join('')}
      </nav>`;
  }

  _renderContents(contents, selected) {
    const { folders, files } = contents;
    if (!folders.length && !files.length) {
      return '<p class="photo-library-empty">This folder is empty.</p>';
    }

    const folderItems = folders.map(name => `
      <button class="photo-library-item photo-library-folder" data-folder="${escapeHtml(name)}" title="${escapeHtml(name)}">
        <span class="photo-library-folder-icon">&#128193;</span>
        <span class="photo-library-item-label">${escapeHtml(name)}</span>
      </button>`).join('');

    const fileItems = files.map(file => {
      const isSelected = selected.has(file.path);
      const url = getPhotoLibraryFileUrl(file.path);
      return `
        <button class="photo-library-item photo-library-file${isSelected ? ' selected' : ''}"
          data-path="${escapeHtml(file.path)}" title="${escapeHtml(file.name)}">
          <img class="photo-library-thumb" src="${escapeHtml(url)}" alt="" loading="lazy">
          <span class="photo-library-item-label">${escapeHtml(file.name)}</span>
          ${isSelected ? '<span class="photo-library-check" aria-hidden="true">&#10003;</span>' : ''}
        </button>`;
    }).join('');

    return `<div class="photo-library-grid">${folderItems}${fileItems}</div>`;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  afterRender() {
    this.$('#plpd-close-btn')?.addEventListener('click', () => this.close());
    this.$('#plpd-cancel-btn')?.addEventListener('click', () => this.close());
    this.$('#plpd-import-btn')?.addEventListener('click', () => this._handleImport());

    // Breadcrumb navigation
    this.$$('.breadcrumb-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const index = parseInt(btn.dataset.index, 10);
        this._navigateToBreadcrumb(index);
      });
    });

    // Folder navigation
    this.$$('.photo-library-folder').forEach(btn => {
      btn.addEventListener('click', () => this._navigateInto(btn.dataset.folder));
    });

    // File selection toggle
    this.$$('.photo-library-file').forEach(btn => {
      btn.addEventListener('click', () => this._toggleFile(btn.dataset.path));
    });

    // Close on backdrop click
    this.container.addEventListener('click', (e) => {
      if (e.target === this.container) this.close();
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  open() {
    if (this.container.classList.contains('active')) return;
    this.setState({ currentPath: '', contents: null, selected: new Set(), loading: false, importing: false });
    this.container.classList.add('active');
    document.body.style.overflow = 'hidden';

    this._keyHandler = (e) => { if (e.key === 'Escape') this.close(); };
    document.addEventListener('keydown', this._keyHandler);

    this._loadContents('');
  }

  close() {
    this.container.classList.remove('active');
    document.body.style.overflow = '';
    if (this._keyHandler) {
      document.removeEventListener('keydown', this._keyHandler);
      this._keyHandler = null;
    }
  }

  destroy() {
    this.close();
    this.unmount();
    this.container.remove();
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  async _loadContents(path) {
    this.setState({ loading: true });
    try {
      const contents = await getPhotoLibraryContents(path);
      this.setState({ loading: false, contents, currentPath: path });
    } catch (err) {
      this.setState({ loading: false, contents: null });
      store.set('toast', { message: err.message || 'Failed to load photo library.', type: 'error' });
    }
  }

  _navigateInto(folderName) {
    const { currentPath } = this.state;
    const newPath = currentPath ? `${currentPath}/${folderName}` : folderName;
    this._loadContents(newPath);
  }

  _navigateToBreadcrumb(index) {
    const { currentPath } = this.state;
    if (index === -1) {
      this._loadContents('');
      return;
    }
    const parts = currentPath.split('/').filter(Boolean);
    const newPath = parts.slice(0, index + 1).join('/');
    this._loadContents(newPath);
  }

  // ── Selection ─────────────────────────────────────────────────────────────

  _toggleFile(path) {
    const selected = new Set(this.state.selected);
    if (selected.has(path)) {
      selected.delete(path);
    } else {
      selected.add(path);
    }
    this.setState({ selected });
  }

  // ── Import ────────────────────────────────────────────────────────────────

  async _handleImport() {
    const { selected } = this.state;
    if (selected.size === 0) return;

    this.setState({ importing: true });
    try {
      const result = await importSelectedPhotos([...selected]);
      this.setState({ importing: false });
      const msg = `Imported ${result.imported} photo${result.imported !== 1 ? 's' : ''}, skipped ${result.skipped} duplicate${result.skipped !== 1 ? 's' : ''}.`;
      store.set('toast', { message: msg, type: result.imported > 0 ? 'success' : 'info' });
      this.props.onImport?.(result);
      this.close();
    } catch (err) {
      this.setState({ importing: false });
      store.set('toast', { message: err.message || 'Import failed.', type: 'error' });
    }
  }
}
