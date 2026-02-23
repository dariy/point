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
    this.container.querySelectorAll('.tag-group').forEach((group) => {
      const btn = group.querySelector('.toggle-children');
      if (!btn) return;

      // Touch / keyboard: toggle on chevron click.
      // Close sibling groups only — do NOT close ancestor groups so that
      // parent dropdowns stay open when a nested chevron is tapped.
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const isOpen = group.classList.contains('is-open');
        this._closeAllExcept(group);
        if (!isOpen) this._open(group);
      });

      // Pointer devices: open/close on hover
      group.addEventListener('mouseenter', () => this._open(group));
      group.addEventListener('mouseleave', () => this._close(group));
    });

    // Store bound refs so they can be removed in beforeUnmount
    this._boundOutside        = (e) => { if (!this.container.contains(e.target)) this._closeAll(); };
    this._boundCloseAll       = () => this._closeAll();
    this._boundCheckOverflow  = () => this._checkOverflow();

    document.addEventListener('click',  this._boundOutside);
    window.addEventListener('scroll',   this._boundCloseAll, { passive: true });
    window.addEventListener('resize',   this._boundCloseAll, { passive: true });
    window.addEventListener('resize',   this._boundCheckOverflow, { passive: true });

    // Defer one frame so the header's flex layout has settled before measuring.
    requestAnimationFrame(() => this._checkOverflow());
  }

  beforeUnmount() {
    document.removeEventListener('click',  this._boundOutside);
    window.removeEventListener('scroll',   this._boundCloseAll);
    window.removeEventListener('resize',   this._boundCloseAll);
    window.removeEventListener('resize',   this._boundCheckOverflow);
  }

  /**
   * If the filter chips overflow the available inline space, apply
   * `.tags-stacked` to the header group so the bar drops to a second line.
   * Clears the class first to get an accurate measurement.
   */
  _checkOverflow() {
    const headerGroup = this.container.closest('.site-header-group');
    const filters     = this.container.querySelector('.tags-filters');
    if (!headerGroup || !filters) return;

    // Measure in non-stacked state
    headerGroup.classList.remove('tags-stacked');
    // Reading scrollWidth forces a synchronous layout recalculation
    const overflows = filters.scrollWidth > filters.clientWidth + 2;
    headerGroup.classList.toggle('tags-stacked', overflows);
  }

  // Open a dropdown, positioning it with position:fixed so it escapes
  // any overflow:auto ancestor (the horizontal-scroll tags bar).
  _open(group) {
    const dropdown = group.querySelector('.tag-children');
    const anchor   = group.querySelector('.tag-group-header') || group;
    if (!dropdown || !anchor) return;

    // Measure dropdown dimensions while invisible
    dropdown.classList.add('is-measuring');
    const anchorRect = anchor.getBoundingClientRect();
    const dropW = dropdown.offsetWidth;
    const dropH = dropdown.offsetHeight;
    dropdown.classList.remove('is-measuring');

    const gap = 0;

    // Horizontal: always centre on the anchor tag, clamped to viewport edges
    let left = anchorRect.left + anchorRect.width / 2 - dropW / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - dropW - 8));

    // Vertical: open below the anchor button (root) or below the parent panel (nested),
    // so the gap is consistent at every level.
    let top;
    if (group.parentElement?.classList.contains('tag-children')) {
      const panelRect = group.parentElement.getBoundingClientRect();
      top = panelRect.bottom + gap;
    } else {
      top = anchorRect.bottom + gap;
    }

    dropdown.style.position  = 'fixed';
    dropdown.style.top       = `${top}px`;
    dropdown.style.left      = `${left}px`;
    dropdown.style.transform = 'none';

    group.classList.add('is-open');
    group.querySelector('.toggle-children')?.setAttribute('aria-expanded', 'true');
  }

  _close(group) {
    const dropdown = group.querySelector('.tag-children');
    if (dropdown) {
      dropdown.style.position  = '';
      dropdown.style.top       = '';
      dropdown.style.left      = '';
      dropdown.style.transform = '';
    }
    group.classList.remove('is-open');
    group.querySelector('.toggle-children')?.setAttribute('aria-expanded', 'false');
  }

  _closeAll() {
    this.container.querySelectorAll('.tag-group.is-open').forEach((g) => this._close(g));
  }

  // Close all open groups except `group` and its ancestors.
  // Used by the chevron click handler so that tapping a nested chevron
  // does not collapse the parent dropdown that contains it.
  _closeAllExcept(group) {
    this.container.querySelectorAll('.tag-group.is-open').forEach((g) => {
      if (g !== group && !g.contains(group)) this._close(g);
    });
  }
}
