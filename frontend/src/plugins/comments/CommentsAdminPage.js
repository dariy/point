/**
 * CommentsAdminPage — /light/comments moderation for the remark42 plugin.
 *
 * Two tabs backed by /api/admin/comments/* (Point-authenticated server-side
 * calls into the remark42 sidecar's admin API — no second login):
 *   - recent:  newest comments with delete / block-author actions
 *   - blocked: blocked users with unblock
 */

import { Component } from '../../components/Component.js';
import { adminLayoutTemplate, setupAdminLayout } from '../../components/light/AdminLayout.js';
import { ConfirmDialog } from '../../components/shared/ConfirmDialog.js';
import { api } from '../../api/client.js';
import { store } from '../../store.js';
import { escapeHtml } from '../../utils/helpers.js';
import { formatDate } from '../../utils/formatters.js';

// remark42 returns sanitized comment HTML; the moderation list only needs
// readable text, so flatten it via DOMParser (inert document — nothing loads
// or executes) instead of re-injecting markup.
function textOf(html) {
  return new DOMParser().parseFromString(html || '', 'text/html').body.textContent.trim();
}

export default class CommentsAdminPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: true, error: null, tab: 'recent', comments: [], blocked: [] };
  }

  render() {
    return adminLayoutTemplate({
      title: 'Comments',
      content: this._renderContent(),
    });
  }

  _renderContent() {
    const { loading, error, tab, comments, blocked } = this.state;
    if (loading) return '<div class="loading-spinner" aria-label="Loading comments…"></div>';
    if (error) return `<p class="error-state" role="alert">${escapeHtml(error)}</p>`;

    const tabs = `
      <div class="menu-editor-tabs" role="tablist">
        <button id="tab-recent" role="tab" aria-selected="${tab === 'recent'}" class="btn btn-sm ${tab === 'recent' ? 'btn-primary' : 'btn-secondary'}">Recent</button>
        <button id="tab-blocked" role="tab" aria-selected="${tab === 'blocked'}" class="btn btn-sm ${tab === 'blocked' ? 'btn-primary' : 'btn-secondary'}">Blocked users${blocked.length ? ` (${blocked.length})` : ''}</button>
      </div>`;

    return `
      <div class="card">
        <div class="card-header">${tabs}</div>
        <div class="card-body">
          ${tab === 'recent' ? this._renderRecent(comments) : this._renderBlocked(blocked)}
        </div>
      </div>`;
  }

  _renderRecent(comments) {
    if (!comments.length) return '<p class="empty-state">No comments yet.</p>';
    const rows = comments.map((c, i) => {
      const url = c.locator?.url || '';
      const name = c.user?.name || c.user?.id || 'unknown';
      return `
        <li class="comment-mod-item" data-i="${i}">
          <div class="comment-mod-meta">
            <strong>${escapeHtml(name)}</strong>
            <time datetime="${escapeHtml(c.time || '')}">${escapeHtml(formatDate(c.time))}</time>
            ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(c.title || c.locator?.title || 'post')} ↗</a>` : ''}
          </div>
          <p class="comment-mod-text">${escapeHtml(textOf(c.text))}</p>
          <div class="comment-mod-actions">
            <button class="btn btn-sm btn-secondary" data-action="delete" data-i="${i}">Delete</button>
            <button class="btn btn-sm btn-secondary" data-action="block" data-i="${i}">Block the author</button>
          </div>
        </li>`;
    }).join('');
    return `<ul class="comment-mod-list">${rows}</ul>`;
  }

  _renderBlocked(blocked) {
    if (!blocked.length) return '<p class="empty-state">No blocked users.</p>';
    const rows = blocked.map((u, i) => `
      <li class="comment-mod-item" data-i="${i}">
        <div class="comment-mod-meta">
          <strong>${escapeHtml(u.name || u.id)}</strong>
          <span>blocked until ${escapeHtml(formatDate(u.time))}</span>
        </div>
        <div class="comment-mod-actions">
          <button class="btn btn-sm btn-secondary" data-action="unblock" data-i="${i}">Unblock</button>
        </div>
      </li>`).join('');
    return `<ul class="comment-mod-list">${rows}</ul>`;
  }

  afterRender() {
    this._cleanupAdminLayout = setupAdminLayout(this, { currentPath: '/light/comments' });

    this.container.querySelector('#tab-recent')?.addEventListener('click', () => this.setState({ tab: 'recent' }));
    this.container.querySelector('#tab-blocked')?.addEventListener('click', () => this.setState({ tab: 'blocked' }));

    this.container.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.i);
        const action = btn.dataset.action;
        if (action === 'delete') this._deleteComment(this.state.comments[i]);
        else if (action === 'block') this._blockUser(this.state.comments[i]?.user);
        else if (action === 'unblock') this._unblock(this.state.blocked[i]);
      });
    });
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    try {
      const [comments, blocked] = await Promise.all([
        api.get('/api/admin/comments/recent?limit=50'),
        api.get('/api/admin/comments/blocked'),
      ]);
      if (this._unmounted) return;
      this.setState({ loading: false, error: null, comments: comments || [], blocked: blocked || [] });
    } catch (err) {
      if (this._unmounted) return;
      const msg = err.status === 503 || err.status === 502
        ? 'The comments engine is not reachable. Is remark42 configured (REMARK_SECRET/REMARK_URL)?'
        : (err.message || 'Failed to load comments.');
      this.setState({ loading: false, error: msg });
    }
  }

  _confirm({ title, message, confirmText, onConfirm }) {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const dialog = new ConfirmDialog(mount, {
      title,
      message,
      confirmText,
      variant: 'danger',
      onConfirm: () => { dialog.unmount(); mount.remove(); onConfirm(); },
      onCancel: () => { dialog.unmount(); mount.remove(); },
    });
    dialog.mount();
  }

  async _run(fn, okMsg) {
    try {
      await fn();
      store.set('toast', { message: okMsg, type: 'success' });
      this._load();
    } catch (err) {
      store.set('toast', { message: err.message || 'Action failed.', type: 'error' });
    }
  }

  _deleteComment(c) {
    if (!c) return;
    this._confirm({
      title: 'Delete comment',
      message: `Delete this comment by ${c.user?.name || 'unknown'}? This cannot be undone.`,
      confirmText: 'Delete',
      onConfirm: () => this._run(
        () => api.delete(`/api/admin/comments/comment/${encodeURIComponent(c.id)}?url=${encodeURIComponent(c.locator?.url || '')}`),
        'Comment deleted.',
      ),
    });
  }

  _blockUser(user) {
    if (!user?.id) return;
    this._confirm({
      title: 'Block user',
      message: `Block ${user.name || user.id} permanently? Their existing comments will be deleted by remark42.`,
      confirmText: 'Block',
      onConfirm: () => this._run(
        () => api.put(`/api/admin/comments/user/${encodeURIComponent(user.id)}/block?block=1`),
        'User blocked.',
      ),
    });
  }

  _unblock(user) {
    if (!user?.id) return;
    this._run(
      () => api.put(`/api/admin/comments/user/${encodeURIComponent(user.id)}/block?block=0`),
      'User unblocked.',
    );
  }

  beforeUnmount() {
    this._cleanupAdminLayout?.();
    super.beforeUnmount?.();
  }
}
