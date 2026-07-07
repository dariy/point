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

    const allCrumbsForPopover = [
      { name: settings.blog_title || 'Photo Blog', href: '/' },
      ...breadcrumb.map(c => ({
        name: c.name,
        href: c.href || (c.slug ? `/tags/${c.slug}` : '/'),
        is_hidden: c.is_hidden,
      })),
      ...(yearLabel ? [{ name: yearLabel, href: null }] : []),
      ...(queryLabel ? [{ name: queryLabel, href: null }] : []),
    ];

    const popoverItemsHtml = allCrumbsForPopover.map((c, i) => {
      const isLast = i === allCrumbsForPopover.length - 1;
      const lockIcon = c.is_hidden ? LOCK_SVG : '';
      if (isLast || !c.href) {
        return `<span class="popover-item is-current">${lockIcon}${escapeHtml(c.name)}</span>`;
      }
      return `<a href="${escapeHtml(c.href)}" class="popover-item">${lockIcon}${escapeHtml(c.name)}</a>`;
    }).join('');

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
      <div class="crumb-popover" id="crumb-popover">${popoverItemsHtml}</div>
    `;
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
    const attachCrumbDropdown = (el, items) => {
      if (!items.length) return;
      if (canHover) {
        el.addEventListener('mouseenter', () => {
          clearTimeout(hoverTimer);
          hoverTimer = setTimeout(
            () => showCrumbDropdown(el, items, navigate, group),
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
          showCrumbDropdown(el, items, navigate, group);
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
      attachCrumbDropdown(el, childItems);
    });

    const crumbCurrentEls = [...this.container.querySelectorAll('.breadcrumb-current')];
    const lastCrumbCurrent = crumbCurrentEls[crumbCurrentEls.length - 1] || null;
    const crumbPopover = this.$('#crumb-popover');
    if (lastCrumbCurrent && crumbPopover) {
      lastCrumbCurrent.addEventListener('click', (e) => {
        if (!group?.classList.contains('fold-current')) return;
        e.preventDefault();
        e.stopPropagation();
        const isOpen = crumbPopover.classList.contains('is-open');
        if (!isOpen) {
          const rect = lastCrumbCurrent.getBoundingClientRect();
          crumbPopover.style.top  = `${rect.bottom + 4}px`;
          crumbPopover.style.left = `${rect.left}px`;
        }
        crumbPopover.classList.toggle('is-open', !isOpen);
      });

      document.addEventListener('click', (e) => {
        if (!crumbPopover.contains(e.target) && e.target !== lastCrumbCurrent) {
          crumbPopover.classList.remove('is-open');
        }
      });
    }
  }

  beforeUnmount() {
    hideFlyout();
  }
}
