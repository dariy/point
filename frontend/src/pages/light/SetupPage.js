import { Component } from '../../components/Component.js';
import { escapeHtml } from '../../utils/helpers.js';
import { api } from '../../api/client.js';
import { sha256 } from '../../api/auth.js';
import { router } from '../../router.js';

export default class SetupPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: false,
      error: null,
      blog_title: '',
      author_name: '',
      email: '',
    };
  }

  render() {
    const { loading, error, blog_title, author_name, email } = this.state;

    return `
      <div class="setup-page-container">
        <div class="card">
          <div class="card-header">
            <h2>Welcome to Point</h2>
            <p class="text-muted text-small">Complete this one-time setup to create your blog.</p>
          </div>
          <div class="card-body">
            ${error ? `<div class="error-message" role="alert">${escapeHtml(error)}</div>` : ''}

            <form id="setup-form" novalidate>
              <div class="form-group">
                <label class="form-label" for="blog_title">Blog Title</label>
                <input type="text" id="blog_title" name="blog_title" class="form-input"
                       value="${escapeHtml(blog_title)}" required placeholder="My Photo Blog"
                       autocomplete="off"
                       ${loading ? 'disabled' : ''}>
              </div>

              <div class="form-group">
                <label class="form-label" for="author_name">Your Name</label>
                <input type="text" id="author_name" name="author_name" class="form-input"
                       value="${escapeHtml(author_name)}" required placeholder="Jane Doe"
                       autocomplete="off"
                       ${loading ? 'disabled' : ''}>
              </div>

              <div class="form-group">
                <label class="form-label" for="email">Email Address</label>
                <input type="text" id="email" name="email" class="form-input"
                       value="${escapeHtml(email)}" placeholder="you@example.com"
                       autocomplete="off"
                       ${loading ? 'disabled' : ''}>
                <span class="form-help">(used for password reset)</span>
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

      const blog_title = this.$('#blog_title').value.trim();
      const author_name = this.$('#author_name').value.trim();
      const email = this.$('#email').value.trim();
      const password = this.$('#password').value;
      const confirm_password = this.$('#confirm_password').value;

      if (!blog_title || !author_name || !password) {
        this.setState({ error: 'Blog title, your name, and password are required.' });
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

      this.setState({ loading: true, error: null, blog_title, author_name, email });

      try {
        await api.post('/api/setup', {
          blog_title,
          author_name,
          email,
          name: await sha256(password),
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
