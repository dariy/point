/**
 * Public site footer — copyright, pagination slot (normal), or post tags (immersive).
 *
 * Props:
 *   settings      {object}    Public blog settings (blog_title, author_name)
 *   immersiveTags {object[]}  When non-empty, renders as immersive tag bar instead of pagination slot
 */

import { Component } from '../Component.js';
import { escapeHtml } from '../../utils/helpers.js';
import { renderTagLink } from '../../utils/tags.js';

export class PublicFooter extends Component {
  render() {
    const { settings = {}, immersiveTags = [], immersiveNav = null } = this.props;
    const author = escapeHtml(settings.author_name || settings.blog_title || '');
    const year = new Date().getFullYear();
    const aboutHref = settings.about_post_id
      ? `/post/${escapeHtml(settings.about_post_id)}`
      : '/light';

    // In immersive mode: show post tags in the center slot.
    // Otherwise: provide the #pagination-mount slot for pages that need it.
    let centerSlot;
    if (immersiveTags.length) {
      const tagLinks = immersiveTags.map((t) => renderTagLink(t)).join('');
      centerSlot = `<div class="immersive-tags">${tagLinks}</div>`;
    } else {
      centerSlot = `<div id="pagination-mount"></div>`;
    }

    // In immersive mode: show prev/next post links in the actions slot.
    let actionsSlot = '';
    if (immersiveNav) {
      const { prev, next } = immersiveNav;
      const { tagSlug } = this.props;
      const buildHref = (p) => tagSlug
        ? `/tag/${escapeHtml(tagSlug)}?slug=${escapeHtml(p.slug)}`
        : `/post/${escapeHtml(p.slug)}`;
      const prevLink = prev
        ? `<a href="${buildHref(prev)}" class="post-nav-icon" aria-label="Previous post" title="${escapeHtml(prev.title)}">&#8592;</a>`
        : `<span class="post-nav-icon disabled" aria-hidden="true"></span>`;
      const nextLink = next
        ? `<a href="${buildHref(next)}" class="post-nav-icon" aria-label="Next post" title="${escapeHtml(next.title)}">&#8594;</a>`
        : `<span class="post-nav-icon disabled" aria-hidden="true"></span>`;
      actionsSlot = `<nav class="footer-actions post-navigation-compact" aria-label="Post navigation">${prevLink}${nextLink}</nav>`;
    }

    return `
      <footer class="site-footer">
        <div class="footer-container">
          <div class="footer-content">
            <p class="footer-copyright">
              <a href="/light">&copy;</a>${author ? ` <a href="${aboutHref}">${author}</a>` : ''}
            </p>
            ${centerSlot}
          </div>
        </div>
      </footer>`;
  }
}
