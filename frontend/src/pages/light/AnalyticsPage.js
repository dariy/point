import { Component } from '../../components/Component.js';
import { adminLayoutTemplate, setupAdminLayout } from '../../components/light/AdminLayout.js';
import { getPostAnalytics, getTopPosts } from '../../api/analytics.js';
import { escapeHtml } from '../../utils/helpers.js';

export default class AnalyticsPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      stats: null,
      topPosts: [],
      error: null
    };
  }

  afterRender() {
    this._cleanupAdminLayout = setupAdminLayout(this, {
      currentPath: '/light/analytics',
    });

    if (this.state.loading && !this._fetchStarted) {
      this._fetchStarted = true;
      this._loadData();
    }
  }

  beforeUnmount() {
    this._cleanupAdminLayout?.();
  }

  async _loadData() {
    try {
      const [stats, topPostsResp] = await Promise.all([
        getPostAnalytics(),
        getTopPosts(10)
      ]);

      this.setState({
        stats,
        topPosts: topPostsResp.posts || [],
        loading: false
      });
    } catch (err) {
      this.setState({
        error: err.message || 'Failed to load analytics',
        loading: false
      });
    }
  }

  render() {
    return adminLayoutTemplate({
      title: 'Analytics',
      content: this._renderContent()
    });
  }

  _renderContent() {
    const { loading, stats, topPosts, error } = this.state;

    if (loading) return '<div class="loading-spinner"></div>';
    if (error) return `<p class="error">${escapeHtml(error)}</p>`;
    if (!stats) return '<p>No data available</p>';

    return `
      <div class="analytics-dashboard">
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">Total Views</div>
            <div class="stat-value stat-primary">${escapeHtml(String(stats.total_views || 0))}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Total Posts</div>
            <div class="stat-value">${escapeHtml(String(stats.total_posts || 0))}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Avg Views / Post</div>
            <div class="stat-value">${escapeHtml(String(Math.round(stats.average_views_per_post || 0)))}</div>
          </div>
        </div>

        <div class="card" style="margin-top: var(--spacing-xl)">
          <div class="card-header"><h2>Top Posts</h2></div>
          <div class="card-body">
            <div class="table-container">
              <table class="table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th class="text-right">Views</th>
                  </tr>
                </thead>
                <tbody>
                  ${topPosts.map(p => `
                    <tr>
                      <td><a href="/light/posts/${p.id}/edit">${escapeHtml(p.title)}</a></td>
                      <td class="text-right font-mono">${escapeHtml(String(p.view_count || 0))}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}
