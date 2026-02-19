/**
 * PostsListPage — paginated, filterable list of all posts.
 *
 * Fetches: GET /api/posts
 */

import { Component } from '../../components/Component.js';
import { LightSidebar } from '../../components/light/LightSidebar.js';
import { Pagination } from '../../components/shared/Pagination.js';
import { listPosts, deletePost } from '../../api/posts.js';
import { logout } from '../../api/auth.js';
import { store } from '../../store.js';
import { escapeHtml, navigate, debounce } from '../../utils/helpers.js';
import { formatDateShort } from '../../utils/formatters.js';

const STATUS_LABELS = {
  published: 'Published',
  draft: 'Draft',
  hidden: 'Hidden',
  page: 'Page',
};

export default class PostsListPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      posts: [],
      pagination: {},
      error: null,
      statusFilter: props.query?.status || '',
      search: props.query?.q || '',
      page: parseInt(props.query?.page || '1', 10),
    };
  }

  render() {
    const { loading, posts, pagination, error, statusFilter, search } = this.state;

    const statusOptions = ['', 'draft', 'published', 'hidden', 'page'].map((s) => {
      const label = s ? STATUS_LABELS[s] : 'All statuses';
      const sel = statusFilter === s ? ' selected' : '';
      return `<option value="${escapeHtml(s)}"${sel}>${escapeHtml(label)}</option>`;
    }).join('');

    const rows = loading
      ? `<tr><td colspan="5" class="loading">Loading…</td></tr>`
      : error
        ? `<tr><td colspan="5" class="error-state">${escapeHtml(error)}</td></tr>`
        : !posts.length
          ? `<tr><td colspan="5" class="empty-state">No posts found.</td></tr>`
          : posts.map((p) => `
              <tr>
                <td>
                  <a href="/light/posts/${escapeHtml(String(p.id))}/edit" class="table-link">
                    ${escapeHtml(p.title)}
                  </a>
                </td>
                <td>
                  <span class="badge badge-${escapeHtml(p.status)}">
                    ${escapeHtml(STATUS_LABELS[p.status] || p.status)}
                  </span>
                </td>
                <td>${escapeHtml(p.tags?.join(', ') || '—')}</td>
                <td>${escapeHtml(formatDateShort(p.updated_at || p.created_at))}</td>
                <td class="actions">
                  <a href="/light/posts/${escapeHtml(String(p.id))}/edit"
                     class="btn btn-sm" title="Edit">✎</a>
                  <a href="/post/${escapeHtml(p.slug)}" class="btn btn-sm"
                     title="View" target="_blank" data-external>↗</a>
                  <button class="btn btn-sm btn-danger delete-btn"
                          data-id="${escapeHtml(String(p.id))}"
                          data-title="${escapeHtml(p.title)}"
                          title="Delete">✕</button>
                </td>
              </tr>`).join('');

    return `
      <div class="light-layout">
        <div id="sidebar-mount"></div>
        <div class="light-main">
          <header class="light-header">
            <h1>Posts</h1>
            <div class="header-actions">
              <a href="/light/posts/new" class="btn btn-primary">+ New Post</a>
            </div>
          </header>
          <main class="light-content">
            <div class="filters">
              <input type="search" id="search-input" class="form-input filter-search"
                     placeholder="Search posts…" value="${escapeHtml(search)}">
              <select id="status-filter" class="filter-select">
                ${statusOptions}
              </select>
            </div>
            <div class="table-container">
              <table class="table">
                <thead>
                  <tr>
                    <th>Title</th><th>Status</th><th>Tags</th><th>Updated</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody id="posts-tbody">${rows}</tbody>
              </table>
            </div>
            <div id="pagination-mount"></div>
          </main>
        </div>
      </div>`;
  }

  afterRender() {
    this.mountChild(LightSidebar, '#sidebar-mount', {
      currentPath: '/light/posts',
      user: store.get('user') || {},
      onLogout: this._handleLogout.bind(this),
    });

    if (!this.state.loading && this.state.pagination.pages > 1) {
      this.mountChild(Pagination, '#pagination-mount', {
        page: this.state.pagination.page,
        pages: this.state.pagination.pages,
        total: this.state.pagination.total,
        onPage: (p) => this._load({ page: p }),
      });
    }

    // Search input with debounce
    const searchInput = this.$('#search-input');
    if (searchInput) {
      searchInput.addEventListener('input', debounce((e) => {
        this.setState({ search: e.target.value, page: 1 });
        this._load({ page: 1, search: e.target.value });
      }, 350));
    }

    // Status filter
    const statusFilter = this.$('#status-filter');
    if (statusFilter) {
      statusFilter.addEventListener('change', (e) => {
        this.setState({ statusFilter: e.target.value, page: 1 });
        this._load({ page: 1, status: e.target.value });
      });
    }

    // Delete buttons
    this.$$('.delete-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.id, 10);
        const title = btn.dataset.title;
        if (confirm(`Delete post "${title}"? This cannot be undone.`)) {
          this._deletePost(id);
        }
      });
    });
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load(overrides = {}) {
    this.setState({ loading: true, error: null });
    const params = {
      page: overrides.page ?? this.state.page,
      per_page: 20,
    };
    const status = overrides.status ?? this.state.statusFilter;
    const search = overrides.search ?? this.state.search;
    if (status) params.status = status;
    if (search) params.q = search;

    try {
      const data = await listPosts(params);
      this.setState({
        loading: false,
        posts: data.posts || data.items || [],
        pagination: {
          page: data.page,
          pages: data.pages,
          total: data.total,
          per_page: data.per_page,
        },
      });
    } catch (err) {
      this.setState({ loading: false, error: err.message || 'Failed to load posts.' });
    }
  }

  async _deletePost(id) {
    try {
      await deletePost(id);
      store.set('toast', { message: 'Post deleted.', type: 'success' });
      this._load();
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
