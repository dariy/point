/**
 * SecurityPage — account security and session management.
 *
 * Fetches: GET /api/auth/sessions
 */

import { Component } from '../../components/Component.js';
import { LightSidebar } from '../../components/light/LightSidebar.js';
import { ConfirmDialog } from '../../components/shared/ConfirmDialog.js';
import {
  getSessions, deleteSession, deleteAllOtherSessions,
  changePassword, logout,
  getPasskeyStatus, registerPasskey, deletePasskey,
  getApiKeys, createApiKey, revokeApiKey, deleteApiKey
} from '../../api/auth.js';
import { store } from '../../store.js';
import { escapeHtml, navigate } from '../../utils/helpers.js';
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
      creatingApiKey: false,
      newRawKey: null,
    };
  }

  render() {
    const {
      loading, error, sessions, changingPassword,
      passkeySupported, passkeyStatus, passkeyWorking,
      apiKeys, creatingApiKey, newRawKey
    } = this.state;

    const apiKeyList = loading
      ? `<div class="loading-spinner" aria-label="Loading API keys…"></div>`
      : !apiKeys.length
        ? `<p class="empty-state">No API keys found.</p>`
        : `
          <div class="table-container">
            <table class="table">
              <thead>
                <tr>
                  <th>Name / Prefix</th><th>Last Used</th><th>Created</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${apiKeys.map(k => `
                  <tr ${k.revoked_at ? 'class="revoked-row"' : ''}>
                    <td>
                      <div class="key-name"><strong>${escapeHtml(k.name)}</strong></div>
                      <div class="key-prefix"><code style="font-size: 0.85em">${escapeHtml(k.prefix)}...</code></div>
                      ${k.revoked_at ? '<span class="badge badge-danger">Revoked</span>' : ''}
                    </td>
                    <td>${k.last_used_at?.Valid ? escapeHtml(formatDateShort(k.last_used_at.Time)) : 'Never'}</td>
                    <td>${escapeHtml(formatDateShort(k.created_at))}</td>
                    <td>
                      ${!k.revoked_at
                        ? `<button class="btn btn-sm btn-secondary revoke-key-btn" data-id="${k.id}">Revoke</button>`
                        : `<button class="btn btn-sm btn-danger delete-key-btn" data-id="${k.id}">Delete</button>`
                      }
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>`;

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

            ${passkeySupported && passkeyStatus?.configured !== false ? `
            <div class="card" style="margin-bottom: var(--spacing-xl)">
              <div class="card-header"><h2>Passkeys</h2></div>
              <div class="card-body">
                ${passkeyStatus === null
                  ? `<div class="loading-spinner" aria-label="Loading passkey status…"></div>`
                  : passkeyStatus.has_passkey
                    ? `
                      <p>A passkey is registered on this account. You can use it to sign in without a password.</p>
                      <button id="remove-passkey-btn" class="btn btn-sm btn-danger" ${passkeyWorking ? 'disabled' : ''}>
                        ${passkeyWorking ? 'Removing…' : 'Remove Passkey'}
                      </button>`
                    : `
                      <p>No passkey registered. Register a passkey to sign in with biometrics or a hardware key.</p>
                      <button id="add-passkey-btn" class="btn btn-sm btn-primary" ${passkeyWorking ? 'disabled' : ''}>
                        ${passkeyWorking ? 'Registering…' : 'Register Passkey'}
                      </button>`
                }
              </div>
            </div>` : ''}

            <div class="card" style="margin-bottom: var(--spacing-xl)">
              <div class="card-header">
                <h2>API Keys</h2>
                <div class="header-actions">
                  <button id="add-key-btn" class="btn btn-sm btn-primary">Generate New Key</button>
                </div>
              </div>
              <div class="card-body">
                <p class="text-muted" style="margin-bottom: var(--spacing-md)">
                  API keys allow programmatic access to your blog. They should be treated as securely as your password.
                </p>
                ${apiKeyList}
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

    // API Key actions
    this.$('#add-key-btn')?.addEventListener('click', () => this._handleCreateApiKey());

    this.$$('.revoke-key-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.id, 10);
        this._showConfirm('Revoke API Key', 'Revoke this API key? Any applications using it will no longer be able to authenticate.', 'Revoke', 'danger', () => {
          this._handleRevokeApiKey(id);
        });
      });
    });

    this.$$('.delete-key-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.id, 10);
        this._showConfirm('Delete API Key Record', 'Permanently delete this API key record from history?', 'Delete', 'danger', () => {
          this._handleDeleteApiKey(id);
        });
      });
    });

    // Passkey actions
    this.$('#add-passkey-btn')?.addEventListener('click', () => this._handleAddPasskey());
    this.$('#remove-passkey-btn')?.addEventListener('click', () => {
      this._showConfirm('Remove passkey', 'Remove the registered passkey? You will only be able to sign in with your password.', 'Remove', 'danger', () => {
        this._handleRemovePasskey();
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
    if (this.state.passkeySupported) this._loadPasskeyStatus();
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
      const [sessionData, apiKeyData] = await Promise.all([
        getSessions(),
        getApiKeys()
      ]);
      this.setState({
        loading: false,
        sessions: sessionData.sessions || [],
        apiKeys: apiKeyData.api_keys || []
      });
    } catch (err) {
      console.error('[SecurityPage] load error:', err);
      store.set('toast', { message: 'Could not load security data.', type: 'error' });
      this.setState({ loading: false, sessions: [], apiKeys: [] });
    }
  }

  async _handleCreateApiKey() {
    const name = window.prompt('Enter a name for this API key (e.g. "Mobile App", "CI/CD"):');
    if (!name) return;

    try {
      const { api_key, raw_key } = await createApiKey(name);
      
      // Show raw key modal
      const mount = document.createElement('div');
      document.body.appendChild(mount);
      const dialog = new ConfirmDialog(mount, {
        title: 'API Key Created',
        allowHtml: true,
        message: `
          <p>Your new API key <strong>"${escapeHtml(api_key.name)}"</strong> has been generated.</p>
          <div class="alert alert-warning" style="margin: var(--spacing-md) 0">
            <strong>CRITICAL:</strong> This is the only time you will see this key. Copy it now and store it securely.
          </div>
          <div class="form-group">
            <input type="text" class="form-input" value="${escapeHtml(raw_key)}" readonly onclick="this.select()" style="font-family: monospace; font-size: 0.9em; background: var(--bg-secondary)">
          </div>
        `,
        confirmText: 'I have saved the key',
        variant: 'primary',
        onConfirm: () => { dialog.unmount(); mount.remove(); this._load(); },
        onCancel:  () => { dialog.unmount(); mount.remove(); this._load(); },
      });
      dialog.mount();
    } catch (err) {
      store.set('toast', { message: err.message || 'Failed to create API key.', type: 'error' });
    }
  }

  async _handleRevokeApiKey(id) {
    try {
      await revokeApiKey(id);
      store.set('toast', { message: 'API key revoked.', type: 'success' });
      this._load();
    } catch (err) {
      store.set('toast', { message: err.message || 'Revoke failed.', type: 'error' });
    }
  }

  async _handleDeleteApiKey(id) {
    try {
      await deleteApiKey(id);
      store.set('toast', { message: 'API key record deleted.', type: 'success' });
      this._load();
    } catch (err) {
      store.set('toast', { message: err.message || 'Delete failed.', type: 'error' });
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

  async _loadPasskeyStatus() {
    try {
      const status = await getPasskeyStatus();
      this.setState({ passkeyStatus: status });
    } catch {
      this.setState({ passkeyStatus: { has_passkey: false, configured: false } });
    }
  }

  async _handleAddPasskey() {
    this.setState({ passkeyWorking: true });
    try {
      await registerPasskey();
      store.set('toast', { message: 'Passkey registered successfully.', type: 'success' });
      await this._loadPasskeyStatus();
    } catch (err) {
      if (err?.name !== 'NotAllowedError') {
        store.set('toast', { message: err?.message || 'Failed to register passkey.', type: 'error' });
      }
    } finally {
      this.setState({ passkeyWorking: false });
    }
  }

  async _handleRemovePasskey() {
    this.setState({ passkeyWorking: true });
    try {
      await deletePasskey();
      store.set('toast', { message: 'Passkey removed.', type: 'success' });
      await this._loadPasskeyStatus();
    } catch (err) {
      store.set('toast', { message: err?.message || 'Failed to remove passkey.', type: 'error' });
    } finally {
      this.setState({ passkeyWorking: false });
    }
  }

  async _handleLogout() {
    try { await logout(); } catch { /* ignore */ }
    store.set('user', null);
    navigate('/', { replace: true });
  }
}
