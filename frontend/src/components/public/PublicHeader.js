/**
 * Public site header — blog logo, unified breadcrumb (tag path + active
 * facets), and nav buttons.
 *
 * Props:
 *   settings        {object}    Public blog settings (blog_title, blog_subtitle)
 *   currentPath     {string}    Current pathname for active nav highlighting
 *   navTags         {object[]}  Root tags with children (used for "site" crumb dropdown)
 *   currentTagSlug  {string}    Active tag slug (for flyout highlight)
 *   breadcrumb      {object[]}  Tag-ancestry crumbs: { name, slug?, href?, is_hidden?, tooltip? }.
 *                               Last item = current tag (may have a slug for a self-link).
 *   total           {number}    Post / result count shown as trailing count crumb.
 *   timelineVisible {boolean}   When true, suppress the year facet crumb (timeline shows it).
 *   slot            {string}    Optional HTML inserted as a middle header item
 *                               (between breadcrumb and action buttons; wraps to its
 *                               own full-width row on mobile), e.g. a page control.
 */

import { Component } from '../Component.js';
import { store } from '../../store.js';
import { escapeHtml, navigate, sharePost } from '../../utils/helpers.js';
import { listPosts } from '../../api/posts.js';
import { listTags } from '../../api/tags.js';
import { APP_LOGO_SVG, MAP_SVG, TAGS_SVG, EDIT_SVG, SUN_SVG, MOON_SVG, LOCK_SVG, SEARCH_SVG, MENU_SVG, SHARE_SVG, EXPAND_SVG, ARTICLE_SVG } from '../../utils/icons.js';
import { ViewContext } from '../../utils/viewContext.js';
import { showCrumbDropdown, hideFlyout, tagHref } from '../../utils/tags.js';

export class PublicHeader extends Component {
  render() {
    const {
      settings = {},
      currentPath = '/',
      navTags = [],
      breadcrumb = [],
      total = 0,
      timelineVisible = false,
      editUrl = null,
      showShare = false,
      immersive = false,
      onToggleImmersive = null,
      slot = '',
    } = this.props;

    const user = store.get('user');
    const title    = escapeHtml(settings.blog_title || 'Photo Blog');
    const subtitle = escapeHtml(settings.blog_subtitle || '');

    const shareButtonHtml = showShare
      ? `<button type="button" class="header-action-btn share-btn" title="Share" aria-label="Share">
           ${SHARE_SVG}
         </button>`
      : '';

    const immersiveToggleHtml = onToggleImmersive
      ? `<button type="button" class="header-action-btn immersive-toggle-btn"
                 title="${immersive ? 'Article view' : 'Immersive mode'}"
                 aria-label="${immersive ? 'Article view' : 'Immersive mode'}">
           ${immersive ? ARTICLE_SVG : EXPAND_SVG}
         </button>`
      : '';

    const vc = ViewContext.current();

    // ── Build unified breadcrumb ──────────────────────────────────────────────
    //
    // Structure: site▾ / [tag crumbs▾] / [year facet] / ["query" facet]   N posts
    //
    // The existing `breadcrumb` prop carries the tag-ancestry path (from page
    // components).  We prepend the root "site" crumb and append any active
    // facet crumbs derived from ViewContext.

    const hasTagCrumbs = breadcrumb.length > 0;

    // Year facet crumb
    let yearLabel = null;
    if (vc.years && !timelineVisible) {
      yearLabel = vc.years[0] === vc.years[1]
        ? String(vc.years[0])
        : `${vc.years[0]}–${vc.years[1]}`; // en-dash
    }

    // Query facet crumb
    const queryLabel = vc.query ? `“${vc.query}”` : null; // "query"

    // Aria-live announcement (mirrors FilterChipsRow behaviour)
    const ariaLabels = [];
    if (vc.tag) ariaLabels.push(vc.tag);
    if (vc.years && !timelineVisible) ariaLabels.push(`from ${vc.years[0]} to ${vc.years[1]}`);
    if (vc.query) ariaLabels.push(`search for ${vc.query}`);
    const ariaLiveText = ariaLabels.length
      ? `Showing ${ariaLabels.join(', ')} — ${total} post${total !== 1 ? 's' : ''}`
      : '';

    // Popover items: "site" + tag crumbs + facets (for fold-current fallback)
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

    // ── Render crumb items ────────────────────────────────────────────────────

    // Root "site" crumb — always a link to /, has ▾ caret for root-tags dropdown
    const siteHasChildren = navTags.length > 0;
    const siteHasFollowingCrumbs = hasTagCrumbs || yearLabel || queryLabel;
    const siteClass = siteHasFollowingCrumbs ? 'breadcrumb-link' : 'breadcrumb-current';
    const siteCrumbHtml = `<span class="crumb-pair" id="site-crumb-pair">
      <a href="/" class="${siteClass} crumb-site${siteHasChildren ? ' has-dropdown' : ''}" data-crumb="site"
         aria-label="${title}"${siteHasChildren ? ' aria-haspopup="true"' : ''}>${title}</a>
      ${siteHasFollowingCrumbs ? '<span class="breadcrumb-separator" aria-hidden="true"></span>' : ''}
    </span>`;

    // Tag ancestry crumbs from `breadcrumb` prop
    const tagCrumbsHtml = breadcrumb.map((crumb, i) => {
      const isLast = i === breadcrumb.length - 1;
      const lockIcon = crumb.is_hidden ? LOCK_SVG : '';
      const tooltipAttr = crumb.tooltip ? ` title="${escapeHtml(crumb.tooltip)}"` : '';

      if (isLast) {
        // Current tag — rendered as breadcrumb-current; may have children dropdown
        const hasChildren = this._crumbHasChildren(crumb, navTags);
        const href = crumb.href
          ? escapeHtml(crumb.href)
          : crumb.slug
            ? `/tags/${escapeHtml(crumb.slug)}`
            : null;
        // If there are facet crumbs after this, it's a non-final crumb visually
        const hasFacets = yearLabel || queryLabel;
        if (hasFacets) {
          // Render as a foldable crumb-pair (not the terminal breadcrumb-current)
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
        // Terminal: breadcrumb-current
        if (href) {
          return `<a href="${href}" class="breadcrumb-current${crumb.is_hidden ? ' is-hidden' : ''}${hasChildren ? ' has-dropdown' : ''}"
             data-crumb-slug="${escapeHtml(crumb.slug)}"${tooltipAttr}${hasChildren ? ' aria-haspopup="true"' : ''}>${lockIcon}${escapeHtml(crumb.name)}</a>`;
        }
        return `<span class="breadcrumb-current${crumb.is_hidden ? ' is-hidden' : ''}${hasChildren ? ' has-dropdown' : ''}"${tooltipAttr}>${lockIcon}${escapeHtml(crumb.name)}</span>`;
      }

      // Non-last tag crumb — foldable crumb-pair with optional dropdown
      const href = crumb.href || (crumb.slug ? `/tags/${escapeHtml(crumb.slug)}` : '/');
      const hasChildren = this._crumbHasChildren(crumb, navTags);
      return `<span class="crumb-pair">
        <a href="${href}" class="breadcrumb-link${crumb.is_hidden ? ' is-hidden' : ''}${hasChildren ? ' has-dropdown' : ''}"
           data-crumb-slug="${escapeHtml(crumb.slug || '')}"${tooltipAttr}${hasChildren ? ' aria-haspopup="true"' : ''}>${lockIcon}${escapeHtml(crumb.name)}</a>
        <span class="breadcrumb-separator" aria-hidden="true"></span>
      </span>`;
    }).join('');

    // Facet crumbs: year and query (no dropdown; removed by clicking an earlier crumb)
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

    const crumbHtml = `<nav class="site-breadcrumb" aria-label="Breadcrumb">
      ${ariaLiveText ? `<span class="sr-only" aria-live="polite">${escapeHtml(ariaLiveText)}</span>` : ''}
      ${siteCrumbHtml}
      ${tagCrumbsHtml}
      ${facetCrumbsHtml}
      <div class="crumb-popover" id="crumb-popover">${popoverItemsHtml}</div>
    </nav>`;

    // ICON BUTTON GUIDANCE
    // All icon-only buttons in the header use the `header-action-btn` class.
    //   <a class="header-action-btn" href="..." aria-label="...">  — for navigation
    //   <button class="header-action-btn" type="button" aria-label="...">  — for actions (no navigation)
    // The `.theme-toggle` class is kept as an alias and for sun/moon icon visibility logic.
    const editButtonHeader = (user && editUrl)
      ? `<a href="${escapeHtml(editUrl)}" class="header-action-btn edit-btn-header" title="Edit" aria-label="Edit post">
           ${EDIT_SVG}
         </a>`
      : '';

    const editButtonBurger = (user && editUrl)
      ? `<a href="${escapeHtml(editUrl)}" class="header-action-btn" title="Edit" aria-label="Edit post">
           ${EDIT_SVG}
         </a>`
      : '';

    const mapButtonHtml = (() => {
      const visibility = settings.map_mode || 'off';
      if (visibility === 'all' || (user && visibility === 'hidden')) {
        return `<a href="/map" class="header-action-btn${currentPath === '/map' ? ' active' : ''}"
                   aria-label="Map view">
                  ${MAP_SVG}
                </a>`;
      }
      return '';
    })();

    const tagsButtonHtml = `<a href="/tags" class="header-action-btn${currentPath === '/tags' ? ' active' : ''}"
                   aria-label="All tags" title="All tags">
                  ${TAGS_SVG}
                </a>`;

    const searchPlaceholder = vc.tag ? `Search ${escapeHtml(vc.tag)}...` : "Search...";

    // Burger: root tags as links for mobile discoverability
    const burgerTagLinksHtml = navTags.length
      ? navTags.map(t =>
          `<a href="/tags/${escapeHtml(t.slug)}" class="burger-link burger-tag-link">${escapeHtml(t.name)}</a>`
        ).join('')
      : '';

    return `
      <div class="site-header-group">
        <div id="search-typeahead-mount" class="search-typeahead-mount"></div>
        <div class="site-header-inner">

          <div class="site-header">
            <div class="site-branding">
              <a href="/" class="site-title-link">
                <h1 class="site-title">
                  ${APP_LOGO_SVG}
                </h1>
                ${!breadcrumb.length && !vc.years && !vc.query && subtitle ? `<p class="site-subtitle">${subtitle}</p>` : ''}
              </a>
              ${crumbHtml}
              ${(immersiveToggleHtml || shareButtonHtml || editButtonHeader)
                ? `<div class="branding-actions">
                ${immersiveToggleHtml}
                ${shareButtonHtml}
                ${editButtonHeader}
              </div>`
                : ''}
            </div>
          </div>

          ${slot ? `<div class="site-nav-slot">${slot}</div>` : ''}

          <nav class="site-nav" aria-label="Main navigation">

            <form class="header-search-form" id="header-search" role="search" action="/search" method="get">
              <input type="search" name="q" placeholder="${searchPlaceholder}" aria-label="Search posts" tabindex="-1">
              <button type="button" aria-label="Toggle search" class="header-action-btn search-toggle-btn">
                ${SEARCH_SVG}
              </button>
            </form>

            <!-- Normal nav items (hidden when fold-nav active) -->
            <div class="site-nav-items">
              ${tagsButtonHtml}
              ${mapButtonHtml}
            </div>

            <!-- Burger (shown when fold-nav active) -->
            <div class="nav-burger" id="nav-burger">
              <button class="header-action-btn burger-toggle" type="button" aria-label="Menu" aria-expanded="false">
                ${MENU_SVG}
              </button>
              <div class="burger-dropdown">
                <form class="burger-search-form" action="/search" method="get" role="search">
                  ${SEARCH_SVG}
                  <input type="search" name="q" placeholder="${searchPlaceholder}" autocomplete="off">
                </form>

                <div class="burger-tags-slot" id="burger-tags-slot">
                  ${burgerTagLinksHtml}
                </div>

                <div class="burger-sitemap">
                  <a href="/tags" class="burger-link">All tags</a>
                  <a href="/map" class="burger-link">Map</a>
                  <a href="/light" class="burger-link">About</a>
                  ${user ? `<a href="/light" class="burger-link">Admin</a>` : ''}
                </div>

                <div class="burger-actions">
                  <button class="theme-toggle" id="burger-theme-toggle" type="button" aria-label="Toggle theme">
                    <span class="icon-sun">${SUN_SVG}</span>
                    <span class="icon-moon">${MOON_SVG}</span>
                  </button>
                  ${immersiveToggleHtml}
                  ${shareButtonHtml}
                  ${editButtonBurger}
                </div>
              </div>
            </div>

          </nav>

        </div>
      </div>`;
  }

  /**
   * Check if a crumb item has children in the navTags tree.
   * Used to decide whether to render a ▾ caret.
   */
  _crumbHasChildren(crumb, navTags) {
    if (!crumb.slug) return false;
    // Search the navTags tree for a tag with this slug that has children
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

  /**
   * Get children of a tag slug from the navTags tree.
   */
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
    const { navTags = [], onToggleImmersive } = this.props;

    this.container.querySelectorAll('.immersive-toggle-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        onToggleImmersive?.();
      });
    });

    this.container.querySelectorAll('.share-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const settings = store.get('settings') || {};
        sharePost({
          title: settings.blog_title || document.title,
          url: window.location.href
        });
      });
    });

    this._group = this.$('.site-header-group');
    this._inner = this.$('.site-header-inner');

    // Theme toggle in the burger menu (the primary toggle now lives in the footer)
    this.$('#burger-theme-toggle')?.addEventListener('click', () => {
      const current = store.get('theme') || 'auto';
      store.set('theme', current === 'dark' ? 'light' : 'dark');
    });

    // ── Crumb dropdowns ───────────────────────────────────────────────────────
    // Desktop (hover-capable): open on hover, click navigates to the crumb's page.
    // Touch / no-hover: keep tap-to-open.
    const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    let hoverTimer = null;
    const attachCrumbDropdown = (el, items) => {
      if (!items.length) return;
      if (canHover) {
        el.addEventListener('mouseenter', () => {
          clearTimeout(hoverTimer);
          hoverTimer = setTimeout(
            () => showCrumbDropdown(el, items, navigate, this._group),
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
          showCrumbDropdown(el, items, navigate, this._group);
        });
      }
    };

    // "site" crumb → root navTags dropdown
    const siteCrumb = this.$('.crumb-site');
    const siteTitleLink = this.$('.site-title-link');
    if (navTags.length) {
      const rootItems = navTags.map(t => ({
        name: t.name,
        slug: t.slug,
        count: t.post_count,
      }));
      if (siteCrumb) attachCrumbDropdown(siteCrumb, rootItems);
      if (siteTitleLink) attachCrumbDropdown(siteTitleLink, rootItems);
    }

    // Tag crumbs with children → sub-tags dropdown.
    // Children of a crumb drill down with a path that includes the crumb and
    // everything before it, so the navigated branch keeps accumulating.
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
        href: tagHref(c.slug, childPath),
      }));
      attachCrumbDropdown(el, childItems);
    });

    // Header search (expandable)
    const searchForm = this.$('#header-search');
    if (searchForm) {
      const input = searchForm.querySelector('input[type="search"]');
      const toggleBtn = searchForm.querySelector('.search-toggle-btn');

      const closeSearch = () => {
        searchForm.classList.remove('is-active');
        input.tabIndex = -1;
        input.blur();
      };

      const submitSearch = () => {
        const q = input.value.trim();
        if (q) {
          this._saveRecentSearch(q);
          ViewContext.update({ query: q });
          input.value = '';
        }
        this._hideTypeahead();
        closeSearch();
      };

      let debounceTimer = null;
      input.addEventListener('input', () => {
        const q = input.value.trim();
        clearTimeout(debounceTimer);
        if (q.length >= 2) {
          debounceTimer = setTimeout(() => this._showTypeahead(q, input), 300);
        } else {
          this._hideTypeahead();
        }
      });

      input.addEventListener('focus', () => {
        if (!input.value.trim()) this._showRecentSearches(input);
      });

      toggleBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (!searchForm.classList.contains('is-active')) {
          searchForm.classList.add('is-active');
          // Expand the search input to fill up to the breadcrumb's left edge
          const breadcrumbEl = this.$('.site-breadcrumb');
          if (breadcrumbEl) {
            const formRect = searchForm.getBoundingClientRect();
            const bcRect = breadcrumbEl.getBoundingClientRect();
            input.style.setProperty('--search-width', `${formRect.right - bcRect.left}px`);
          }
          input.tabIndex = 0;
          input.focus();
        } else {
          submitSearch();
        }
      });

      searchForm.addEventListener('submit', (e) => { e.preventDefault(); submitSearch(); });
      input.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSearch(); });
      document.addEventListener('click', (e) => {
        if (searchForm.classList.contains('is-active') && !searchForm.contains(e.target)) closeSearch();
      });
    }

    // Burger search (always-visible full-width input)
    const burgerSearchForm = this.$('.burger-search-form');
    if (burgerSearchForm) {
      burgerSearchForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const q = burgerSearchForm.querySelector('input[type="search"]').value.trim();
        if (q) ViewContext.update({ query: q });
        this._closeBurger();
      });
    }

    // Burger toggle + outside-click close
    const navBurger = this.$('#nav-burger');
    if (navBurger) {
      const burgerBtn = navBurger.querySelector('.burger-toggle');
      burgerBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = navBurger.classList.contains('is-open');
        navBurger.classList.toggle('is-open', !isOpen);
        burgerBtn.setAttribute('aria-expanded', String(!isOpen));

        if (!isOpen) {
          const input = navBurger.querySelector('input[type="search"]');
          if (input) setTimeout(() => input.focus(), 100);
        }
      });

      document.addEventListener('click', (e) => {
        if (!navBurger.contains(e.target)) this._closeBurger();
      });
    }

    // Crumb popover (fold-current step): clicking the last .breadcrumb-current
    // when everything is folded shows a popover with all crumbs.
    const crumbCurrentEls = [...this.container.querySelectorAll('.breadcrumb-current')];
    const lastCrumbCurrent = crumbCurrentEls[crumbCurrentEls.length - 1] || null;
    const crumbPopover = this.$('#crumb-popover');
    if (lastCrumbCurrent && crumbPopover) {
      lastCrumbCurrent.addEventListener('click', (e) => {
        if (!this._group?.classList.contains('fold-current')) return;
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

    // ResizeObserver drives the progressive fold
    this._ro = new ResizeObserver(() => this._updateFold());
    this._ro.observe(this._group);
    this._updateFold();
  }

  _saveRecentSearch(q) {
    const recent = JSON.parse(localStorage.getItem('recentSearches') || '[]');
    const next = [q, ...recent.filter(s => s !== q)].slice(0, 5);
    localStorage.setItem('recentSearches', JSON.stringify(next));
  }

  async _showTypeahead(q, input) {
    this._typeaheadActive = true;
    const vc = ViewContext.current();
    const params = { q, limit: 3, status: 'published' };
    if (vc.tag) params.tag = vc.tag;

    try {
      const [postsData, tagsData] = await Promise.all([
        listPosts(params),
        listTags({ q, limit: 5, include_empty: false })
      ]);

      if (!this._typeaheadActive) return;
      this._renderTypeaheadResults(q, postsData.posts || [], tagsData.tags || [], input);
    } catch (err) {
      console.error('Typeahead failed:', err);
    }
  }

  _showRecentSearches(input) {
    const recent = JSON.parse(localStorage.getItem('recentSearches') || '[]');
    if (!recent.length) return;
    this._renderTypeaheadResults('', [], [], input, recent);
  }

  _renderTypeaheadResults(q, posts, tags, input, recent = []) {
    const mount = document.getElementById('search-typeahead-mount');
    if (!mount) return;

    const inputRect = input.getBoundingClientRect();
    mount.style.top = `${inputRect.bottom + 4}px`;
    mount.style.left = `${inputRect.left}px`;
    mount.style.width = `${inputRect.width}px`;
    mount.classList.add('is-open');

    let html = '';
    if (recent.length) {
      html += `<div class="typeahead-section"><div class="typeahead-label">Recent</div>`;
      recent.forEach(s => {
        html += `<a href="#" class="typeahead-item recent-item" data-q="${escapeHtml(s)}">${escapeHtml(s)}</a>`;
      });
      html += `</div>`;
    } else {
      if (tags.length) {
        html += `<div class="typeahead-section"><div class="typeahead-label">Tags</div>`;
        tags.forEach(t => {
          html += `<a href="/tags/${t.slug}" class="typeahead-item tag-item">
            <span class="name">${escapeHtml(t.name)}</span>
            <span class="count">${t.post_count}</span>
          </a>`;
        });
        html += `</div>`;
      }
      if (posts.length) {
        html += `<div class="typeahead-section"><div class="typeahead-label">Posts</div>`;
        posts.forEach(p => {
          html += `<a href="/posts/${p.slug}" class="typeahead-item post-item">${escapeHtml(p.title)}</a>`;
        });
        html += `</div>`;
      }
      html += `<a href="#" class="typeahead-item search-all" data-q="${escapeHtml(q)}">Search everything for &ldquo;${escapeHtml(q)}&rdquo;</a>`;
    }

    mount.innerHTML = html;

    mount.querySelectorAll('.typeahead-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const searchQ = item.dataset.q;
        if (searchQ) {
          this._saveRecentSearch(searchQ);
          ViewContext.update({ query: searchQ });
          input.value = '';
        } else {
          navigate(item.getAttribute('href'));
        }
        this._hideTypeahead();
      });
    });
  }

  _hideTypeahead() {
    this._typeaheadActive = false;
    const mount = document.getElementById('search-typeahead-mount');
    mount?.classList.remove('is-open');
  }

  _closeBurger() {
    const navBurger = this.$('#nav-burger');
    if (!navBurger) return;
    navBurger.classList.remove('is-open');
    navBurger.querySelector('.burger-toggle')?.setAttribute('aria-expanded', 'false');
  }

  _overflows(inner) {
    void inner.offsetWidth; // force reflow

    // The breadcrumb renders at its natural width (overflow:visible) and the
    // branding box has min-width:0, so an over-wide breadcrumb shrinks the
    // branding box and spills its content *under* the nav rather than pushing
    // nav.right past the container — a nav-vs-container check would never fire.
    // Instead compare the branding's content right edge to the limit it must not
    // cross: the nav's left edge when they share a row, else the container edge
    // (the layout wraps the nav onto its own row below 720px).
    // scrollWidth is unreliable on overflow:visible flex containers in Chrome,
    // so compare bounding rects instead.
    const innerRight = inner.getBoundingClientRect().right;
    const navEl = inner.querySelector('.site-nav');
    // Measure the breadcrumb itself: it holds the crumbs + leaf and is the thing
    // the fold algorithm shrinks. (branding-actions sit after it but get moved to
    // the burger by fold-nav, so they must not be the measured element.)
    const content = inner.querySelector('.site-breadcrumb');
    if (content) {
      const cRect = content.getBoundingClientRect();
      if (navEl) {
        const nRect = navEl.getBoundingClientRect();
        const sameRow = Math.abs(nRect.top - cRect.top) < cRect.height;
        const limit = sameRow ? nRect.left : innerRight;
        return cRect.right > limit - 1;
      }
      return cRect.right > innerRight + 1;
    }

    // Fallback: nav (or header) exits the container boundary.
    if (navEl) return navEl.getBoundingClientRect().right > innerRight + 1;
    const headerEl = inner.querySelector('.site-header');
    return headerEl ? headerEl.getBoundingClientRect().right > innerRight + 1 : false;
  }

  _resetFold() {
    const group = this._group;
    if (!group) return;
    group.classList.remove('fold-title', 'fold-nav', 'fold-current');
    group.querySelectorAll('.crumb-pair.folded').forEach((p) => {
      p.classList.remove('folded', 'show-ellipsis');
    });
    this._closeBurger();
    group.querySelector('#crumb-popover')?.classList.remove('is-open');
  }

  _updateFold() {
    const inner = this._inner;
    const group = this._group;
    if (!inner || !group) return;

    this._resetFold();
    if (!this._overflows(inner)) return;

    // Step 1: hide site subtitle
    group.classList.add('fold-title');
    if (!this._overflows(inner)) return;

    // Step 2: fold breadcrumb pairs left to right (excluding site title)
    // Drop facet pairs first, then tag pairs
    const allPairs = [...group.querySelectorAll('.crumb-pair')];
    const facetPairs = allPairs.filter(p => p.classList.contains('crumb-facet-pair'));
    const tagPairs = allPairs.filter(p => !p.classList.contains('crumb-facet-pair') && p.id !== 'site-crumb-pair');
    const sitePair = allPairs.find(p => p.id === 'site-crumb-pair');

    const checkEllipsis = () => {
      const allFolded = group.querySelectorAll('.crumb-pair.folded');
      allFolded.forEach(p => p.classList.remove('show-ellipsis'));
      if (allFolded.length > 0) {
        allFolded[allFolded.length - 1].classList.add('show-ellipsis');
      }
    };

    // Fold facet pairs
    for (const pair of facetPairs) {
      pair.classList.add('folded');
      checkEllipsis();
      if (!this._overflows(inner)) return;
    }

    // Fold tag pairs left to right
    for (const pair of tagPairs) {
      pair.classList.add('folded');
      checkEllipsis();
      if (!this._overflows(inner)) return;
    }

    // Step 3: fold site title if it still overflows
    if (sitePair) {
      sitePair.classList.add('folded');
      checkEllipsis();
      if (!this._overflows(inner)) return;
    }

    // Step 4: collapse nav to burger
    group.classList.add('fold-nav');
    if (!this._overflows(inner)) return;

    // Step 5: last resort — ellipsis on breadcrumb-current
    group.classList.add('fold-current');
  }

  beforeRender() {
    this._ro?.disconnect();
    this._ro = null;
  }

  beforeUnmount() {
    this._ro?.disconnect();
    hideFlyout();
  }
}
