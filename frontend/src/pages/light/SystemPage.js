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
  updateMapCoords, scanMediaImport,
} from '../../api/system.js';
import { getAllSettings } from '../../api/settings.js';
import { getOfflineStats, getOfflineSnapshot } from '../../api/offline.js';
import { saveSnapshot, saveMeta, getMeta } from '../../utils/offlineStore.js';
import { preCacheImages } from '../../utils/imageCache.js';
import { getQueue, resetFailedOps, updateStatus } from '../../utils/mutationQueue.js';
import { syncQueue } from '../../utils/sync.js';
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
      
      // Offline states
      offlineStats: null,
      loadingOfflineStats: false,
      downloadingOffline: false,
      offlineProgress: 0,
      offlineStatusText: '',
      lastSync: null,

      // Sync queue state
      syncQueue: [],

      // Photo library import
      scanningMedia: false,
      scanResult: null,
      importPath: '',
    };
  }

  render() {
    const { loading, error, backups, migrations, creatingBackup, updatingCoords, coordsResult, scanningMedia, scanResult, importPath } = this.state;
    const settings = store.get('settings') || {};
    const enableBackup = settings.enable_backup !== false;

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
    const { downloadingOffline, offlineProgress, offlineStatusText, lastSync, syncQueue: queue } = this.state;

    return `
      <div class="light-layout">
        <div id="sidebar-mount"></div>
        <div class="light-main">
          <header class="light-header">
            <h1>System</h1>
          </header>
          <main class="light-content">

            <div class="card">
              <div class="card-header">
                <h2>Offline Data</h2>
                ${lastSync ? `<span class="header-meta">Last synced: ${escapeHtml(formatDateShort(lastSync))}</span>` : ''}
              </div>
              <div class="card-body">
                <div class="ops-list">
                  <div class="op-item">
                    <div class="op-info">
                      <h4>Download for offline</h4>
                      <p>Download posts, tags, and images to this device for offline reading.</p>
                      ${downloadingOffline ? `
                        <div class="offline-progress-container" style="margin-top: 1rem;">
                          <div class="progress-bar-bg"><div class="progress-bar-fill" style="width: ${offlineProgress}%"></div></div>
                          <div class="progress-text">${escapeHtml(offlineStatusText)}</div>
                        </div>
                      ` : ''}
                    </div>
                    <button id="prepare-offline-btn" class="btn btn-secondary" ${downloadingOffline ? 'disabled' : ''}>
                      ${downloadingOffline ? 'Downloading…' : 'Download for offline'}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            ${this._renderSyncPanel(queue, lastSync)}

            <div class="card">
              <div class="card-header"><h2>Photo Library</h2></div>
              <div class="card-body">
                <div class="ops-list">
                  <div class="op-item">
                    <div class="op-info">
                      <h4>Scan for New Photos</h4>
                      ${importPath
                        ? `<p>Scanning: <code>${escapeHtml(importPath)}</code></p>`
                        : `<p class="text-muted">Set a <strong>Photo Library path</strong> (<code>media_import_path</code>) in Settings first.</p>`
                      }
                      ${scanningMedia ? `<p class="text-muted" style="margin-top:var(--spacing-sm)">Scanning library, please wait&hellip;</p>` : ''}
                      ${scanResult ? this._renderScanResult(scanResult) : ''}
                    </div>
                    <button id="scan-media-btn" class="btn btn-secondary" ${scanningMedia || !importPath ? 'disabled' : ''}>
                      ${scanningMedia ? 'Scanning&hellip;' : 'Scan for New Photos'}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div class="card">
              <div class="card-header"><h2>Maintenance</h2></div>
              <div class="card-body">
                <div class="ops-list">
                  <div class="op-item">
                    <div class="op-info">
                      <h4>Clear Cache & Sync Media</h4>
                      <p>Clears server-side cache and synchronizes media visibility (ensures images in public posts are accessible to guests).</p>
                    </div>
                    <button id="clear-cache-btn" class="btn btn-secondary">Clear & Sync</button>
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

            ${enableBackup ? `
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
            </div>` : ''}

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

  _renderScanResult(result) {
    const cls = result.imported > 0 ? 'success' : 'info';
    const errs = result.errors || [];
    return `
      <div class="alert alert-${cls}" style="margin-top: var(--spacing-md)">
        Imported <strong>${result.imported}</strong> photo${result.imported !== 1 ? 's' : ''},
        skipped <strong>${result.skipped}</strong> duplicate${result.skipped !== 1 ? 's' : ''}.
        ${errs.length ? `
          <ul style="margin-top: var(--spacing-sm)">
            ${errs.map(e => `<li>${escapeHtml(e)}</li>`).join('')}
          </ul>` : ''}
      </div>`;
  }

  _renderSyncPanel(queue, lastSync) {
    const pending  = queue.filter(op => op.status === 'pending').length;
    const syncing  = queue.filter(op => op.status === 'syncing').length;
    const failedOp = queue.find(op => op.status === 'failed');
    const isOnline = navigator.onLine;

    const syncBtnDisabled = !isOnline || (!pending && !syncing) || !!syncing;
    const syncBtnLabel = syncing ? 'Syncing…' : 'Sync now';

    const statusParts = [];
    if (pending + syncing > 0) statusParts.push(`${pending + syncing} pending`);
    if (lastSync) statusParts.push(`Last synced: ${escapeHtml(formatDateShort(lastSync))}`);
    const statusText = statusParts.length ? statusParts.join(' · ') : (lastSync ? `Last synced: ${escapeHtml(formatDateShort(lastSync))}` : 'No data downloaded yet');

    const errorCard = failedOp ? `
      <div class="sync-error-card" style="margin-top: 1rem;">
        <strong>⚠ Sync halted</strong>
        <p>Failed: <code>${escapeHtml(failedOp.method)} ${escapeHtml(failedOp.url)}</code></p>
        <p class="sync-error-msg">${escapeHtml(failedOp.error || 'Unknown error')}</p>
        <button id="dismiss-retry-btn" class="btn btn-sm btn-secondary" style="margin-top: 0.5rem;">Dismiss &amp; retry</button>
      </div>` : '';

    return `
      <div class="card">
        <div class="card-header"><h2>Offline Sync</h2></div>
        <div class="card-body">
          <div class="ops-list">
            <div class="op-item">
              <div class="op-info">
                <h4>Mutation queue</h4>
                <p>${statusText}</p>
                ${errorCard}
              </div>
              <button id="sync-now-btn" class="btn btn-primary" ${syncBtnDisabled ? 'disabled' : ''}>${syncBtnLabel}</button>
            </div>
          </div>
        </div>
      </div>`;
  }

  afterRender() {
    this.mountChild(LightSidebar, '#sidebar-mount', {
      currentPath: '/light/system',
      user: store.get('user') || {},
      onLogout: this._handleLogout.bind(this),
    });

    if (this.state.loading || this.state.error) return;

    // Offline
    this.$('#prepare-offline-btn')?.addEventListener('click', () => this._handlePrepareOffline());

    // Sync panel
    this.$('#sync-now-btn')?.addEventListener('click', () => this._handleSyncNow());
    this.$('#dismiss-retry-btn')?.addEventListener('click', () => this._handleDismissRetry());
    this.subscribeStore(store, 'offline_status', () => this._refreshSyncState());

    // Photo library scan
    this.$('#scan-media-btn')?.addEventListener('click', () => this._handleScanMedia());

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
      const [backups, migrations, lastSync, queue, allSettings] = await Promise.all([
        listBackups(),
        getMigrations(),
        getMeta('last_sync'),
        getQueue(),
        getAllSettings().catch(() => ({})),
      ]);
      await updateStatus();
      const importPath = allSettings.media_import_path || '';
      this.setState({ loading: false, backups, migrations, lastSync, syncQueue: queue, importPath });
    } catch (err) {
      console.error('[SystemPage] load error:', err);
      store.set('toast', { message: 'Could not load system data.', type: 'error' });
      this.setState({ loading: false });
    }
  }

  async _handlePrepareOffline() {
    this.setState({ loadingOfflineStats: true });
    try {
      const stats = await getOfflineStats();
      this.setState({ loadingOfflineStats: false, offlineStats: stats });
      
      this._showConfirm({
        title: 'Download for offline',
        message: `
          <div class="offline-stats">
            <p>Download ${stats.post_count} posts and ${stats.image_count} images?</p>
            <div class="radio-group" style="margin-top: 1rem;">
              <label style="display: block; margin-bottom: 0.5rem;">
                <input type="radio" name="imageScope" value="thumbnails" checked> 
                Thumbnails only (${formatFileSize(stats.thumbnail_bytes)})
              </label>
              <label style="display: block;">
                <input type="radio" name="imageScope" value="full"> 
                Thumbnails + originals (${formatFileSize(stats.original_bytes)})
              </label>
            </div>
          </div>`,
        confirmText: 'Download',
        variant: 'primary',
        allowHtml: true,
        onConfirm: (dialog) => {
          const selected = dialog.container.querySelector('input[name="imageScope"]:checked');
          const scope = selected ? selected.value : 'thumbnails';
          this._handleStartDownload(scope);
        },
      });    } catch (err) {
      this.setState({ loadingOfflineStats: false });
      store.set('toast', { message: err.message || 'Failed to fetch offline stats.', type: 'error' });
    }
  }

  async _handleStartDownload(imageScope) {
    this.setState({
      downloadingOffline: true,
      offlineProgress: 0,
      offlineStatusText: 'Fetching snapshot…'
    });

    try {
      // 1. Snapshot
      const snapshot = await getOfflineSnapshot();
      this.setState({ offlineProgress: 20, offlineStatusText: 'Saving data…' });
      await saveSnapshot(snapshot);

      // 2. Images
      const urls = snapshot.media.map(m => imageScope === 'full' ? m.path : m.thumbnail_path).filter(Boolean);
      this.setState({ offlineProgress: 40, offlineStatusText: `Downloading ${urls.length} images…` });

      await preCacheImages(urls, imageScope, ({ completed, total }) => {
        const progress = 40 + Math.floor((completed / total) * 55);
        this.setState({ offlineProgress: progress, offlineStatusText: `Images: ${completed}/${total}` });
      });

      // 3. Meta
      const lastSync = Date.now();
      await saveMeta('last_sync', lastSync);
      await saveMeta('image_scope', imageScope);
      await saveMeta('blog_settings', snapshot.settings);

      this.setState({
        downloadingOffline: false,
        lastSync,
        offlineStatusText: ''
      });
      store.set('toast', { message: 'Offline download complete.', type: 'success' });
    } catch (err) {
      this.setState({ downloadingOffline: false });
      store.set('toast', { message: err.message || 'Offline download failed.', type: 'error' });
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

  async _handleScanMedia() {
    this.setState({ scanningMedia: true, scanResult: null });
    try {
      const result = await scanMediaImport();
      this.setState({ scanningMedia: false, scanResult: result });
      const msg = `Imported ${result.imported} photo${result.imported !== 1 ? 's' : ''}, skipped ${result.skipped} duplicate${result.skipped !== 1 ? 's' : ''}.`;
      store.set('toast', { message: msg, type: result.imported > 0 ? 'success' : 'info' });
    } catch (err) {
      this.setState({ scanningMedia: false });
      store.set('toast', { message: err.message || 'Scan failed.', type: 'error' });
    }
  }

  async _handleClearCache() {
    try {
      const result = await clearCache();
      const count = result.updated_media || 0;
      store.set('toast', { message: `Cache cleared and ${count} media records synchronized.`, type: 'success' });
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

  _showConfirm({ title, message, confirmText, variant, allowHtml, onConfirm }) {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const dialog = new ConfirmDialog(mount, {
      title,
      message,
      confirmText,
      variant,
      allowHtml,
      onConfirm: () => { onConfirm(dialog); dialog.unmount(); mount.remove(); },
      onCancel:  () => { dialog.unmount(); mount.remove(); },
    });
    dialog.mount();
  }

  async _refreshSyncState() {
    const queue = await getQueue();
    this.setState({ syncQueue: queue });
  }

  async _handleSyncNow() {
    await syncQueue();
    await this._refreshSyncState();
  }

  async _handleDismissRetry() {
    await resetFailedOps();
    await updateStatus();
    await this._refreshSyncState();
    syncQueue();
  }

  async _handleLogout() {
    try { await logout(); } catch { /* ignore */ }
    store.set('user', null);
    navigate('/light/login', { replace: true });
  }
}
