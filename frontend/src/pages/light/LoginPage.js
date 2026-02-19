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

    return `
      <div class="login-page">
        <div class="login-container">
          <div class="login-card card">
            <div class="login-header card-body">
              <h1>Point Admin</h1>
            </div>
            <div class="card-body">
              ${error ? `<div class="login-error" role="alert">${escapeHtml(error)}</div>` : ''}
              <form id="login-form" novalidate>
                <div class="form-group">
                  <label for="username-input">Username (optional)</label>
                  <input type="text" id="username-input" name="username"
                         class="form-input" autocomplete="username"
                         placeholder="Leave blank for single-user blog">
                </div>
                <div class="form-group">
                  <label for="password-input">Password</label>
                  <input type="password" id="password-input" name="password"
                         class="form-input" autocomplete="current-password"
                         required placeholder="Password">
                </div>
                <div class="form-group">
                  <label class="checkbox-label">
                    <input type="checkbox" id="remember-me" name="remember_me">
                    Remember me
                  </label>
                </div>
                <div class="login-actions">
                  <button type="submit" class="btn btn-primary btn-lg" id="submit-btn"
                          ${loading ? 'disabled' : ''}>
                    ${loading ? 'Signing in…' : 'Sign in'}
                  </button>
                </div>
              </form>
            </div>
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
      const rememberMe = this.$('#remember-me')?.checked || false;

      if (!password) {
        this.setState({ error: 'Password is required.' });
        return;
      }

      this.setState({ loading: true, error: null });

      try {
        const result = await login(username, password, rememberMe);
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
