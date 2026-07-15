/**
 * LoginPage — standalone login page mounted at /light/login.
 *
 * Reached by a full document load (never an in-app modal), so the credential
 * form is isolated from the guest UI and any third-party markup injected into
 * it. On success it navigates to `next` (or /light); dismissing returns home.
 *
 * Props (from the router): { query } — `query.next` is the post-login target.
 * The legacy overlay props `next`/`onSuccess`/`onCancel` are still honoured if
 * present.
 */

import { Component } from '../../components/Component.js';
import { login, loginWithPasskey } from '../../api/auth.js';
import { store } from '../../store.js';
import { escapeHtml, navigate } from '../../utils/helpers.js';

export default class LoginPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: false,
      error: null,
      passkeySupported: typeof window.PublicKeyCredential !== 'undefined',
    };
  }

  // Post-login target: explicit prop, else ?next from the query, else /light.
  _next() {
    return this.props.next || this.props.query?.next || '/light';
  }

  // Called after a successful login. Honours a legacy onSuccess prop; otherwise
  // navigates into the app. Staying in this (freshly loaded, third-party-free)
  // document is fine — the authenticated session never shares it with injected
  // markup.
  _finish(user) {
    if (this.props.onSuccess) return this.props.onSuccess(user);
    navigate(this._next(), { replace: true });
  }

  // Dismiss (backdrop / Escape) — return to the public home.
  _dismiss() {
    if (this.props.onCancel) return this.props.onCancel();
    navigate('/', { replace: true });
  }

  render() {
    const { loading, error, passkeySupported } = this.state;
    const settings = store.get('settings') || {};
    const multiUser = settings.multi_user_mode === 'true' || settings.multi_user_mode === true;

    return `
      <div class="login-overlay-backdrop" id="login-backdrop">
        <div class="login-modal-box">
          ${error ? `<p class="login-modal-error" role="alert">${escapeHtml(error)}</p>` : ''}
          ${passkeySupported ? `
          <button id="passkey-btn" class="btn btn-secondary login-passkey-btn" ${loading ? 'disabled' : ''}>
            Sign in with Passkey
          </button>
          <div class="login-divider"><span>or</span></div>` : ''}
          <form id="login-form" class="login-modal-form" novalidate>
            ${multiUser ? `
            <input type="text" id="username-input" name="username"
                   class="login-input" autocomplete="username"
                   placeholder="Username">` : ''}
            <input type="password" id="password-input" name="password"
                   class="login-input" autocomplete="current-password"
                   required placeholder="${loading ? 'Signing in…' : 'Password'}"
                   ${loading ? 'disabled' : ''}>
          </form>
        </div>
      </div>`;
  }

  afterRender() {
    const form = this.$('#login-form');
    if (!form) return;

    // Passkey sign-in button
    this.$('#passkey-btn')?.addEventListener('click', async () => {
      if (this.state.loading) return;
      this.setState({ loading: true, error: null });
      try {
        const result = await loginWithPasskey();
        store.set('user', result.user);
        this._finish(result.user);
      } catch (err) {
        if (err?.name !== 'NotAllowedError') {
          this.setState({ loading: false, error: err?.message || 'Passkey login failed.' });
        } else {
          this.setState({ loading: false });
        }
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (this.state.loading) return;

      const username = this.$('#username-input')?.value.trim() || null;
      const password = this.$('#password-input')?.value || '';

      if (!password) {
        this.setState({ error: 'Password is required.' });
        return;
      }

      this.setState({ loading: true, error: null });

      try {
        const result = await login(username, password, true);
        store.set('user', result.user);
        this._finish(result.user);
      } catch (err) {
        this.setState({
          loading: false,
          error: err.message || 'Login failed. Check your credentials.',
        });
      }
    });

    // Backdrop click cancels.
    const backdrop = this.$('#login-backdrop');
    backdrop?.addEventListener('click', (e) => {
      if (e.target === backdrop) this._dismiss();
    });

    // Escape key cancels.
    this._onKeyDown = (e) => {
      if (e.key === 'Escape') this._dismiss();
    };
    window.addEventListener('keydown', this._onKeyDown);

    // Auto-focus first input after animation settles.
    const pwField = this.$('#password-input');
    const usrField = this.$('#username-input');
    setTimeout(() => (usrField || pwField)?.focus(), 80);

    // Auto-redirect if already logged in.
    if (store.get('user')) this._finish(store.get('user'));
  }

  beforeUnmount() {
    window.removeEventListener('keydown', this._onKeyDown);
  }
}
