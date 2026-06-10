/**
 * PublicHeaderTagsBar — header filter bar showing root-level tags as
 * dropdown chip buttons.  Renders inside .header-tags-bar.
 *
 * Props:
 *   navTags        {object[]}  Root tags with children from /api/pages/home
 *   currentTagSlug {string}    Active tag slug (for highlight), optional
 */

import { Component } from '../Component.js';
import { escapeHtml, navigate } from '../../utils/helpers.js';
import { CHEVRON_SVG } from '../../utils/icons.js';
import { renderTagLink, setupScrollableStrip, createHotZone } from '../../utils/tags.js';

export class PublicHeaderTagsBar extends Component {
  render() {
    const { navTags = [], currentTagSlug = '' } = this.props;
    if (!navTags.length) return '';

    const chips = navTags
      .map((tag) => this._renderTag(tag, currentTagSlug, true))
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

  /**
   * Recursively render a tag (or related tag) and its children.
   *
   * @param {object}  tag             Tag data with .children[]
   * @param {string}  currentTagSlug  Active slug for highlighting
   * @param {boolean} isRoot          True if this is a top-level nav chip
   * @returns {string} HTML string
   */
  _renderTag(tag, currentTagSlug, isRoot = false) {
    const relatedClass = tag.is_related ? ' is-related' : '';
    const rootClass = isRoot ? ' category-tag' : '';

    if (!tag.children?.length) {
      const extra = [isRoot ? 'category-tag' : '', tag.is_related ? 'is-related' : ''].filter(Boolean).join(' ');
      return renderTagLink(tag, { active: currentTagSlug === tag.slug, extra });
    }

    const childHtml = tag.children
      .map((c) => this._renderTag(c, currentTagSlug, false))
      .join('');

    const headerLink = renderTagLink(tag, { active: currentTagSlug === tag.slug });

    return `
      <div class="tag-group${rootClass}${relatedClass}" data-slug="${escapeHtml(tag.slug)}">
        <div class="tag-group-header">
          ${headerLink}
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

      // Click / tap: explicit toggle.
      // Toggle decision uses _openedByClick (not the CSS is-open class) so
      // that the synthesized mouseenter touch browsers fire before click
      // does not trick the handler into seeing the menu as already-open.
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearTimeout(group._openTimer);
        const wasClickOpen = group._openedByClick;
        this._closeAllExcept(group);
        if (wasClickOpen) {
          this._close(group);
        } else {
          group._openedByClick = true;
          this._open(group);
        }
      });

      // Tapping/clicking the pill text: always navigate immediately.
      // To open the dropdown on touch, use the chevron toggle button.
      const headerLink = group.querySelector('.tag-group-header > .tag-link');
      if (headerLink) {
        headerLink.addEventListener('click', () => {
          // One click = navigate everywhere.
          // No preventDefault — let it navigate via natural <a> behavior
          // (which the SPA router intercepts).
          this._closeAll();
        });
      }

      // Hover open: 300 ms intent delay.
      // – Long enough that navigating between chips doesn't trigger spurious
      //   opens; short enough to feel instant on deliberate hover.
      // – Touch: synthesized mouseenter fires < 5 ms before click, so the
      //   click handler always wins the race and cancels the timer.
      // – Close same-level siblings immediately on enter so there is never
      //   a lag where two dropdowns are visible at once.
      group.addEventListener('mouseenter', () => {
        clearTimeout(group._openTimer);
        this._closeSiblings(group);
        if (!group._openedByClick) {
          group._openTimer = setTimeout(() => this._open(group), 300);
        }
      });

      // Cancel a pending open if cursor leaves before the 300 ms are up.
      // Closing an already-open menu is handled by the hot zone, not here.
      group.addEventListener('mouseleave', () => {
        clearTimeout(group._openTimer);
      });
    });

    const track   = this.container.querySelector('.tag-strip-track');
    const filters = this.container.querySelector('.tag-strip-scroll');
    this._cleanupStrip = setupScrollableStrip(track, filters);

    // Store bound refs so they can be removed in beforeUnmount
    this._boundOutside  = (e) => { if (!this.container.contains(e.target)) this._closeAll(); };
    this._boundCloseAll = () => {
      if (Date.now() - (this._lastOpenTime || 0) < 300) return;
      this._closeAll();
    };

    document.addEventListener('click',  this._boundOutside);
    window.addEventListener('scroll',   this._boundCloseAll, { passive: true });
    window.addEventListener('resize',   this._boundCloseAll, { passive: true });
  }

  beforeUnmount() {
    // Close all groups first so their hot-zone mousemove listeners are removed.
    this._closeAll();

    document.removeEventListener('click',  this._boundOutside);
    window.removeEventListener('scroll',   this._boundCloseAll);
    window.removeEventListener('resize',   this._boundCloseAll);

    this._cleanupStrip?.();
  }

  // Open a dropdown, positioning it with position:fixed so it escapes
  // any overflow:auto ancestor (the horizontal-scroll tags bar).
  // After opening, attaches a hot-zone tracker on document mousemove.
  _open(group) {
    const dropdown = group.querySelector('.tag-children');
    const anchor   = group.querySelector('.tag-group-header') || group;
    if (!dropdown || !anchor) return;

    // Measure dropdown width while invisible.
    dropdown.classList.add('is-measuring');
    const anchorRect = anchor.getBoundingClientRect();
    const dropW = dropdown.offsetWidth;
    dropdown.classList.remove('is-measuring');

    // Horizontal: centre on the anchor chip, clamped to viewport edges.
    let left = anchorRect.left + anchorRect.width / 2 - dropW / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - dropW - 8));

    // Vertical: flush below the chip.
    const top = anchorRect.bottom;

    dropdown.style.position  = 'fixed';
    dropdown.style.top       = `${top}px`;
    dropdown.style.left      = `${left}px`;
    dropdown.style.transform = 'none';

    group.classList.add('is-open');
    group.querySelector('.toggle-children')?.setAttribute('aria-expanded', 'true');
    this.container.querySelector('.tag-strip-track')?.classList.add('is-dropdown-open');

    this._lastOpenTime = Date.now();
    this._startHotZone(group);
  }

  // The hot zone covers the chip header, its own dropdown, and any nested
  // open dropdowns — evaluated live on every mousemove so newly-opened
  // sub-menus are automatically included without any stale-coord race.
  _startHotZone(group) {
    this._stopHotZone(group);
    group._hotZone = createHotZone(
      () => [
        group.querySelector('.tag-group-header') || group,
        group.querySelector(':scope > .tag-children'),
        ...Array.from(group.querySelectorAll('.tag-group.is-open > .tag-children')),
      ],
      () => { if (!group._openedByClick) this._close(group); }
    );
  }

  _stopHotZone(group) {
    group._hotZone?.stop();
    group._hotZone = null;
  }

  _close(group) {
    this._stopHotZone(group);
    clearTimeout(group._openTimer);
    group._openedByClick = false;

    // Close any open descendants before removing our own is-open so that
    // their hot-zone listeners are also cleaned up.
    group.querySelectorAll('.tag-group.is-open').forEach((g) => this._close(g));

    const dropdown = group.querySelector('.tag-children');
    if (dropdown) {
      dropdown.style.position  = '';
      dropdown.style.top       = '';
      dropdown.style.left      = '';
      dropdown.style.transform = '';
    }
    group.classList.remove('is-open');
    group.querySelector('.toggle-children')?.setAttribute('aria-expanded', 'false');

    // If no more dropdowns are open in the track, remove the masking override
    if (!this.container.querySelector('.tag-group.is-open')) {
      this.container.querySelector('.tag-strip-track')?.classList.remove('is-dropdown-open');
    }
  }

  _closeAll() {
    this.container.querySelectorAll('.tag-group.is-open').forEach((g) => this._close(g));
  }

  // Close open groups that are direct siblings of `group` at the same DOM
  // level.  Called on mouseenter so the previous chip closes immediately.
  _closeSiblings(group) {
    group.parentElement?.querySelectorAll(':scope > .tag-group.is-open').forEach((g) => {
      if (g !== group) this._close(g);
    });
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
