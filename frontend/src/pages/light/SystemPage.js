/**
 * SystemPage — system administration (cache, backups, migrations).
 *
 * Fetches: GET /api/system/*
 */

import { Component } from '../../components/Component.js';
import { LightSidebar } from '../../components/light/LightSidebar.js';
import {
  clearCache, listBackups,
  createBackup, restoreBackup, deleteBackup, getMigrations,
  updateMapCoords,
} from '../../api/system.js';
import { logout } from '../../api/auth.js';
import { store } from '../../store.js';
import { escapeHtml, navigate } from '../../utils/helpers.js';
import { formatFileSize, formatDateShort } from '../../utils/formatters.js';
import { RESTORE_SVG, CHEVRON_SVG } from '../../utils/icons.js';
import { ConfirmDialog } from '../../components/shared/ConfirmDialog.js';

export default class SystemPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      backups: [],
      migrations: [],
      creatingBackup: false,
      updatingCoords: false,
      coordsResult: null,
      error: null,
    };
  }

  render() {
    const { loading, error, backups, migrations, creatingBackup, updatingCoords, coordsResult } = this.state;

    if (loading) {
      return `
        <div class="light-layout">
          <div id="sidebar-mount"></div>
          <div class="light-main">
            <header class="light-header"><h1>System</h1></header>
            <main class="light-content">
              <div class="loading-spinner" aria-label="Loading system data…"></div>
            </main>
          </div>
        </div>`;
    }

    if (error) {
      return `
        <div class="light-layout">
          <div id="sidebar-mount"></div>
          <div class="light-main">
            <header class="light-header"><h1>System</h1></header>
            <main class="light-content">
              <p class="error-state" role="alert">${escapeHtml(error)}</p>
            </main>
          </div>
        </div>`;
    }

    return `
      <div class="light-layout">
        <div id="sidebar-mount"></div>
        <div class="light-main">
          <header class="light-header">
            <h1>System</h1>
          </header>
          <main class="light-content">

            <div class="card">
              <div class="card-header"><h2>Maintenance</h2></div>
              <div class="card-body">
                <div class="ops-list">
                  <div class="op-item">
                    <div class="op-info">
                      <h4>Clear Cache</h4>
                      <p>Clear the server-side file cache (thumbnails, optimized images).</p>
                    </div>
                    <button id="clear-cache-btn" class="btn btn-secondary">Clear Cache</button>
                  </div>
                  <div class="op-item">
                    <div class="op-info">
                      <h4>Update Map Coordinates</h4>
                      <p>Auto-geocode tags under <strong>city / cities / country / countries</strong> that have no coordinates yet. Uses OpenStreetMap Nominatim (rate-limited — may take a while).</p>
                    </div>
                    <button id="update-coords-btn" class="btn btn-secondary" ${updatingCoords ? 'disabled' : ''}>
                      ${updatingCoords ? 'Geocoding…' : 'Update Coordinates'}
                    </button>
                  </div>
                </div>
                ${coordsResult ? this._renderCoordsResult(coordsResult) : ''}
              </div>
            </div>

            <div class="card">
              <div class="card-header">
                <h2>Backups</h2>
                <div class="header-actions">
                  <button id="create-backup-btn" class="btn btn-primary btn-sm" ${creatingBackup ? 'disabled' : ''}>
                    ${creatingBackup ? 'Creating…' : 'Create Backup'}
                  </button>
                </div>
              </div>
              <div class="card-body">
                ${this._renderBackups(backups)}
              </div>
            </div>

            <div class="card collapsed" id="migrations-card">
              <div class="card-header">
                <h2>Database Migrations</h2>
                <span class="toggle-icon">${CHEVRON_SVG}</span>
              </div>
              <div class="card-body">
                <div class="table-container">
                  <table class="table">
                    <thead><tr><th>Migration</th><th>Applied At</th></tr></thead>
                    <tbody>
                      ${migrations.map(m => `
                        <tr>
                          <td><code>${escapeHtml(m.name)}</code></td>
                          <td>${escapeHtml(formatDateShort(m.applied_at))}</td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

          </main>
        </div>
      </div>`;
  }

  _renderBackups(backups) {
    if (!backups.length) return '<p class="empty-state">No backups found.</p>';
    return backups.map(b => `
      <div class="backup-item">
        <div class="backup-info">
          <div class="backup-filename" title="${escapeHtml(b.filename)}">${escapeHtml(b.filename)}</div>
          <div class="backup-meta">
            <span class="backup-date">${escapeHtml(formatDateShort(b.created_at))}</span>
            <span class="backup-size">${escapeHtml(formatFileSize(b.size))}</span>
          </div>
        </div>
        <div class="backup-actions">
          <button class="btn btn-sm restore-backup-btn" data-file="${escapeHtml(b.filename)}" title="Restore">${RESTORE_SVG}</button>
          <button class="btn btn-sm btn-danger delete-backup-btn" data-file="${escapeHtml(b.filename)}">✕</button>
        </div>
      </div>
    `).join('');
  }

  _renderCoordsResult(result) {
    const cls = result.updated_count > 0 ? 'success' : 'info';
    const errors = result.errors || [];
    return `
      <div class="coords-result alert alert-${cls}" style="margin-top: var(--spacing-md)">
        <strong>${escapeHtml(result.message || '')}</strong>
        ${errors.length ? `
          <ul class="coords-errors" style="margin-top: var(--spacing-sm)">
            ${errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}
          </ul>` : ''}
      </div>`;
  }

  afterRender() {
    this.mountChild(LightSidebar, '#sidebar-mount', {
      currentPath: '/light/system',
      user: store.get('user') || {},
      onLogout: this._handleLogout.bind(this),
    });

    if (this.state.loading || this.state.error) return;

    // Cache
    this.$('#clear-cache-btn')?.addEventListener('click', () => this._handleClearCache());

    // Map coordinates
    this.$('#update-coords-btn')?.addEventListener('click', () => this._handleUpdateCoords());

    // Backups
    this.$('#create-backup-btn')?.addEventListener('click', () => this._handleCreateBackup());
    this.$$('.restore-backup-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const file = btn.dataset.file;
        this._showConfirm({
          title: 'Restore backup',
          message: `Restore "${escapeHtml(file)}"? This will overwrite your current database!`,
          confirmText: 'Restore',
          variant: 'primary',
          onConfirm: () => this._handleRestoreBackup(file),
        });
      });
    });
    this.$$('.delete-backup-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const file = btn.dataset.file;
        this._showConfirm({
          title: 'Delete backup',
          message: `Delete "${escapeHtml(file)}"?`,
          confirmText: 'Delete',
          variant: 'danger',
          onConfirm: () => this._handleDeleteBackup(file),
        });
      });
    });

    // Migrations collapse toggle
    this.$('#migrations-card .card-header')?.addEventListener('click', () => {
      this.$('#migrations-card')?.classList.toggle('collapsed');
    });
  }

  mount() {
    super.mount();
    this._loadInitial();
  }

  async _loadInitial() {
    this.setState({ loading: true, error: null });
    try {
      const [backups, migrations] = await Promise.all([
        listBackups(),
        getMigrations(),
      ]);
      this.setState({ loading: false, backups, migrations });
    } catch (err) {
      this.setState({ loading: false, error: err.message || 'Failed to load system data.' });
    }
  }

  async _handleUpdateCoords() {
    this.setState({ updatingCoords: true, coordsResult: null });
    try {
      const result = await updateMapCoords();
      this.setState({ updatingCoords: false, coordsResult: result });
      store.set('toast', { message: result.message || 'Done.', type: 'success' });
    } catch (err) {
      this.setState({ updatingCoords: false, coordsResult: null });
      store.set('toast', { message: err.message || 'Failed to update coordinates.', type: 'error' });
    }
  }

  async _handleClearCache() {
    try {
      await clearCache();
      store.set('toast', { message: 'Cache cleared successfully.', type: 'success' });
    } catch (err) {
      store.set('toast', { message: err.message || 'Failed to clear cache.', type: 'error' });
    }
  }

  async _handleCreateBackup() {
    this.setState({ creatingBackup: true });
    try {
      await createBackup();
      store.set('toast', { message: 'Backup created.', type: 'success' });
      const backups = await listBackups();
      this.setState({ creatingBackup: false, backups });
    } catch (err) {
      this.setState({ creatingBackup: false });
      store.set('toast', { message: err.message || 'Backup failed.', type: 'error' });
    }
  }

  async _handleRestoreBackup(filename) {
    try {
      await restoreBackup(filename);
      store.set('toast', { message: 'Backup restored. Reloading…', type: 'success' });
      setTimeout(() => location.reload(), 2000);
    } catch (err) {
      store.set('toast', { message: err.message || 'Restore failed.', type: 'error' });
    }
  }

  async _handleDeleteBackup(filename) {
    try {
      await deleteBackup(filename);
      store.set('toast', { message: 'Backup deleted.', type: 'success' });
      const backups = await listBackups();
      this.setState({ backups });
    } catch (err) {
      store.set('toast', { message: err.message || 'Delete failed.', type: 'error' });
    }
  }

  _showConfirm({ title, message, confirmText, variant, onConfirm }) {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const dialog = new ConfirmDialog(mount, {
      title,
      message,
      confirmText,
      variant,
      onConfirm: () => { dialog.unmount(); mount.remove(); onConfirm(); },
      onCancel:  () => { dialog.unmount(); mount.remove(); },
    });
    dialog.mount();
  }

  async _handleLogout() {
    try { await logout(); } catch { /* ignore */ }
    store.set('user', null);
    navigate('/light/login', { replace: true });
  }
}
