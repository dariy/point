/**
 * DashboardPage — admin overview with stats and quick actions.
 *
 * Fetches: GET /api/system/stats, GET /api/system/version
 */

import { Component } from '../../components/Component.js';
import { adminLayoutTemplate, setupAdminLayout } from '../../components/light/AdminLayout.js';
import { getStats, getVersion } from '../../api/system.js';
import { getPostAnalytics, getTopPosts } from '../../api/analytics.js';
import { store } from '../../store.js';
import { escapeHtml } from '../../utils/helpers.js';
import { formatFileSize } from '../../utils/formatters.js';
import { PLUS_SVG } from '../../utils/icons.js';

export default class DashboardPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: true, stats: null, analyticsStats: null, topPosts: [], error: null, versionBanner: null };
  }

  render() {
    const { versionBanner } = this.state;
    const banner = versionBanner
      ? `<div class="version-update-banner" role="status">
           Point ${escapeHtml(versionBanner)} is available. Update with: <code>./update.sh</code>
           <button class="version-update-dismiss" id="dashboard-version-dismiss" aria-label="Dismiss">&times;</button>
         </div>`
      : '';

    return adminLayoutTemplate({
      title: 'Dashboard',
      banner,
      actions: `<a href="/light/posts/new" class="btn btn-primary" title="New Post">${PLUS_SVG}<span class="btn-label">New Post</span></a>`,
      content: this._renderContent()
    });
  }

  _renderContent() {
    const { loading, stats, analyticsStats, topPosts, error } = this.state;

    if (loading) return `<div class="loading-spinner" aria-label="Loading…"></div>`;
    if (error) return `<p class="error-state" role="alert">${escapeHtml(error)}</p>`;
    return this._renderStats(stats, analyticsStats, topPosts);
  }

  _renderStats(s, analytics, topPosts) {
    if (!s) return '';

    const usagePercent = s.storage_quota_mb
      ? Math.min(100, Math.round((s.storage_used_mb / s.storage_quota_mb) * 100))
      : 0;
    const barClass = usagePercent >= 90 ? 'danger' : usagePercent >= 70 ? 'warning' : '';

    const analyticsCards = analytics ? `
        <div class="stat-card">
          <div class="stat-label">Total Views</div>
          <div class="stat-value stat-primary">${escapeHtml(String(analytics.total_views ?? 0))}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Avg Views / Post</div>
          <div class="stat-value">${escapeHtml(String(Math.round(analytics.average_views_per_post ?? 0)))}</div>
        </div>` : '';

    const topPostsTable = topPosts.length > 0 ? `
      <div class="card" style="margin-top: var(--spacing-xl)">
        <div class="card-header"><h2>Top Posts by Views</h2></div>
        <div class="card-body">
          <div class="table-container">
            <table class="table">
              <thead>
                <tr>
                  <th>Post Title</th>
                  <th class="text-right">Views</th>
                  <th class="text-right">Status</th>
                </tr>
              </thead>
              <tbody>
                ${topPosts.map(post => `
                  <tr>
                    <td>
                      <a href="/light/posts/${escapeHtml(String(post.id))}/edit" class="post-title-link">
                        ${escapeHtml(post.title)}
                      </a>
                    </td>
                    <td class="text-right font-mono">${escapeHtml(String(post.view_count ?? 0))}</td>
                    <td class="text-right">
                      <span class="status-pill status-${escapeHtml(post.status)}">${escapeHtml(post.status)}</span>
                    </td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>` : '';

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
        ${analyticsCards}
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
      </div>
      ${topPostsTable}`;
  }

  afterRender() {
    this._cleanupAdminLayout = setupAdminLayout(this, {
      currentPath: '/light',
    });

    this.$('#dashboard-version-dismiss')?.addEventListener('click', () => {
      const { versionBanner } = this.state;
      if (versionBanner) {
        localStorage.setItem(`version_dismissed_${versionBanner}`, '1');
        this.setState({ versionBanner: null });
      }
    });
  }

  beforeUnmount() {
    this._cleanupAdminLayout?.();
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    try {
      const [stats, analyticsStats, topPostsResp] = await Promise.all([
        getStats(),
        getPostAnalytics().catch(() => null),
        getTopPosts(10).catch(() => ({ posts: [] })),
      ]);
      this.setState({
        loading: false,
        stats,
        analyticsStats,
        topPosts: topPostsResp.posts || [],
        error: null,
      });
    } catch (err) {
      console.error('[DashboardPage] load error:', err);
      store.set('toast', { message: 'Could not load dashboard stats.', type: 'error' });
      this.setState({ loading: false, stats: null });
    }

    // Check for available updates in the background — don't block the page.
    try {
      const ver = await getVersion();
      if (ver.update_available) {
        const dismissKey = `version_dismissed_${ver.latest}`;
        if (!localStorage.getItem(dismissKey)) {
          this.setState({ versionBanner: ver.latest });
        }
      }
    } catch {
      // Version check failure is non-critical; silently ignore.
    }
  }
}
