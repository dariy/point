/**
 * Public site footer — copyright, RSS link, admin link.
 *
 * Props:
 *   settings  {object}  Public blog settings (blog_title, author_name)
 */

import { Component } from '../Component.js';
import { escapeHtml } from '../../utils/helpers.js';

export class PublicFooter extends Component {
  render() {
    const { settings = {} } = this.props;
    const author = escapeHtml(settings.author_name || settings.blog_title || '');
    const year = new Date().getFullYear();

    return `
      <footer class="site-footer">
        <div class="footer-container">
          <div class="footer-content">
            <p class="footer-copyright">
              &copy; ${escapeHtml(String(year))}${author ? ` ${author}` : ''}
            </p>
            <nav class="footer-actions" aria-label="Footer navigation">
              <a href="/feed.xml" class="footer-link" data-external aria-label="RSS Feed">RSS</a>
              <a href="/sitemap.xml" class="footer-link" data-external aria-label="Sitemap">Sitemap</a>
              <a href="/light/login" class="footer-link footer-admin-link">Admin</a>
            </nav>
          </div>
        </div>
      </footer>`;
  }
}
