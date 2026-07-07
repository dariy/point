import { Component } from '../../components/Component.js';
import { escapeHtml, navigate } from '../../utils/helpers.js';
import { LOCK_SVG } from '../../utils/icons.js';
import { ViewContext } from '../../utils/viewContext.js';
import { showCrumbDropdown, hideFlyout, tagHref } from '../../utils/tags.js';

export class Breadcrumbs extends Component {
  render() {
    const {
      settings = {},
      navTags = [],
      breadcrumb = [],
      total = 0,
      timelineVisible = false,
    } = this.props;

    const title    = escapeHtml(settings.blog_title || 'Photo Blog');
    const vc = ViewContext.current();
    const hasTagCrumbs = breadcrumb.length > 0;

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

    // The site crumb is a plain home link. Menu navigation lives in the nav
    // zone (inline links / More / burger) — the old navTags flyout on the
    // title was invisible to touch and raced the nav fetch on first load.
    const siteHasFollowingCrumbs = hasTagCrumbs || yearLabel || queryLabel;
    const siteClass = siteHasFollowingCrumbs ? 'breadcrumb-link' : 'breadcrumb-current';
    const siteCrumbHtml = `<span class="crumb-pair" id="site-crumb-pair">
      <a href="/" class="${siteClass} crumb-site" data-crumb="site"
         aria-label="${title}">${title}</a>
      ${siteHasFollowingCrumbs ? '<span class="breadcrumb-separator" aria-hidden="true"></span>' : ''}
    </span>`;

    const tagCrumbsHtml = breadcrumb.map((crumb, i) => {
      const isLast = i === breadcrumb.length - 1;
      const lockIcon = crumb.is_hidden ? LOCK_SVG : '';
      const tooltipAttr = crumb.tooltip ? ` title="${escapeHtml(crumb.tooltip)}"` : '';

      if (isLast) {
        const hasChildren = this._crumbHasChildren(crumb, navTags);
        const href = crumb.href
          ? escapeHtml(crumb.href)
          : crumb.slug
            ? `/tags/${escapeHtml(crumb.slug)}`
            : null;
        const hasFacets = yearLabel || queryLabel;
        if (hasFacets) {
          if (href) {
            return `<span class="crumb-pair">
              <a href="${href}" class="breadcrumb-link${crumb.is_hidden ? ' is-hidden' : ''}${hasChildren ? ' has-dropdown' : ''}"
                 data-crumb-slug="${escapeHtml(crumb.slug)}"${tooltipAttr}${hasChildren ? ' aria-haspopup="true"' : ''}>${lockIcon}${escapeHtml(crumb.name)}</a>
              <span class="breadcrumb-separator" aria-hidden="true"></span>
            </span>`;
          }
          return `<span class="crumb-pair">
            <span class="breadcrumb-link${crumb.is_hidden ? ' is-hidden' : ''}${hasChildren ? ' has-dropdown' : ''}"${tooltipAttr}>${lockIcon}${escapeHtml(crumb.name)}</span>
            <span class="breadcrumb-separator" aria-hidden="true"></span>
          </span>`;
        }
        if (href) {
          return `<a href="${href}" class="breadcrumb-current${crumb.is_hidden ? ' is-hidden' : ''}${hasChildren ? ' has-dropdown' : ''}"
             data-crumb-slug="${escapeHtml(crumb.slug)}"${tooltipAttr}${hasChildren ? ' aria-haspopup="true"' : ''}>${lockIcon}${escapeHtml(crumb.name)}</a>`;
        }
        return `<span class="breadcrumb-current${crumb.is_hidden ? ' is-hidden' : ''}${hasChildren ? ' has-dropdown' : ''}"${tooltipAttr}>${lockIcon}${escapeHtml(crumb.name)}</span>`;
      }

      const href = crumb.href || (crumb.slug ? `/tags/${escapeHtml(crumb.slug)}` : '/');
      const hasChildren = this._crumbHasChildren(crumb, navTags);
      return `<span class="crumb-pair">
        <a href="${href}" class="breadcrumb-link${crumb.is_hidden ? ' is-hidden' : ''}${hasChildren ? ' has-dropdown' : ''}"
           data-crumb-slug="${escapeHtml(crumb.slug || '')}"${tooltipAttr}${hasChildren ? ' aria-haspopup="true"' : ''}>${lockIcon}${escapeHtml(crumb.name)}</a>
        <span class="breadcrumb-separator" aria-hidden="true"></span>
      </span>`;
    }).join('');

    let facetCrumbsHtml = '';
    if (yearLabel) {
      const isTerminal = !queryLabel;
      if (isTerminal) {
        facetCrumbsHtml += `<span class="breadcrumb-current breadcrumb-facet breadcrumb-year">${escapeHtml(yearLabel)}</span>`;
      } else {
        facetCrumbsHtml += `<span class="crumb-pair crumb-facet-pair">
          <span class="breadcrumb-link breadcrumb-facet breadcrumb-year">${escapeHtml(yearLabel)}</span>
          <span class="breadcrumb-separator" aria-hidden="true"></span>
        </span>`;
      }
    }
    if (queryLabel) {
      facetCrumbsHtml += `<span class="breadcrumb-current breadcrumb-facet breadcrumb-query">${escapeHtml(queryLabel)}</span>`;
    }

    return `
      ${ariaLiveText ? `<span class="sr-only" aria-live="polite">${escapeHtml(ariaLiveText)}</span>` : ''}
      ${siteCrumbHtml}
      ${tagCrumbsHtml}
      ${facetCrumbsHtml}
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

    const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    let hoverTimer = null;

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
      const openSpec = () => ({
        path: (buildPath && trailHidden()) ? buildPath() : [],
        children,
      });
      if (canHover) {
        el.addEventListener('mouseenter', () => {
          clearTimeout(hoverTimer);
          hoverTimer = setTimeout(
            () => showCrumbDropdown(el, openSpec(), navigate, group),
            180,
          );
        });
        el.addEventListener('mouseleave', () => clearTimeout(hoverTimer));
        el.addEventListener('click', () => { clearTimeout(hoverTimer); hideFlyout(); });
      } else {
        el.addEventListener('click', (e) => {
          if (el.classList.contains('is-flyout-open')) {
            const href = el.getAttribute('href');
            if (href) {
              hideFlyout();
              navigate(href);
              e.preventDefault();
              return;
            }
          }
          e.preventDefault();
          showCrumbDropdown(el, openSpec(), navigate, group);
        });
      }
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
      lastCrumbCurrent.addEventListener('click', (e) => {
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
