// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.12.
/**
 * Breadcrumbs — the tag-ancestry trail and the active facet crumbs.
 *
 * The blog title that heads the trail is NOT here: it is site identity and
 * outlives this plugin being switched off, so the header owns it (see
 * components/public/SiteCrumb.js). This component renders everything after it.
 */

import { Component } from '../../components/Component.js';
import { html, navigate, raw } from '../../utils/helpers.js';
import { LOCK_SVG } from '../../utils/icons.js';
import { ViewContext } from '../../utils/viewContext.js';
import { tagHref } from '../../utils/tagLinks.js';
import {
  showCrumbDropdown, hideFlyout, attachFlyoutTrigger, HOVER_OPEN_MS,
} from '../../utils/tagFlyout.js';

export class Breadcrumbs extends Component {
  render() {
    const {
      navTags = [],
      breadcrumb = [],
      total = 0,
      timelineVisible = false,
    } = this.props;

    const vc = ViewContext.current();

    let yearLabel = null;
    if (vc.years && !timelineVisible) {
      yearLabel = vc.years[0] === vc.years[1]
        ? String(vc.years[0])
        : `${vc.years[0]}–${vc.years[1]}`;
    }

    const queryLabel = vc.query ? `“${vc.query}”` : null;

    const ariaLabels = [];
    if (vc.tag) ariaLabels.push(vc.tag);
    if (vc.years && !timelineVisible) ariaLabels.push(`from ${vc.years[0]} to ${vc.years[1]}`);
    if (vc.query) ariaLabels.push(`search for ${vc.query}`);
    const ariaLiveText = ariaLabels.length
      ? `Showing ${ariaLabels.join(', ')} — ${total} post${total !== 1 ? 's' : ''}`
      : '';

    const tagCrumbsHtml = breadcrumb.map((crumb, i) => {
      const isLast = i === breadcrumb.length - 1;
      const lockIcon = crumb.is_hidden ? raw(LOCK_SVG) : '';
      const tooltipAttr = crumb.tooltip ? html` title="${crumb.tooltip}"` : '';
      const popupAttr = (has) => (has ? raw(' aria-haspopup="true"') : '');

      if (isLast) {
        const hasChildren = this._crumbHasChildren(crumb, navTags);
        // The raw href goes in: href= puts the tag's URL policy in play, which
        // is the point — escapeHtml never touched `javascript:`.
        const href = crumb.href
          ? crumb.href
          : crumb.slug
            ? `/tags/${crumb.slug}`
            : null;
        const hasFacets = yearLabel || queryLabel;
        if (hasFacets) {
          if (href) {
            return html`<span class="crumb-pair">
              <a href="${href}" class="breadcrumb-link${crumb.is_hidden ? ' is-hidden' : ''}${hasChildren ? ' has-dropdown' : ''}"
                 data-crumb-slug="${crumb.slug}"${tooltipAttr}${popupAttr(hasChildren)}>${lockIcon}${crumb.name}</a>
              <span class="breadcrumb-separator" aria-hidden="true"></span>
            </span>`;
          }
          return html`<span class="crumb-pair">
            <span class="breadcrumb-link${crumb.is_hidden ? ' is-hidden' : ''}${hasChildren ? ' has-dropdown' : ''}"${tooltipAttr}>${lockIcon}${crumb.name}</span>
            <span class="breadcrumb-separator" aria-hidden="true"></span>
          </span>`;
        }
        if (href) {
          return html`<a href="${href}" class="breadcrumb-current${crumb.is_hidden ? ' is-hidden' : ''}${hasChildren ? ' has-dropdown' : ''}"
             data-crumb-slug="${crumb.slug}"${tooltipAttr}${popupAttr(hasChildren)}>${lockIcon}${crumb.name}</a>`;
        }
        return html`<span class="breadcrumb-current${crumb.is_hidden ? ' is-hidden' : ''}${hasChildren ? ' has-dropdown' : ''}"${tooltipAttr}>${lockIcon}${crumb.name}</span>`;
      }

      const href = crumb.href || (crumb.slug ? `/tags/${crumb.slug}` : '/');
      const hasChildren = this._crumbHasChildren(crumb, navTags);
      return html`<span class="crumb-pair">
        <a href="${href}" class="breadcrumb-link${crumb.is_hidden ? ' is-hidden' : ''}${hasChildren ? ' has-dropdown' : ''}"
           data-crumb-slug="${crumb.slug || ''}"${tooltipAttr}${popupAttr(hasChildren)}>${lockIcon}${crumb.name}</a>
        <span class="breadcrumb-separator" aria-hidden="true"></span>
      </span>`;
    });

    // Collected rather than concatenated: `+=` would drop html`` output back to
    // a plain string.
    const facetCrumbs = [];
    if (yearLabel) {
      const isTerminal = !queryLabel;
      if (isTerminal) {
        facetCrumbs.push(html`<span class="breadcrumb-current breadcrumb-facet breadcrumb-year">${yearLabel}</span>`);
      } else {
        facetCrumbs.push(html`<span class="crumb-pair crumb-facet-pair">
          <span class="breadcrumb-link breadcrumb-facet breadcrumb-year">${yearLabel}</span>
          <span class="breadcrumb-separator" aria-hidden="true"></span>
        </span>`);
      }
    }
    if (queryLabel) {
      facetCrumbs.push(html`<span class="breadcrumb-current breadcrumb-facet breadcrumb-query">${queryLabel}</span>`);
    }

    return html`
      ${ariaLiveText ? html`<span class="sr-only" aria-live="polite">${ariaLiveText}</span>` : ''}
      ${tagCrumbsHtml}
      ${facetCrumbs}
    `;
  }

  /**
   * Ancestor trail shown at the top of a crumb dropdown: Home + every crumb up
   * to and including `upToIndex` (which is flagged `current`). Lets the folded
   * "…" ancestors stay reachable inside the anchored dropdown on mobile.
   */
  _buildPath(upToIndex) {
    const { settings = {}, breadcrumb = [] } = this.props;
    const path = [{ name: settings.blog_title || 'Photo Blog', href: '/' }];
    breadcrumb.slice(0, upToIndex + 1).forEach((c, i) => {
      path.push({
        name: c.name,
        href: c.href || (c.slug ? `/tags/${c.slug}` : '/'),
        is_hidden: c.is_hidden,
        current: i === upToIndex,
      });
    });
    return path;
  }

  _crumbHasChildren(crumb, navTags) {
    if (!crumb.slug) return false;
    const find = (tags) => {
      for (const t of tags) {
        if (t.slug === crumb.slug) return !!(t.children && t.children.length);
        if (t.children && t.children.length) {
          const found = find(t.children);
          if (found !== null) return found;
        }
      }
      return null;
    };
    return find(navTags) === true;
  }

  _getTagChildren(slug, navTags) {
    const find = (tags) => {
      for (const t of tags) {
        if (t.slug === slug) return t.children || [];
        if (t.children && t.children.length) {
          const found = find(t.children);
          if (found) return found;
        }
      }
      return null;
    };
    return find(navTags) || [];
  }

  afterRender() {
    const { navTags = [], group } = this.props;

    // The trail is "hidden" when the header has folded ancestors into "…" or
    // ellipsized the current crumb. Only then does the dropdown need to carry
    // the ancestor path — on a wide header the trail is already fully visible,
    // so the dropdown stays children-only. Evaluated at open time because the
    // fold state changes on resize after this wiring runs.
    const trailHidden = () =>
      !!group?.querySelector('.crumb-pair.folded') ||
      !!group?.classList.contains('fold-current');

    // `buildPath` (optional) returns the ancestor trail lazily; `children` is
    // the drill-down list. The final spec is assembled per open.
    const attachCrumbDropdown = (el, children, buildPath = null) => {
      if (!children.length && !buildPath) return;
      attachFlyoutTrigger(el, () => ({
        path: (buildPath && trailHidden()) ? buildPath() : [],
        children,
      }), navigate, group);
    };

    const breadcrumbSlugs = (this.props.breadcrumb || [])
      .map(b => b.slug)
      .filter(Boolean);
    this.container.querySelectorAll('.breadcrumb-link[data-crumb-slug], .breadcrumb-current[data-crumb-slug]').forEach(el => {
      if (!el.classList.contains('has-dropdown')) return;
      const slug = el.dataset.crumbSlug;
      if (!slug) return;
      const children = this._getTagChildren(slug, navTags);
      if (!children.length) return;
      const idx = breadcrumbSlugs.indexOf(slug);
      const childPath = idx >= 0 ? breadcrumbSlugs.slice(0, idx + 1) : [slug];
      const childItems = children.map(c => ({
        name: c.name,
        slug: c.slug,
        count: c.post_count,
        href: c.url || tagHref(c.slug, childPath),
      }));
      attachCrumbDropdown(el, childItems, () => this._buildPath(idx));
    });

    // When the current crumb is a childless leaf it gets no dropdown above, so
    // whenever the trail is hidden (ancestors folded into "…" or the current
    // crumb ellipsized) those ancestors would be unreachable. Give that leaf a
    // path-only dropdown so the trail stays one tap away — same anchored panel,
    // no children section. The `has-hidden-trail` class drives the affordance.
    const crumbCurrentEls = [...this.container.querySelectorAll('.breadcrumb-current')];
    const lastCrumbCurrent = crumbCurrentEls[crumbCurrentEls.length - 1] || null;
    if (
      lastCrumbCurrent &&
      !lastCrumbCurrent.classList.contains('has-dropdown') &&
      breadcrumbSlugs.length
    ) {
      const path = this._buildPath(this.props.breadcrumb.length - 1);
      // Marker for the CSS affordance: a "reveal trail" chevron shows on this
      // crumb only while the header is actually hiding ancestors (see header.css).
      lastCrumbCurrent.classList.add('crumb-trail-toggle');
      let trailTimer = null;
      lastCrumbCurrent.addEventListener('pointerenter', (e) => {
        if (e.pointerType !== 'mouse') return;
        clearTimeout(trailTimer);
        trailTimer = setTimeout(() => {
          if (!trailHidden()) return;
          showCrumbDropdown(lastCrumbCurrent, { path }, navigate, group);
        }, HOVER_OPEN_MS);
      });
      lastCrumbCurrent.addEventListener('pointerleave', () => clearTimeout(trailTimer));
      lastCrumbCurrent.addEventListener('click', (e) => {
        clearTimeout(trailTimer);
        if (!trailHidden()) return;
        e.preventDefault();
        e.stopPropagation();
        if (lastCrumbCurrent.classList.contains('is-flyout-open')) {
          hideFlyout();
        } else {
          showCrumbDropdown(lastCrumbCurrent, { path }, navigate, group);
        }
      });
    }
  }

  beforeUnmount() {
    hideFlyout();
  }
}
