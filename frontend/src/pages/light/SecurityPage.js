/**
 * SecurityPage — account security and session management.
 *
 * Fetches: GET /api/auth/sessions
 */

import { Component } from '../../components/Component.js';
import { LightSidebar } from '../../components/light/LightSidebar.js';
import { ConfirmDialog } from '../../components/shared/ConfirmDialog.js';
import { getSessions, deleteSession, deleteAllOtherSessions, changePassword, logout } from '../../api/auth.js';
import { store } from '../../store.js';
import { escapeHtml, navigate } from '../../utils/helpers.js';
import { formatDateShort } from '../../utils/formatters.js';

export default class SecurityPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      sessions: [],
      error: null,
      changingPassword: false,
    };
  }

  render() {
    const { loading, error, sessions, changingPassword } = this.state;

    const sessionList = loading
      ? `<div class="loading-spinner" aria-label="Loading sessions…"></div>`
      : error
        ? `<p class="error-state" role="alert">${escapeHtml(error)}</p>`
        : !sessions.length
          ? `<p class="empty-state">No active sessions found.</p>`
          : `
            <div class="table-container">
              <table class="table">
                <thead>
                  <tr>
                    <th>Device / IP</th><th>Last Active</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${sessions.map(s => `
                    <tr ${s.is_current ? 'class="current-session"' : ''}>
                      <td>
                        <div class="session-ua">${escapeHtml(s.user_agent || 'Unknown Device')}</div>
                        <div class="session-ip"><small>${escapeHtml(s.ip_address || 'Unknown IP')}</small></div>
                        ${s.is_current ? '<span class="badge badge-primary">Current</span>' : ''}
                      </td>
                      <td>${escapeHtml(formatDateShort(s.last_active_at))}</td>
                      <td>
                        ${s.is_current
                          ? '—'
                          : `<button class="btn btn-sm btn-danger delete-session-btn" data-id="${s.id}">Revoke</button>`
                        }
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>`;

    return `
      <div class="light-layout">
        <div id="sidebar-mount"></div>
        <div class="light-main">
          <header class="light-header">
            <h1>Security</h1>
          </header>
          <main class="light-content">

            <div class="card" style="margin-bottom: var(--spacing-xl)">
              <div class="card-header"><h2>Change Password</h2></div>
              <div class="card-body">
                <form id="password-form">
                  <div class="form-group">
                    <label for="current-password">Current Password</label>
                    <input type="password" id="current-password" class="form-input" required autocomplete="current-password">
                  </div>
                  <div class="form-group">
                    <label for="new-password">New Password</label>
                    <input type="password" id="new-password" class="form-input" required autocomplete="new-password" minlength="8">
                  </div>
                  <div class="form-group">
                    <label for="confirm-password">Confirm New Password</label>
                    <input type="password" id="confirm-password" class="form-input" required autocomplete="new-password">
                  </div>
                  <div class="form-actions">
                    <button type="submit" class="btn btn-primary" ${changingPassword ? 'disabled' : ''}>
                      ${changingPassword ? 'Changing…' : 'Update Password'}
                    </button>
                  </div>
                </form>
              </div>
            </div>

            <div class="card">
              <div class="card-header">
                <h2>Active Sessions</h2>
                <div class="header-actions">
                  <button id="revoke-all-btn" class="btn btn-sm btn-secondary">Revoke All Others</button>
                </div>
              </div>
              <div class="card-body">
                ${sessionList}
              </div>
            </div>

          </main>
        </div>
      </div>`;
  }

  afterRender() {
    this.mountChild(LightSidebar, '#sidebar-mount', {
      currentPath: '/light/security',
      user: store.get('user') || {},
      onLogout: this._handleLogout.bind(this),
    });

    if (this.state.loading && !this.state.error) return;

    // Password form
    this.$('#password-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this._handlePasswordChange();
    });

    // Revoke individual session
    this.$$('.delete-session-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.id, 10);
        this._handleRevoke(id);
      });
    });

    // Revoke all other sessions
    this.$('#revoke-all-btn')?.addEventListener('click', () => {
      this._showConfirm('Revoke all sessions', 'Revoke all other active sessions? You will remain logged in on this device.', 'Revoke', 'danger', () => {
        this._handleRevokeAll();
      });
    });
  }

  mount() {
    super.mount();
    this._load();
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

  async _load() {
    this.setState({ loading: true, error: null });
    try {
      const data = await getSessions();
      this.setState({ loading: false, sessions: data.sessions || [] });
    } catch (err) {
      this.setState({ loading: false, error: err.message || 'Failed to load sessions.' });
    }
  }

  async _handlePasswordChange() {
    const currentPass = this.$('#current-password')?.value;
    const newPass     = this.$('#new-password')?.value;
    const confirmPass = this.$('#confirm-password')?.value;

    if (newPass !== confirmPass) {
      store.set('toast', { message: 'New passwords do not match.', type: 'error' });
      return;
    }

    this.setState({ changingPassword: true });
    try {
      await changePassword(currentPass, newPass);
      store.set('toast', { message: 'Password updated successfully.', type: 'success' });
      this.$('#password-form')?.reset();
    } catch (err) {
      store.set('toast', { message: err.message || 'Failed to change password.', type: 'error' });
    } finally {
      this.setState({ changingPassword: false });
    }
  }

  async _handleRevoke(id) {
    try {
      await deleteSession(id);
      store.set('toast', { message: 'Session revoked.', type: 'success' });
      this._load();
    } catch (err) {
      store.set('toast', { message: err.message || 'Revoke failed.', type: 'error' });
    }
  }

  async _handleRevokeAll() {
    try {
      await deleteAllOtherSessions();
      store.set('toast', { message: 'Other sessions revoked.', type: 'success' });
      this._load();
    } catch (err) {
      store.set('toast', { message: err.message || 'Revoke failed.', type: 'error' });
    }
  }

  async _handleLogout() {
    try { await logout(); } catch { /* ignore */ }
    store.set('user', null);
    navigate('/light/login', { replace: true });
  }
}
