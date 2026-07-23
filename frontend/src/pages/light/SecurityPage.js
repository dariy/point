/**
 * SecurityPage — account security and session management.
 *
 * Fetches: GET /api/auth/sessions
 */

import { Component } from '../../components/Component.js';
import { adminLayoutTemplate, setupAdminLayout } from '../../components/light/AdminLayout.js';
import { ConfirmDialog } from '../../components/shared/ConfirmDialog.js';
import {
  getSessions, deleteSession, deleteAllOtherSessions,
  changePassword, changeEmail, getMe
} from '../../api/auth.js';
import { store } from '../../store.js';
import { escapeHtml } from '../../utils/helpers.js';
import { formatDateShort } from '../../utils/formatters.js';

export default class SecurityPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      sessions: [],
      error: null,
      changingPassword: false,
      changingEmail: false,
      email: '',
    };
  }

  render() {
    return adminLayoutTemplate({
      title: 'Security',
      content: this._renderContent()
    });
  }

  _renderContent() {
    const { loading, error, sessions, changingPassword, changingEmail, email } = this.state;

    if (loading) return '<div class="loading-spinner" aria-label="Loading security info…"></div>';
    if (error) return `<p class="error-state" role="alert">${escapeHtml(error)}</p>`;

    return `
      <div class="security-grid">
        <section class="card">
          <div class="card-header"><h2>Change Password</h2></div>
          <div class="card-body">
            <p class="form-hint">Change your password here.</p>
            <form id="change-password-form">
              <div class="form-group">
                <label class="form-label" for="old-password">Current Password</label>
                <input type="password" id="old-password" class="form-input" required autocomplete="current-password">
              </div>
              <div class="form-group">
                <label class="form-label" for="new-password">New Password</label>
                <input type="password" id="new-password" class="form-input" required autocomplete="new-password">
              </div>
              <button type="submit" class="btn btn-primary" ${changingPassword ? 'disabled' : ''}>
                ${changingPassword ? 'Updating…' : 'Update Password'}
              </button>
            </form>
          </div>
        </section>

        <section class="card">
          <div class="card-header"><h2>Change Email</h2></div>
          <div class="card-body">
            <p class="form-hint">Password reset links are sent to this address.</p>
            <form id="change-email-form">
              <div class="form-group">
                <label class="form-label" for="account-email">Email</label>
                <input type="email" id="account-email" class="form-input" required autocomplete="email"
                       value="${escapeHtml(email)}">
              </div>
              <div class="form-group">
                <label class="form-label" for="email-password">Current Password</label>
                <input type="password" id="email-password" class="form-input" required autocomplete="current-password">
              </div>
              <button type="submit" class="btn btn-primary" ${changingEmail ? 'disabled' : ''}>
                ${changingEmail ? 'Updating…' : 'Update Email'}
              </button>
            </form>
          </div>
        </section>

        <section class="card security-full-width">
          <div class="card-header">
            <h2>Active Sessions</h2>
            <button id="logout-others-btn" class="btn btn-sm btn-secondary">Logout All Other Sessions</button>
          </div>
          <div class="card-body">
            <div class="table-container">
              <table class="table">
                <thead>
                  <tr>
                    <th>Device / Browser</th>
                    <th>Last Active</th>
                    <th class="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${sessions.map(s => `
                    <tr class="${s.is_current ? 'session-current' : ''}">
                      <td>
                        <strong>${escapeHtml(s.ua_browser || 'Unknown')} on ${escapeHtml(s.ua_os || 'Unknown')}</strong>
                        ${s.is_current ? ' <span class="badge badge-success">Current</span>' : ''}
                      </td>
                      <td>${escapeHtml(formatDateShort(s.last_active))}</td>
                      <td class="text-right">
                        ${!s.is_current ? `<button class="btn btn-sm btn-danger delete-session-btn" data-id="${s.id}">Logout</button>` : ''}
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>`;
  }

  afterRender() {
    this._cleanupAdminLayout = setupAdminLayout(this, {
      currentPath: '/light/security',
    });

    if (this.state.loading || this.state.error) return;

    this.container.querySelector('#change-password-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this._handleChangePassword();
    });

    this.container.querySelector('#change-email-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this._handleChangeEmail();
    });

    this.container.querySelector('#logout-others-btn')?.addEventListener('click', () => {
      this._showConfirm('Logout others', 'Logout all other active sessions?', 'Logout Others', 'danger', () => {
        this._handleLogoutOthers();
      });
    });

    this.container.querySelectorAll('.delete-session-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this._handleDeleteSession(btn.dataset.id);
      });
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
      const [sessions, me] = await Promise.all([getSessions(), getMe()]);
      this.setState({
        loading: false,
        sessions: sessions.sessions || [],
        email: me?.email || '',
        error: null
      });
    } catch (err) {
      console.error('[SecurityPage] load error:', err);
      this.setState({ loading: false, error: 'Could not load security information.' });
    }
  }

  async _handleChangePassword() {
    const oldEl = this.container.querySelector('#old-password');
    const newEl = this.container.querySelector('#new-password');
    const oldPassword = oldEl.value;
    const newPassword = newEl.value;

    this.setState({ changingPassword: true });
    try {
      await changePassword(oldPassword, newPassword);
      store.set('toast', { message: 'Password updated successfully.', type: 'success' });
      oldEl.value = '';
      newEl.value = '';
    } catch (err) {
      store.set('toast', { message: err.message || 'Failed to update password.', type: 'error' });
    } finally {
      this.setState({ changingPassword: false });
    }
  }

  async _handleChangeEmail() {
    const emailEl = this.container.querySelector('#account-email');
    const passEl = this.container.querySelector('#email-password');
    const email = emailEl.value.trim();
    const password = passEl.value;

    this.setState({ changingEmail: true });
    try {
      await changeEmail(password, email);
      store.set('toast', { message: 'Email updated successfully.', type: 'success' });
      this.setState({ changingEmail: false, email });
    } catch (err) {
      store.set('toast', { message: err.message || 'Failed to update email.', type: 'error' });
      this.setState({ changingEmail: false });
    }
  }

  async _handleLogoutOthers() {
    try {
      await deleteAllOtherSessions();
      store.set('toast', { message: 'Other sessions logged out.', type: 'success' });
      this._load();
    } catch (err) {
      store.set('toast', { message: err.message || 'Failed to logout other sessions.', type: 'error' });
    }
  }

  async _handleDeleteSession(id) {
    try {
      await deleteSession(id);
      this._load();
    } catch (err) {
      store.set('toast', { message: err.message || 'Failed to delete session.', type: 'error' });
    }
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
}
