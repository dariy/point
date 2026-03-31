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
import { CHEVRON_SVG } from '../../utils/icons.js';
import { store } from '../../store.js';

export class PublicFooter extends Component {
  render() {
    const { settings = {}, immersiveTags = [], exifMedia = [] } = this.props;
    const author = escapeHtml(settings.author_name || settings.blog_title || '');

    const aboutHref = settings.about_post_id
      ? `/post/${escapeHtml(settings.about_post_id)}`
      : '/light';

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
      // EXIF pill — rendered only when there is metadata on at least one media item
      const hasExif = exifMedia.some((m) => m.metadata && Object.keys(m.metadata).length > 0);
      const exifPill = hasExif
        ? `<button class="tag-link exif-pill" type="button" aria-expanded="false" aria-label="Show EXIF data">exif <span class="flyout-indicator" aria-hidden="true">${CHEVRON_SVG}</span></button>`
        : '';
      centerSlot = `<div class="immersive-tags">${tagLinks}${exifPill}</div>`;
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

    const pill = tagsEl.querySelector('.exif-pill');
    if (pill) this._setupExifPill(pill);
  }

  _setupExifPill(pill) {
    const { exifMedia = [] } = this.props;

    // Build a flyout element local to this footer instance
    const flyout = document.createElement('div');
    flyout.className = 'post-card-tag-flyout hidden exif-flyout';
    document.body.appendChild(flyout);
    this._exifFlyout = flyout;

    // Populate flyout with EXIF rows from all media items that have metadata
    const mediaWithExif = exifMedia.filter((m) => m.metadata && Object.keys(m.metadata).length > 0);
    mediaWithExif.forEach((m, i) => {
      if (i > 0) {
        const sep = document.createElement('hr');
        sep.className = 'exif-flyout-sep';
        flyout.appendChild(sep);
      }
      const table = document.createElement('table');
      table.className = 'exif-flyout-table';
      Object.entries(m.metadata).forEach(([k, v]) => {
        const tr = document.createElement('tr');
        const tdK = document.createElement('td');
        tdK.textContent = k;
        const tdV = document.createElement('td');
        tdV.textContent = String(v);
        tr.appendChild(tdK);
        tr.appendChild(tdV);
        table.appendChild(tr);
      });
      flyout.appendChild(table);
    });

    const show = () => {
      flyout.style.visibility = 'hidden';
      flyout.classList.remove('hidden');
      const fH = flyout.offsetHeight;
      const fW = flyout.offsetWidth;
      const r = pill.getBoundingClientRect();
      const gap = 8;
      let top = r.top - fH - gap;
      top = Math.max(8, top);
      let left = r.left + r.width / 2 - fW / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - fW - 8));
      flyout.style.top = `${top}px`;
      flyout.style.left = `${left}px`;
      flyout.style.visibility = '';
      pill.classList.add('is-active');
      pill.setAttribute('aria-expanded', 'true');
    };

    const hide = () => {
      flyout.classList.add('hidden');
      pill.classList.remove('is-active');
      pill.setAttribute('aria-expanded', 'false');
    };

    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      flyout.classList.contains('hidden') ? show() : hide();
    });

    const dismiss = (e) => {
      if (!flyout.contains(e.target) && e.target !== pill) hide();
    };
    document.addEventListener('click', dismiss);
    this._exifDismiss = dismiss;
  }

  beforeUnmount() {
    this._cleanupFlyout?.();
    this._exifFlyout?.remove();
    this._exifFlyout = null;
    if (this._exifDismiss) {
      document.removeEventListener('click', this._exifDismiss);
      this._exifDismiss = null;
    }
  }
}
