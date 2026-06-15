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
  changePassword,
  getPasskeyStatus, registerPasskey, deletePasskey,
  getApiKeys, createApiKey, deleteApiKey
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
      apiKeys: [],
      error: null,
      changingPassword: false,
      passkeySupported: typeof window.PublicKeyCredential !== 'undefined',
      passkeyStatus: null,
      passkeyWorking: false,
    };
  }

  render() {
    return adminLayoutTemplate({
      title: 'Security',
      content: this._renderContent()
    });
  }

  _renderContent() {
    const {
      loading, error, sessions, changingPassword,
      passkeySupported, passkeyStatus, passkeyWorking,
      apiKeys
    } = this.state;

    if (loading) return '<div class="loading-spinner" aria-label="Loading security info…"></div>';
    if (error) return `<p class="error-state" role="alert">${escapeHtml(error)}</p>`;

    const apiKeyList = !apiKeys.length
        ? `<p class="empty-state">No API keys found.</p>`
        : `
          <div class="table-container">
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Key Prefix</th>
                  <th>Created</th>
                  <th class="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                ${apiKeys.map(k => `
                  <tr>
                    <td><strong>${escapeHtml(k.name)}</strong></td>
                    <td><code class="font-mono">${escapeHtml(k.prefix)}\u2026</code></td>
                    <td>${escapeHtml(formatDateShort(k.created_at))}</td>
                    <td class="text-right">
                      <button class="btn btn-sm btn-danger delete-api-key-btn" data-id="${k.id}" title="Delete">Delete</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>`;

    return `
      <div class="security-grid">
        <section class="card">
          <div class="card-header"><h2>Change Password</h2></div>
          <div class="card-body">
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
          <div class="card-header"><h2>Passkeys (WebAuthn)</h2></div>
          <div class="card-body">
            ${!passkeySupported ? '<p class="text-muted">Passkeys are not supported by this browser.</p>' : `
              ${!passkeyStatus?.configured ? `
                <p class="text-muted">Passkeys are not configured on this server.</p>
              ` : passkeyStatus?.registered ? `
                <div class="passkey-status success">
                  <p>Passkey is registered.</p>
                  <button id="delete-passkey-btn" class="btn btn-sm btn-danger" ${passkeyWorking ? 'disabled' : ''}>Remove Passkey</button>
                </div>
              ` : `
                <p>Register a passkey for faster, more secure login.</p>
                <button id="register-passkey-btn" class="btn btn-primary" ${passkeyWorking ? 'disabled' : ''}>Register Passkey</button>
              `}
            `}
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

        <section class="card security-full-width">
          <div class="card-header">
            <h2>API Keys</h2>
            <button id="create-api-key-btn" class="btn btn-sm btn-primary">Create New API Key</button>
          </div>
          <div class="card-body">
            ${apiKeyList}
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

    this.container.querySelector('#register-passkey-btn')?.addEventListener('click', () => this._handleRegisterPasskey());
    this.container.querySelector('#delete-passkey-btn')?.addEventListener('click', () => this._handleDeletePasskey());

    this.container.querySelector('#create-api-key-btn')?.addEventListener('click', () => this._handleCreateApiKey());
    this.container.querySelectorAll('.delete-api-key-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this._handleDeleteApiKey(btn.dataset.id);
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
      const [sessions, passkeyStatus, apiKeys] = await Promise.all([
        getSessions(),
        this.state.passkeySupported ? getPasskeyStatus() : Promise.resolve(null),
        getApiKeys()
      ]);
      this.setState({
        loading: false,
        sessions: sessions.sessions || [],
        passkeyStatus,
        apiKeys: apiKeys.keys || [],
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

  async _handleRegisterPasskey() {
    this.setState({ passkeyWorking: true });
    try {
      await registerPasskey();
      store.set('toast', { message: 'Passkey registered.', type: 'success' });
      this._load();
    } catch (err) {
      if (err.name !== 'NotAllowedError') {
        store.set('toast', { message: err.message || 'Failed to register passkey.', type: 'error' });
      }
    } finally {
      this.setState({ passkeyWorking: false });
    }
  }

  async _handleDeletePasskey() {
    if (!confirm('Remove passkey? You will need to use your password to login.')) return;
    this.setState({ passkeyWorking: true });
    try {
      await deletePasskey();
      store.set('toast', { message: 'Passkey removed.', type: 'success' });
      this._load();
    } catch (err) {
      store.set('toast', { message: err.message || 'Failed to remove passkey.', type: 'error' });
    } finally {
      this.setState({ passkeyWorking: false });
    }
  }

  async _handleCreateApiKey() {
    const name = prompt('Enter a name for the new API key:');
    if (!name) return;

    try {
      const result = await createApiKey(name);
      this._showConfirm('API Key Created', `Please copy your API key now. It will not be shown again:\n\n${result.key}`, 'Copy to Clipboard', 'primary', () => {
        navigator.clipboard.writeText(result.key);
      });
      this._load();
    } catch (err) {
      store.set('toast', { message: err.message || 'Failed to create API key.', type: 'error' });
    }
  }

  async _handleDeleteApiKey(id) {
    if (!confirm('Permanently delete this API key? Applications using it will lose access.')) return;
    try {
      await deleteApiKey(id);
      this._load();
    } catch (err) {
      store.set('toast', { message: err.message || 'Failed to delete API key.', type: 'error' });
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
