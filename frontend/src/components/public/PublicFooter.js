/**
 * Public site footer — copyright, pagination slot (normal), or post tags (immersive).
 *
 * Props:
 *   settings      {object}    Public blog settings (blog_title, author_name)
 *   immersiveTags {object[]}  When non-empty, renders as immersive tag bar instead of pagination slot
 */

import { Component } from '../Component.js';
import { escapeHtml, navigate } from '../../utils/helpers.js';
import { renderTagLink, buildTagIndex, setupTagFlyout } from '../../utils/tags.js';
import { store } from '../../store.js';

export class PublicFooter extends Component {
  render() {
    const { settings = {}, immersiveTags = [] } = this.props;
    const author = escapeHtml(settings.author_name || settings.blog_title || '');

    const aboutHref = settings.about_post_id
      ? `/post/${escapeHtml(settings.about_post_id)}`
      : '/light';

    // In immersive mode: show post tags in the center slot.
    // Otherwise: provide the #pagination-mount slot for pages that need it.
    let centerSlot;
    if (immersiveTags.length) {
      const navTags = store.get('navTags') || [];
      const tagIndex = navTags.length ? buildTagIndex(navTags) : null;
      const visibleTags = immersiveTags.filter((t) => {
        if (!tagIndex) return true;
        const entry = tagIndex.get(t.slug);
        return !entry || entry.isLeaf;
      });
      const tagLinks = visibleTags.map((t) => renderTagLink(t)).join('');
      centerSlot = `<div class="immersive-tags">${tagLinks}</div>`;
    } else {
      centerSlot = `<div id="pagination-mount"></div>`;
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

  afterRender() {
    const tagsEl = this.$('.immersive-tags');
    if (!tagsEl) return;
    const navTags = store.get('navTags') || [];
    const tagIndex = navTags.length ? buildTagIndex(navTags) : null;
    this._cleanupFlyout = setupTagFlyout(tagsEl, tagIndex, navigate);
  }

  beforeUnmount() {
    this._cleanupFlyout?.();
  }
}
