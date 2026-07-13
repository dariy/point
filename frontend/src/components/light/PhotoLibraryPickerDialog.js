/**
 * PhotoLibraryPickerDialog — browse the external photo library and selectively
 * import photos into site media.
 *
 * Layout: folder tree sidebar on the left, large photo grid on the right.
 * Appended to document.body once and reused across open/close cycles.
 *
 * The modal shell is rendered once (on first open). All subsequent updates
 * patch only the changed DOM regions in place, avoiding full rerenders.
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
    this._mounted = false;

    this.state = {
      currentPath: '',
      contents: null,
      selected: new Set(),
      loading: false,
      importing: false,
    };
  }

  // ── Shell (rendered once) ─────────────────────────────────────────────────

  render() {
    return `
      <div class="modal photo-library-modal">
        <header class="modal-header photo-library-header">
          <div class="photo-library-title-row">
            <h3>Browse Photo Library</h3>
            <button class="modal-close" id="plpd-close-btn" aria-label="Close">&times;</button>
          </div>
          <nav class="photo-library-breadcrumb" id="plpd-breadcrumb" aria-label="Path"></nav>
        </header>
        <div class="modal-body photo-library-body">
          <div class="photo-library-layout">
            <nav class="photo-library-sidebar" id="plpd-sidebar" aria-label="Folders"></nav>
            <div class="photo-library-content" id="plpd-content"></div>
          </div>
        </div>
        <footer class="modal-footer">
          <button class="btn btn-secondary" id="plpd-cancel-btn">Cancel</button>
          <button class="btn btn-primary" id="plpd-import-btn" disabled>Import selected</button>
        </footer>
      </div>`;
  }

  afterRender() {
    this.$('#plpd-close-btn').addEventListener('click', () => this.close());
    this.$('#plpd-cancel-btn').addEventListener('click', () => this.close());
    this.$('#plpd-import-btn').addEventListener('click', () => this._handleImport());

    // Event delegation on stable region containers — handles dynamically replaced content
    this.$('#plpd-breadcrumb').addEventListener('click', (e) => {
      const btn = e.target.closest('.breadcrumb-btn');
      if (btn) this._navigateToBreadcrumb(parseInt(btn.dataset.index, 10));
    });
    this.$('#plpd-sidebar').addEventListener('click', (e) => {
      const btn = e.target.closest('.photo-library-folder-btn');
      if (btn) this._navigateInto(btn.dataset.folder);
    });
    this.$('#plpd-content').addEventListener('click', (e) => {
      const item = e.target.closest('.photo-library-item');
      if (item) this._toggleFile(item.dataset.path);
    });
    this.container.addEventListener('click', (e) => {
      if (e.target === this.container) this.close();
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  open() {
    if (this.container.classList.contains('active')) return;

    if (!this._mounted) {
      this.mount(); // render() + afterRender() — runs once
      this._mounted = true;
    } else {
      // Restart the slideUp animation for re-opens without a full rerender
      const modal = this.$('.photo-library-modal');
      if (modal) {
        modal.style.animation = 'none';
        void modal.offsetHeight; // force reflow
        modal.style.animation = '';
      }
    }

    this.state = { currentPath: '', contents: null, selected: new Set(), loading: false, importing: false };
    this._patchBreadcrumb('');
    this._patchSidebar(null);
    this._patchContent(null, new Set());
    this._patchImportBtn(0, false);

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
    this.state.loading = true;
    this._patchSidebar(null);
    this._patchContent(null, this.state.selected);
    try {
      const contents = await getPhotoLibraryContents(path);
      this.state.loading = false;
      this.state.contents = contents;
      this.state.currentPath = path;
      this._patchBreadcrumb(path);
      this._patchSidebar(contents.folders);
      this._patchContent(contents.files, this.state.selected);
    } catch (err) {
      this.state.loading = false;
      store.set('toast', { message: err.message || 'Failed to load photo library.', type: 'error' });
    }
  }

  _navigateInto(folderName) {
    const newPath = this.state.currentPath
      ? `${this.state.currentPath}/${folderName}`
      : folderName;
    this._loadContents(newPath);
  }

  _navigateToBreadcrumb(index) {
    if (index === -1) { this._loadContents(''); return; }
    const parts = (this.state.currentPath || '').split('/').filter(Boolean);
    this._loadContents(parts.slice(0, index + 1).join('/'));
  }

  // ── Selection ─────────────────────────────────────────────────────────────

  _toggleFile(path) {
    const { selected } = this.state;
    const wasSelected = selected.has(path);
    if (wasSelected) {
      selected.delete(path);
    } else {
      selected.add(path);
    }

    // Patch only the toggled item — no region rerender needed
    const item = [...this.$$('#plpd-content .photo-library-item')]
      .find(el => el.dataset.path === path);
    if (item) {
      item.classList.toggle('selected', !wasSelected);
      const check = item.querySelector('.photo-library-check');
      if (!wasSelected && !check) {
        const span = document.createElement('span');
        span.className = 'photo-library-check';
        span.setAttribute('aria-hidden', 'true');
        span.textContent = '✓';
        item.appendChild(span);
      } else if (wasSelected && check) {
        check.remove();
      }
    }

    this._patchImportBtn(selected.size, this.state.importing);
  }

  // ── DOM patch helpers ─────────────────────────────────────────────────────

  _patchBreadcrumb(currentPath) {
    const el = this.$('#plpd-breadcrumb');
    if (!el) return;
    const parts = currentPath ? currentPath.split('/').filter(Boolean) : [];
    const crumbs = [{ label: '/', index: -1 }, ...parts.map((p, i) => ({ label: p, index: i }))];
    el.innerHTML = crumbs.map((crumb, i) => {
      const isLast = i === crumbs.length - 1;
      return isLast
        ? `<span class="breadcrumb-current">${escapeHtml(crumb.label)}</span>`
        : `<button class="breadcrumb-btn" data-index="${crumb.index}">${escapeHtml(crumb.label)}</button>
           <span class="breadcrumb-sep">/</span>`;
    }).join('');
  }

  _patchSidebar(folders) {
    const el = this.$('#plpd-sidebar');
    if (!el) return;
    if (folders === null) {
      el.innerHTML = '<span class="photo-library-sidebar-empty">Loading…</span>';
      return;
    }
    el.innerHTML = folders.length
      ? folders.map(name => `
          <button class="photo-library-folder-btn" data-folder="${escapeHtml(name)}" title="${escapeHtml(name)}">
            <span class="photo-library-folder-icon">&#128193;</span>
            <span class="photo-library-item-label">${escapeHtml(name)}</span>
          </button>`).join('')
      : '<span class="photo-library-sidebar-empty">No subfolders</span>';
  }

  _patchContent(files, selected) {
    const el = this.$('#plpd-content');
    if (!el) return;
    if (files === null) {
      el.innerHTML = '<div class="photo-library-loading">Loading…</div>';
      return;
    }
    if (!files.length) {
      el.innerHTML = '<p class="photo-library-empty">No photos in this folder.</p>';
      return;
    }
    el.innerHTML = `<div class="photo-library-grid">${files.map(file => {
      const isSelected = selected.has(file.path);
      const url = getPhotoLibraryFileUrl(file.path);
      return `
        <button class="photo-library-item${isSelected ? ' selected' : ''}"
          data-path="${escapeHtml(file.path)}" title="${escapeHtml(file.name)}">
          <img class="photo-library-thumb" src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async">
          <span class="photo-library-item-label">${escapeHtml(file.name)}</span>
          ${isSelected ? '<span class="photo-library-check" aria-hidden="true">✓</span>' : ''}
        </button>`;
    }).join('')}</div>`;
  }

  _patchImportBtn(count, importing) {
    const btn = this.$('#plpd-import-btn');
    if (!btn) return;
    btn.disabled = count === 0 || importing;
    btn.textContent = importing
      ? 'Importing…'
      : count === 0
        ? 'Import selected'
        : `Import ${count} photo${count !== 1 ? 's' : ''}`;
  }

  // ── Import ────────────────────────────────────────────────────────────────

  async _handleImport() {
    const { selected } = this.state;
    if (selected.size === 0) return;

    this.state.importing = true;
    this._patchImportBtn(selected.size, true);

    try {
      const result = await importSelectedPhotos([...selected]);
      this.state.importing = false;
      const msg = `Imported ${result.imported} photo${result.imported !== 1 ? 's' : ''}, skipped ${result.skipped} duplicate${result.skipped !== 1 ? 's' : ''}.`;
      store.set('toast', { message: msg, type: result.imported > 0 ? 'success' : 'info' });
      this.close();
      this.props.onImport?.(result);
    } catch (err) {
      this.state.importing = false;
      this._patchImportBtn(selected.size, false);
      store.set('toast', { message: err.message || 'Import failed.', type: 'error' });
    }
  }
}
