/**
 * SystemPage — system administration (logs, cache, backups, migrations).
 *
 * Fetches: GET /api/system/*
 */

import { Component } from '../../components/Component.js';
import { LightSidebar } from '../../components/light/LightSidebar.js';
import {
  getStats, getLogs, clearCache, listBackups,
  createBackup, restoreBackup, deleteBackup, getMigrations
} from '../../api/system.js';
import { logout } from '../../api/auth.js';
import { store } from '../../store.js';
import { escapeHtml, navigate } from '../../utils/helpers.js';
import { formatFileSize, formatDateShort } from '../../utils/formatters.js';

export default class SystemPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      stats: null,
      backups: [],
      migrations: [],
      logs: [],
      logType: 'app',
      logLines: 50,
      loadingLogs: false,
      creatingBackup: false,
      error: null,
    };
  }

  render() {
    const { loading, error, stats, backups, migrations, logs, logType, logLines, loadingLogs, creatingBackup } = this.state;

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

    return `
      <div class="light-layout">
        <div id="sidebar-mount"></div>
        <div class="light-main">
          <header class="light-header">
            <h1>System</h1>
          </header>
          <main class="light-content">

            <div class="grid-2-col">
              <div class="card">
                <div class="card-header"><h2>Cache Management</h2></div>
                <div class="card-body">
                  <p>Clear the server-side file cache (thumbnails, optimized images).</p>
                  <button id="clear-cache-btn" class="btn btn-secondary">Clear All Cache</button>
                </div>
              </div>

              <div class="card">
                <div class="card-header"><h2>Backups</h2></div>
                <div class="card-body">
                  <button id="create-backup-btn" class="btn btn-primary" ${creatingBackup ? 'disabled' : ''}>
                    ${creatingBackup ? 'Creating…' : 'Create New Backup'}
                  </button>
                  <div class="backup-list" style="margin-top: var(--spacing-md)">
                    ${this._renderBackups(backups)}
                  </div>
                </div>
              </div>
            </div>

            <div class="card" style="margin-top: var(--spacing-xl)">
              <div class="card-header">
                <h2>System Logs</h2>
                <div class="header-actions">
                  <select id="log-type-select" class="form-input form-input-sm">
                    <option value="app" ${logType === 'app' ? 'selected' : ''}>App Log</option>
                    <option value="error" ${logType === 'error' ? 'selected' : ''}>Error Log</option>
                  </select>
                  <select id="log-lines-select" class="form-input form-input-sm">
                    <option value="50" ${logLines === 50 ? 'selected' : ''}>50 lines</option>
                    <option value="200" ${logLines === 200 ? 'selected' : ''}>200 lines</option>
                    <option value="500" ${logLines === 500 ? 'selected' : ''}>500 lines</option>
                  </select>
                  <button id="refresh-logs-btn" class="btn btn-sm btn-secondary">Refresh</button>
                </div>
              </div>
              <div class="card-body log-viewer">
                ${loadingLogs
                  ? `<div class="loading-spinner loading-spinner-sm"></div>`
                  : `<pre class="log-content">${escapeHtml(logs.join('
') || 'No log entries found.')}</pre>`
                }
              </div>
            </div>

            <div class="card" style="margin-top: var(--spacing-xl)">
              <div class="card-header"><h2>Migrations History</h2></div>
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
    return `
      <table class="table table-sm">
        <thead><tr><th>Filename</th><th>Size</th><th>Actions</th></tr></thead>
        <tbody>
          ${backups.map(b => `
            <tr>
              <td title="${escapeHtml(b.filename)}">${escapeHtml(b.filename)}</td>
              <td>${escapeHtml(formatFileSize(b.size))}</td>
              <td class="actions">
                <button class="btn btn-sm restore-backup-btn" data-file="${escapeHtml(b.filename)}">Restore</button>
                <button class="btn btn-sm btn-danger delete-backup-btn" data-file="${escapeHtml(b.filename)}">✕</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;
  }

  afterRender() {
    this.mountChild(LightSidebar, '#sidebar-mount', {
      currentPath: '/light/system',
      user: store.get('user') || {},
      onLogout: this._handleLogout.bind(this),
    });

    if (this.state.loading) return;

    // Cache
    this.$('#clear-cache-btn')?.addEventListener('click', () => this._handleClearCache());

    // Backups
    this.$('#create-backup-btn')?.addEventListener('click', () => this._handleCreateBackup());
    this.$$('.restore-backup-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const file = btn.dataset.file;
        if (confirm(`Restore backup "${file}"? This will overwrite your current database!`)) {
          this._handleRestoreBackup(file);
        }
      });
    });
    this.$$('.delete-backup-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const file = btn.dataset.file;
        if (confirm(`Delete backup "${file}"?`)) {
          this._handleDeleteBackup(file);
        }
      });
    });

    // Logs
    this.$('#log-type-select')?.addEventListener('change', (e) => {
      this.setState({ logType: e.target.value });
      this._loadLogs();
    });
    this.$('#log-lines-select')?.addEventListener('change', (e) => {
      this.setState({ logLines: parseInt(e.target.value, 10) });
      this._loadLogs();
    });
    this.$('#refresh-logs-btn')?.addEventListener('click', () => this._loadLogs());
  }

  mount() {
    super.mount();
    this._loadInitial();
  }

  async _loadInitial() {
    this.setState({ loading: true, error: null });
    try {
      const [stats, backups, migrations] = await Promise.all([
        getStats(),
        listBackups(),
        getMigrations(),
      ]);
      this.setState({ loading: false, stats, backups, migrations });
      this._loadLogs();
    } catch (err) {
      this.setState({ loading: false, error: err.message || 'Failed to load system data.' });
    }
  }

  async _loadLogs() {
    this.setState({ loadingLogs: true });
    try {
      const logs = await getLogs({ log_type: this.state.logType, lines: this.state.logLines });
      this.setState({ loadingLogs: false, logs });
    } catch (err) {
      this.setState({ loadingLogs: false, logs: [`Error loading logs: ${err.message}`] });
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

  async _handleLogout() {
    try { await logout(); } catch { /* ignore */ }
    store.set('user', null);
    navigate('/light/login', { replace: true });
  }
}
