/**
 * Public site footer — copyright, pagination slot (normal), or post tags (immersive).
 *
 * Props:
 *   settings      {object}    Public blog settings (blog_title, author_name)
 *   immersiveTags {object[]}  When non-empty, renders as immersive tag bar instead of pagination slot
 */

import { Component } from '../Component.js';
import { escapeHtml } from '../../utils/helpers.js';

export class PublicFooter extends Component {
  render() {
    const { settings = {}, immersiveTags = [] } = this.props;
    const author = escapeHtml(settings.author_name || settings.blog_title || '');
    const year = new Date().getFullYear();

    // In immersive mode: show post tags in the center slot.
    // Otherwise: provide the #pagination-mount slot for pages that need it.
    let centerSlot;
    if (immersiveTags.length) {
      const tagLinks = immersiveTags.map((t) => {
        const slug = typeof t === 'string' ? t : t.slug;
        const name = typeof t === 'string' ? t : t.name;
        return `<a href="/tag/${escapeHtml(slug)}" class="post-tag">${escapeHtml(name)}</a>`;
      }).join('');
      centerSlot = `<div class="immersive-tags">${tagLinks}</div>`;
    } else {
      centerSlot = `<div id="pagination-mount"></div>`;
    }

    return `
      <footer class="site-footer">
        <div class="footer-container">
          <div class="footer-content">
            <p class="footer-copyright">
              <a href="/light">&copy;</a>${author ? ` ${author}` : ''} ${year}
            </p>
            ${centerSlot}
            <nav class="footer-actions" aria-label="Footer navigation">
            </nav>
          </div>
        </div>
      </footer>`;
  }
}
