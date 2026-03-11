/**
 * DashboardPage — admin overview with stats and quick actions.
 *
 * Fetches: GET /api/system/stats
 */

import { Component } from '../../components/Component.js';
import { LightSidebar } from '../../components/light/LightSidebar.js';
import { getStats } from '../../api/system.js';
import { logout } from '../../api/auth.js';
import { store } from '../../store.js';
import { escapeHtml, navigate } from '../../utils/helpers.js';
import { formatFileSize } from '../../utils/formatters.js';

export default class DashboardPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: true, stats: null, error: null };
  }

  render() {
    const { loading, stats, error } = this.state;
    const user = store.get('user') || {};

    const content = loading
      ? `<div class="loading-spinner" aria-label="Loading…"></div>`
      : error
        ? `<p class="error-state" role="alert">${escapeHtml(error)}</p>`
        : this._renderStats(stats);

    const offline = store.get('offline_status') || {};
    let syncPill = '';
    if (offline.has_ops || offline.syncing) {
      const text = offline.syncing ? '⟳ Syncing…' : offline.failed ? `⚠ ${offline.failed} failed` : `● ${offline.pending} pending`;
      const cls = `sync-pill ${offline.syncing ? 'syncing' : offline.failed ? 'failed' : 'pending'}`;
      syncPill = `<button class="${cls}" id="dashboard-sync-pill">${text}</button>`;
    }

    return `
      <div class="light-layout">
        <div id="sidebar-mount"></div>
        <div class="light-main">
          <header class="light-header">
            <div class="header-title-row">
              <h1>Dashboard</h1>
              ${syncPill}
            </div>
            <div class="header-actions">
              <a href="/light/posts/new" class="btn btn-primary">+ New Post</a>
            </div>
          </header>
          <main class="light-content">${content}</main>
        </div>
      </div>`;
  }

  _renderStats(s) {
    if (!s) return '';

    const usagePercent = s.storage_quota_mb
      ? Math.min(100, Math.round((s.storage_used_mb / s.storage_quota_mb) * 100))
      : 0;
    const barClass = usagePercent >= 90 ? 'danger' : usagePercent >= 70 ? 'warning' : '';

    return `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Published Posts</div>
          <div class="stat-value stat-primary">${escapeHtml(String(s.published_posts ?? 0))}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total Posts</div>
          <div class="stat-value">${escapeHtml(String(s.total_posts ?? 0))}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Tags</div>
          <div class="stat-value">${escapeHtml(String(s.total_tags ?? 0))}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Media Files</div>
          <div class="stat-value">${escapeHtml(String(s.total_media ?? 0))}</div>
        </div>
      </div>

      <div class="card" style="margin-top: var(--spacing-xl)">
        <div class="card-header"><h2>Storage</h2></div>
        <div class="card-body">
          <p>
            ${escapeHtml(formatFileSize((s.storage_used_mb ?? 0) * 1024 * 1024))}
            ${s.storage_quota_mb ? ` of ${escapeHtml(formatFileSize(s.storage_quota_mb * 1024 * 1024))} used (${escapeHtml(String(usagePercent))}%)` : ' used'}
          </p>
          <div class="storage-bar">
            <div class="storage-bar-fill ${barClass}" style="width: ${escapeHtml(String(usagePercent))}%"></div>
          </div>
        </div>
      </div>`;
  }

  afterRender() {
    this.mountChild(LightSidebar, '#sidebar-mount', {
      currentPath: '/light',
      user: store.get('user') || {},
      onLogout: this._handleLogout.bind(this),
    });

    this.$('#dashboard-sync-pill')?.addEventListener('click', () => {
      const offline = store.get('offline_status') || {};
      if (offline.failed) navigate('/light/system');
      else if (offline.pending) import('../../utils/sync.js').then(m => m.syncQueue());
    });
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    try {
      const stats = await getStats();
      this.setState({ loading: false, stats, error: null });
    } catch (err) {
      this.setState({ loading: false, stats: null, error: err.message || 'Failed to load stats.' });
    }
  }

  async _handleLogout() {
    try { await logout(); } catch { /* ignore */ }
    store.set('user', null);
    navigate('/light/login', { replace: true });
  }
}
