import { Component } from '../../components/Component.js';
import { escapeHtml } from '../../utils/helpers.js';
import { api } from '../../api/client.js';
import { router } from '../../router.js';

export default class SetupPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: false,
      error: null,
      blog_title: '',
      author_name: '',
      username: '',
    };
  }

  render() {
    const { loading, error, blog_title, author_name, username } = this.state;

    return `
      <div class="setup-page-container" style="display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: var(--spacing-lg); background-color: var(--bg-primary);">
        <div class="card" style="width: 100%; max-width: 480px; box-shadow: var(--shadow-lg);">
          <div class="card-header" style="text-align: center; padding: var(--spacing-xl) var(--spacing-lg);">
            <h2 style="margin-bottom: var(--spacing-xs);">Welcome to Point</h2>
            <p class="text-muted text-small">Complete this one-time setup to create your blog.</p>
          </div>
          <div class="card-body" style="padding: var(--spacing-xl);">
            ${error ? `<div class="error-message" style="margin-bottom: var(--spacing-lg);" role="alert">${escapeHtml(error)}</div>` : ''}

            <form id="setup-form" novalidate>
              <div class="form-group">
                <label for="blog_title">Blog Title</label>
                <input type="text" id="blog_title" name="blog_title"
                       value="${escapeHtml(blog_title)}" required placeholder="e.g. My Photo Blog"
                       ${loading ? 'disabled' : ''}>
              </div>

              <div class="form-group">
                <label for="author_name">Your Name</label>
                <input type="text" id="author_name" name="author_name"
                       value="${escapeHtml(author_name)}" required placeholder="e.g. Jane Doe"
                       ${loading ? 'disabled' : ''}>
              </div>

              <div class="form-group">
                <label for="username">Admin Username</label>
                <input type="text" id="username" name="username"
                       value="${escapeHtml(username)}" required placeholder="e.g. admin"
                       autocomplete="username"
                       ${loading ? 'disabled' : ''}>
              </div>

              <div class="form-group">
                <label for="password">Password</label>
                <input type="password" id="password" name="password"
                       required placeholder="Minimum 8 characters"
                       autocomplete="new-password"
                       ${loading ? 'disabled' : ''}>
              </div>

              <div class="form-group">
                <label for="confirm_password">Confirm Password</label>
                <input type="password" id="confirm_password" name="confirm_password"
                       required placeholder="Repeat your password"
                       autocomplete="new-password"
                       ${loading ? 'disabled' : ''}>
              </div>

              <div style="margin-top: var(--spacing-xl);">
                <button type="submit" class="btn btn-primary" style="width: 100%; height: 44px; font-weight: 600;" ${loading ? 'disabled' : ''}>
                  ${loading ? 'Setting up...' : 'Finish Setup'}
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

      const blog_title = this.$('#blog_title').value.trim();
      const author_name = this.$('#author_name').value.trim();
      const username = this.$('#username').value.trim();
      const password = this.$('#password').value;
      const confirm_password = this.$('#confirm_password').value;

      if (!blog_title || !author_name || !username || !password) {
        this.setState({ error: 'All fields are required.' });
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

      this.setState({
        loading: true,
        error: null,
        blog_title,
        author_name,
        username,
      });

      try {
        await api.post('/api/setup', {
          blog_title,
          author_name,
          username,
          password,
        });

        router.navigate('/light');
      } catch (err) {
        this.setState({
          loading: false,
          error: err.message || 'Setup failed. Please try again.',
        });
      }
    });

    setTimeout(() => {
      const firstInput = this.$('#blog_title');
      if (firstInput) firstInput.focus();
    }, 100);
  }
}
