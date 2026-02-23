/**
 * LoginPage — admin login form.
 *
 * On success, stores the user in the store and redirects to /light.
 */

import { Component } from '../../components/Component.js';
import { login } from '../../api/auth.js';
import { store } from '../../store.js';
import { navigate, escapeHtml } from '../../utils/helpers.js';

export default class LoginPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: false, error: null };
  }

  render() {
    const { loading, error } = this.state;
    const settings = store.get('settings') || {};
    const title = escapeHtml(settings.blog_title || 'Point');
    const multiUser = settings.multi_user_mode === 'true' || settings.multi_user_mode === true;

    return `
      <div class="login-page">
        <div class="login-container">
          <div class="login-card">

            <div class="login-header">
              <div class="site-branding">
                <a href="/" class="site-title-link">
                  <span class="site-title">
                    <svg class="app-logo" viewBox="0 0 128 128" version="1.1" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                      <path class="logo-shape" d="M128 64A64 64 0 1 0 64 128h48a16 16 0 0 0 16-16V64z" />
                    </svg>
                    ${title}
                  </span>
                </a>
              </div>
            </div>

            ${error ? `<div class="login-error" role="alert">${escapeHtml(error)}</div>` : ''}

            <form id="login-form" novalidate>
              ${multiUser ? `
              <div class="form-group">
                <input type="text" id="username-input" name="username"
                       class="form-input" autocomplete="username"
                       placeholder="Username">
              </div>` : ''}
              <div class="form-group">
                <input type="password" id="password-input" name="password"
                       class="form-input" autocomplete="current-password"
                       required placeholder="Enter your password">
              </div>
              <div class="login-actions">
                <button type="submit" class="btn btn-primary" id="submit-btn"
                        ${loading ? 'disabled' : ''}>
                  ${loading ? 'Signing in…' : 'Sign in'}
                </button>
              </div>
            </form>

          </div>
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
        navigate('/light', { replace: true });
      } catch (err) {
        this.setState({
          loading: false,
          error: err.message || 'Login failed. Check your credentials.',
        });
      }
    });

    // Auto-redirect if already logged in.
    if (store.get('user')) {
      navigate('/light', { replace: true });
    }
  }
}
