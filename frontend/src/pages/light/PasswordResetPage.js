import { Component } from '../../components/Component.js';
import { escapeHtml } from '../../utils/helpers.js';
import { sha256 } from '../../api/auth.js';
import { api } from '../../api/client.js';
import { router } from '../../router.js';

export default class PasswordResetPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    // token is present when visiting /light/pss/:token
    this._token = props.params?.token || null;
    this.state = {
      loading: false,
      error: null,
      success: null,
    };
  }

  render() {
    const { loading, error, success } = this.state;

    if (this._token) {
      return this._renderResetForm(loading, error, success);
    }
    return this._renderRequestForm(loading, error, success);
  }

  _renderRequestForm(loading, error, success) {
    return `
      <div class="setup-page-container">
        <div class="card">
          <div class="card-header">
            <h2>Reset Password</h2>
            <p class="text-muted text-small">Enter your email address to receive a reset link.</p>
          </div>
          <div class="card-body">
            ${error ? `<div class="error-message" role="alert">${escapeHtml(error)}</div>` : ''}
            ${success ? `<div class="pss-success">${escapeHtml(success)}</div>` : `
            <form id="pss-request-form" novalidate>
              <div class="form-group">
                <label class="form-label" for="pss-email">Email Address</label>
                <input type="text" id="pss-email" name="email" class="form-input"
                       required placeholder="you@example.com"
                       autocomplete="off"
                       ${loading ? 'disabled' : ''}>
              </div>
              <div class="setup-submit-wrapper">
                <button type="submit" class="btn btn-primary setup-submit-btn" ${loading ? 'disabled' : ''}>
                  ${loading ? 'Sending…' : 'Send Reset Link'}
                </button>
              </div>
            </form>
            <div class="pss-back">
              <a href="/light/login" class="text-muted text-small">Back to login</a>
            </div>
            `}
          </div>
        </div>
      </div>
    `;
  }

  _renderResetForm(loading, error, success) {
    return `
      <div class="setup-page-container">
        <div class="card">
          <div class="card-header">
            <h2>Set New Password</h2>
            <p class="text-muted text-small">Choose a strong password for your blog.</p>
          </div>
          <div class="card-body">
            ${error ? `<div class="error-message" role="alert">${escapeHtml(error)}</div>` : ''}
            ${success ? `
            <div class="pss-success">${escapeHtml(success)}</div>
            <div class="pss-back" style="margin-top:var(--spacing-lg)">
              <a href="/light/login" class="btn btn-primary setup-submit-btn">Go to Login</a>
            </div>
            ` : `
            <form id="pss-reset-form" novalidate>
              <div class="form-group">
                <label class="form-label" for="pss-password">New Password</label>
                <input type="password" id="pss-password" name="password" class="form-input"
                       required placeholder="Minimum 8 characters"
                       autocomplete="off"
                       ${loading ? 'disabled' : ''}>
              </div>
              <div class="form-group">
                <label class="form-label" for="pss-confirm">Confirm Password</label>
                <input type="password" id="pss-confirm" name="confirm" class="form-input"
                       required placeholder="Repeat your password"
                       autocomplete="off"
                       ${loading ? 'disabled' : ''}>
              </div>
              <div class="setup-submit-wrapper">
                <button type="submit" class="btn btn-primary setup-submit-btn" ${loading ? 'disabled' : ''}>
                  ${loading ? 'Saving…' : 'Set New Password'}
                </button>
              </div>
            </form>
            `}
          </div>
        </div>
      </div>
    `;
  }

  afterRender() {
    if (this._token) {
      this._bindResetForm();
    } else {
      this._bindRequestForm();
    }
  }

  _bindRequestForm() {
    const form = this.$('#pss-request-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (this.state.loading) return;

      const email = this.$('#pss-email')?.value.trim();
      if (!email) {
        this.setState({ error: 'Email address is required.' });
        return;
      }

      this.setState({ loading: true, error: null });

      try {
        const res = await api.post('/api/auth/forgot-password', { email });
        this.setState({ loading: false, success: res.detail });
      } catch (err) {
        this.setState({
          loading: false,
          error: err.message || 'Something went wrong. Please try again.',
        });
      }
    });

    setTimeout(() => this.$('#pss-email')?.focus(), 80);
  }

  _bindResetForm() {
    const form = this.$('#pss-reset-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (this.state.loading) return;

      const password = this.$('#pss-password')?.value || '';
      const confirm = this.$('#pss-confirm')?.value || '';

      if (password.length < 8) {
        this.setState({ error: 'Password must be at least 8 characters.' });
        return;
      }
      if (password !== confirm) {
        this.setState({ error: 'Passwords do not match.' });
        return;
      }

      this.setState({ loading: true, error: null });

      try {
        const res = await api.post('/api/auth/reset-password', {
          token: this._token,
          name: await sha256(password),
        });
        this.setState({ loading: false, success: res.detail });
      } catch (err) {
        this.setState({
          loading: false,
          error: err.message || 'Reset failed. The link may have expired.',
        });
      }
    });

    setTimeout(() => this.$('#pss-password')?.focus(), 80);
  }
}
