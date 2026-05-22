/**
 * Public site header — blog logo, optional breadcrumb, tag filter bar, nav buttons.
 *
 * Props:
 *   settings       {object}    Public blog settings (blog_title, blog_subtitle)
 *   currentPath    {string}    Current pathname for active nav highlighting
 *   navTags        {object[]}  Root tags with children for the filter bar
 *   currentTagSlug {string}    Active tag slug (for filter bar highlight)
 *   breadcrumb     {object[]}  Crumb items: { name, slug? }. Last item = current page (no slug).
 */

import { Component } from '../Component.js';
import { PublicHeaderTagsBar } from './PublicHeaderTagsBar.js';
import { store } from '../../store.js';
import { escapeHtml, navigate } from '../../utils/helpers.js';
import { APP_LOGO_SVG, MAP_SVG, EDIT_SVG, SUN_SVG, MOON_SVG, LOCK_SVG, SEARCH_SVG, MENU_SVG } from '../../utils/icons.js';

export class PublicHeader extends Component {
  render() {
    const {
      settings = {},
      currentPath = '/',
      navTags = [],
      breadcrumb = [],
      editUrl = null,
    } = this.props;

    const user = store.get('user');
    const title    = escapeHtml(settings.blog_title || 'Photo Blog');
    const subtitle = escapeHtml(settings.blog_subtitle || '');

    // Build breadcrumb nav rendered inside .site-branding
    let crumbHtml = '';
    if (breadcrumb.length) {
      // Popover lists all crumb items (shown when fold-current is active)
      const popoverItems = breadcrumb.map((crumb, i) => {
        const isLast = i === breadcrumb.length - 1;
        const lockIcon = crumb.is_hidden ? LOCK_SVG : '';
        if (isLast) {
          return `<span class="popover-item is-current">${lockIcon}${escapeHtml(crumb.name)}</span>`;
        }
        const href = crumb.href || (crumb.slug ? `/tags/${escapeHtml(crumb.slug)}` : '/');
        return `<a href="${href}" class="popover-item">${lockIcon}${escapeHtml(crumb.name)}</a>`;
      }).join('');

      // Leading separator + crumb-pairs (each non-last crumb wrapped for fold toggling)
      const items = [
        `<span class="breadcrumb-separator" aria-hidden="true">/</span>`,
        ...breadcrumb.map((crumb, i) => {
          const isLast = i === breadcrumb.length - 1;
          const lockIcon = crumb.is_hidden ? LOCK_SVG : '';
          if (isLast) {
            const tooltipAttr = crumb.tooltip ? ` title="${escapeHtml(crumb.tooltip)}"` : '';
            if (crumb.slug) {
              const href = `/tags/${escapeHtml(crumb.slug)}`;
              return `<a href="${href}" class="breadcrumb-current${crumb.is_hidden ? ' is-hidden' : ''}"${tooltipAttr}>${lockIcon}${escapeHtml(crumb.name)}</a>`;
            }
            return `<span class="breadcrumb-current${crumb.is_hidden ? ' is-hidden' : ''}"${tooltipAttr}>${lockIcon}${escapeHtml(crumb.name)}</span>`;
          }
          const href = crumb.href || (crumb.slug ? `/tags/${escapeHtml(crumb.slug)}` : '/');
          return `<span class="crumb-pair">
                    <a href="${href}" class="breadcrumb-link${crumb.is_hidden ? ' is-hidden' : ''}">${lockIcon}${escapeHtml(crumb.name)}</a>
                    <span class="breadcrumb-separator" aria-hidden="true">/</span>
                  </span>`;
        }),
      ].join('');
      crumbHtml = `<nav class="site-breadcrumb" aria-label="Breadcrumb">
        ${items}
        <div class="crumb-popover" id="crumb-popover">${popoverItems}</div>
      </nav>`;
    }

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

    return `
      <div class="site-header-group">
        <div class="site-header-inner">

          <div class="site-header">
            <div class="site-branding">
              <a href="/" class="site-title-link">
                <h1 class="site-title">
                  ${APP_LOGO_SVG}
                  <span class="site-title-text">${title}</span>
                </h1>
                ${!breadcrumb.length && subtitle ? `<p class="site-subtitle">${subtitle}</p>` : ''}
              </a>
              ${crumbHtml}
              ${editButtonHeader}
            </div>
          </div>

          ${navTags.length ? '<div class="header-tags-bar" id="header-tags-mount"></div>' : ''}

          <nav class="site-nav" aria-label="Main navigation">

            <!-- Normal nav items (hidden when fold-nav active) -->
            <div class="site-nav-items">
              <form class="header-search-form" id="header-search" role="search" action="/search" method="get">
                <input type="search" name="q" placeholder="Search..." aria-label="Search posts" tabindex="-1">
                <button type="button" aria-label="Toggle search" class="header-action-btn search-toggle-btn">
                  ${SEARCH_SVG}
                </button>
              </form>
              ${mapButtonHtml}
              <button class="theme-toggle" id="theme-toggle" aria-label="Toggle theme" type="button">
                <span class="icon-sun">${SUN_SVG}</span>
                <span class="icon-moon">${MOON_SVG}</span>
              </button>
            </div>

            <!-- Burger (shown when fold-nav active) -->
            <div class="nav-burger" id="nav-burger">
              <button class="header-action-btn burger-toggle" type="button" aria-label="Menu" aria-expanded="false">
                ${MENU_SVG}
              </button>
              <div class="burger-dropdown">
                <form class="burger-search-form" action="/search" method="get" role="search">
                  ${SEARCH_SVG}
                  <input type="search" name="q" placeholder="Search..." autocomplete="off">
                </form>
                <div class="burger-actions">
                  ${mapButtonHtml}
                  <button class="theme-toggle" id="burger-theme-toggle" type="button" aria-label="Toggle theme">
                    <span class="icon-sun">${SUN_SVG}</span>
                    <span class="icon-moon">${MOON_SVG}</span>
                  </button>
                  ${editButtonBurger}
                </div>
                <div class="burger-tags-slot" id="burger-tags-slot"></div>
              </div>
            </div>

          </nav>

        </div>
      </div>`;
  }

  afterRender() {
    const { navTags = [], currentTagSlug = '' } = this.props;

    if (navTags.length) {
      this.mountChild(PublicHeaderTagsBar, '#header-tags-mount', { navTags, currentTagSlug });
    }

    this._group = this.$('.site-header-group');
    this._inner = this.$('.site-header-inner');

    // Theme toggles (header + burger share the same handler)
    const toggleTheme = () => {
      const current = store.get('theme') || 'auto';
      store.set('theme', current === 'dark' ? 'light' : 'dark');
    };
    this.$('#theme-toggle')?.addEventListener('click', toggleTheme);
    this.$('#burger-theme-toggle')?.addEventListener('click', toggleTheme);

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
          navigate(`/search?q=${encodeURIComponent(q)}`);
          input.value = '';
        }
        closeSearch();
      };

      toggleBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (!searchForm.classList.contains('is-active')) {
          searchForm.classList.add('is-active');
          const tagsBar = document.getElementById('header-tags-mount');
          if (tagsBar) {
            const formRect = searchForm.getBoundingClientRect();
            const tagsRect = tagsBar.getBoundingClientRect();
            input.style.setProperty('--search-width', `${formRect.right - tagsRect.left}px`);
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
        if (q) navigate(`/search?q=${encodeURIComponent(q)}`);
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
      });

      document.addEventListener('click', (e) => {
        if (!navBurger.contains(e.target)) this._closeBurger();
      });
    }

    // Crumb popover (fold-current step)
    const crumbCurrent = this.$('.breadcrumb-current');
    const crumbPopover = this.$('#crumb-popover');
    if (crumbCurrent && crumbPopover) {
      crumbCurrent.addEventListener('click', (e) => {
        if (!this._group?.classList.contains('fold-current')) return;
        e.preventDefault();
        e.stopPropagation();
        const isOpen = crumbPopover.classList.contains('is-open');
        if (!isOpen) {
          const rect = crumbCurrent.getBoundingClientRect();
          crumbPopover.style.top  = `${rect.bottom + 4}px`;
          crumbPopover.style.left = `${rect.left}px`;
        }
        crumbPopover.classList.toggle('is-open', !isOpen);
      });

      document.addEventListener('click', (e) => {
        if (!crumbPopover.contains(e.target) && e.target !== crumbCurrent) {
          crumbPopover.classList.remove('is-open');
        }
      });
    }

    // ResizeObserver drives the progressive fold
    this._ro = new ResizeObserver(() => this._updateFold());
    this._ro.observe(this._group);
    this._updateFold();
  }

  _closeBurger() {
    const navBurger = this.$('#nav-burger');
    if (!navBurger) return;
    navBurger.classList.remove('is-open');
    navBurger.querySelector('.burger-toggle')?.setAttribute('aria-expanded', 'false');
  }

  _overflows(inner) {
    void inner.offsetWidth; // force reflow
    // scrollWidth is unreliable on overflow:visible flex containers in Chrome;
    // compare the nav's right edge against the container's right edge instead.
    const innerRight = inner.getBoundingClientRect().right;
    const navEl = inner.querySelector('.site-nav');
    if (navEl) return navEl.getBoundingClientRect().right > innerRight + 1;
    const headerEl = inner.querySelector('.site-header');
    return headerEl ? headerEl.getBoundingClientRect().right > innerRight + 1 : false;
  }

  _moveTags(target) {
    const tagsMount = document.getElementById('header-tags-mount');
    if (!tagsMount) return;
    if (target === 'burger') {
      const slot = document.getElementById('burger-tags-slot');
      if (slot && !slot.contains(tagsMount)) slot.appendChild(tagsMount);
    } else {
      const bar = this._group?.querySelector('.header-tags-bar');
      if (bar && !bar.contains(tagsMount)) bar.appendChild(tagsMount);
    }
  }

  _resetFold() {
    const group = this._group;
    if (!group) return;
    // Move tags back to header before measuring
    this._moveTags('header');
    group.classList.remove('fold-title', 'fold-nav', 'fold-tags', 'fold-current');
    group.querySelectorAll('.crumb-pair.folded').forEach((p) => p.classList.remove('folded'));
    this._closeBurger();
    group.querySelector('#crumb-popover')?.classList.remove('is-open');
  }

  _updateFold() {
    const inner = this._inner;
    const group = this._group;
    if (!inner || !group) return;

    this._resetFold();
    if (!this._overflows(inner)) return;

    // Step 1: hide site-title text
    group.classList.add('fold-title');
    if (!this._overflows(inner)) return;

    // Step 2: fold breadcrumb pairs left to right
    const pairs = [...group.querySelectorAll('.crumb-pair')];
    for (const pair of pairs) {
      pair.classList.add('folded');
      if (!this._overflows(inner)) return;
    }

    // Step 3: collapse nav to burger
    group.classList.add('fold-nav');
    if (!this._overflows(inner)) return;

    // Step 4: move tags into burger
    this._moveTags('burger');
    group.classList.add('fold-tags');
    if (!this._overflows(inner)) return;

    // Step 5: last resort — ellipsis on breadcrumb-current
    group.classList.add('fold-current');
  }

  beforeUnmount() {
    this._ro?.disconnect();
  }
}
