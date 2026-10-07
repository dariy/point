import { Component } from '../../components/Component.ts';
import { html, raw } from '../../utils/helpers.ts';
import { api } from '../../api/client.ts';
import { sha256 } from '../../api/auth.ts';
import { APP_LOGO_SVG } from '../../utils/icons.ts';

/**
 * The one-time setup token from the setup link (`/setup?token=…`). Managed
 * installs require it (SETUP_TOKEN); self-hosted installs ignore it.
 * @param search - a `location.search` string
 * @returns the token, or '' when the link has none
 */
export function setupTokenFrom(search: string): string {
  return new URLSearchParams(search).get('token') || '';
}

export default class SetupPage extends Component {
  constructor(container: HTMLElement, props = {}) {
    super(container, props);
    this.state = {
      loading: false,
      error: null,
      username: '',
    };
  }

  render() {
    const { loading, error, username } = this.state;

    return html`
      <div class="setup-page-container">
        <div class="card">
          <div class="card-header">
            ${raw(APP_LOGO_SVG)}
            <h2>Welcome to Point</h2>
            <p class="text-muted text-small">Create your account to get started.</p>
          </div>
          <div class="card-body">
            ${error ? html`<div class="error-message" role="alert">${error}</div>` : ''}

            <form id="setup-form" novalidate>
              <div class="form-group">
                <label class="form-label" for="username">Username</label>
                <input type="text" id="username" name="username" class="form-input"
                       value="${username}" required placeholder="alex"
                       autocomplete="username" autocapitalize="none" spellcheck="false"
                       ${loading ? 'disabled' : ''}>
              </div>

              <div class="form-group">
                <label class="form-label" for="password">Password</label>
                <input type="password" id="password" name="password" class="form-input"
                       required placeholder="Minimum 8 characters"
                       autocomplete="new-password"
                       ${loading ? 'disabled' : ''}>
              </div>

              <div class="form-group">
                <label class="form-label" for="confirm_password">Confirm Password</label>
                <input type="password" id="confirm_password" name="confirm_password" class="form-input"
                       required placeholder="Repeat your password"
                       autocomplete="new-password"
                       ${loading ? 'disabled' : ''}>
              </div>

              <div class="setup-submit-wrapper">
                <button type="submit" class="btn btn-primary setup-submit-btn" ${loading ? 'disabled' : ''}>
                  ${loading ? 'Setting up…' : 'Finish Setup'}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    `;
  }

  afterRender() {
    const form = this.$('#setup-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (this.state.loading) return;

      const field = (id: string) =>
        (this.$(id) as HTMLInputElement).value;
      const username = field('#username').trim();
      const password = field('#password');
      const confirm_password = field('#confirm_password');

      if (!username || !password) {
        this.setState({ error: 'Username and password are required.' });
        return;
      }

      if (!/^[A-Za-z0-9._-]{1,32}$/.test(username)) {
        this.setState({ error: 'Username can use up to 32 letters, digits, ".", "_" or "-".' });
        return;
      }

      if (password.length < 8) {
        this.setState({ error: 'Password must be at least 8 characters long.' });
        return;
      }

      if (password !== confirm_password) {
        this.setState({ error: 'Passwords do not match.' });
        return;
      }

      this.setState({ loading: true, error: null, username });

      try {
        await api.post('/api/setup', {
          username,
          name: await sha256(password),
          token: setupTokenFrom(window.location.search),
        });

        // Full document load rather than an SPA navigate: the app bootstrapped
        // against an unconfigured install (no settings, no user, no theme), and
        // setup has just changed all three. Reloading picks up the seeded
        // settings and the session the API issued — landing the owner straight
        // in the app instead of at the login screen. If the session could not
        // be minted, the auth guard sends them to login from there. The owner
        // lands in the first-post flow (US-005).
        window.location.assign('/light/first-post');
      } catch (err) {
        this.setState({
          loading: false,
          error: (err as Error).message || 'Setup failed. Please try again.',
        });
      }
    });

    setTimeout(() => {
      const firstInput = this.$('#username');
      if (firstInput) firstInput.focus();
    }, 100);
  }
}
