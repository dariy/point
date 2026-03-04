/**
 * PostsListPage — paginated, filterable list of all posts.
 *
 * Fetches: GET /api/posts
 */

import { Component } from '../../components/Component.js';
import { LightSidebar } from '../../components/light/LightSidebar.js';
import { TagsInput } from '../../components/light/TagsInput.js';
import { Pagination } from '../../components/shared/Pagination.js';
import { ConfirmDialog } from '../../components/shared/ConfirmDialog.js';
import { listPosts, deletePost, updatePostTags } from '../../api/posts.js';
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
      search: props.query?.search || '',
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
              <tr data-post-id="${escapeHtml(String(p.id))}">
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
                <td class="tags-col"><div id="tags-cell-${escapeHtml(String(p.id))}"></div></td>
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
        <div class="light-main posts-list-main">
          <header class="light-header">
            <h1>Posts</h1>
            <div class="header-actions">
              <a href="/light/posts/new" class="btn btn-primary">+ New Post</a>
            </div>
          </header>
          <main class="light-content">
            <div class="filters">
              <select id="status-filter" class="filter-select">
                ${statusOptions}
              </select>
              <input type="search" id="search-input" class="form-input filter-search"
                     placeholder="Search posts…" value="${escapeHtml(search)}">
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

    // Restore focus to search input after a re-render triggered by _load
    const searchInput = this.$('#search-input');
    if (searchInput) {
      if (this._restoreSearchFocus) {
        this._restoreSearchFocus = false;
        const len = searchInput.value.length;
        searchInput.focus();
        searchInput.setSelectionRange(len, len);
      }

      searchInput.addEventListener('input', debounce((e) => {
        // Update state without re-rendering — the input already shows the new value
        this.state.search = e.target.value;
        this.state.page = 1;
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

    // Mount a TagsInput in every tags cell
    if (!this.state.loading && !this.state.error) {
      for (const post of this.state.posts) {
        this._mountTagEditor(post);
      }
    }

    // Delete buttons
    this.$$('.delete-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.id, 10);
        const title = btn.dataset.title;
        this._showConfirm('Delete post', `Delete post "${title}"? This cannot be undone.`, 'Delete', 'danger', () => {
          this._deletePost(id);
        });
      });
    });
  }

  mount() {
    super.mount();
    this._perPage = this._calcPerPage();
    this._load();

    this._onResize = debounce(() => {
      const next = this._calcPerPage();
      if (next !== this._perPage) {
        this._perPage = next;
        this._load({ page: 1 });
      }
    }, 200);
    window.addEventListener('resize', this._onResize);
  }

  beforeUnmount() {
    if (this._onResize) window.removeEventListener('resize', this._onResize);
  }

  /** Measure how many table rows fit in the available container height. */
  _calcPerPage() {
    const container = this.$('.table-container');
    const thead = this.$('thead');
    const probeRow = this.$('tbody tr');
    if (!container || !thead || !probeRow) return 20;
    const bodyHeight = container.clientHeight - thead.offsetHeight;
    const rowHeight = probeRow.offsetHeight || 44;
    return Math.max(5, Math.floor(bodyHeight / rowHeight));
  }

  /** Update the browser URL to reflect current filters without triggering a full navigation. */
  _syncUrl(overrides = {}) {
    const status = overrides.status ?? this.state.statusFilter;
    const search = overrides.search ?? this.state.search;
    const page   = overrides.page   ?? this.state.page;

    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (search) params.set('search', search);
    if (page > 1) params.set('page', String(page));

    const qs = params.toString();
    const url = '/light/posts' + (qs ? '?' + qs : '');
    history.replaceState(null, '', url);
  }

  async _load(overrides = {}) {
    // Check focus before any DOM mutation so we can restore it after re-render
    const searchEl = this.$('#search-input');
    const searchHadFocus = searchEl && document.activeElement === searchEl;

    // Show loading indicator in-place — no full re-render, no focus loss.
    // The string is fully static (no user data), so innerHTML is safe here.
    const tbody = this.$('#posts-tbody');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="5" class="loading">Loading\u2026</td></tr>`; // static, safe
    }
    this.state.loading = true;
    this.state.error = null;

    const params = {
      page: overrides.page ?? this.state.page,
      per_page: this._perPage ?? 20,
    };
    const status = overrides.status ?? this.state.statusFilter;
    const search = overrides.search ?? this.state.search;
    if (status) params.status = status;
    if (search) params.q = search;

    // Sync URL whenever filters change
    this._syncUrl(overrides);

    try {
      const data = await listPosts(params);
      this._restoreSearchFocus = searchHadFocus;
      this.setState({
        loading: false,
        posts: (data.posts || data.items || []).map(p => ({ ...p, status: (p.status || '').toLowerCase() })),
        pagination: {
          page: data.page,
          pages: data.pages,
          total: data.total,
          per_page: data.per_page,
        },
      });
    } catch (err) {
      this._restoreSearchFocus = searchHadFocus;
      this.setState({ loading: false, error: err.message || 'Failed to load posts.' });
    }
  }

  /** Mount a TagsInput directly in the tags cell for a post row. Saves on change. */
  _mountTagEditor(post) {
    const mount = this.$(`#tags-cell-${post.id}`);
    if (!mount) return;

    const initialTags = (post.tags || []).map(t => typeof t === 'string' ? t : t.name);

    this.mountChild(TagsInput, `#tags-cell-${post.id}`, {
      tags: initialTags,
      onChange: async (tags) => {
        try {
          const updated = await updatePostTags(post.id, tags);
          // Update local state silently so re-render preserves the new tags
          post.tags = updated.tags || tags.map(n => ({ name: n, slug: n }));
          store.set('toast', { message: 'Tags saved.', type: 'success' });
        } catch (err) {
          store.set('toast', { message: err.message || 'Failed to save tags.', type: 'error' });
        }
      },
    });
  }

  _showConfirm(title, message, confirmText, variant, onConfirm) {
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
