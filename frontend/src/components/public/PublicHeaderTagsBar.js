/**
 * PublicHeaderTagsBar — header filter bar showing root-level tags as
 * dropdown chip buttons.  Renders inside .header-tags-bar.
 *
 * Props:
 *   navTags        {object[]}  Root tags with children from /api/pages/home
 *   currentTagSlug {string}    Active tag slug (for highlight), optional
 */

import { Component } from '../Component.js';
import { escapeHtml } from '../../utils/helpers.js';

const CHEVRON_SVG = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export class PublicHeaderTagsBar extends Component {
  render() {
    const { navTags = [], currentTagSlug = '' } = this.props;
    if (!navTags.length) return '';

    const chips = navTags
      .map((tag) => this._renderTag(tag, currentTagSlug, true))
      .join('');

    return `
      <div class="tags-filters is-ready" data-mode="categories">
        ${chips}
      </div>`;
  }

  /**
   * Recursively render a tag (or related tag) and its children.
   *
   * @param {object}  tag             Tag data with .children[]
   * @param {string}  currentTagSlug  Active slug for highlighting
   * @param {boolean} isRoot          True if this is a top-level nav chip
   * @returns {string} HTML string
   */
  _renderTag(tag, currentTagSlug, isRoot = false) {
    if (tag.is_hidden) return '';
    const activeClass = currentTagSlug === tag.slug ? ' active' : '';
    const relatedClass = tag.is_related ? ' is-related' : '';
    const rootClass = isRoot ? ' category-tag' : '';

    if (!tag.children?.length) {
      return `
        <a href="/tag/${escapeHtml(tag.slug)}"
           class="filter-btn${rootClass}${relatedClass}${activeClass}">
          ${escapeHtml(tag.name)}
        </a>`;
    }

    const childHtml = tag.children
      .map((c) => this._renderTag(c, currentTagSlug, false))
      .join('');

    return `
      <div class="tag-group${rootClass}${relatedClass}" data-slug="${escapeHtml(tag.slug)}">
        <div class="tag-group-header">
          <a href="/tag/${escapeHtml(tag.slug)}"
             class="filter-btn${activeClass}">
            ${escapeHtml(tag.name)}
          </a>
          <button class="toggle-children" type="button"
                  aria-label="Toggle ${escapeHtml(tag.name)} sub-tags"
                  aria-expanded="false">
            ${CHEVRON_SVG}
          </button>
        </div>
        <div class="tag-children">${childHtml}</div>
      </div>`;
  }

  afterRender() {
    // Toggle .is-open on click (for touch/keyboard access)
    this.container.querySelectorAll('.tag-group').forEach((group) => {
      const btn = group.querySelector('.toggle-children');
      if (!btn) return;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const open = group.classList.toggle('is-open');
        btn.setAttribute('aria-expanded', String(open));
      });
    });

    // Close dropdowns when clicking outside
    document.addEventListener('click', this._handleOutsideClick.bind(this), { once: false });
  }

  beforeUnmount() {
    document.removeEventListener('click', this._handleOutsideClick.bind(this));
  }

  _handleOutsideClick(e) {
    if (!this.container.contains(e.target)) {
      this.container.querySelectorAll('.tag-group.is-open').forEach((g) => {
        g.classList.remove('is-open');
        g.querySelector('.toggle-children')?.setAttribute('aria-expanded', 'false');
      });
    }
  }
}
