import { Component } from '../../components/Component.js';
import { LightSidebar } from '../../components/light/LightSidebar.js';
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
    this.mountChild(LightSidebar, '#sidebar-mount', {
      currentPath: '/light/analytics',
    });

    if (this.state.loading && !this._fetchStarted) {
      this._fetchStarted = true;
      this._loadData();
    }
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
    const { loading, stats, topPosts, error } = this.state;

    const content = loading
      ? `<div class="loading-spinner" aria-label="Loading…"></div>`
      : error
        ? `<p class="error-state" role="alert">${escapeHtml(error)}</p>`
        : this._renderAnalytics(stats, topPosts);

    return `
      <div class="light-layout">
        <div id="sidebar-mount"></div>
        <div class="light-main">
          <header class="light-header">
            <div class="header-title-row">
              <h1>Analytics</h1>
            </div>
          </header>
          <main class="light-content">${content}</main>
        </div>
      </div>`;
  }

  _renderAnalytics(stats, topPosts) {
    return `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Total Views</div>
          <div class="stat-value stat-primary">${escapeHtml(String(stats.total_views ?? 0))}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Average Views / Post</div>
          <div class="stat-value">${escapeHtml(String(Math.round(stats.average_views_per_post ?? 0)))}</div>
        </div>
      </div>

      <div class="card" style="margin-top: var(--spacing-xl)">
        <div class="card-header">
          <h2>Top 10 Posts</h2>
        </div>
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
                      <a href="/light/posts/${post.id}/edit" class="post-title-link">
                        ${escapeHtml(post.title)}
                      </a>
                    </td>
                    <td class="text-right font-mono">${escapeHtml(String(post.view_count ?? 0))}</td>
                    <td class="text-right">
                      <span class="status-pill status-${post.status}">${escapeHtml(post.status)}</span>
                    </td>
                  </tr>
                `).join('')}
                ${topPosts.length === 0 ? '<tr><td colspan="3" class="text-center">No posts found</td></tr>' : ''}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }
}
