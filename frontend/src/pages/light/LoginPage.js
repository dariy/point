/**
 * LoginPage — minimal login overlay.
 *
 * Renders into a dedicated overlay container (outside #app) so the current
 * public page remains visible and blurred behind it.
 *
 * Props:
 *   next       {string|null}   URL to navigate to on success
 *   onSuccess  {Function}      Called with the user object after login
 *   onCancel   {Function}      Called when the backdrop or Escape is pressed
 */

import { Component } from '../../components/Component.js';
import { login } from '../../api/auth.js';
import { store } from '../../store.js';
import { escapeHtml } from '../../utils/helpers.js';

export default class LoginPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: false, error: null };
  }

  render() {
    const { loading, error } = this.state;
    const settings = store.get('settings') || {};
    const multiUser = settings.multi_user_mode === 'true' || settings.multi_user_mode === true;

    return `
      <div class="login-overlay-backdrop" id="login-backdrop">
        <div class="login-modal-box">
          ${error ? `<p class="login-modal-error" role="alert">${escapeHtml(error)}</p>` : ''}
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
        this.props.onSuccess?.(result.user);
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
      if (e.target === backdrop) this.props.onCancel?.();
    });

    // Escape key cancels.
    this._onKeyDown = (e) => {
      if (e.key === 'Escape') this.props.onCancel?.();
    };
    window.addEventListener('keydown', this._onKeyDown);

    // Auto-focus first input after animation settles.
    const pwField = this.$('#password-input');
    const usrField = this.$('#username-input');
    setTimeout(() => (usrField || pwField)?.focus(), 80);

    // Auto-redirect if already logged in.
    if (store.get('user')) this.props.onSuccess?.(store.get('user'));
  }

  beforeUnmount() {
    window.removeEventListener('keydown', this._onKeyDown);
  }
}
