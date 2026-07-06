/**
 * CommentsAdminPage — /light/comments moderation for the remark42 plugin.
 */

import { Component } from '../../components/Component.js';
import { adminLayoutTemplate, setupAdminLayout } from '../../components/light/AdminLayout.js';
import { ConfirmDialog } from '../../components/shared/ConfirmDialog.js';
import { api } from '../../api/client.js';
import { store } from '../../store.js';
import { escapeHtml } from '../../utils/helpers.js';
import { formatDate } from '../../utils/formatters.js';
import { MINUS_SVG, TRASH_SVG, EXTERNAL_LINK_SVG, RESTORE_SVG, SELECT_SVG, X_SVG } from '../../utils/icons.js';

function textOf(html) {
  return new DOMParser().parseFromString(html || '', 'text/html').body.textContent.trim();
}

export default class CommentsAdminPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: true, error: null, tab: 'recent', comments: [], blocked: [], selectMode: false, selectedIds: new Set() };
  }

  render() {
    const { selectMode } = this.state;
    const actions = `<button id="select-mode-btn" class="btn" title="${selectMode ? "Cancel selection" : "Select comments"}">${selectMode ? X_SVG : SELECT_SVG}<span class="btn-label">${selectMode ? "Cancel" : "Select"}</span></button>`;
    return adminLayoutTemplate({ title: 'Comments', actions, content: this._renderContent() });
  }

  _renderContent() {
    const { loading, error, tab, comments, blocked, selectMode, selectedIds } = this.state;
    if (loading) return '<div class="loading-spinner" aria-label="Loading comments…"></div>';
    if (error) return `<p class="error-state" role="alert">${escapeHtml(error)}</p>`;

    const tabs = `
      <div class="menu-editor-tabs" role="tablist">
        <button id="tab-recent" role="tab" aria-selected="${tab === 'recent'}" class="btn btn-sm ${tab === 'recent' ? 'btn-primary' : 'btn-secondary'}">Recent</button>
        <button id="tab-blocked" role="tab" aria-selected="${tab === 'blocked'}" class="btn btn-sm ${tab === 'blocked' ? 'btn-primary' : 'btn-secondary'}">Blocked users${blocked.length ? ` (${blocked.length})` : ''}</button>
      </div>`;

    let bulkToolbar = '';
    if (selectMode) {
      const isRecent = tab === 'recent';
      bulkToolbar = `
        <div class="posts-toolbar" style="margin-bottom: var(--spacing-sm);">
          <div class="bulk-toolbar" style="display: flex;">
            <div class="bulk-actions">
              <span id="bulk-count">${selectedIds.size} selected</span>
              ${isRecent ? `
                <button id="bulk-block-btn" class="btn btn-sm btn-secondary" ${selectedIds.size ? '' : 'disabled'}>${MINUS_SVG}<span class="btn-label">Block Authors</span></button>
                <button id="bulk-delete-btn" class="btn btn-sm btn-danger" ${selectedIds.size ? '' : 'disabled'}>${TRASH_SVG}<span class="btn-label">Delete</span></button>
              ` : `
                <button id="bulk-unblock-btn" class="btn btn-sm btn-secondary" ${selectedIds.size ? '' : 'disabled'}>${RESTORE_SVG}<span class="btn-label">Unblock</span></button>
              `}
            </div>
          </div>
        </div>
      `;
    }

    return `
      ${bulkToolbar}
      <div class="card">
        <div class="card-header">${tabs}</div>
        <div class="card-body">
          ${tab === 'recent' ? this._renderRecent(comments) : this._renderBlocked(blocked)}
        </div>
      </div>`;
  }

  _renderRecent(comments) {
    const { selectMode, selectedIds } = this.state;
    if (!comments.length) return '<p class="empty-state">No comments yet.</p>';
    
    const tableRows = comments.map((c, i) => {
      const url = c.locator?.url || '';
      const name = c.user?.name || c.user?.id || 'unknown';
      const isChecked = selectedIds.has(i);
      return `
        <tr data-i="${i}" class="post-row-main">
          ${selectMode ? `<td class="check-col" rowspan="2"><input type="checkbox" class="select-row-cb" data-i="${i}" ${isChecked ? "checked" : ""}></td>` : ""}
          <td class="meta-col"><strong>${escapeHtml(name)}</strong></td>
          <td class="title-col">${url ? `<a href="${escapeHtml(url)}" class="table-link muted" target="_blank" rel="noopener noreferrer">${escapeHtml(c.title || c.locator?.title || 'post')} ${EXTERNAL_LINK_SVG}</a>` : '<span class="text-muted">—</span>'}</td>
          <td class="updated-col"><time datetime="${escapeHtml(c.time || '')}">${escapeHtml(formatDate(c.time))}</time></td>
          <td class="actions-col" rowspan="2">
            <div class="actions">
              <button class="btn btn-sm btn-secondary btn-block-user" data-action="block" data-i="${i}" title="Block the author">${MINUS_SVG}</button>
              <button class="btn btn-sm btn-danger btn-delete-comment" data-action="delete" data-i="${i}" title="Delete">${TRASH_SVG}</button>
            </div>
          </td>
        </tr>
        <tr data-i="${i}" class="post-row-tags">
          <td colspan="3" class="tags-col" style="white-space: normal;">${escapeHtml(textOf(c.text))}</td>
        </tr>`;
    }).join('');

    const tableHTML = `
      <div class="table-container">
        <table class="table">
          <thead>
            <tr>
              ${selectMode ? `<th class="check-col" style="width: 1%;"><input type="checkbox" id="select-all-cb" ${comments.length > 0 && selectedIds.size === comments.length ? 'checked' : ''}></th>` : ''}
              <th style="width: 20%;">Author</th>
              <th style="width: 50%;">Post</th>
              <th style="width: 20%;">Date</th>
              <th style="width: 10%;"></th>
            </tr>
          </thead>
          <tbody id="posts-tbody">${tableRows}</tbody>
        </table>
      </div>`;

    const cardRows = comments.map((c, i) => {
      const url = c.locator?.url || '';
      const name = c.user?.name || c.user?.id || 'unknown';
      const isChecked = selectedIds.has(i);
      return `
        <div class="post-card${isChecked ? " is-selected" : ""}" data-i="${i}">
          <div class="post-card-body">
            <div class="post-card-top" style="align-items: baseline; flex-wrap: wrap;">
              <span class="post-card-title" style="flex: 1;">
                <strong>${escapeHtml(name)}</strong>
                <span class="text-muted" style="font-weight: normal; font-size: var(--font-size-xs); margin-left: var(--spacing-sm);">
                  ${url ? `on <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" style="color: inherit;">${escapeHtml(c.title || c.locator?.title || 'post')}</a> · ` : ''}
                  <time datetime="${escapeHtml(c.time || '')}">${escapeHtml(formatDate(c.time))}</time>
                </span>
              </span>
            </div>
            <div class="post-card-chips" style="white-space: normal; color: var(--text-primary); font-size: var(--font-size-sm); margin-bottom: var(--spacing-xs);">
              ${escapeHtml(textOf(c.text))}
            </div>
          </div>
          <div class="post-card-swipe-actions">
            <button class="btn btn-sm swipe-block-btn btn-block-user" data-action="block" data-i="${i}">${MINUS_SVG}<span>Block</span></button>
            <button class="btn btn-sm btn-danger swipe-delete-btn btn-delete-comment" data-action="delete" data-i="${i}">${TRASH_SVG}<span>Delete</span></button>
          </div>
        </div>`;
    }).join('');

    const selectClass = selectMode ? " select-mode" : "";
    const cardHTML = `<div class="posts-card-list${selectClass}" id="posts-card-list">${cardRows}</div>`;
    return tableHTML + cardHTML;
  }

  _renderBlocked(blocked) {
    const { selectMode, selectedIds } = this.state;
    if (!blocked.length) return '<p class="empty-state">No blocked users.</p>';
    
    const tableRows = blocked.map((u, i) => {
      const isChecked = selectedIds.has(i);
      return `
        <tr data-i="${i}" class="post-row-main">
          ${selectMode ? `<td class="check-col"><input type="checkbox" class="select-row-cb" data-i="${i}" ${isChecked ? "checked" : ""}></td>` : ""}
          <td><strong>${escapeHtml(u.name || u.id)}</strong></td>
          <td>blocked until ${escapeHtml(formatDate(u.time))}</td>
          <td class="actions-col">
            <div class="actions">
              <button class="btn btn-sm btn-secondary btn-unblock-user" data-action="unblock" data-i="${i}" title="Unblock">${RESTORE_SVG}</button>
            </div>
          </td>
        </tr>`;
    }).join('');

    const tableHTML = `
      <div class="table-container">
        <table class="table">
          <thead>
            <tr>
              ${selectMode ? `<th class="check-col" style="width: 1%;"><input type="checkbox" id="select-all-cb" ${blocked.length > 0 && selectedIds.size === blocked.length ? 'checked' : ''}></th>` : ''}
              <th>User</th>
              <th>Status</th>
              <th style="width: 1%;"></th>
            </tr>
          </thead>
          <tbody id="posts-tbody">${tableRows}</tbody>
        </table>
      </div>`;

    const cardRows = blocked.map((u, i) => {
      const isChecked = selectedIds.has(i);
      return `
        <div class="post-card${isChecked ? " is-selected" : ""}" data-i="${i}">
          <div class="post-card-body">
            <div class="post-card-top" style="align-items: baseline;">
              <span class="post-card-title">
                <strong>${escapeHtml(u.name || u.id)}</strong>
                <span class="text-muted" style="font-weight: normal; font-size: var(--font-size-xs); margin-left: var(--spacing-sm);">
                  blocked until ${escapeHtml(formatDate(u.time))}
                </span>
              </span>
            </div>
          </div>
          <div class="post-card-swipe-actions">
            <button class="btn btn-sm btn-secondary swipe-unblock-btn btn-unblock-user" data-action="unblock" data-i="${i}">${RESTORE_SVG}<span>Unblock</span></button>
          </div>
        </div>`;
    }).join('');

    const selectClass = selectMode ? " select-mode" : "";
    const cardHTML = `<div class="posts-card-list${selectClass}" id="posts-card-list">${cardRows}</div>`;
    return tableHTML + cardHTML;
  }

  afterRender() {
    this._cleanupAdminLayout = setupAdminLayout(this, { currentPath: '/light/comments' });

    this.container.querySelector('#tab-recent')?.addEventListener('click', () => this.setState({ tab: 'recent', selectMode: false, selectedIds: new Set() }));
    this.container.querySelector('#tab-blocked')?.addEventListener('click', () => this.setState({ tab: 'blocked', selectMode: false, selectedIds: new Set() }));

    this.container.querySelector('#select-mode-btn')?.addEventListener('click', () => {
      this.setState({ selectMode: !this.state.selectMode, selectedIds: new Set() });
    });

    this.container.querySelector('#select-all-cb')?.addEventListener('change', (e) => {
      const items = this.state.tab === 'recent' ? this.state.comments : this.state.blocked;
      const selectedIds = new Set();
      if (e.target.checked) items.forEach((_, i) => selectedIds.add(i));
      this.setState({ selectMode: selectedIds.size > 0, selectedIds });
    });

    this.container.querySelectorAll('.select-row-cb').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const i = Number(e.target.dataset.i);
        const selectedIds = new Set(this.state.selectedIds);
        if (e.target.checked) selectedIds.add(i);
        else selectedIds.delete(i);
        this.setState({ selectedIds });
      });
    });

    this.container.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.i);
        const action = btn.dataset.action;
        if (action === 'delete') this._deleteComment(this.state.comments[i]);
        else if (action === 'block') this._blockUser(this.state.comments[i]?.user);
        else if (action === 'unblock') this._unblock(this.state.blocked[i]);
      });
    });

    this.container.querySelector('#bulk-delete-btn')?.addEventListener('click', () => this._handleBulkDelete());
    this.container.querySelector('#bulk-block-btn')?.addEventListener('click', () => this._handleBulkBlock());
    this.container.querySelector('#bulk-unblock-btn')?.addEventListener('click', () => this._handleBulkUnblock());

    this._bindSwipeToReveal();
  }

  _bindSwipeToReveal() {
    this._swipeCleanup?.();
    this._swipeCleanup = null;
    if (!window.matchMedia) return;
    if (!window.matchMedia('(max-width: 48em)').matches) return;

    let startX = 0;
    let startY = 0;
    let dragging = false;
    let decided = false;
    let openCard = null;
    let actionsWidth = 0;
    let dx = 0;
    const THRESHOLD_PX = 30;

    const abortControllers = [];

    const closeOpen = () => {
      if (!openCard) return;
      openCard.style.transition = 'transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1)';
      openCard.style.transform = 'translateX(0)';
      openCard.classList.remove('post-card--revealed');
      openCard = null;
    };

    this.container.querySelectorAll('.post-card').forEach(card => {
      if (!card.querySelector('.post-card-swipe-actions')) return;
      const ac = new AbortController();
      abortControllers.push(ac);
      const sig = { signal: ac.signal };

      card.addEventListener('touchstart', e => {
        if (e.touches.length !== 1) return;
        if (card === openCard && e.target.closest('.post-card-swipe-actions')) return;
        const t = e.touches[0];
        startX = t.clientX;
        startY = t.clientY;
        dragging = false;
        decided = false;
        dx = 0;
        const actions = card.querySelector('.post-card-swipe-actions');
        actionsWidth = actions ? actions.offsetWidth : 0;
        card.style.transition = 'none';
      }, { ...sig, passive: true });

      card.addEventListener('touchmove', e => {
        if (e.touches.length !== 1) return;
        const t = e.touches[0];
        dx = t.clientX - startX;
        const dy = t.clientY - startY;

        if (!decided) {
          if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
            decided = true;
            dragging = Math.abs(dx) > Math.abs(dy);
          }
        }
        if (dragging) {
          const isOpen = card === openCard;
          let tx = dx;
          if (isOpen) tx = dx - actionsWidth;
          if (tx > 0) tx = Math.pow(tx, 0.7);
          else if (tx < -actionsWidth) tx = -actionsWidth - Math.pow(-tx - actionsWidth, 0.7);
          card.style.transform = `translateX(${tx}px)`;
        }
      }, { ...sig, passive: true });

      card.addEventListener('touchend', e => {
        if (!dragging) return;
        card.style.transition = 'transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1)';
        const isOpen = card === openCard;
        if (isOpen) {
          if (dx > THRESHOLD_PX) closeOpen();
          else card.style.transform = `translateX(${-actionsWidth}px)`;
        } else if (dx < -THRESHOLD_PX && actionsWidth > 0) {
          closeOpen();
          card.style.transform = `translateX(${-actionsWidth}px)`;
          card.classList.add('post-card--revealed');
          openCard = card;
        } else if (dx > THRESHOLD_PX) {
          card.style.transform = '';
          const i = Number(card.dataset.i);
          const selectedIds = new Set(this.state.selectedIds);
          if (selectedIds.has(i)) selectedIds.delete(i);
          else selectedIds.add(i);
          this.setState({ selectMode: selectedIds.size > 0, selectedIds });
        } else {
          card.style.transform = '';
        }
      }, { ...sig, passive: true });

      card.addEventListener('touchcancel', () => {
        card.style.transition = '';
        card.style.transform = card === openCard ? `translateX(${-actionsWidth}px)` : '';
      }, { ...sig, passive: true });
    });

    const containerAc = new AbortController();
    abortControllers.push(containerAc);
    this.container.addEventListener('click', e => {
      if (!openCard) return;
      if (openCard.contains(e.target)) return;
      closeOpen();
    }, { signal: containerAc.signal });

    this._swipeCleanup = () => {
      abortControllers.forEach(ac => ac.abort());
      closeOpen();
    };
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
      title, message, confirmText, variant: 'danger',
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
      onConfirm: () => this._run(() => api.delete(`/api/admin/comments/comment/${encodeURIComponent(c.id)}?url=${encodeURIComponent(c.locator?.url || '')}`), 'Comment deleted.'),
    });
  }

  _blockUser(user) {
    if (!user?.id) return;
    this._confirm({
      title: 'Block user',
      message: `Block ${user.name || user.id} permanently? Their existing comments will be deleted by remark42.`,
      confirmText: 'Block',
      onConfirm: () => this._run(() => api.put(`/api/admin/comments/user/${encodeURIComponent(user.id)}/block?block=1`), 'User blocked.'),
    });
  }

  _unblock(user) {
    if (!user?.id) return;
    this._run(() => api.put(`/api/admin/comments/user/${encodeURIComponent(user.id)}/block?block=0`), 'User unblocked.');
  }

  _handleBulkDelete() {
    const { comments, selectedIds } = this.state;
    const toDelete = Array.from(selectedIds).map(i => comments[i]).filter(Boolean);
    if (!toDelete.length) return;
    this._confirm({
      title: 'Delete selected',
      message: `Delete ${toDelete.length} selected comment(s)? This cannot be undone.`,
      confirmText: 'Delete All',
      onConfirm: async () => {
        try {
          await Promise.all(toDelete.map(c => api.delete(`/api/admin/comments/comment/${encodeURIComponent(c.id)}?url=${encodeURIComponent(c.locator?.url || '')}`)));
          store.set('toast', { message: 'Comments deleted.', type: 'success' });
          this.setState({ selectMode: false, selectedIds: new Set() });
          this._load();
        } catch (err) {
          store.set('toast', { message: err.message || 'Delete failed.', type: 'error' });
        }
      }
    });
  }

  _handleBulkBlock() {
    const { comments, selectedIds } = this.state;
    const users = Array.from(selectedIds).map(i => comments[i]?.user).filter(Boolean);
    // filter unique users to prevent multiple requests for the same user
    const uniqueUsers = Array.from(new Map(users.map(u => [u.id, u])).values());
    if (!uniqueUsers.length) return;
    this._confirm({
      title: 'Block selected authors',
      message: `Block ${uniqueUsers.length} author(s) permanently? Their existing comments will also be deleted by remark42.`,
      confirmText: 'Block All',
      onConfirm: async () => {
        try {
          await Promise.all(uniqueUsers.map(user => api.put(`/api/admin/comments/user/${encodeURIComponent(user.id)}/block?block=1`)));
          store.set('toast', { message: 'Authors blocked.', type: 'success' });
          this.setState({ selectMode: false, selectedIds: new Set() });
          this._load();
        } catch (err) {
          store.set('toast', { message: err.message || 'Block failed.', type: 'error' });
        }
      }
    });
  }

  _handleBulkUnblock() {
    const { blocked, selectedIds } = this.state;
    const toUnblock = Array.from(selectedIds).map(i => blocked[i]).filter(Boolean);
    if (!toUnblock.length) return;
    this._confirm({
      title: 'Unblock selected users',
      message: `Unblock ${toUnblock.length} selected user(s)?`,
      confirmText: 'Unblock All',
      onConfirm: async () => {
        try {
          await Promise.all(toUnblock.map(user => api.put(`/api/admin/comments/user/${encodeURIComponent(user.id)}/block?block=0`)));
          store.set('toast', { message: 'Users unblocked.', type: 'success' });
          this.setState({ selectMode: false, selectedIds: new Set() });
          this._load();
        } catch (err) {
          store.set('toast', { message: err.message || 'Unblock failed.', type: 'error' });
        }
      }
    });
  }

  beforeUnmount() {
    this._swipeCleanup?.();
    this._cleanupAdminLayout?.();
    super.beforeUnmount?.();
  }
}
