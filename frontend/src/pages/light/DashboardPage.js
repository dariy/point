/**
 * DashboardPage — admin overview with stats and quick actions.
 *
 * Fetches: GET /api/system/stats, GET /api/system/version
 */

import { Component } from '../../components/Component.js';
import { adminLayoutTemplate, setupAdminLayout } from '../../components/light/AdminLayout.js';
import { getStats, getVersion } from '../../api/system.js';
import { getPostAnalytics, getTopPosts } from '../../api/analytics.js';
import { listPosts, createPost } from '../../api/posts.js';
import { store } from '../../store.js';
import { html, navigate, raw } from '../../utils/helpers.js';
import { formatFileSize, formatDateShort } from '../../utils/formatters.js';
import { PLUS_SVG, MEDIA_SVG } from '../../utils/icons.js';

export default class DashboardPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: true, stats: null, analyticsStats: null, topPosts: [], drafts: [], error: null, versionBanner: null };
  }

  render() {
    const { versionBanner } = this.state;
    const banner = versionBanner
      ? html`<div class="version-update-banner" role="status">
           Point ${versionBanner} is available. Update with: <code>./update.sh</code>
           <button class="version-update-dismiss" id="dashboard-version-dismiss" aria-label="Dismiss">&times;</button>
         </div>`
      : '';

    return adminLayoutTemplate({
      title: 'Dashboard',
      banner,
      actions: html`<a href="/light/posts/new" class="btn btn-primary" title="New Post">${raw(PLUS_SVG)}<span class="btn-label">New Post</span></a>`,
      content: this._renderContent()
    });
  }

  _renderContent() {
    const { loading, stats, analyticsStats, topPosts, drafts, error } = this.state;

    if (loading) return html`<div class="loading-spinner" aria-label="Loading…"></div>`;
    if (error) return html`<p class="error-state" role="alert">${error}</p>`;
    // Omit the sidebar element entirely when it has nothing in it — an empty
    // one still reserves its grid column and shrinks the stats grid.
    const sidebar = this._renderContinueWriting(drafts);
    //       ${this._renderComposeStrip()}
    return html`

      <div class="dashboard-grid">
        <div class="dashboard-main">
          ${this._renderStats(stats, analyticsStats, topPosts)}
        </div>
        ${sidebar ? html`<div class="dashboard-sidebar">${sidebar}</div>` : ''}
      </div>
    `;
  }

  _renderComposeStrip() {
    return html`
      <div class="compose-strip-card card">
        <div class="compose-strip">
          <textarea id="compose-textarea" class="compose-textarea" placeholder="Compose something…" rows="1"></textarea>
          <div class="compose-actions">
            <button id="compose-attach-btn" class="btn btn-icon" title="Attach media" aria-label="Attach media">${raw(MEDIA_SVG)}</button>
            <button id="compose-draft-btn" class="btn btn-primary btn-sm">Draft</button>
          </div>
        </div>
      </div>
    `;
  }

  _renderContinueWriting(drafts) {
    // Falsy, not html``: RawHtml('') is truthy, and _renderContent gates the
    // sidebar wrapper on this result.
    if (!drafts || drafts.length === 0) return '';

    return html`
      <div class="card continue-writing-card">
        <div class="card-header"><h2>Continue writing</h2></div>
        <div class="card-body">
          <ul class="drafts-list">
            ${drafts.map(d => html`
              <li>
                <a href="/light/posts/${d.id}/edit" class="draft-stub">
                  <span class="draft-title">${d.title || '(Untitled)'}</span>
                  <span class="draft-date">${formatDateShort(d.updated_at || d.created_at)}</span>
                </a>
              </li>
            `)}
          </ul>
          <div class="card-footer-actions">
            <a href="/light/posts?status=draft" class="btn btn-text btn-sm">View all drafts</a>
          </div>
        </div>
      </div>
    `;
  }

  _renderStats(s, analytics, topPosts) {
    if (!s) return '';

    // The quota is operator-set (STORAGE_QUOTA_MB) and absent from the stats
    // response when unlimited — then we report bare usage with no bar to fill.
    const usagePercent = s.storage_quota_mb
      ? Math.min(100, Math.round((s.storage_used_mb / s.storage_quota_mb) * 100))
      : 0;
    const barClass = usagePercent >= 90 ? 'danger' : usagePercent >= 70 ? 'warning' : '';

    const analyticsCards = analytics ? html`
        <div class="stat-card">
          <div class="stat-label">Total Views</div>
          <div class="stat-value stat-primary">${String(analytics.total_views ?? 0)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Avg Views / Post</div>
          <div class="stat-value">${String(Math.round(analytics.average_views_per_post ?? 0))}</div>
        </div>` : '';

    const topPostsTable = topPosts.length > 0 ? html`
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
                ${topPosts.map(post => html`
                  <tr>
                    <td>
                      <a href="/light/posts/${String(post.id)}/edit" class="post-title-link">
                        ${post.title}
                      </a>
                    </td>
                    <td class="text-right font-mono">${String(post.view_count ?? 0)}</td>
                    <td class="text-right">
                      <span class="status-pill status-${post.status}">${post.status}</span>
                    </td>
                  </tr>`)}
              </tbody>
            </table>
          </div>
        </div>
      </div>` : '';

    return html`
      <div class="stats-grid">
        <a class="stat-card" href="/light/posts?status=published">
          <div class="stat-label">Published Posts</div>
          <div class="stat-value stat-primary">${String(s.published_posts ?? 0)}</div>
        </a>
        <a class="stat-card" href="/light/posts">
          <div class="stat-label">Total Posts</div>
          <div class="stat-value">${String(s.total_posts ?? 0)}</div>
        </a>
        <a class="stat-card" href="/light/tags">
          <div class="stat-label">Tags</div>
          <div class="stat-value">${String(s.total_tags ?? 0)}</div>
        </a>
        <a class="stat-card" href="/light/media">
          <div class="stat-label">Media Files</div>
          <div class="stat-value">${String(s.total_media ?? 0)}</div>
        </a>
        ${analyticsCards}
      </div>

      <div class="card" style="margin-top: var(--spacing-xl)">
        <div class="card-header"><h2>Storage</h2></div>
        <div class="card-body">
          <p>
            ${formatFileSize((s.storage_used_mb ?? 0) * 1024 * 1024)}
            ${s.storage_quota_mb ? html` of ${formatFileSize(s.storage_quota_mb * 1024 * 1024)} used (${String(usagePercent)}%)` : ' used'}
          </p>
          ${s.storage_quota_mb ? html`
          <div class="storage-bar">
            <div class="storage-bar-fill ${barClass}" style="width: ${String(usagePercent)}%"></div>
          </div>` : ''}
        </div>
      </div>
      ${topPostsTable}`;
  }

  afterRender() {
    setupAdminLayout(this, {
      currentPath: '/light',
    });

    this.$('#dashboard-version-dismiss')?.addEventListener('click', () => {
      const { versionBanner } = this.state;
      if (versionBanner) {
        localStorage.setItem(`version_dismissed_${versionBanner}`, '1');
        this.setState({ versionBanner: null });
      }
    });

    // Compose strip interactions
    const textarea = this.$('#compose-textarea');
    if (textarea) {
      textarea.addEventListener('input', () => {
        textarea.style.height = 'auto';
        textarea.style.height = (textarea.scrollHeight) + 'px';
      });

      this.$('#compose-draft-btn')?.addEventListener('click', async () => {
        const content = textarea.value.trim();
        if (!content) return;
        try {
          const post = await createPost({
            content,
            status: 'draft',
            // Blank first line: let the backend apply the date default.
            title: content.split('\n')[0].substring(0, 50).trim()
          });
          navigate(`/light/posts/${post.id}/edit`);
        } catch (err) {
          store.set('toast', { message: err.message || 'Failed to create draft.', type: 'error' });
        }
      });

      this.$('#compose-attach-btn')?.addEventListener('click', () => {
        // Just go to full editor for now as media picker needs more context
        const content = textarea.value.trim();
        navigate(`/light/posts/new?content=${encodeURIComponent(content)}&openMedia=1`);
      });
    }
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    try {
      const [stats, analyticsStats, topPostsResp, draftsResp] = await Promise.all([
        getStats(),
        getPostAnalytics().catch(() => null),
        getTopPosts(10).catch(() => ({ posts: [] })),
        listPosts({ status: 'draft', per_page: 5 }).catch(() => ({ posts: [] })),
      ]);
      this.setState({
        loading: false,
        stats,
        analyticsStats,
        topPosts: topPostsResp.posts || topPostsResp.items || [],
        drafts: draftsResp.posts || draftsResp.items || [],
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
