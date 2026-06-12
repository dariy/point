/**
 * PublicHeaderTagsBar — header filter bar showing root-level tags.
 * Uses the unified tag family flyout (point-x52z.13).
 *
 * Props:
 *   navTags        {object[]}  Root tags with children from /api/pages/home
 *   currentTagSlug {string}    Active tag slug (for highlight), optional
 */

import { Component } from '../Component.js';
import { escapeHtml, navigate } from '../../utils/helpers.js';
import { CHEVRON_SVG } from '../../utils/icons.js';
import { renderTagLink, setupScrollableStrip, setupTagFlyout, buildTagIndex } from '../../utils/tags.js';
import { store } from '../../store.js';

export class PublicHeaderTagsBar extends Component {
  render() {
    const { navTags = [], currentTagSlug = '' } = this.props;
    if (!navTags.length) return '';

    const chips = navTags
      .map((tag) => {
        const extra = ['category-tag', tag.is_related ? 'is-related' : ''].filter(Boolean).join(' ');
        const hasChildren = !!tag.children?.length;
        
        const link = renderTagLink(tag, { active: currentTagSlug === tag.slug, extra });
        
        if (hasChildren) {
          return `
            <div class="tag-group category-tag" data-slug="${escapeHtml(tag.slug)}">
              <div class="tag-group-header">
                ${link}
                <button class="toggle-children" type="button"
                        aria-label="Toggle ${escapeHtml(tag.name)} sub-tags"
                        aria-expanded="false">
                  ${CHEVRON_SVG}
                </button>
              </div>
            </div>`;
        }
        return link;
      })
      .join('');

    return `
      <div class="tag-strip-track">
        <button class="tags-scroll-btn tags-scroll-btn--left" aria-label="Scroll left" type="button">
          ${CHEVRON_SVG}
        </button>
        <div class="tag-strip-scroll is-ready" data-mode="categories">
          ${chips}
        </div>
        <button class="tags-scroll-btn tags-scroll-btn--right" aria-label="Scroll right" type="button">
          ${CHEVRON_SVG}
        </button>
      </div>`;
  }

  afterRender() {
    const { navTags = [] } = this.props;
    const track   = this.container.querySelector('.tag-strip-track');
    const filters = this.container.querySelector('.tag-strip-scroll');
    
    this._cleanupScroll = setupScrollableStrip(track, filters);
    
    const tagIndex = buildTagIndex(navTags);
    this._cleanupFlyout = setupTagFlyout(filters, tagIndex, navigate);

    // Header chips ▾ caret also opens the flyout
    this.container.querySelectorAll('.toggle-children').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const link = btn.previousElementSibling;
        if (link) {
          // Trigger the flyout manually
          link.dispatchEvent(new Event('mouseenter')); // For desktop/hover logic
          // Or we could export a manual open function from tags.js
        }
      });
    });
  }

  beforeUnmount() {
    this._cleanupScroll?.();
    this._cleanupFlyout?.();
  }
}
